import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FakeContainerRuntime } from "./fakes.js";
import { api, bootTidepool, git, HOUR, makeWorkspace, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MIN = 60 * 1000;
const WORK_LIMIT = 90 * MIN;
const GRACE = 30 * MIN;
const RECLAIM_TIMEOUT = 5 * MIN;

const watchdog = { timeLimits: { work: WORK_LIMIT }, grace: GRACE, reclaimTimeout: RECLAIM_TIMEOUT };

/** リミット到達 → 猶予 → 強制回収まで進める。容器は空になっていない。 */
async function forceReclaimed(task: { id: string }): Promise<void> {
  await t.clock.advance(90 * MIN); // 畳み込み停止
  await t.clock.advance(GRACE); // 強制回収
  expect(t.containers.forceReclaims).toEqual([task.id]);
}

const questions = async (): Promise<any[]> =>
  (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((x: any) => x.type === "question");

const containmentQuestion = async (): Promise<any> =>
  (await questions()).find((q: any) => q.title.includes("containment"));

it("強制回収の送達では slot は解放されない — 解放するのは容器が空になった観測である", async () => {
  const containers = new FakeContainerRuntime();
  // ここで測るのは「送達では解放しない / 空の観測で解放する」だけなので、回収
  // timeout は十分遠くに置く(timeout 側の挙動は次のテストが測る)
  t = await bootTidepool({
    containerRuntime: containers,
    watchdog: { ...watchdog, reclaimTimeout: 10 * HOUR },
  });
  const task = await registerWork(t, "long haul");
  await t.clock.advance(HOUR); // pickup
  containers.hold(task.id); // このホストでは force だけでは容器が空にならない

  await forceReclaimed(task);

  // 送達と同 tick でも、その後の tick でも failure question は立たず slot も動かない
  expect(await questions()).toEqual([]);
  await t.clock.advance(1 * MIN);
  const second = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);

  // 空になった signal が届いて初めて failure question と slot 解放へ進む
  containers.fireEmpty(task.id);
  await t.clock.advance(1 * MIN);
  expect((await questions())[0].question_items[0].options).toContain("retry");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, second.id]);
});

it("回収 timeout では failure question は立つが slot は解放されず、Containment quarantine の確認 question が立つ", async () => {
  const containers = new FakeContainerRuntime();
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws, containerRuntime: containers, watchdog });
  const task = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  containers.hold(task.id);
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");

  await forceReclaimed(task);
  await t.clock.advance(RECLAIM_TIMEOUT);

  // 失敗の記録は残る
  const failure = (await questions()).find((q: any) => q.title.includes("watchdog killed"));
  expect(failure.question_items[0].options).toContain("retry");
  expect(failure.purpose).toMatch(/could not observe the container going empty/);
  // 解放の門は確認 question ただ1枚(1資源1枚の既存規律)
  const quarantine = await containmentQuestion();
  expect(quarantine.question_items[0].options).toEqual(["repaired by hand"]);
  expect(quarantine.purpose).toContain(task.id);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${quarantine.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").worker_id).toBe("tidepool");

  // slot は解放されない。tree rule も走っていない — まだ生きているかもしれない
  // process が書いている作業ツリーを退避すること自体が競合である
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
  await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);

  // 遅れて届いた空の観測は slot を黙って解放しない — 門は確認 question だけ
  containers.fireEmpty(task.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("「今なぜ pickup が起きないか」の読み口が回収失敗を盤面全体の停止として答える", async () => {
  const containers = new FakeContainerRuntime();
  t = await bootTidepool({ containerRuntime: containers, watchdog });
  const task = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  containers.hold(task.id);

  await forceReclaimed(task);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([]);

  await t.clock.advance(RECLAIM_TIMEOUT);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([{ kind: "containment" }]);
});

it("quarantine の回答時に容器の空を再観測する — populated なら回答は拒否され question は開いたまま", async () => {
  const containers = new FakeContainerRuntime();
  t = await bootTidepool({ containerRuntime: containers, watchdog });
  const task = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  containers.hold(task.id);
  await forceReclaimed(task);
  await t.clock.advance(RECLAIM_TIMEOUT);

  const quarantine = await containmentQuestion();
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(task.id);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${quarantine.id}`)).json.status).toBe("todo");
});

it("空を観測してから回答すると受理され、slot-release tree rule が走って slot が解放される", async () => {
  const containers = new FakeContainerRuntime();
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws, containerRuntime: containers, watchdog });
  const task = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  containers.hold(task.id);
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");
  await forceReclaimed(task);
  await t.clock.advance(RECLAIM_TIMEOUT);

  // 人間が手で残存 process を片付けた = 容器の空が観測できるようになった
  containers.fireEmpty(task.id);
  const quarantine = await containmentQuestion();
  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(accepted.status).toBe(200);

  // 解放の瞬間に tree rule が走る(WIP はタスクブランチへ退避され、ツリーは清潔)
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:draft.txt`)).toBe("stuck work");

  const second = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, second.id]);
});

it("容器機構の前提が boot 時に不成立なら、黙って弱い回収へ落ちずに pickup が止まる", async () => {
  const containers = new FakeContainerRuntime();
  containers.scriptPreflight("cgroup v2 delegation is not available on this host");
  t = await bootTidepool({ containerRuntime: containers, watchdog });

  const quarantine = await containmentQuestion();
  expect(quarantine.purpose).toContain("cgroup v2 delegation");

  await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
});

it("容器機構の前提は pickup と quarantine 回答時にも読み直される — boot 時だけの検査ではない", async () => {
  const containers = new FakeContainerRuntime();
  t = await bootTidepool({
    containerRuntime: containers,
    watchdog,
    resolveHarness: () => "claude-code",
    harnessContainment: async () => ({ available: true }),
  });
  containers.scriptPreflight("cgroup v2 delegation was lost after boot");

  await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  const quarantine = await containmentQuestion();
  expect(quarantine.purpose).toContain("delegation was lost");

  // 前提が壊れたままの回答は拒否される(検査を回答時にもう一度走らせる)
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("delegation was lost");

  containers.scriptPreflight(); // 修理済み
  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(accepted.status).toBe(200);

  // 受理で pickup が再開する
  await t.clock.advance(HOUR);
  expect(t.worker.started).toHaveLength(1);
});
