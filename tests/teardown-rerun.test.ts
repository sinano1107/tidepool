import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { checkoutPickupPredicates } from "../src/pickup-predicates.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, listBoard, pickupTask, registerTask } from "../src/tasks.js";
import { acceptTeardownQuarantine, markTeardown, resumeUnfinishedTeardown, runTeardown, sessionInTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { firePickupPredicates, type RunPlace, recordTaskCheckoutTip, releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import {
  commitWork,

  FULL_HANDOFF,
  failGitCommits,
  failTeardownMark,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  prepareAtPickup,
  quarantineQuestion,
  sessionId,
  WORKER_SPAWNED,
} from "./harness.js";

// 後始末の再実行(ADR 0345): tree rule を通った後にもう1度撃つ経路の振る舞い。ADR 0356 の後、worker は task の checkout で走り、
// 名前の場所の HEAD は保護ブランチを離れない —— 再実行は開いた event と checkout の有無から残りを決める。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 未決着の親の work を登録し、そのタスクブランチを main から立てる —— 子はそこへ merge back する。 */
function registerParentWithBranch(db: Db, ws: WorkspaceConfig, now: Date): string {
  const { id } = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, now, ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${id}`, "main");
  return id;
}

/** 親のブランチに `work.txt` の別の内容を commit し、子は main から分ける —— 子の merge back は conflict する。 */
function conflictOnParentBranch(ws: WorkspaceConfig, parentBranch: string, taskId: string): void {
  git(ws.path, "checkout", parentBranch);
  commitWork(ws.path, "work.txt", "conflicting\n");
  git(ws.path, "checkout", "main");
  git(ws.path, "branch", `task/${taskId}`, "main");
}

/** pickup の準備まで済み、worker が task の checkout で `work.txt` を1つ commit して決着した session。完了なら完了の門が tip を
 *  名前の場所へ引いてある。`work` は決着の前に task の checkout で撃つ。枠を握って後始末の印が立っている。 */
async function settledSession(
  settle: "completed" | "interrupted",
  { workspace, parent, work }: { workspace?: WorkspaceConfig; parent?: "delivers" | "conflicts"; work?: (checkout: string) => void } = {},
) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = workspace ?? (await makeWorkspace("teardown-rerun"));
  const parentId = parent && registerParentWithBranch(db, ws, clock.now());
  const registered = registerTask(db, { type: "work", title: "rerun", purpose: "why", completion_criteria: "done", parent_id: parentId }, clock.now(), ...HUMAN_WEBUI);
  if (parent === "conflicts") conflictOnParentBranch(ws, `task/${parentId}`, registered.id);
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, ws, task, { now: clock.now() });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  commitWork(place.path, "work.txt", "work\n");
  work?.(place.path);
  if (settle === "completed") {
    recordTaskCheckoutTip(db, place, task.id);
    completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  }
  markTeardown(db, task.id, clock.now());
  const slot = new Slot();
  slot.occupy(task.id, sessionId(db, task.id));
  slot.enterTeardown();
  const deps: TeardownDeps = { db, clock, slot, resolve: () => ws, pollNow: () => {} };
  return { db, clock, ws, place, task, slot, deps, branch: `task/${task.id}`, parentBranch: `task/${parentId}` };
}

type Session = Awaited<ReturnType<typeof settledSession>>;

/** tree rule は返り、状態遷移と印を消す tx だけが落ちた後始末(落ちた後始末の question が1枚立つ)。 */
async function teardownThrewAfterTreeRule(s: Session): Promise<void> {
  const repair = failTeardownMark(s.db);
  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));
  repair();
}

/** 再起動で枠の in-memory は消える。 */
const restarted = (s: Session): TeardownDeps => ({ ...s.deps, slot: new Slot() });

const head = (s: Session) => git(s.ws.path, "rev-parse", "--abbrev-ref", "HEAD");
const release = (s: Session, place: RunPlace = s.place) => releaseWorkspace(s.db, place, getTask(s.db, s.task.id)!, s.clock.now());

function expectCleanRerun(s: Session, deps: TeardownDeps, status: string): void {
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(deps.slot.currentTaskId).toBeNull();
  expect(getTask(s.db, s.task.id)?.status).toBe(status);
  expect(sessionInTeardown(s.db)).toBeUndefined();
  expect(head(s)).toBe("main");
  expect(existsSync(s.place.path)).toBe(false);
}

it.each([
  ["完了、process が生きたままの受理", "completed", "done", false],
  ["上限到達による中断、process が生きたままの受理", "interrupted", "todo", false],
  ["完了、再起動を跨いだ受理", "completed", "done", true],
  ["上限到達による中断、再起動を跨いだ受理", "interrupted", "todo", true],
] as const)("tree rule を通った後の tx で落ちた後始末を受理すると、偽の workspace Quarantine を立てずに枠が空く —— %s(ADR 0345 決定3)", async (_, settle, status, restart) => {
  const s = await settledSession(settle);
  await teardownThrewAfterTreeRule(s);
  const deps = restart ? restarted(s) : s.deps;

  await acceptTeardownQuarantine(deps, s.task.id);

  expectCleanRerun(s, deps, status);
});

// 旧: pickup が HEAD をタスクブランチへ動かし、基準の HEAD 行は休止で保護ブランチへ畳まれた(ADR 0345 決定2)
it("名前の場所の基準の HEAD 行は refname 順の先頭で、pickup の後も解放の後も保護ブランチを指す(ADR 0345 決定2 / ADR 0356 決定1)", async () => {
  const s = await settledSession("interrupted");
  const baseline = () => (s.db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(s.ws.name) as string).split("\n");
  expect(baseline()[0]).toBe("symref=refs/heads/main HEAD");
  expect(baseline()[1]).toMatch(/ refs\//);

  release(s);

  expect(baseline()[0]).toBe("symref=refs/heads/main HEAD");
});

it("完了の tree rule の後に question も無く落ちた盤面の次の起動の復旧は、偽の workspace Quarantine を立てずに枠が空く(ADR 0345 決定3)", async () => {
  const s = await settledSession("completed");
  releaseWorkspace(s.db, s.place, getTask(s.db, s.task.id)!, s.clock.now(), true, undefined, undefined, true);
  const deps = restarted(s);

  await resumeUnfinishedTeardown(deps);

  expectCleanRerun(s, deps, "done");
});

// 旧: worker がタスクブランチを離れていると commit を拒んで quarantine に落ちた(#234 ケース1)
it.each([
  ["別のブランチ", (checkout: string) => git(checkout, "checkout", "-b", "elsewhere")],
  ["detached HEAD", (checkout: string) => git(checkout, "checkout", "--detach")],
] as const)("worker が task の checkout で別の位置(%s)に居たまま終わっても、盤面はタスクブランチ1本を読み、残したものはその上の WIP に載る(ADR 0356 決定4)", async (_, wander) => {
  const s = await settledSession("interrupted");
  wander(s.place.path);
  writeFileSync(join(s.place.path, "left.txt"), "left behind\n");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(git(s.ws.path, "show", `${s.branch}:left.txt`)).toBe("left behind");
  expect(head(s)).toBe("main");
});

// 旧: 基準の行が無い workspace の HEAD は盤面が動かしたと読まず commit を拒んだ(ADR 0345 決定3)。ADR 0356 決定2 の後、解放を
// 刻んだ再実行は削除だけを撃つので、基準を失うのは解放より前
it("基準の行を失った名前の場所の解放は、動いていない ref も違反と読んで quarantine に落ちる(fail-closed、ADR 0064 決定6 / ADR 0356 決定4)", async () => {
  const s = await settledSession("completed");
  s.db.exec("DELETE FROM workspace_state");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain("changed during the session");
});

// 旧: 盤面が HEAD を動かした後の名前の場所への書き込みを再実行が quarantine にした(ADR 0345 決定3)。worker はもう名前の場所で
// 走らないので、休止中の書き込みは次の pickup の休止検査が止める
it("解放の後の名前の場所への書き込みは再実行では読まず、次の pickup の休止検査が止める(ADR 0351 決定5 / ADR 0356 決定1)", async () => {
  const s = await settledSession("completed");
  await teardownThrewAfterTreeRule(s);
  writeFileSync(join(s.ws.path, "late.txt"), "written by a process that outlived the board\n");

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  const next = registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, s.clock.now(), ...HUMAN_WEBUI);
  await expect(prepareAtPickup(s.db, s.ws, next)).rejects.toThrow("?? late.txt");
});

// 旧: タスクブランチだけが無視する生成物は HEAD を動かす前に消した(ADR 0352 決定1・5)
it("タスクブランチが無視する生成物は task の checkout と一緒に消え、名前の場所に届かず、再実行も Quarantine 無しで完了する(ADR 0356 決定2)", async () => {
  const s = await settledSession("interrupted", {
    work: (checkout) => {
      commitWork(checkout, ".gitignore", "build/\n");
      mkdirSync(join(checkout, "build"));
      writeFileSync(join(checkout, "build", "out.txt"), "generated\n");
    },
  });
  await teardownThrewAfterTreeRule(s);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(git(s.ws.path, "ls-tree", "-r", "--name-only", s.branch)).not.toContain("build/out.txt");

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "todo");
  expect(existsSync(join(s.ws.path, "build"))).toBe(false);
});

// 旧: 盤面が休止させた後に名前の場所に書かれた shadow 残骸を数えなかった(ADR 0069 / ADR 0345 決定3)
it("task の checkout の shadow 残骸は完了の後の書き込みに数えない(ADR 0069 / ADR 0356 決定3)", async () => {
  const s = await settledSession("completed");
  writeFileSync(join(s.place.path, ".bashrc"), "");
  await teardownThrewAfterTreeRule(s);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
});

/** 再実行が同じ観測に着いても question は最初の登録の1枚のまま、何も足さない(ADR 0366 決定1)。 */
function expectOneQuestionUnchanged(s: Session, reason: string): void {
  const question = quarantineQuestion(s.db, "workspace", s.ws.name)!;
  expect(listBoard(s.db).filter((t) => t.title === question.title).map((t) => t.id)).toEqual([question.id]);
  expect(question.purpose).toContain(reason);
  expect(listEvents(s.db, question.id).map((e) => e.kind)).toEqual(["task_registered"]);
  expect(s.deps.slot.currentTaskId).toBeNull();
}

function expectLateWriteRecorded(s: Session, deps: TeardownDeps): void {
  expectCleanRerun(s, deps, "done");
  expect(listEvents(s.db, s.task.id).map(({ payload }) => payload).filter(({ kind }) => kind === "task_checkout_written_after_completion")).toEqual([
    { kind: "task_checkout_written_after_completion", path: s.place.path, observation: "uncommitted", paths: ["late.txt"] },
  ]);
  expect(git(s.ws.path, "show", `${s.parentBranch}:work.txt`)).toBe("work");
  expect(git(s.ws.path, "ls-tree", "--name-only", s.parentBranch, "--", "late.txt")).toBe("");
  expect(git(s.ws.path, "log", "--format=%s", "--all")).not.toContain("WIP: task");
}

it.each([false, true])("報告後の書き込みを観測した解放は、後始末の受理で重ねて観測しない(再起動=%s、ADR 0345 決定1 / ADR 0359 決定3)", async (restart) => {
  const s = await settledSession("completed", { parent: "delivers" });
  writeFileSync(join(s.place.path, "late.txt"), "written after completion\n");
  await teardownThrewAfterTreeRule(s);
  const deps = restart ? restarted(s) : s.deps;

  await acceptTeardownQuarantine(deps, s.task.id);

  expectLateWriteRecorded(s, deps);
});

it("報告後の書き込みを観測した解放の後で盤面が落ちても、起動時の復旧は観測を重ねない(ADR 0345 決定1 / ADR 0359 決定3)", async () => {
  const s = await settledSession("completed", { parent: "delivers" });
  writeFileSync(join(s.place.path, "late.txt"), "written after completion\n");
  // tree rule が返ってから印を消す前に process が死ぬ —— failedTeardown の question は立たない。
  releaseWorkspace(s.db, s.place, getTask(s.db, s.task.id)!, s.clock.now(), true, undefined, undefined, true);
  const deps = restarted(s);

  await resumeUnfinishedTeardown(deps);

  expectLateWriteRecorded(s, deps);
});

it("退避の commit が落ちて Quarantine に返った tree rule の受理は、同じ question を1枚のまま何も足さない(ADR 0345 決定4 / ADR 0366 決定1)", async () => {
  const s = await settledSession("interrupted");
  writeFileSync(join(s.place.path, "wip.txt"), "wip\n");
  failGitCommits("commit-tree");
  await teardownThrewAfterTreeRule(s);
  expect(existsSync(join(s.place.path, "wip.txt"))).toBe(true);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectOneQuestionUnchanged(s, "fixture commit failed");
  expect(head(s)).toBe("main");
});

it("merge back の conflict で Quarantine に返った tree rule の受理は、同じ conflict に着き、同じ question を1枚のまま何も足さない(ADR 0345 決定3・4 / ADR 0356 決定5 / ADR 0366 決定1)", async () => {
  const s = await settledSession("completed", { parent: "conflicts" });
  await teardownThrewAfterTreeRule(s);
  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectOneQuestionUnchanged(s, "does not merge cleanly");
  expect(head(s)).toBe("main");
  expect(git(s.ws.path, "status", "--porcelain")).toBe("");
});

// 旧: HEAD の2値行(予告と畳みの間で落ちた休止)と parking の回復(ADR 0243 決定2 / ADR 0345 決定3 / ADR 0356 決定5)。名前の場所の
// HEAD は動かなくなったので、予告と畳みの間で落ちうる盤面の書き込みはタスクブランチの WIP の1本になった
it("WIP のタスクブランチの書き込みの予告と畳みの間で落ちた解放の再実行は、2つ目の WIP を積まず、残った2値の行で次の pickup は止まらない(ADR 0243 決定2 / ADR 0351 決定4 / ADR 0356 決定2)", async () => {
  const s = await settledSession("interrupted");
  writeFileSync(join(s.place.path, "wip.txt"), "wip\n");
  const pickedUp = git(s.ws.path, "rev-parse", s.branch);
  // 落ちた盤面の形: WIP は着き checkout は残り、タスクブランチの行は予告の2値のまま(削除の前で止めてから行を予告に戻す)
  const parent = join(s.place.path, "..");
  chmodSync(parent, 0o555);
  try {
    expect(() => release(s)).toThrow();
  } finally {
    chmodSync(parent, 0o755);
  }
  const tip = git(s.ws.path, "rev-parse", s.branch);
  expect(git(s.ws.path, "log", "-1", "--format=%s", s.branch)).toContain("WIP: task");
  const row = s.db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(s.ws.name) as string;
  s.db.prepare("UPDATE workspace_state SET ref_snapshot = ? WHERE name = ?").run(row.replace(`${tip} refs/heads/${s.branch}`, `${pickedUp}|${tip} refs/heads/${s.branch}`), s.ws.name);

  release(s);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(git(s.ws.path, "rev-parse", s.branch)).toBe(tip);
  expect(existsSync(s.place.path)).toBe(false);
  const next = registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, s.clock.now(), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(s.db, s.ws, next);
  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${next.id}`);
  expect(head(s)).toBe("main");
});

// 旧: merge back の conflict は HEAD を動かさず、ignored の入れ子 repo は名前の場所に残った(ADR 0352 決定1 / ADR 0356 決定5)
it("merge back の conflict は名前の場所の HEAD を動かさず、ignored の入れ子 repo は task の checkout にだけあって名前の場所に届かない(ADR 0356 決定2・5)", async () => {
  const s = await settledSession("completed", {
    parent: "conflicts",
    work: (checkout) => {
      commitWork(checkout, ".gitignore", "build/\n");
      const nested = join(checkout, "build", "nested");
      mkdirSync(nested, { recursive: true });
      git(nested, "init", "-q");
      writeFileSync(join(nested, "out.txt"), "generated\n");
    },
  });

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain("does not merge cleanly");
  expect(head(s)).toBe("main");
  expect(existsSync(join(s.ws.path, "build"))).toBe(false);
});

it("帰り先へ届いた merge back の後の再実行は、帰り先を動かさず休止位置に居る(ADR 0345 決定3 / ADR 0356 決定2)", async () => {
  const s = await settledSession("completed", { parent: "delivers" });
  await teardownThrewAfterTreeRule(s);
  const delivered = git(s.ws.path, "rev-parse", s.branch);
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);
});

// 旧: 再実行が fetch と park の ff-only を撃ち直して休止位置を remote に追従させた(ADR 0345 決定3)。解放を刻んだ再実行は削除だけで、
// 追従は次の pickup の鮮度の段が持つ(issue #2223)
it("remote-backed の完了の merge back の後の再実行は名前の場所に触れず、その後に remote が進んでも次の pickup が休止位置を追従させる(ADR 0345 決定3 / ADR 0356 決定2)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("teardown-rerun-remote");
  const s = await settledSession("completed", { workspace, parent: "delivers" });
  // 後始末の前に remote が進み、1度目の fetch が写しを動かす
  publish("first.txt", "merged on GitHub\n", "merged before the teardown");
  await teardownThrewAfterTreeRule(s);
  const delivered = git(s.ws.path, "rev-parse", s.branch);
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);
  publish("merged.txt", "merged on GitHub\n", "merged outside");

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);
  const next = registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, s.clock.now(), ...HUMAN_WEBUI);
  await prepareAtPickup(s.db, s.ws, next);
  expect(git(s.ws.path, "rev-parse", "main")).toBe(git(s.ws.path, "rev-parse", "origin/main"));
  expect(git(s.ws.path, "show", "main:merged.txt")).toBe("merged on GitHub");
});

// ADR 0351 決定2: 基準は切れない —— 再実行の後始末の後も次の pickup は比べ、release はタスクブランチの行を無条件に畳む(#2953)。
it("再実行の後始末の後に休止中の main へ載った帯域外の commit は、次の pickup が refs/heads/main を名指して止める(#2911 の形)", async () => {
  const s = await settledSession("completed");
  await teardownThrewAfterTreeRule(s);
  await acceptTeardownQuarantine(s.deps, s.task.id);
  expectCleanRerun(s, s.deps, "done");
  commitWork(s.ws.path, "by-hand.txt", "committed on main while the checkout rested\n");
  const moved = git(s.ws.path, "rev-parse", "main");
  const next = registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, s.clock.now(), ...HUMAN_WEBUI);

  await expect(prepareAtPickup(s.db, s.ws, next)).rejects.toThrow(`now: ${moved} refs/heads/main`);
  expect(head(s)).toBe("main");
});

// 旧: 休止位置の checkout の予告(ADR 0342 決定4)。名前の場所の HEAD は動かないので、休止位置で盤面が書くのは remote への追従だけ
it("休止位置の remote への追従の予告で盤面 DB が書きを拒むと、追従の失敗に包まずに投げる(ADR 0342 決定4 / ADR 0356 決定5)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("teardown-rerun-readonly");
  const s = await settledSession("completed", { workspace });
  publish("merged.txt", "merged on GitHub\n", "merged outside");
  s.db.pragma("query_only = true");

  await expect(firePickupPredicates(s.db, s.ws, checkoutPickupPredicates(s.ws), "after-open")).rejects.toMatchObject({ code: "SQLITE_READONLY" });
});
