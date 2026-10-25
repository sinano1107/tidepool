import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { markTeardown } from "../src/teardown.js";
import { FakeContainerRuntime } from "./fakes.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, makeWorkspace, queueWork, servedQuarantineQuestion, type Tidepool } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
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

/** `harnessContainment` を渡す盤面の pickup は人間面の自己検査(実 HTTP の往復、
 *  `src/server.ts` の Harness 封じ込めの合成)を挟むので、fake clock の tick の中では
 *  終わらない。watchdog の起点は `task_picked_up` の時刻なので、次に進める前に待つ。 */
async function pickedUp(...tasks: Array<{ id: string }>): Promise<void> {
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual(tasks.map((x) => x.id)));
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
  const task = queueWork(t, "long haul");
  await t.clock.advance(HOUR); // pickup
  containers.hold(task.id); // このホストでは force だけでは容器が空にならない

  await forceReclaimed(task);

  // 送達と同 tick でも、その後の tick でも failure question は立たず slot も動かない
  expect(await questions()).toEqual([]);
  await t.clock.advance(1 * MIN);
  const second = queueWork(t, "long haul");
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
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws, containerRuntime: containers, watchdog });
  const task = queueWork(t, "long haul");
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
  expect(events.find((e: any) => e.kind === "task_registered").actor_id).toBe("tidepool");

  // slot は解放されない。tree rule も走っていない — まだ生きているかもしれない
  // process が書いている作業ツリーを退避すること自体が競合である
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
  queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);

  // 遅れて届いた空の観測は slot を黙って解放しない — 門は確認 question だけ
  containers.fireEmpty(task.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  // pickup は開いている quarantine だけで止まるので、上の assert は slot の解放を
  // 見分けない。解放の直前に走る tree rule が作業ツリーを動かしていないことで見る
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
  // 遅れた観測は question も刷り直さない
  const after = await questions();
  expect(after.filter((q: any) => q.title.includes("watchdog killed"))).toHaveLength(1);
  expect(after.filter((q: any) => q.title.includes("containment"))).toHaveLength(1);
});

it("「今なぜ pickup が起きないか」の読み口が回収失敗を盤面全体の停止として答える", async () => {
  const containers = new FakeContainerRuntime();
  t = await bootTidepool({ containerRuntime: containers, watchdog });
  const task = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  containers.hold(task.id);

  await forceReclaimed(task);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([]);

  await t.clock.advance(RECLAIM_TIMEOUT);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([{ kind: "containment" }]);
});

it("quarantine の回答時に容器の空を再観測する — populated なら回答は拒否され question は開いたまま", async () => {
  const containers = new FakeContainerRuntime();
  t = await bootTidepool({ containerRuntime: containers, watchdog, harnessContainment: async () => ({ available: true }) });
  const task = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  await pickedUp(task);
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
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({
    workspace: ws,
    containerRuntime: containers,
    watchdog,
    harnessContainment: async () => ({ available: true }),
  });
  const task = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  await pickedUp(task);
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

  const second = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  await pickedUp(task, second);
});

it("容器機構の前提が boot 時に不成立なら、黙って弱い回収へ落ちずに pickup が止まる", async () => {
  const containers = new FakeContainerRuntime();
  containers.scriptPreflight("cgroup v2 delegation is not available on this host");
  t = await bootTidepool({ containerRuntime: containers, watchdog });

  const quarantine = await containmentQuestion();
  expect(quarantine.purpose).toContain("cgroup v2 delegation");

  queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
});

it("容器機構の前提は pickup と quarantine 回答時にも読み直される — boot 時だけの検査ではない", async () => {
  const containers = new FakeContainerRuntime();
  t = await bootTidepool({
    containerRuntime: containers,
    watchdog,
    harnessContainment: async () => ({ available: true }),
  });
  containers.scriptPreflight("cgroup v2 delegation was lost after boot");

  queueWork(t, "long haul");
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
  await vi.waitFor(() => expect(t.worker.started).toHaveLength(1));
});

it("回収 timeout のあと再起動して前提検査が通ると、回答より前に WIP が退避される —— それでも pickup は確認 question に答えるまで止まる(issue #648)", async () => {
  const containers = new FakeContainerRuntime();
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws, containerRuntime: containers, watchdog });
  const task = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  containers.hold(task.id);
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");
  await forceReclaimed(task);
  await t.clock.advance(RECLAIM_TIMEOUT);
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace: ws, watchdog, harnessContainment: async () => ({ available: true }) });
  await vi.waitFor(() => expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"));

  // 起動時の復旧が後始末を完走させた: tree rule は回答を待たずに走っている
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:draft.txt`)).toBe("stuck work");
  // 確認 question は開いたまま pickup を止める —— 門であることは pickup について変わらない
  const second = queueWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  const quarantine = await containmentQuestion();
  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(accepted.status).toBe(200);
  await t.clock.advance(HOUR);
  await pickedUp(second);
});

it("Harness 封じ込めの盤面で前提検査が落ちた再起動のあと、Harness Containment question への確認回答が後始末の印の残る session の後始末を走らせる —— 中断のタスクは todo に戻り、完走より前に次の pickup は起きない(issue #1937)", async () => {
  const ws = await makeWorkspace("sandbox");
  const harnessContainment = async () => ({ available: true }) as const;
  t = await bootTidepool({ workspace: ws, watchdog, harnessContainment });
  const task = queueWork(t, "interrupted by cap");
  queueWork(t, "next");
  await t.clock.advance(HOUR);
  await pickedUp(task);
  writeFileSync(join(ws.path, "wip.txt"), "unfinished work\n");
  // 上限到達による中断を adapter が観測した瞬間の行(tests/teardown.test.ts と同じ setup)。
  // 梯子には落ちていないので盤面全体の Containment question は無く、残るのは後始末の印だけ
  markTeardown(t.db, task.id, t.clock.now());
  await t.stopServer();

  // 前提検査が落ちた起動: 起動時の復旧は枠を握らず、盤面全体の Containment ではなく Harness ごとの question が立つ
  const restarted = new FakeContainerRuntime();
  restarted.scriptPreflight("previous session may still be alive");
  t = await bootTidepool({ dir: t.dir, workspace: ws, containerRuntime: restarted, watchdog, harnessContainment });
  const [claude, codex] = await vi.waitFor(async () => {
    const both = await Promise.all([
      servedQuarantineQuestion(t, "harnessContainment", "claude-code"),
      servedQuarantineQuestion(t, "harnessContainment", "codex"),
    ]);
    expect(both).not.toContain(undefined);
    return both;
  });
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([]);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id, settlement: "interrupted" });
  // 次に走り出す session の瞬間に、作業ツリーが清潔で WIP がタスクブランチにあるかを見る
  const atStart: Array<{ id: string; dirty: string; taskBranch: string }> = [];
  const start = t.worker.start.bind(t.worker);
  t.worker.start = (started, ...rest) => {
    atStart.push({
      id: started.id,
      dirty: git(ws.path, "status", "--porcelain"),
      taskBranch: git(ws.path, "ls-tree", "--name-only", `task/${task.id}`),
    });
    start(started, ...rest);
  };

  restarted.scriptPreflight(); // 修理済み
  for (const question of [claude, codex]) {
    const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
    expect(answered.status).toBe(200);
  }
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(atStart).toHaveLength(1));

  // 後始末が完走して todo に戻ったタスク自身が次の pickup になり、その時点で WIP はタスクブランチに退避済み
  expect(atStart[0]).toMatchObject({ id: task.id, dirty: "", taskBranch: expect.stringContaining("wip.txt") });
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
});
