import { afterEach, expect, it, vi } from "vitest";
import { memoryRepairVerbs, recordKnowledge } from "../src/memory.js";
import { MEMORY_META_REVIEW_VERBS, MEMORY_REPAIR_VERBS } from "../src/meta-review.js";
import { cancelTaskDirectly, listChildren, registerTask } from "../src/tasks.js";
import { commitTriage, raiseObjection } from "../src/triage.js";
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
  HUMAN_WEBUI,
  judgmentRepairTask,
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
    // 行の文と中身はドメイン層が言う —— ここは tool 結果の event_id が決定ログの行になる写像だけ
    const row = { id: knowledge.event_id, task_id: task.id, worker_id: t.worker.id, payload: expect.objectContaining({ kind: "memory_written" }) };
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

it("記憶の修理 verb は memory_repair の修理 task にだけ登録され、その tool 結果の event_id は修理 task の書き込みの記録", async () => {
  t = await bootTidepool();
  const objected = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);
  const wrote = body(
    await callAsTask(t, objected.id, "record_knowledge", { path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" } }),
  );
  const decision = await loggedEntry(t, objected.id, "squashed the branch");
  await completeViaMcp(t, objected.id);
  await completeIntegrationReviews(t, objected.id);
  /** 異議を打って triage を閉じ、束ねが立てた `type` の修理子と異議の id を返す。 */
  const repairOf = async (entryId: number, type: "work" | "memory_repair") => {
    await api(t.baseUrl, "POST", "/api/triage/start");
    const objection = await object(t, entryId, "undo it");
    await api(t.baseUrl, "POST", "/api/triage/close");
    return { objection, repair: (await children(t, objected.id)).filter((c: any) => c.type === type).at(-1) };
  };
  const write = await repairOf(wrote.event_id, "memory_repair");
  // 同じ書き込みの行への異議を材料にした work の修理子(束ねは立てないので手で)
  const writeWorkRepair = registerTask(
    t.db,
    { type: "work", title: "repair", purpose: "undo it", completion_criteria: "c", parent_id: objected.id, objection_event_ids: [write.objection] },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  const decisionRepair = (await repairOf(decision.id, "work")).repair;
  const names = async (taskId: string) => {
    const client = await mcpClient(t.mcpBaseUrl, taskId);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  };

  expect(await names(write.repair.id)).toEqual(expect.arrayContaining([...MEMORY_REPAIR_VERBS]));
  for (const taskId of [writeWorkRepair.id, decisionRepair.id, objected.id]) {
    expect((await names(taskId)).filter((name) => (MEMORY_REPAIR_VERBS as readonly string[]).includes(name))).toEqual([]);
  }

  await runNow(t, write.repair.id);
  const dropped = body(await callAsTask(t, write.repair.id, "invalidate_memory", { entry_id: wrote.entry_id, reason: "capability" }));
  expect(await writeRecords(write.repair.id)).toEqual([dropped.event_id]);
});

it("memory_repair の worker MCP は tools/list に記憶の修理 verb 6本を持ち分解の verb と新規の記憶の書き込みの verb を持たず、get_current_task は祖先の cancel の下でも成果が捨てられた旨でなく記憶の修理の1行を運ぶ(ADR 0272 決定3)", async () => {
  t = await bootTidepool();
  const objected = registerTask(t.db, { type: "work", title: "index the tide charts", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  cancelTaskDirectly(t.db, objected, null, t.clock.now(), {}, "webui");
  const repair = registerTask(
    t.db,
    { type: "memory_repair", title: "memory repair", purpose: "undo it", completion_criteria: "c", parent_id: objected.id },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  await runNow(t, repair.id);
  const client = await mcpClient(t.mcpBaseUrl, repair.id);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...MEMORY_REPAIR_VERBS]));
    const withheld = ["decompose", "redecompose", "continue_decomposition", "declare_premise_breach", "record_knowledge", "define_memory_branch"];
    expect(names.filter((name) => withheld.includes(name))).toEqual([]);
    const envelope = body(await client.callTool({ name: "get_current_task", arguments: {} }));
    expect(envelope.memory_repair).toBe(
      "This task is a memory repair: its reach is limited to the entries the objected memory writes touched and the entries and branches the objected judgments name, so it cannot decompose or write memory outside them — to rewrite an entry a write touched, use replace_memory.",
    );
    expect(envelope.artifact_discarded).toBeUndefined();
  } finally {
    await client.close();
  }
});

it("memory_repair の tools/list の記憶の verb は、書き込みの行だけ・判断の行だけ・両方のどの組でも memoryRepairVerbs の集合(中身は domain の釘、ADR 0281 / ADR 0107 決定3)", async () => {
  t = await bootTidepool();
  const at = t.clock.now();
  const objected = registerTask(t.db, { type: "work", title: "index the tide charts", purpose: "p", completion_criteria: "c", workspace: "charts" }, at, ...HUMAN_WEBUI);
  const wrote = recordKnowledge(t.db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at, objected.id);
  raiseObjection(t.db, wrote.event_id, "undo it", at);
  commitTriage(t.db, at);
  const repairs = [listChildren(t.db, objected.id).find((c) => c.type === "memory_repair")!, judgmentRepairTask(t.db, at), judgmentRepairTask(t.db, at, { withWrite: true })];
  const memoryVerbs = async (taskId: string) => {
    const client = await mcpClient(t.mcpBaseUrl, taskId);
    try {
      const all: readonly string[] = [...MEMORY_REPAIR_VERBS, ...MEMORY_META_REVIEW_VERBS];
      return (await client.listTools()).tools.map((tool) => tool.name).filter((name) => all.includes(name)).sort();
    } finally {
      await client.close();
    }
  };

  for (const repair of repairs) expect(await memoryVerbs(repair.id)).toEqual(memoryRepairVerbs(t.db, repair.id).sort());
});

it("routing_repair の worker MCP は tools/list が基本の面(get_current_task / log_decision / escalate / complete_task)だけで、get_current_task は祖先の cancel の下でも routing の修理の1行を運ぶ(ADR 0279 決定4)", async () => {
  t = await bootTidepool();
  const objected = registerTask(t.db, { type: "work", title: "judge the routing table", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  cancelTaskDirectly(t.db, objected, null, t.clock.now(), {}, "webui");
  const repair = registerTask(
    t.db,
    { type: "routing_repair", title: "routing repair", purpose: "redo it", completion_criteria: "c", parent_id: objected.id },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  await runNow(t, repair.id);
  const client = await mcpClient(t.mcpBaseUrl, repair.id);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["complete_task", "escalate", "get_current_task", "log_decision"]);
    const envelope = body(await client.callTool({ name: "get_current_task", arguments: {} }));
    expect(envelope.routing_repair).toBe(
      "This task is a routing repair: it repairs the routing meta-review judgment objected in its purpose, and its reach is limited to what that judgment names, so it cannot decompose, delegate or use memory verbs.",
    );
    expect(envelope.memory_repair).toBeUndefined();
    expect(envelope.artifact_discarded).toBeUndefined();
  } finally {
    await client.close();
  }
});
