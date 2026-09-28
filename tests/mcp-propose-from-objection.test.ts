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
  memoryEntries,
  propose,
  registerWork,
  runNow,
  type Tidepool,
} from "./harness.js";

/** RCA の起草 verb `propose_from_objection`(spec #615 B / issue #616)のサーバ境界。kind・宛先・出所・scope の
 *  導出は domain 層(tests/propose-from-objection.test.ts)が言う(ADR 0107 決定3)。ここが言うのは author の
 *  解決、settings の一覧(HTTP / 管理MCP)の写像、戻り値の tool 結果への写像、拒否の tool error への写像だけ。 */
let t: Tidepool;
afterEach(() => t?.stop());

const body = (result: any) => JSON.parse(result.content[0].text);

interface Objected {
  title: string;
  cause: Cause;
  /** agent が登録した task(decompose と同じ登録者の形)。省略 = 人間が登録。 */
  registrant?: string;
}

/** task ごとに cause を台本にしたエントリを1つ作り、1つの triage session で全エントリに異議を commit する。 */
async function objectedTasks(attributionClient: FakeAttributionClient, specs: Objected[]): Promise<any[]> {
  const made = [];
  for (const spec of specs) {
    const task = spec.registrant
      ? registerTask(t.db, { type: "work", title: spec.title, purpose: "p", completion_criteria: "c", workspace: "charts" }, t.clock.now(), spec.registrant, "worker")
      : await registerWork(t, spec.title, "charts");
    await t.clock.advance(HOUR);
    const entry = await loggedEntry(t, task.id, `${spec.title}: decided as ${spec.cause}`);
    await completeViaMcp(t, task.id);
    await completeIntegrationReviews(t, task.id);
    attributionClient.scriptJudgment(entry.id, { cause: spec.cause, evidence: `scripted ${spec.cause}` });
    made.push({ task, entry });
  }
  await api(t.baseUrl, "POST", "/api/triage/start");
  for (const { entry } of made) await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry.id, comment: "redo it" });
  await api(t.baseUrl, "POST", "/api/triage/close");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return made.map((m) => ({ ...m, kids: tasks.filter((x: any) => x.parent_id === m.task.id) }));
}

it("capability の異議エントリに self RCA が propose すると、author = rca + RCA の agent で載り、tool 結果に entry id と event id が載る", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const [{ entry, kids }]: any[] = await objectedTasks(attributionClient, [{ title: "capable", cause: "capability" }]);
  const self = kids.find((x: any) => x.title === "rca (self): capable");
  await runNow(t, self.id);

  const result = await propose(t, self.id, { entry_id: entry.id });

  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const returned = body(result);
  expect(returned).toEqual({ entry_id: expect.any(Number), event_id: expect.any(Number) });
  expect(await memoryEntries(t)).toEqual([expect.objectContaining({ id: returned.entry_id, author: { activity: "rca", name: t.worker.id } })]);
});

it("propose_from_objection の拒否は tool error として返る(何を断るかは domain 層 —— tests/propose-from-objection.test.ts が言う)", async () => {
  t = await bootTidepool();
  const work = await registerWork(t, "not a review", "charts");
  await t.clock.advance(HOUR); // picked up into the slot

  expect(await propose(t, work.id, { entry_id: 999_999 })).toMatchObject({ isError: true, content: [{ text: expect.any(String) }] });
});

it("auditor RCA では author = RCA task の agent 名(auditorName の盤面)になり、settings の HTTP 一覧と管理MCP 一覧が同じ行を author の活動と cause つきで返す", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient, auditorName: "shako" });
  const [{ entry, kids }]: any[] = await objectedTasks(attributionClient, [{ title: "delegated", cause: "task_ambiguity", registrant: "tako" }]);
  const auditor = kids.find((x: any) => x.title === "rca (auditor): delegated");
  await runNow(t, auditor.id);

  const result = await propose(t, auditor.id, { entry_id: entry.id });

  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const { entry_id } = body(result);
  const listed = await memoryEntries(t);
  expect(listed).toEqual([expect.objectContaining({ id: entry_id, author: { activity: "rca", name: "shako" }, cause: "task_ambiguity" })]);

  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(body(await client.callTool({ name: "list_memory_entries", arguments: {} }))).toEqual(listed);
  } finally {
    await client.close();
  }
});
