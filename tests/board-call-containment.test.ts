import { afterEach, expect, it, vi } from "vitest";
import { enumerateHostSkills } from "../src/claude-worker.js";
import { RECLAIM_TIMEOUT } from "../src/watchdog.js";
import { FakeContainerRuntime, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, HOUR, queueWork, type Tidepool } from "./harness.js";

/** Board call の回収失敗の写像(ADR 0136 決定6 / issue #767)。whole-probe の fake を
 *  外し、実物の skill 列挙(skills ピッカーの中立 cwd 版)を fake の容器機構の上で
 *  走らせる —— 測るのは probe の中身ではなく、**空を観測できなかったときに盤面が
 *  worker session の回収失敗と同じ形で止まること**である。 */

let t: Tidepool;
afterEach(() => t?.stop());

const settle = () => new Promise((resolve) => setImmediate(resolve));

const questions = async (): Promise<any[]> =>
  (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((x: any) => x.type === "question");

const containmentQuestion = async (): Promise<any> =>
  (await questions()).find((q: any) => q.title.includes("containment"));

/** GET /api/skills を撃って、その Board call の容器を「force では空にならない」
 *  ホストに仕立て、root を exit させるところまで進める。 */
async function unreclaimedSkillEnumeration() {
  const recorder = recordingSpawn();
  const runtime = new FakeContainerRuntime(recorder.spawn);
  t = await bootTidepool({ containerRuntime: runtime, hostSkills: enumerateHostSkills });

  const pending = api(t.baseUrl, "GET", "/api/skills");
  await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));
  const container = runtime.created[0]!;
  runtime.hold(container);
  recorder.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", skills: ["tdd"] })}\n`);
  await settle();
  recorder.emitExit(0, null);

  // 中立 cwd の呼び出しの結果は root の exit で返る(待つのは workspace cwd だけ)
  expect((await pending).json).toEqual({ skills: ["tdd"], degraded: false });
  return { recorder, runtime, container };
}

it("Board call の容器が回収 timeout まで空にならなければ、盤面全体の pickup が止まり確認 question が立つ", async () => {
  const { runtime } = await unreclaimedSkillEnumeration();
  expect(await questions()).toEqual([]);

  await t.clock.advance(RECLAIM_TIMEOUT);

  const quarantine = await containmentQuestion();
  expect(quarantine.question_items[0].options).toEqual(["repaired by hand"]);
  // 文面から「Board call の容器であること」と「呼び出しの種類」が読める —— 原因が
  // worker なのか probe なのかを区別できるために(ADR 0136)
  expect(quarantine.purpose).toContain("board call");
  expect(quarantine.purpose).toContain("skill enumeration");
  // Tidepool 名義(盤面自身の判断であってエージェントの失敗ではない)
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${quarantine.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").worker_id).toBe("tidepool");

  // 停止範囲は盤面全体 —— cwd では線を引かない
  queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect(runtime.forceReclaims).toHaveLength(1);
});

it("回答時の再検査は未回収の Board call 容器を読み、まだ空でなければ回答を拒む", async () => {
  const { runtime, container } = await unreclaimedSkillEnumeration();
  await t.clock.advance(RECLAIM_TIMEOUT);
  const quarantine = await containmentQuestion();

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });

  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("skill enumeration");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${quarantine.id}`)).json.status).toBe("todo");

  // 人間が残っていた process を片付けた = 容器が空になった
  runtime.fireEmpty(container);
  await settle();

  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });

  expect(accepted.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${quarantine.id}`)).json.status).toBe("done");
  // 止まっていた pickup が再開する
  const task = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});
