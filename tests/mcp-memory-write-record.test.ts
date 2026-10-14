import { afterEach, expect, it, vi } from "vitest";
import { MEMORY_REPAIR_VERBS, recordKnowledge } from "../src/memory.js";
import {
  api,
  bootTidepool,
  callAsTask,
  children,
  completeIntegrationReviews,
  completeViaMcp,
  defaultingTo,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  loggedEntry,
  makeWorkspace,
  managementMcpClient,
  mcpClient,
  object,
  registerWork,
  runNow,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 書き込みの記録(issue #632 / ADR 0252)のサーバ境界: verb の tool 結果の event_id が記録で、決定ログの API が行を写す。
 *  記録の有無と文の中身はドメイン層(tests/memory-write-record.test.ts)が言う。 */
let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const body = (result: any) => JSON.parse(result.content[0].text);
const writeRecords = async (taskId: string) =>
  ((await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json as any[]).filter((e) => e.kind === "memory_written").map((e) => e.id);

it("record_knowledge と define_memory_branch の tool 結果の event_id は書き込みの記録で、GET /api/log と read_decision_log はそれを未読の1行として写す", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const management = await managementMcpClient(t.baseUrl);
  try {
    const branch = body(await client.callTool({ name: "define_memory_branch", arguments: { prefix: "build", definition: "How the charts build." } }));
    const knowledge = body(
      await client.callTool({ name: "record_knowledge", arguments: { path: "build", title: "Tests need Node 22", text: "npm test fails on Node 24.", source: { commit: "0a46a46" } } }),
    );

    expect(await writeRecords(task.id)).toEqual([branch.event_id, knowledge.event_id]);
    const row = {
      id: knowledge.event_id,
      task_id: task.id,
      worker_id: t.worker.id,
      payload: { kind: "memory_written", line: `wrote knowledge #${knowledge.entry_id} "Tests need Node 22" at build (charts)`, created: [knowledge.entry_id], invalidated: [] },
    };
    expect((await api(t.baseUrl, "GET", "/api/log")).json.entries).toContainEqual(expect.objectContaining({ ...row, unread: true }));
    const read = body(await management.callTool({ name: "read_decision_log", arguments: {} }));
    expect(read.entries).toContainEqual(expect.objectContaining(row));
  } finally {
    await client.close();
    await management.close();
  }
});

it("meta-review の define_memory / fold_memory / move_memory / move_memory_branch / invalidate_memory の tool 結果の event_id は、呼び出しごとの書き込みの記録", async () => {
  const sandbox = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: sandbox, resolveWorkspace: defaultingTo(sandbox) });
  const material = recordKnowledge(
    t.db,
    { scope: "sandbox", path: "build", title: "Tests need Node 22", text: "Tests need Node 22.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
  ).entry_id;
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "memory");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown>) => body(await client.callTool({ name, arguments: args }));
  try {
    const defined = await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds." });
    const { event_id: decision } = await call("log_decision", { line: "the build note belongs board-wide" });
    const folded = await call("fold_memory", { scope: null, path: "toolchain", title: "Node 22", text: "Use Node 22.", replaces: [material], based_on_decision: decision });
    const moved = await call("move_memory", { entry_id: folded.entry_id, scope: null, path: "toolchain/node" });
    const branch = await call("move_memory_branch", { scope: "sandbox", path: "build", to_scope: null, to_path: "builds" });
    const dropped = await call("invalidate_memory", { entry_id: moved.entry_id, reason: "requirement_change" });

    expect(await writeRecords(review.id)).toEqual([defined, folded, moved, branch, dropped].map((r) => r.event_id));
  } finally {
    await client.close();
  }
});

it("記憶の修理 verb は書き込みの行への異議を束に持つ修理 task にだけ登録され、その tool 結果の event_id は修理 task の書き込みの記録", async () => {
  t = await bootTidepool();
  const objected = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);
  const wrote = body(
    await callAsTask(t, objected.id, "record_knowledge", { path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" } }),
  );
  const decision = await loggedEntry(t, objected.id, "squashed the branch");
  await completeViaMcp(t, objected.id);
  await completeIntegrationReviews(t, objected.id);
  const repairOf = async (entryId: number) => {
    await api(t.baseUrl, "POST", "/api/triage/start");
    await object(t, entryId, "undo it");
    await api(t.baseUrl, "POST", "/api/triage/close");
    return (await children(t, objected.id)).filter((c: any) => c.type === "work").at(-1);
  };
  const writeRepair = await repairOf(wrote.event_id);
  const decisionRepair = await repairOf(decision.id);
  const names = async (taskId: string) => {
    const client = await mcpClient(t.mcpBaseUrl, taskId);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  };

  expect(await names(writeRepair.id)).toEqual(expect.arrayContaining([...MEMORY_REPAIR_VERBS]));
  for (const taskId of [decisionRepair.id, objected.id]) {
    expect((await names(taskId)).filter((name) => (MEMORY_REPAIR_VERBS as readonly string[]).includes(name))).toEqual([]);
  }

  await runNow(t, writeRepair.id);
  const dropped = body(await callAsTask(t, writeRepair.id, "invalidate_memory", { entry_id: wrote.entry_id, reason: "capability" }));
  expect(await writeRecords(writeRepair.id)).toEqual([dropped.event_id]);
});
