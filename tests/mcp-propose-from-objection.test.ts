import { afterEach, expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import { registerTask } from "../src/tasks.js";
import { FakeAttributionClient } from "./fakes.js";
import {
  api,
  bootTidepool,
  completeIntegrationReviews,
  completeViaMcp,
  FULL_HANDOFF,
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
  /** 人間が担当して人間の扉で完了した task(完了エントリ1つに cause[0])。 */
  human?: true;
  /** agent が登録した task(decompose と同じ登録者の形)。省略 = 人間が登録。 */
  registrant?: string;
}

/** task ごとに cause を台本にしたエントリを作り、1つの triage session で全エントリに異議を commit する。 */
async function objectedTasks(attributionClient: FakeAttributionClient, specs: Objected[]): Promise<any[]> {
  const made = [];
  for (const spec of specs) {
    const task = spec.registrant
      ? registerTask(t.db, { type: "work", title: spec.title, purpose: "p", completion_criteria: "c", workspace: "charts" }, t.clock.now(), spec.registrant, "worker")
      : await registerWork(t, spec.title, "charts", undefined, spec.human && "human");
    const entries: any[] = [];
    if (spec.human) {
      await api(t.baseUrl, "POST", `/api/tasks/${task.id}/complete`, { handoff: FULL_HANDOFF });
      entries.push((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json.find((e: any) => e.kind === "task_completed"));
    } else {
      await t.clock.advance(HOUR);
      for (const cause of spec.causes) entries.push(await loggedEntry(t, task.id, `${spec.title}: decided as ${cause}`));
      await completeViaMcp(t, task.id);
    }
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

it("学習に向かない cause・人間登録の task_ambiguity / missing_information の Behavior・as の過不足・親の異議エントリでない id は domain error で拒否され、work task から呼んでも拒否され、店には何も載らない", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const [mixed, other]: any[] = await objectedTasks(attributionClient, [
    { title: "mixed", causes: ["capability", "uncertain", "requirement_change", "environment", "task_ambiguity", "missing_information"] },
    { title: "other", causes: ["capability"] },
  ]);
  const [capability, uncertain, requirementChange, environment, taskAmbiguity, missingInformation] = mixed.entries.map((e: any) => e.id);
  const completion = (await api(t.baseUrl, "GET", `/api/tasks/${mixed.task.id}/events`)).json.find((e: any) => e.kind === "task_completed").id;
  const repair = mixed.kids.find((x: any) => x.title === "repair: mixed");
  await runNow(repair.id);

  // RCA でない work task
  expect((await propose(repair.id, { entry_id: capability })).content[0].text).toBe("propose_from_objection is only for a review of an objected task");

  const self = mixed.kids.find((x: any) => x.title === "rca (self): mixed");
  await runNow(self.id);
  for (const [args, error] of [
    [{ entry_id: uncertain }, "the entry's cause is uncertain: nothing to learn from it"],
    [{ entry_id: requirementChange }, "the entry's cause is requirement_change: nothing to learn from it"],
    [{ entry_id: environment }, "the entry's cause is environment: nothing to learn from it"],
    [{ entry_id: taskAmbiguity }, "the task was registered by a human: there is no agent to address a behavior to"],
    [{ entry_id: missingInformation, as: "behavior" }, "the task was registered by a human: there is no agent to address a behavior to"],
    [{ entry_id: missingInformation }, 'as ("behavior" or "knowledge") is required for a missing_information entry and only for it'],
    [{ entry_id: capability, as: "behavior" }, 'as ("behavior" or "knowledge") is required for a missing_information entry and only for it'],
    [{ entry_id: completion }, `entry ${completion} carries no attributed objection`],
    [{ entry_id: other.entries[0].id }, `entry ${other.entries[0].id} is not a decision-log entry of your parent task`],
    [{ entry_id: 999_999 }, "entry 999999 is not a decision-log entry of your parent task"],
  ] as const) {
    const result = await propose(self.id, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
  }
  expect(await memoryEntries()).toEqual([]);
});

it("人間が書いた異議エントリは auditor RCA から拒否され、parent を持たない review から呼んでも拒否される", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const [{ entries, kids }]: any[] = await objectedTasks(attributionClient, [{ title: "by hand", causes: ["capability"], human: true }]);
  const auditor = kids.find((x: any) => x.title === "rca (auditor): by hand");
  await runNow(auditor.id);

  expect((await propose(auditor.id, { entry_id: entries[0].id })).content[0].text).toBe(`entry ${entries[0].id} was written by a human`);

  const root = (await api(t.baseUrl, "POST", "/api/tasks", { type: "review", title: "loose review", purpose: "p", completion_criteria: "c" })).json;
  await runNow(root.id);
  expect((await propose(root.id, { entry_id: entries[0].id })).content[0].text).toBe("propose_from_objection is only for a review of an objected task");
  expect(await memoryEntries()).toEqual([]);
});

it("agent 登録の task では task_ambiguity と missing_information の Behavior が登録者宛て、missing_information の Knowledge は宛先なしで即 approved、preference は worker 宛てになり、settings の一覧(HTTP / 管理MCP)が author の活動と出所の cause を運ぶ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient, auditorName: "shako" });
  const [{ task, entries, kids }]: any[] = await objectedTasks(attributionClient, [
    { title: "delegated", causes: ["task_ambiguity", "missing_information", "preference"], registrant: "tako" },
  ]);
  const [taskAmbiguity, missingInformation, preference] = entries.map((e: any) => e.id);
  const auditor = kids.find((x: any) => x.title === "rca (auditor): delegated");
  await runNow(auditor.id);

  const ids = [];
  for (const args of [
    { entry_id: taskAmbiguity },
    { entry_id: missingInformation, as: "behavior" },
    { entry_id: missingInformation, as: "knowledge" },
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
    expect.objectContaining({ id: ids[2], kind: "knowledge", state: "approved", addressee: null, source: await source(missingInformation), author, cause: "missing_information" }),
    expect.objectContaining({ id: ids[3], kind: "behavior", state: "candidate", addressee: t.worker.id, source: await source(preference), author, cause: "preference" }),
  ]);

  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(body(await client.callTool({ name: "list_memory_entries", arguments: {} }))).toEqual(listed);
  } finally {
    await client.close();
  }
});
