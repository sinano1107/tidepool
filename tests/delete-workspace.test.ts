import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { CheckoutHostError } from "../src/git.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { contentLeftBehindLocally, createLanding, lastPushedHead, prRootIdsWithUnpushedContentInWorkspace, registerPrPromotionFailureQuestion, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import { openQuarantineQuestion, registerQuarantine, workspaceContainmentValue } from "../src/quarantine.js";
import { loadRegistry } from "../src/registry.js";
import { DeletionConfirmationRequiredError } from "../src/registry-write.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, countUnsettledTasksReferencing, getTask, registerTask } from "../src/tasks.js";
import { acceptTeardownQuarantine, markTeardown, runTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { workbenchPath } from "../src/workbench.js";
import { holdsBaseline, openHumanContentWorkbench, openIntakeQuestionId, quarantineWorkspace, releaseWorkspace, resolveExecutionWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { deleteWorkspace } from "../src/workspace-create.js";
import { awaitWindow, FakeClock, FakeGitHubClient, unusedLanding } from "./fakes.js";
import { commitWork, completionTreePaths, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeLandingWorkspace, makeWorkspace, prepareAtPickup, quarantineQuestion, sessionId, withHistoryOnlyBlob } from "./harness.js";
import {
  answerHoldOnPr,
  answerPromotion,
  commitThroughTaskCheckout,
  completeThroughTaskCheckout,
  convergeOn,
  deletionReaders,
  finish,
  giveHeadRepo,
  landingWork,
  openBoard,
  promotionFailures,
  pushOutsideBoard,
  pushPrHead,
  recordPrOpenedOutsideConvergence,
  registeredReef,
  settleRepairNotMergedBack,
  tearDownRepair,
} from "./landing-fixture.js";
import { FIXTURE_WORKSPACE, makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

/** 盤面が基準を撮った `name` の checkout。削除の参照検査にかからないようタスクは決着させておく。 */
async function sessionWithState(name: string) {
  const db = openDb(":memory:");
  const ws = await makeWorkspace(name);
  const now = new Date();
  const task = registerTask(db, { type: "work", title: "t", purpose: "why", completion_criteria: "done" }, now, ...HUMAN_WEBUI);
  cancelTaskDirectly(db, task, null, now, {}, "webui");
  const place = await prepareAtPickup(db, ws, task);
  commitWork(place.path, "work.txt", "work\n");
  return { db, ws, place, task, now };
}

type Session = Awaited<ReturnType<typeof sessionWithState>>;

/** 行の有無を production の読み手で: 基準は解放の比較が読む(無ければ違反、ADR 0064 決定6)。 */
function expectState(s: Session, kept: boolean): void {
  releaseWorkspace(s.db, s.place, s.task, s.now);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name) === undefined).toBe(kept);
}

function deletionDeps(db: Db, dir: string, workspacesBaseDir = "/workspaces") {
  const registry = { dir, mode: "purely-local" as const };
  const resolveIn = (name: string) => (taskWorkspace: string | null) => resolveExecutionWorkspace(loadRegistry(dir, registry.mode), name, taskWorkspace, workspacesBaseDir);
  return {
    db, registry, workspacesBaseDir,
    countUnsettledTasks: (name: string) => countUnsettledTasksReferencing(db, "workspace", name),
    listAwaitingLandingTaskIds: (name: string) => taskIdsAwaitingLandingInWorkspace(db, resolveIn(name), name),
    listUnpushedPrRootIds: (name: string) => prRootIdsWithUnpushedContentInWorkspace(db, resolveIn(name), name),
    listLandingInProgressTaskIds: () => [],
  };
}

describe("deleteWorkspace: workspace_state の行(ADR 0351 決定7)", () => {
  vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

  it("削除が成立すると、その name の行(基準)が無くなる", async () => {
    const s = await sessionWithState("tidepool");

    await deleteWorkspace({ name: "tidepool", confirm: true }, deletionDeps(s.db, await makeMainRegistry()));

    expectState(s, false);
  });

  it("deleting a workspace clears its pinned sparse policy before the name is reused (ADR 0351 決定7 / ADR 0356 決定3)", async () => {
    const s = await sessionWithState("tidepool");
    try {
      await deleteWorkspace({ name: "tidepool", confirm: true }, deletionDeps(s.db, await makeMainRegistry()));
      const replacement = await makeWorkspace("tidepool");
      commitWork(replacement.path, "omitted.txt", "new checkout policy\n");
      git(replacement.path, "sparse-checkout", "set", "--no-cone", "/*", "!/omitted.txt");
      const next = registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, s.now, ...HUMAN_WEBUI);

      const place = await prepareAtPickup(s.db, replacement, next);

      expect(completionTreePaths(s.db, place, next.id)).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  it("confirm なしで拒まれたとき、行はそのまま", async () => {
    const s = await sessionWithState("tidepool");

    await expect(
      deleteWorkspace({ name: "tidepool" }, deletionDeps(s.db, await makeMainRegistry())),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expectState(s, true);
  });

  it.each([
    { reason: "未決着タスク", seed: (s: Session, clock: FakeClock) => { landingWork(s.db, clock, s.ws.name); } },
    {
      reason: "着地待ち",
      seed: async (s: Session, clock: FakeClock) => {
        const task = landingWork(s.db, clock, s.ws.name);
        await completeThroughTaskCheckout(s.db, clock, s.ws, task, "landing.txt", "landing\n");
      },
    },
    { reason: "既定 workspace", defaultWorkspaceName: "tidepool" },
  ])("確認で買えない拒否($reason)のとき、行はそのまま", async ({ seed, defaultWorkspaceName }) => {
    const s = await sessionWithState("tidepool");
    await seed?.(s, new FakeClock());
    const registryDir = await makeRegistry({ "workspaces.yaml": `${s.ws.name}:\n  path: ${s.ws.path}\n` });

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        { ...deletionDeps(s.db, registryDir), defaultWorkspaceName },
      ),
    ).rejects.toMatchObject({ name: "DeletionBlockedError" });

    expectState(s, true);
  });
});

describe("deleteWorkspace: 開いた Quarantine と基準(ADR 0373 決定14)", () => {
  vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

  it.each([
    ["workspace", (s: Session) => quarantineWorkspace(s.db, "tidepool", "refs moved", s.now) && quarantineQuestion(s.db, "workspace", "tidepool")!],
    ["封じ込め", (s: Session) => {
      const value = workspaceContainmentValue("claude-code", "tidepool");
      registerQuarantine(s.db, "workspaceContainment", value, "not contained", s.now);
      return quarantineQuestion(s.db, "workspaceContainment", value)!;
    }],
  ])("基準の行を持つ名前は、その名前を名指す %s の Quarantine が開いている間は confirm があっても消せず、registry のエントリも Quarantine も残る(spec #3273 text B10)", async (_kind, open) => {
    const s = await sessionWithState("tidepool");
    const question = open(s);
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace({ name: "tidepool", confirm: true }, deletionDeps(s.db, registryDir)),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message: `workspace "tidepool" cannot be deleted: workspace "tidepool" has an open Quarantine (question ${question.id}) and a baseline — answer it first.`,
      reasons: [{ code: "open_quarantine", question_id: question.id }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
    expect(getTask(s.db, question.id)!.status).toBe("todo");
  });

  it.each([
    ["workspace", "workspace", "tidepool"],
    ["封じ込め", "workspaceContainment", workspaceContainmentValue("claude-code", "tidepool")],
  ] as const)("基準の行を持たない名前は消せ、開いていた %s の Quarantine は削除が閉じて quarantine_released を残す(ADR 0373 決定14)", async (_kind, quarantine, value) => {
    const db = openDb(":memory:");
    registerQuarantine(db, quarantine, value, "pickup failed before its first capture", new Date());
    const question = quarantineQuestion(db, quarantine, value)!;
    const registryDir = await makeMainRegistry();

    await deleteWorkspace({ name: "tidepool", confirm: true }, deletionDeps(db, registryDir));

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    expect(getTask(db, question.id)!.status).toBe("done");
    expect(listEvents(db, question.id).map(({ payload }) => payload).filter(({ kind }) => kind === "quarantine_released")).toEqual([
      { kind: "quarantine_released", quarantine, value },
    ]);
  });

  it("registry の commit の後・行を消す前に止まった盤面は、名前を戻して削除し直せば抜けられる(ADR 0373 決定14)", async () => {
    const s = await sessionWithState("tidepool");
    const registryDir = await makeMainRegistry();
    // registry の commit だけが着地した —— 行は s.db に残る
    await deleteWorkspace({ name: "tidepool", confirm: true }, deletionDeps(openDb(":memory:"), registryDir));
    git(registryDir, "-c", "user.name=test", "-c", "user.email=test@example.com", "revert", "--no-edit", "HEAD");

    await deleteWorkspace({ name: "tidepool", confirm: true }, deletionDeps(s.db, registryDir));

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    expectState(s, false);
  });
});

describe("deleteWorkspace: 正常系(issue #205 / ADR 0087 決定1・決定4)", () => {
  it("workspaces.yaml からエントリを除去するコミットが着地し、残る checkout の場所を返す", async () => {
    const registryDir = await makeMainRegistry();

    const checkout = await deleteWorkspace(
      { name: "tidepool", confirm: true },
      deletionDeps(openDb(":memory:"), registryDir),
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("delete workspace tidepool via WebUI");
    // ADR 0087 決定4: ホスト上の checkout は触らない —— 応答が場所を名指しする
    expect(checkout).toBe(FIXTURE_WORKSPACE);
  });
});

describe("deleteWorkspace: 確認の門(issue #205 / ADR 0087)", () => {
  it("confirm なしの削除要求は拒まれ、エントリは残る", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      deleteWorkspace(
        { name: "tidepool" },
        deletionDeps(openDb(":memory:"), registryDir),
      ),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("deleteWorkspace: 確認で買えない拒否(ADR 0087 決定2/3)", () => {
  it("未決着タスクが参照していると confirm があっても消せず、件数が理由に載る", async () => {
    const registryDir = await makeMainRegistry();
    const db = openDb(":memory:");
    const now = new Date();
    for (const title of ["First task", "Second task", "Third task"]) {
      registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace: "tidepool" }, now, ...HUMAN_WEBUI);
    }

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        deletionDeps(db, registryDir),
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "unsettled_tasks", count: 3 }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
  });

  it("この workspace で着地を待つ完了タスクがあると confirm があっても消せず、件数が理由に載る(ADR 0226)", async () => {
    const db = openDb(":memory:");
    const ws = await makeWorkspace("tidepool");
    const registryDir = await makeRegistry({ "workspaces.yaml": `${ws.name}:\n  path: ${ws.path}\n` });
    const clock = new FakeClock();
    const first = await completeThroughTaskCheckout(db, clock, ws, landingWork(db, clock, ws.name), "first.txt", "first\n");
    const second = await completeThroughTaskCheckout(db, clock, ws, landingWork(db, clock, ws.name), "second.txt", "second\n");

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        deletionDeps(db, registryDir),
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message: `workspace "tidepool" cannot be deleted: 2 completed task(s) still await landing through it: ${first.id}, ${second.id}`,
      reasons: [{ code: "tasks_awaiting_landing", count: 2, task_ids: [first.id, second.id] }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
  });

  it("盤面の既定 workspace は confirm があっても消せない", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        {
          ...deletionDeps(openDb(":memory:"), registryDir),
          defaultWorkspaceName: "tidepool",
        },
      ),
    ).rejects.toMatchObject({ name: "DeletionBlockedError", reasons: [{ code: "board_default" }] });
  });

  it("profile の allowed_workspaces に列挙されているだけの workspace は消せる(ADR 0087 決定2)", async () => {
    const registryDir = await makeRegistry({
      "authority/standard.yaml":
        "guidance: lists tidepool as an allowed workspace\nassignable_to: []\nallowed_workspaces:\n  - tidepool\nmerge: escalate\n",
    });
    git(registryDir, "branch", "-M", "main");

    await deleteWorkspace(
      { name: "tidepool", confirm: true },
      deletionDeps(openDb(":memory:"), registryDir),
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    // 掃除は不要 —— 許可先が1つ消えるだけで無害である
    expect(
      loadRegistry(registryDir, "purely-local").authority.standard?.allowed_workspaces,
    ).toEqual(["tidepool"]);
  });

  // ADR 0377 決定8: registry clone を拒む削除の項は消えた —— 手で足した registry clone の entry は削除の扉で外せる(spec #3273 text E1 の出口)
  it("registry clone を名指す手書きの entry は消せて、registry clone はそのまま残る", async () => {
    const registryDir = await makeMainRegistry();
    writeFileSync(join(registryDir, "workspaces.yaml"), `registry:\n  path: ${registryDir}\n`);
    git(registryDir, "add", "-A");
    git(registryDir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "name the registry clone by hand");

    await expect(
      deleteWorkspace(
        { name: "registry", confirm: true },
        deletionDeps(openDb(":memory:"), registryDir),
      ),
    ).resolves.toBe(registryDir);
    expect(loadRegistry(registryDir, "purely-local").workspaces.registry).toBeUndefined();
  });
});

describe("deleteWorkspace: 盤面がその名前でまだ運ぶものを持つ間は拒む(ADR 0421 決定4)", () => {
  vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

  /** `reef` に登録した checkout で PR #1 を開いた `external` の根。`door` は本物の読み口(収束の印も)で削除の扉を叩く。 */
  async function reefWithPrRoot() {
    const { db, clock } = await openBoard();
    const { workspace: old } = await makeLandingWorkspace("reef-old");
    const reef = await registeredReef(old);
    giveHeadRepo(db, reef, old.head_repo!);
    const github = new FakeGitHubClient();
    const workspace = reef.resolve("reef");
    const work = landingWork(db, clock, "reef");
    await commitThroughTaskCheckout(db, clock, workspace, work, "feature.txt", "ready\n");
    const root = finish(db, clock, work);
    const head = pushPrHead(github, workspace, root.id, 1);
    recordPrOpenedOutsideConvergence(db, root, 1, clock.now(), { authority: { merge: "external" }, head, workspace });
    const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github });
    const door = () => deleteWorkspace({ name: "reef", confirm: true }, { ...reef.admin, db, ...deletionReaders(db, reef.resolve, landing) });
    /** 根の修理子を merge back まで済ませる(後始末の印は立てない)。 */
    const mergedBackRepair = async () => tearDownRepair(db, clock, workspace, await settleRepairNotMergedBack(db, clock, workspace, root.id));
    /** push の失敗 question に断念と答える —— 収束はこの根に何もしなくなる(ADR 0225)。 */
    const abandon = async () => {
      registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
      await answerPromotion(db, clock, landing, workspace, promotionFailures(db, root.id)[0]!, "abandon promotion");
    };
    return { db, clock, reef, workspace, github, landing, root, head, door, mergedBackRepair, abandon };
  }

  /** 根の修理子を完了させ、後始末の印を立てて枠を後始末に入れる —— merge back はまだ撃っていない。`teardown` が本物の後始末を撃つ。 */
  async function repairInTeardown(r: Awaited<ReturnType<typeof reefWithPrRoot>>, resolve: TeardownDeps["resolve"] = r.reef.resolve) {
    const repair = await settleRepairNotMergedBack(r.db, r.clock, r.workspace, r.root.id);
    const slot = new Slot();
    slot.occupy(repair.id, sessionId(r.db, repair.id));
    markTeardown(r.db, repair.id, r.clock.now());
    slot.enterTeardown();
    const deps: TeardownDeps = { db: r.db, clock: r.clock, slot, resolve, pollNow: () => {} };
    return { repair, deps, teardown: () => runTeardown(deps, repair.id, teardownStep(r.db, repair.id)) };
  }

  it("後始末の済んでいない完了 task と、収束がまだ push する内容を持つ PR の根を名指して拒み、後始末と push を待てば通る", async () => {
    const r = await reefWithPrRoot();
    const { repair, teardown } = await repairInTeardown(r);

    const unpushed = `PR root task(s) ${r.root.id} hold content the board has not pushed to their PR yet — wait for the board to push it, or answer its open PR promotion question`;
    await expect(r.door()).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message:
        `workspace "reef" cannot be deleted: completed task(s) ${repair.id} have not finished their teardown, which merges their work back — ` +
        `wait for it to finish (a failed teardown finishes once its Quarantine is answered); ${unpushed}`,
      reasons: [{ code: "teardown_unfinished", task_ids: [repair.id] }, { code: "unpushed_pr_content", task_ids: [r.root.id] }],
    });
    await teardown();
    await expect(r.door()).rejects.toMatchObject({
      message: `workspace "reef" cannot be deleted: ${unpushed}`,
      reasons: [{ code: "unpushed_pr_content", task_ids: [r.root.id] }],
    });
    await r.landing.converge();
    expect(r.github.pushes.map(({ branch }) => branch)).toEqual([`task/${r.root.id}`]);

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });

  it("後始末が落ちた task で拒まれた削除は、その Quarantine に答えた後に通る", async () => {
    const r = await reefWithPrRoot();
    await r.abandon();
    let broken = true;
    const { repair, deps, teardown } = await repairInTeardown(r, (name) => {
      if (broken) throw new Error("resolve exploded");
      return r.reef.resolve(name);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await teardown();
    const question = getTask(r.db, openQuarantineQuestion(r.db, "failedTeardown", repair.id)!.id)!;

    await expect(r.door()).rejects.toMatchObject({ reasons: [{ code: "teardown_unfinished", task_ids: [repair.id] }] });
    broken = false;
    await submitAnswer(
      { db: r.db, pollNow() {}, landing: r.landing, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: r.db, teardownQuarantine: (id) => acceptTeardownQuarantine(deps, id) }) },
      question,
      ["repaired by hand"],
      undefined,
      () => r.clock.now(),
      "webui",
    );

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });

  it("push の失敗に断念と答えた PR の根は、push していない内容を持っていても拒まない", async () => {
    const r = await reefWithPrRoot();
    await r.mergedBackRepair();
    r.github.preparePush = async () => {
      throw new Error("push rejected");
    };
    await r.landing.converge();
    await answerPromotion(r.db, r.clock, r.landing, r.workspace, promotionFailures(r.db, r.root.id)[0]!, "abandon promotion");
    expect(contentLeftBehindLocally(r.db, r.workspace, r.root.id, lastPushedHead(r.db, r.root.id))).not.toEqual([]);

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });

  // ADR 0394 決定6・7: 書き換えの head を hold した根に収束は push しない —— 待っても通らない拒否にしない
  it("盤面の外で書き換えられた head の merge question に hold と答えた PR の根は、push していない内容を持っていても拒まない", async () => {
    const r = await reefWithPrRoot();
    await r.mergedBackRepair();
    await pushOutsideBoard(r.workspace, r.root.id, `${r.head}~1`);
    expect(await convergeOn(r.landing, r.root.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
    await answerHoldOnPr(r);
    expect(await convergeOn(r.landing, r.root.id)).toMatchObject({ kind: "awaiting_held_question" });

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });

  it("名前の場所に根のブランチが無いとき、push する内容を数えずに通す", async () => {
    const r = await reefWithPrRoot();
    await r.mergedBackRepair();
    git(r.workspace.path, "branch", "-D", `task/${r.root.id}`);

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });

  it("根に処理中の印だけが付いている間は根を名指して拒み、印が放されれば通る", async () => {
    const r = await reefWithPrRoot();
    const release = r.landing.takeInFlightMark(r.root.id)!;

    await expect(r.door()).rejects.toMatchObject({
      message: `workspace "reef" cannot be deleted: the board is landing task(s) ${r.root.id} right now — try again in a moment`,
      reasons: [{ code: "landing_in_progress", task_ids: [r.root.id] }],
    });
    release();

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });

  it("収束がその名前の根を着地させている間は根を名指して拒み、執行が終われば通る", async () => {
    const r = await reefWithPrRoot();
    await r.mergedBackRepair();
    const window = awaitWindow();
    const prepare = r.github.preparePush.bind(r.github);
    r.github.preparePush = async (input) => {
      await window.hold();
      return prepare(input);
    };
    const converging = r.landing.converge();
    await window.entered;

    await expect(r.door()).rejects.toMatchObject({
      message: expect.stringContaining(`the board is landing task(s) ${r.root.id} right now`),
      reasons: [{ code: "unpushed_pr_content", task_ids: [r.root.id] }, { code: "landing_in_progress", task_ids: [r.root.id] }],
    });
    window.open();
    await converging;

    await expect(r.door()).resolves.toBe(r.workspace.path);
  });
});

describe("deleteWorkspace: 人間自身の内容の作業台と intake question(ADR 0382 決定5 / spec #3273 text A15)", () => {
  vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

  /** registry に登録した purely-local の workspace に `open_workbench` を撃った盤面。 */
  async function openedWorkbench(seed?: (ws: WorkspaceConfig) => void) {
    const db = openDb(":memory:");
    const ws = await makeWorkspace("intake");
    seed?.(ws);
    const base = await tempDir("tidepool-workbenches-");
    const registryDir = await makeRegistry({ "workspaces.yaml": `${ws.name}:\n  path: ${ws.path}\n` });
    git(registryDir, "branch", "-M", "main");
    await openHumanContentWorkbench(db, ws, base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, () => new Date(), { resolveRegistered: undefined });
    const question = getTask(db, openIntakeQuestionId(db, ws.name)!)!;
    const workbench = realpathSync(workbenchPath(base, { workspace: ws.name }));
    const deps = () => deletionDeps(db, registryDir, base);
    const answer = (option: string, asked = question) =>
      submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, workspace: ws, workspacesDir: base }, asked, [option], undefined, () => new Date(), "webui");
    const close = () => answer("close");
    const reopen = async () => {
      await openHumanContentWorkbench(db, ws, base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, () => new Date(), { resolveRegistered: undefined });
      return getTask(db, openIntakeQuestionId(db, ws.name)!)!;
    };
    return { db, ws, registryDir, question, workbench, deps, close, answer, reopen };
  }

  it("intake question が開いている間は、未決着の理由に `close` の手を足して拒む", async () => {
    const o = await openedWorkbench();

    await expect(deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps())).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message: `workspace "${o.ws.name}" cannot be deleted: 1 unsettled task(s) still reference it. Answer \`close\` on question ${o.question.id} first.`,
      reasons: [{ code: "unsettled_tasks", count: 1, intake_question: o.question.id }],
    });
    expect(loadRegistry(o.registryDir, "purely-local").workspaces[o.ws.name]).toBeDefined();
  });

  it("作業台に取り込まれていない commit があれば拒み、無くなれば削除が作業台を消す", async () => {
    const o = await openedWorkbench();
    await o.close();
    commitWork(o.workbench, "notes.txt", "the human's\n");

    await expect(deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps())).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message:
        `workspace "${o.ws.name}" cannot be deleted: the workbench at ${o.workbench} holds work that main does not have — ` +
        "take it in (`open_workbench`, then `take in`) or remove the workbench by hand first",
      reasons: [{ code: "human_content_workbench", workbench: o.workbench, branch: "main" }],
    });
    expect(existsSync(o.workbench)).toBe(true);

    git(o.workbench, "reset", "--quiet", "--hard", "board/main");
    await deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps());

    expect(loadRegistry(o.registryDir, "purely-local").workspaces[o.ws.name]).toBeUndefined();
    expect(existsSync(o.workbench)).toBe(false);
  });

  it("作業台を消せなければ参照の拒否にせずそのまま投げ、entry も基準の行も残す(issue #3625)", async () => {
    const o = await openedWorkbench();
    await o.close();
    expect(holdsBaseline(o.db, o.ws.name)).toBe(true);
    const parent = dirname(o.workbench);
    chmodSync(parent, 0o555);
    try {
      await expect(deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps())).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(loadRegistry(o.registryDir, "purely-local").workspaces[o.ws.name]).toBeDefined();
    expect(holdsBaseline(o.db, o.ws.name)).toBe(true);
  });

  it("名前の場所の checkout が読めなければ、作業台を消せとは言わず checkout を名指して拒み、作業台を残す", async () => {
    const o = await openedWorkbench();
    await o.close();
    rmSync(o.ws.path, { recursive: true, force: true });

    const refused = deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps());

    await expect(refused).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "human_content_workbench", workbench: o.workbench, branch: "main", unreadable: { place: o.ws.path } }],
    });
    await expect(refused).rejects.toThrow(
      `the board cannot read the workspace's checkout at ${o.ws.path} (`,
    );
    await expect(refused).rejects.toThrow(`so it cannot tell whether the workbench at ${o.workbench} holds work that main does not have — repair the checkout first`);
    expect(existsSync(o.workbench)).toBe(true);
  });

  // #3589: 作業台は閉包を全部持つ複製 —— 名前の場所の履歴にだけある blob を作業台は自前に持ち、検証は名前の場所の損傷と混ざらない(ADR 0411 決定2・4)
  it.each(["missing", "corrupt"] as const)("作業台の未取り込みの commit が名前の場所の履歴にだけある blob を復元していて、その blob が名前の場所で %s でも、削除の扉は作業台を読めないとは言わず取り込むよう言い、取り込めば削除が通る(ADR 0411 決定2・4、#3589)", async (damage) => {
    const o = await openedWorkbench(withHistoryOnlyBlob);
    await o.close();
    git(o.workbench, "checkout", "--quiet", "HEAD~1", "--", "old.txt");
    git(o.workbench, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "restore old.txt");
    const blob = git(o.workbench, "rev-parse", "HEAD:old.txt");
    const loose = join(o.ws.path, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    rmSync(loose);
    if (damage === "corrupt") writeFileSync(loose, "not zlib");

    await expect(deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps())).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message:
        `workspace "${o.ws.name}" cannot be deleted: the workbench at ${o.workbench} holds work that main does not have — ` +
        "take it in (`open_workbench`, then `take in`) or remove the workbench by hand first",
      reasons: [{ code: "human_content_workbench", workbench: o.workbench, branch: "main" }],
    });

    await o.answer("take in", await o.reopen());
    await deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps());
    expect(existsSync(o.workbench)).toBe(false);
  });

  it("名前の場所の値との比較が名前の場所の欠けで落ちれば、作業台を消せとは言わず名前の場所を名指して拒み、作業台を残す(ADR 0411 決定2・3)", async () => {
    const o = await openedWorkbench();
    await o.close();
    commitWork(o.workbench, "notes.txt", "the human's\n");
    // 名前の場所の main が作業台の tip の閉包に無い commit を2つ積み、古いほうを欠く —— 作業台の tip が main に含まれるかを比べる手が読む
    commitWork(o.ws.path, "first.txt", "first\n");
    const first = git(o.ws.path, "rev-parse", "HEAD");
    commitWork(o.ws.path, "second.txt", "second\n");
    rmSync(join(o.ws.path, ".git", "objects", first.slice(0, 2), first.slice(2)));

    const refused = deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps());

    await expect(refused).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "human_content_workbench", workbench: o.workbench, branch: "main", unreadable: { place: o.ws.path } }],
    });
    await expect(refused).rejects.toThrow(`so it cannot tell whether the workbench at ${o.workbench} holds work that main does not have — repair the checkout first`);
    await expect(refused).rejects.not.toThrow("remove it by hand");
    expect(existsSync(o.workbench)).toBe(true);
  });

  /** 作業台そのものが読めない削除の拒否: 作業台を名指して手で消すよう言い、作業台を残す。 */
  async function expectWorkbenchUnreadable(o: Awaited<ReturnType<typeof openedWorkbench>>) {
    const refused = deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps());

    await expect(refused).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "human_content_workbench", workbench: o.workbench, branch: "main", unreadable: { place: o.workbench } }],
    });
    await expect(refused).rejects.toThrow(`the board cannot read the workbench at ${o.workbench} (`);
    await expect(refused).rejects.toThrow("); remove it by hand first");
    expect(existsSync(o.workbench)).toBe(true);
  }

  it("検証の段で作業台が読めなければ、作業台を名指して手で消すよう言い、作業台を残す", async () => {
    const o = await openedWorkbench();
    await o.close();
    const ref = join(o.workbench, ".git", "refs", "heads", "main");
    rmSync(ref);
    mkdirSync(ref);

    await expectWorkbenchUnreadable(o);
  });

  it("判定が作業台に撃つ git で作業台が読めなければ、作業台を名指して手で消すよう言い、作業台を残す", async () => {
    const o = await openedWorkbench();
    await o.close();
    writeFileSync(join(o.workbench, ".git", "config"), "not a config\n");

    await expectWorkbenchUnreadable(o);
    // 括弧の中は git の失敗だけ —— 作業台の名指しを重ねない
    await expect(deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps())).rejects.not.toThrow(`(the workbench at ${o.workbench} cannot be read`);
  });

  it("作業台でも名前の場所でもない失敗(盤面の写しの host)は参照の拒否にせずそのまま投げ、entry も作業台も残す", async () => {
    const o = await openedWorkbench();
    await o.close();
    vi.stubEnv("TMPDIR", join(o.workbench, "no-such-tmp"));
    try {
      const failed = deleteWorkspace({ name: o.ws.name, confirm: true }, o.deps());

      await expect(failed).rejects.toThrow(CheckoutHostError);
      await expect(failed).rejects.not.toMatchObject({ name: "DeletionBlockedError" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(loadRegistry(o.registryDir, "purely-local").workspaces[o.ws.name]).toBeDefined();
    expect(existsSync(o.workbench)).toBe(true);
  });
});
