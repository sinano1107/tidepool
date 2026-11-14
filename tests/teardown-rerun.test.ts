import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { checkoutPickupPredicates } from "../src/pickup-predicates.js";
import { Slot } from "../src/slot.js";
import { completeTask, escalateTask, getTask, listBoard, pickupTask, registerTask } from "../src/tasks.js";
import { acceptTeardownQuarantine, markTeardown, resumeUnfinishedTeardown, runTeardown, sessionInTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { firePickupPredicates, type RunPlace, recordTaskCheckoutTip, releaseWorkspace, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import {
  commitWork,

  FULL_HANDOFF,
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

/** 作業がタスクブランチに着き、解放を刻んだ直後に盤面が落ちた形。 */
function recordReleaseBeforeRestart(s: Session): void {
  appendEvent(s.db, { taskId: s.task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_released", path: s.place.path }, at: s.clock.now() });
}

const head = (s: Session) => git(s.ws.path, "rev-parse", "--abbrev-ref", "HEAD");
const release = (s: Session, place: RunPlace = s.place) => releaseWorkspace(s.db, place, getTask(s.db, s.task.id)!, s.clock.now());

it("別の ref が動いても、作業がタスクブランチに着いた解放は刻まれ、checkout を消す (ADR 0369 決定7)", async () => {
  const s = await settledSession("interrupted");
  escalateTask(s.db, s.task, { context: "need a decision", questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }] }, "deckhand", s.clock.now(), "worker");
  writeFileSync(join(s.place.path, "wip.txt"), "wip\n");
  git(s.ws.path, "branch", "moved-by-hand", "main");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(git(s.ws.path, "show", `${s.branch}:work.txt`)).toBe("work");
  expect(git(s.ws.path, "show", `${s.branch}:wip.txt`)).toBe("wip");
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain("refs/heads/moved-by-hand");
  expect(listEvents(s.db, s.task.id).filter(({ kind }) => kind === "task_checkout_released").map(({ payload }) => payload)).toEqual([
    { kind: "task_checkout_released", path: s.place.path },
  ]);
  expect(existsSync(s.place.path)).toBe(false);
});

it.each([
  { containsTip: true, removeGit: false },
  { containsTip: false, removeGit: false },
  { containsTip: false, removeGit: true },
])("完了の門の tip が今のタスクブランチに含まれる場合だけ checkout を消す (contains tip=$containsTip, .git removed=$removeGit、ADR 0369 決定7)", async ({ containsTip, removeGit }) => {
  const s = await settledSession("completed", { parent: "delivers" });
  if (containsTip) {
    git(s.ws.path, "switch", s.branch);
    commitWork(s.ws.path, "by-hand.txt", "added after completion\n");
    git(s.ws.path, "switch", "main");
  } else {
    git(s.ws.path, "update-ref", `refs/heads/${s.branch}`, "main");
  }
  if (removeGit) rmSync(join(s.place.path, ".git"), { recursive: true });

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain(`now: ${git(s.ws.path, "rev-parse", s.branch)} refs/heads/${s.branch}`);
  if (containsTip) expect(git(s.ws.path, "show", `${s.branch}:work.txt`)).toBe("work");
  expect(git(s.ws.path, "ls-tree", "--name-only", s.parentBranch, "--", "by-hand.txt", "work.txt")).toBe("");
  const events = listEvents(s.db, s.task.id);
  expect(events.some(({ kind }) => kind === "task_checkout_released")).toBe(containsTip);
  expect(events.find(({ kind }) => kind === "task_checkout_written_after_completion")?.payload).toEqual(removeGit ?
    { kind: "task_checkout_written_after_completion", path: s.place.path, observation: "unreadable", reason: expect.stringContaining("has no git repository") } : undefined);
  expect(existsSync(s.place.path)).toBe(!containsTip);
});

it.each(["current", "old", "new"] as const)("完了の門の予告が残っていても、タスクブランチに含まれる記録から解放する (recorded tip=%s、ADR 0369 決定7)", async (recorded) => {
  const s = await settledSession("completed", { parent: "delivers" });
  const ref = `refs/heads/${s.branch}`;
  const gateTip = git(s.ws.path, "rev-parse", s.branch);
  const base = git(s.ws.path, "rev-parse", "main");
  git(s.ws.path, "switch", s.branch);
  commitWork(s.ws.path, "by-hand.txt", "added after completion\n");
  git(s.ws.path, "switch", "main");
  const current = git(s.ws.path, "rev-parse", s.branch);
  const announcement = { current: `${gateTip}|${current}`, old: `${gateTip}|${"a".repeat(40)}`, new: `${base}|${gateTip}` }[recorded];
  const snapshot = s.db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(s.ws.name) as string;
  s.db.prepare("UPDATE workspace_state SET ref_snapshot = ? WHERE name = ?").run(snapshot.replace(`${gateTip} ${ref}`, `${announcement} ${ref}`), s.ws.name);
  if (recorded === "current") {
    // The worker left the tip whose gate write the board last announced.
    git(s.place.path, "fetch", s.ws.path, s.branch);
    git(s.place.path, "reset", "--hard", "FETCH_HEAD");
  }

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  const events = listEvents(s.db, s.task.id);
  expect(events.some(({ kind }) => kind === "task_checkout_written_after_completion")).toBe(false);
  expect(events.some(({ kind }) => kind === "task_checkout_released")).toBe(true);
  expect(existsSync(s.place.path)).toBe(false);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose?.includes(ref) ?? false).toBe(recorded !== "current");
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(recorded === "current" ? current : base);
});

it("置換 ref が門の tip を見せても、実際のタスクブランチから辿れなければ checkout を残す (ADR 0369 決定7)", async () => {
  const s = await settledSession("completed");
  const gateTip = git(s.ws.path, "rev-parse", s.branch);
  git(s.ws.path, "switch", "--detach", gateTip);
  commitWork(s.ws.path, "child.txt", "descendant\n");
  const descendant = git(s.ws.path, "rev-parse", "HEAD");
  git(s.ws.path, "switch", "main");
  commitWork(s.ws.path, "unrelated.txt", "different history\n");
  const unrelated = git(s.ws.path, "rev-parse", "main");
  git(s.ws.path, "replace", unrelated, descendant);
  git(s.ws.path, "update-ref", `refs/heads/${s.branch}`, unrelated);

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeDefined();
  expect(listEvents(s.db, s.task.id).map(({ kind }) => kind)).not.toContain("task_checkout_released");
  expect(readFileSync(join(s.place.path, "work.txt"), "utf8")).toBe("work\n");
});

it("タスクブランチが門の tip を指す別 ref への symref に変わったら checkout を残す (ADR 0369 決定7)", async () => {
  const s = await settledSession("completed");
  const ref = `refs/heads/${s.branch}`;
  git(s.ws.path, "branch", "points-to-gate-tip", s.branch);
  git(s.ws.path, "symbolic-ref", ref, "refs/heads/points-to-gate-tip");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain(`symref=refs/heads/points-to-gate-tip ${ref}`);
  expect(listEvents(s.db, s.task.id).map(({ kind }) => kind)).not.toContain("task_checkout_released");
  expect(existsSync(s.place.path)).toBe(true);
});

it.each([
  { treePath: "root", removeGit: false },
  { treePath: "nested", removeGit: false },
  { treePath: "nested", removeGit: true },
])("門が記録した tree が読めなければ checkout を残す (tree=$treePath, .git removed=$removeGit、ADR 0369 決定7)", async ({ treePath, removeGit }) => {
  const s = await settledSession("completed", { work: (checkout) => {
    mkdirSync(join(checkout, "nested"));
    commitWork(checkout, "nested/deliverable.txt", "the real work\n");
  } });
  const tree = git(s.ws.path, "rev-parse", treePath === "root" ? `${s.branch}^{tree}` : `${s.branch}:nested`);
  rmSync(join(s.ws.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  if (removeGit) rmSync(join(s.place.path, ".git"), { recursive: true });

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeDefined();
  expect(readFileSync(join(s.place.path, "nested/deliverable.txt"), "utf8")).toBe("the real work\n");
  const events = listEvents(s.db, s.task.id);
  expect(events.some(({ kind }) => kind === "task_checkout_released")).toBe(false);
  expect(events.find(({ kind }) => kind === "task_checkout_written_after_completion")?.payload).toEqual(removeGit ?
    { kind: "task_checkout_written_after_completion", path: s.place.path, observation: "unreadable", reason: expect.stringContaining("has no git repository") } : undefined);
});

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

it("解放を刻んだ直後に停止しても、再起動が merge back と休止位置への追従を済ませて checkout を消す (ADR 0369 決定7)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("teardown-restart-after-release");
  const s = await settledSession("completed", { workspace, parent: "delivers" });
  publish("merged.txt", "merged on GitHub\n", "merged before the teardown");
  recordReleaseBeforeRestart(s);
  writeFileSync(join(s.place.path, "late.txt"), "written after the release\n");
  const deps = restarted(s);

  await resumeUnfinishedTeardown(deps);

  expectCleanRerun(s, deps, "done");
  expect(git(s.ws.path, "show", `${s.parentBranch}:work.txt`)).toBe("work");
  expect(readFileSync(join(s.ws.path, "merged.txt"), "utf8")).toBe("merged on GitHub\n");
  expect(listEvents(s.db, s.task.id).filter(({ kind }) => kind === "task_checkout_released")).toHaveLength(1);
  expect(listEvents(s.db, s.task.id).map(({ kind }) => kind)).not.toContain("task_checkout_written_after_completion");
});

it("解放を刻んだ後に名前の場所が drift しても、再起動が Quarantine を立てて checkout を消す (ADR 0369 決定7)", async () => {
  const s = await settledSession("completed");
  recordReleaseBeforeRestart(s);
  const deps = { ...restarted(s), resolve: () => { throw new UnknownWorkspaceError(s.ws.name); } };

  await resumeUnfinishedTeardown(deps);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain(`unknown workspace: ${s.ws.name}`);
  expect(existsSync(s.place.path)).toBe(false);
  expect(sessionInTeardown(s.db)).toBeUndefined();
});

it("中断の解放を刻んだ後にタスクブランチが動くと、再起動は変更を基準に入れず Quarantine に落とす (ADR 0369 決定7)", async () => {
  const s = await settledSession("interrupted");
  recordTaskCheckoutTip(s.db, s.place, s.task.id);
  recordReleaseBeforeRestart(s);
  const ref = `refs/heads/${s.branch}`;
  git(s.ws.path, "update-ref", ref, "main");

  await resumeUnfinishedTeardown(restarted(s));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain(ref);
  expect(existsSync(s.place.path)).toBe(false);
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

it("基準の行を失った名前の場所の完了の解放は quarantine に落ちて checkout を残す (ADR 0369 決定7)", async () => {
  const s = await settledSession("completed");
  s.db.exec("DELETE FROM workspace_state");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain("changed during the session");
  expect(existsSync(s.place.path)).toBe(true);
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

it("退避の fetch が落ちて Quarantine に返った tree rule の受理は、同じ question を1枚のまま何も足さない(ADR 0345 決定4 / ADR 0366 決定1)", async () => {
  const s = await settledSession("interrupted");
  writeFileSync(join(s.place.path, "wip.txt"), "wip\n");
  recordTaskCheckoutTip(s.db, s.place, s.task.id);
  git(s.ws.path, "config", "fetch.unpackLimit", "1");
  const packDir = join(s.ws.path, ".git", "objects", "pack");
  rmSync(packDir, { recursive: true });
  writeFileSync(packDir, "");
  await teardownThrewAfterTreeRule(s);
  expect(existsSync(join(s.place.path, "wip.txt"))).toBe(true);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectOneQuestionUnchanged(s, "the WIP commit");
  expect(head(s)).toBe("main");
});

it("merge back の conflict で checkout を消し、後始末の受理では同じ Quarantine を保つ (ADR 0369 決定7 / ADR 0366 決定1)", async () => {
  const s = await settledSession("completed", { parent: "conflicts" });
  writeFileSync(join(s.place.path, "late.txt"), "written after completion\n");
  await teardownThrewAfterTreeRule(s);
  expect(existsSync(s.place.path)).toBe(false);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectOneQuestionUnchanged(s, "does not merge cleanly");
  expect(head(s)).toBe("main");
  expect(git(s.ws.path, "status", "--porcelain")).toBe("");
  expect(git(s.ws.path, "show", `${s.branch}:work.txt`)).toBe("work");
  expect(listEvents(s.db, s.task.id).filter(({ kind }) => kind === "task_checkout_written_after_completion" || kind === "task_checkout_released").map(({ payload }) => payload)).toEqual([
    { kind: "task_checkout_written_after_completion", path: s.place.path, observation: "uncommitted", paths: ["late.txt"] },
    { kind: "task_checkout_released", path: s.place.path },
  ]);
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

it("checkout の削除が投げた時点で merge back と休止位置への追従は済んでいる (ADR 0369 決定7)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("teardown-delete-failure");
  const s = await settledSession("completed", { workspace, parent: "delivers" });
  publish("merged.txt", "merged on GitHub\n", "merged before the teardown");
  const parent = join(s.place.path, "..");
  chmodSync(parent, 0o555);
  try {
    await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));
    expect(sessionInTeardown(s.db)).toBeDefined();
    expect(existsSync(s.place.path)).toBe(true);
    expect(listEvents(s.db, s.task.id).map(({ kind }) => kind)).toContain("task_checkout_released");
    expect(git(s.ws.path, "show", `${s.parentBranch}:work.txt`)).toBe("work");
    expect(readFileSync(join(s.ws.path, "merged.txt"), "utf8")).toBe("merged on GitHub\n");
  } finally {
    chmodSync(parent, 0o755);
  }

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
});

it("remote-backed の完了の再実行は済んだ merge back を保ち、休止位置を最新の remote に追従させる (ADR 0369 決定7)", async () => {
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
