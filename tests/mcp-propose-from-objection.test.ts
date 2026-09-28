import { afterEach, expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import { registerTask } from "../src/tasks.js";
import { FakeAttributionClient } from "./fakes.js";
import {
  api,
  bootTidepool,
  completeIntegrationReviews,
  completeViaMcp,
  HOUR,
  loggedEntry,
  managementMcpClient,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

/** RCA の起草 verb `propose_from_objection`(spec #615 B / issue #616)。kind と宛先は
 *  盤面が最新の cause から導出し(ADR 0115 決定4)、門は構造で引く(ADR 0120 決定1(a))。 */
let t: Tidepool;
afterEach(() => t?.stop());

const body = (result: any) => JSON.parse(result.content[0].text);

interface Objected {
  title: string;
  causes: Cause[];
  /** agent が登録した task(decompose と同じ登録者の形)。省略 = 人間が登録。 */
  registrant?: string;
}

/** task ごとに cause を台本にしたエントリを作り、1つの triage session で全エントリに異議を commit する。 */
async function objectedTasks(attributionClient: FakeAttributionClient, specs: Objected[]): Promise<any[]> {
  const made = [];
  for (const spec of specs) {
    const task = spec.registrant
      ? registerTask(t.db, { type: "work", title: spec.title, purpose: "p", completion_criteria: "c", workspace: "charts" }, t.clock.now(), spec.registrant, "worker")
      : await registerWork(t, spec.title, "charts");
    const entries: any[] = [];
    await t.clock.advance(HOUR);
    for (const cause of spec.causes) entries.push(await loggedEntry(t, task.id, `${spec.title}: decided as ${cause}`));
    await completeViaMcp(t, task.id);
    await completeIntegrationReviews(t, task.id);
    spec.causes.forEach((cause, i) => attributionClient.scriptJudgment(entries[i].id, { cause, evidence: `scripted ${cause}` }));
    made.push({ task, entries });
  }
  await api(t.baseUrl, "POST", "/api/triage/start");
  for (const { entries } of made) {
    for (const entry of entries) await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry.id, comment: "redo it" });
  }
  await api(t.baseUrl, "POST", "/api/triage/close");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return made.map((m) => ({ ...m, kids: tasks.filter((x: any) => x.parent_id === m.task.id) }));
}

/** slot を占めている task を順に完了させてから、先頭での2回の move で `taskId` を Run now。 */
async function runNow(taskId: string) {
  for (;;) {
    const running = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.status === "in_progress");
    if (!running || running.id === taskId) break;
    await completeViaMcp(t, running.id, running.type === "work");
  }
  await api(t.baseUrl, "POST", `/api/tasks/${taskId}/move`, { after: null });
  await api(t.baseUrl, "POST", `/api/tasks/${taskId}/move`, { after: null });
}

async function propose(taskId: string, args: Record<string, unknown>) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  try {
    return (await client.callTool({ name: "propose_from_objection", arguments: { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", ...args } })) as any;
  } finally {
    await client.close();
  }
}

const memoryEntries = async () => (await api(t.baseUrl, "GET", "/api/settings/memory/entries")).json.entries;

async function attributionId(taskId: string, entryId: number) {
  return (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.findLast(
    (e: any) => e.kind === "objection_attributed" && e.payload.entry_id === entryId,
  ).id;
}

it("capability の異議エントリに RCA が呼ぶと、宛先 = エントリの worker の Behavior candidate が親の workspace・出所 = 最新の帰責 event・author = rca + RCA の agent で載り、entry id と event id を返す", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const [{ task, entries, kids }]: any[] = await objectedTasks(attributionClient, [{ title: "capable", causes: ["capability"] }]);
  const self = kids.find((x: any) => x.title === "rca (self): capable");
  await runNow(self.id);

  const result = await propose(self.id, { entry_id: entries[0].id });

  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const { entry_id, event_id } = body(result);
  expect(event_id).toBe(entry_id);
  expect(await memoryEntries()).toEqual([
    expect.objectContaining({
      id: entry_id,
      kind: "behavior",
      state: "candidate",
      scope: "charts",
      path: "testing/fixtures",
      title: "Keep fixtures",
      text: "Never skip the fixtures.",
      addressee: entries[0].worker_id,
      source: { kind: "event", ref: await attributionId(task.id, entries[0].id) },
      author: { activity: "rca", name: t.worker.id },
    }),
  ]);
});

it("propose_from_objection の拒否は tool error として返る(何を断るかは domain 層 —— tests/propose-from-objection.test.ts が言う)", async () => {
  t = await bootTidepool();
  const work = await registerWork(t, "not a review", "charts");
  await t.clock.advance(HOUR); // picked up into the slot

  expect(await propose(work.id, { entry_id: 999_999 })).toMatchObject({ isError: true, content: [{ text: expect.any(String) }] });
});

it("agent 登録の task では task_ambiguity と missing_information の Behavior が登録者宛て、missing_information の Knowledge は宛先なしで即 approved・出所は RCA が log_decision した推論(based_on_decision、cause は無い)、preference は worker 宛てになり、settings の一覧(HTTP / 管理MCP)が author の活動と出所の cause を運ぶ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient, auditorName: "shako" });
  const [{ task, entries, kids }]: any[] = await objectedTasks(attributionClient, [
    { title: "delegated", causes: ["task_ambiguity", "missing_information", "preference"], registrant: "tako" },
  ]);
  const [taskAmbiguity, missingInformation, preference] = entries.map((e: any) => e.id);
  const auditor = kids.find((x: any) => x.title === "rca (auditor): delegated");
  await runNow(auditor.id);
  const decision = (await loggedEntry(t, auditor.id, "the fixture rule was never written down")).id;

  const ids = [];
  for (const args of [
    { entry_id: taskAmbiguity },
    { entry_id: missingInformation, as: "behavior" },
    { entry_id: missingInformation, as: "knowledge", based_on_decision: decision },
    { entry_id: preference },
  ]) {
    const result = await propose(auditor.id, args);
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    ids.push(body(result).entry_id);
  }

  const source = async (entryId: number) => ({ kind: "event", ref: await attributionId(task.id, entryId) });
  const author = { activity: "rca", name: "shako" };
  const listed = await memoryEntries();
  expect(listed).toEqual([
    expect.objectContaining({ id: ids[0], kind: "behavior", state: "candidate", addressee: "tako", source: await source(taskAmbiguity), author, cause: "task_ambiguity" }),
    expect.objectContaining({ id: ids[1], kind: "behavior", state: "candidate", addressee: "tako", source: await source(missingInformation), author, cause: "missing_information" }),
    expect.objectContaining({ id: ids[2], kind: "knowledge", state: "approved", addressee: null, source: { kind: "decision", ref: decision }, author, cause: null }),
    expect.objectContaining({ id: ids[3], kind: "behavior", state: "candidate", addressee: t.worker.id, source: await source(preference), author, cause: "preference" }),
  ]);

  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(body(await client.callTool({ name: "list_memory_entries", arguments: {} }))).toEqual(listed);
  } finally {
    await client.close();
  }
});

it("前提の破綻の宣言への異議エントリも、宣言者の review の RCA から提案できる", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const parent = await registerWork(t, "T", "charts");
  await t.clock.advance(HOUR);
  const worker = await mcpClient(t.mcpBaseUrl, parent.id);
  const [a] = body(
    await worker.callTool({ name: "decompose", arguments: { reason: "split T", children: [{ title: "A", purpose: "p", completion_criteria: "c" }] } }),
  ).child_ids;
  await worker.close();
  await t.clock.advance(HOUR);
  const declarer = await mcpClient(t.mcpBaseUrl, a);
  await declarer.callTool({ name: "declare_premise_breach", arguments: { reason: "module M is broken" } });
  await declarer.close();
  const entry = (await api(t.baseUrl, "GET", `/api/tasks/${a}/events`)).json.find((e: any) => e.kind === "premise_breached");
  attributionClient.scriptJudgment(entry.id, { cause: "capability", evidence: "scripted capability" });
  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry.id, comment: "M was fine" });
  await api(t.baseUrl, "POST", "/api/triage/close");
  // triage close の poll で早期統合復帰した親が続行し、held の子(RCA を含む)を解く
  const resumed = await mcpClient(t.mcpBaseUrl, parent.id);
  await resumed.callTool({ name: "continue_decomposition", arguments: { line: "M is fine" } });
  await resumed.close();
  const self = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.title === "rca (self): A");
  await runNow(self.id);

  const result = await propose(self.id, { entry_id: entry.id });

  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  expect(await memoryEntries()).toEqual([
    expect.objectContaining({ id: body(result).entry_id, kind: "behavior", addressee: entry.worker_id, source: { kind: "event", ref: await attributionId(a, entry.id) } }),
  ]);
});
