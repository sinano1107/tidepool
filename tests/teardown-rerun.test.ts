import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { checkoutPickupPredicates } from "../src/pickup-predicates.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, listBoard, pickupTask, registerTask } from "../src/tasks.js";
import { acceptTeardownQuarantine, markTeardown, resumeUnfinishedTeardown, runTeardown, sessionInTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { boardRefWriter, firePickupPredicates, prepareWorkspaceAtPickup, releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, FULL_HANDOFF, failGitCommits, failTeardownMark, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, quarantineQuestion, sessionId, WORKER_SPAWNED } from "./harness.js";

// 後始末の再実行(ADR 0345): tree rule を通った checkout をもう1度読む経路の振る舞い。

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
  git(ws.path, "branch", `task/${taskId}`, "main");
}

/** pickup の準備まで済み、worker が `work.txt` を1つ commit して決着した session。枠を握って後始末の印が立っている。 */
async function settledSession(settle: "completed" | "interrupted", { workspace, parent }: { workspace?: WorkspaceConfig; parent?: "delivers" | "conflicts" } = {}) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = workspace ?? (await makeWorkspace("teardown-rerun"));
  const parentId = parent && registerParentWithBranch(db, ws, clock.now());
  const registered = registerTask(db, { type: "work", title: "rerun", purpose: "why", completion_criteria: "done", parent_id: parentId }, clock.now(), ...HUMAN_WEBUI);
  if (parent === "conflicts") conflictOnParentBranch(ws, `task/${parentId}`, registered.id);
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  await prepareWorkspaceAtPickup(db, ws, task);
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  commitWork(ws.path, "work.txt", "work\n");
  if (settle === "completed") completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  markTeardown(db, task.id, clock.now());
  const slot = new Slot();
  slot.occupy(task.id, sessionId(db, task.id));
  slot.enterTeardown();
  const deps: TeardownDeps = { db, clock, slot, resolve: () => ws, pollNow: () => {} };
  return { db, clock, ws, task, slot, deps, branch: `task/${task.id}`, parentBranch: `task/${parentId}` };
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

function expectCleanRerun(s: Session, deps: TeardownDeps, status: string): void {
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(deps.slot.currentTaskId).toBeNull();
  expect(getTask(s.db, s.task.id)?.status).toBe(status);
  expect(sessionInTeardown(s.db)).toBeUndefined();
  expect(head(s)).toBe("main");
}

/** HEAD を休止位置へ予告して `write` を撃ち、畳む前に盤面が落ちる: 基準に2値の HEAD 行が残る。 */
function dropBoardAtHeadFold(s: Session, write: () => void): void {
  const reopen = dropBoardBeforeFold(s.db);
  expect(() => boardRefWriter(s.db, s.ws)("HEAD", "symref=refs/heads/main", write)).toThrow("the board dropped");
  reopen();
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

it("基準は pickup で HEAD の行を refname 順の先頭に持ち、休止の後は休止位置の1値に畳む(ADR 0345 決定2 / ADR 0064 決定6)", async () => {
  const s = await settledSession("interrupted");
  const baseline = () => (s.db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(s.ws.name) as string).split("\n");
  expect(baseline()[0]).toBe(`symref=refs/heads/${s.branch} HEAD`);
  expect(baseline()[1]).toMatch(/ refs\//);

  releaseWorkspace(s.db, s.ws, getTask(s.db, s.task.id)!, s.clock.now());

  expect(baseline()[0]).toBe("symref=refs/heads/main HEAD");
});

it("完了の tree rule の後に question も無く落ちた盤面の次の起動の復旧は、偽の workspace Quarantine を立てずに枠が空く(ADR 0345 決定3)", async () => {
  const s = await settledSession("completed");
  releaseWorkspace(s.db, s.ws, getTask(s.db, s.task.id)!, s.clock.now(), true, undefined, undefined, true);
  const deps = restarted(s);

  await resumeUnfinishedTeardown(deps);

  expectCleanRerun(s, deps, "done");
});

it.each([
  ["保護ブランチ", (ws: WorkspaceConfig) => git(ws.path, "checkout", "main"), "main"],
  ["別のブランチ", (ws: WorkspaceConfig) => git(ws.path, "checkout", "-b", "elsewhere"), "elsewhere"],
  ["detached HEAD", (ws: WorkspaceConfig) => git(ws.path, "checkout", "--detach"), "HEAD"],
] as const)("worker が予告の無い位置(%s)に居たまま終わると今日どおり commit を拒み、残したものはその位置に落ちない(#234 ケース1)", async (_, wander, position) => {
  const s = await settledSession("interrupted");
  wander(s.ws);
  writeFileSync(join(s.ws.path, "left.txt"), "left behind\n");
  const before = git(s.ws.path, "rev-parse", "HEAD");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain(`is on '${position}', not '${s.branch}' — refusing to commit`);
  expect(git(s.ws.path, "rev-parse", "HEAD")).toBe(before);
  expect(git(s.ws.path, "status", "--porcelain")).toBe("?? left.txt");
});

it("基準の行が無い workspace の HEAD は盤面が動かしたと読まず、今日どおり commit を拒む(fail-closed、ADR 0064 決定6)", async () => {
  const s = await settledSession("completed");
  await teardownThrewAfterTreeRule(s);
  s.db.exec("DELETE FROM workspace_state");

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain(`is on 'main', not '${s.branch}' — refusing to commit`);
});

it.each([false, true])("盤面が休止させた後の書き込みは quarantine に落ちる(info/exclude: %s、ADR 0345 決定3 / ADR 0356 決定3)", async (hidden) => {
  const s = await settledSession("completed");
  await teardownThrewAfterTreeRule(s);
  if (hidden) writeFileSync(join(s.ws.path, ".git/info/exclude"), "late.txt\n");
  writeFileSync(join(s.ws.path, "late.txt"), "written by a process that outlived the board\n");
  const tips = () => [git(s.ws.path, "rev-parse", "main"), git(s.ws.path, "rev-parse", s.branch)];
  const before = tips();

  await acceptTeardownQuarantine(s.deps, s.task.id);

  const purpose = quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose;
  expect(purpose).toContain(`has uncommitted changes after the board moved its checkout off '${s.branch}'`);
  expect(purpose).toContain("?? late.txt");
  expect(purpose).toContain("a process wrote them");
  expect(purpose).not.toContain("ignored only on the task branch");
  expect(tips()).toEqual(before);
  expect(git(s.ws.path, "status", "--porcelain")).toBe(hidden ? "" : "?? late.txt");
  expect(head(s)).toBe("main");
});

it("タスクブランチだけが無視する生成物は休止前に消え、再実行も workspace Quarantine 無しで完了する(ADR 0352 決定1・5)", async () => {
  const s = await settledSession("completed");
  commitWork(s.ws.path, ".gitignore", "build/\n");
  mkdirSync(join(s.ws.path, "build"));
  writeFileSync(join(s.ws.path, "build", "out.txt"), "generated\n");
  await teardownThrewAfterTreeRule(s);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(git(s.ws.path, "status", "--porcelain")).toBe("");
  expect(existsSync(join(s.ws.path, "build"))).toBe(false);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
});

it("盤面が休止させた後の shadow 残骸は書かれたものに数えない(ADR 0069 / ADR 0345 決定3)", async () => {
  const s = await settledSession("completed");
  await teardownThrewAfterTreeRule(s);
  writeFileSync(join(s.ws.path, ".bashrc"), "");

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
});

function expectOneQuestionRefiredOnce(s: Session, reason: string): void {
  const question = quarantineQuestion(s.db, "workspace", s.ws.name)!;
  expect(listBoard(s.db).filter((t) => t.title === question.title).map((t) => t.id)).toEqual([question.id]);
  expect(listEvents(s.db, question.id).flatMap((e) => (e.payload.kind === "quarantine_refired" ? [e.payload.reason] : []))).toEqual([expect.stringContaining(reason)]);
  expect(s.deps.slot.currentTaskId).toBeNull();
}

function expectLateWriteQuarantinePreserved(s: Session, deps: TeardownDeps, questionId: string, reason: string): void {
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.id).toBe(questionId);
  expect(listEvents(s.db, questionId).flatMap((e) => e.payload.kind === "quarantine_refired" ? [e.payload.reason] : [])).toEqual([expect.stringContaining(reason)]);
  expect(git(s.ws.path, "ls-tree", "--name-only", s.parentBranch)).not.toContain("late.txt");
  expect(git(s.ws.path, "log", "--format=%s", "--all")).not.toContain("WIP: task");
  expect(head(s)).toBe(s.branch);
  expect(deps.slot.currentTaskId).toBeNull();
  expect(getTask(s.db, s.task.id)?.status).toBe("done");
  expect(sessionInTeardown(s.db)).toBeUndefined();
}

it.each([false, true])("完了報告後の書き込みで Quarantine に返った後始末の受理は、再起動=%s でも検査を切らず同じ question を再発火する(ADR 0350 決定1・3)", async (restart) => {
  const s = await settledSession("completed", { parent: "delivers" });
  writeFileSync(join(s.ws.path, "late.txt"), "written after completion\n");
  await teardownThrewAfterTreeRule(s);
  const question = quarantineQuestion(s.db, "workspace", s.ws.name)!;
  const reason = `written to after task ${s.task.id} reported done`;
  expect(question.purpose).toContain(reason);
  expect(head(s)).toBe(s.branch);
  const deps = restart ? restarted(s) : s.deps;

  await acceptTeardownQuarantine(deps, s.task.id);

  expectLateWriteQuarantinePreserved(s, deps, question.id, reason);
});

it("完了報告後の書き込みで Quarantine に返った直後に盤面が落ちても、起動時の復旧は同じ question を再発火する(ADR 0350 決定1・3)", async () => {
  const s = await settledSession("completed", { parent: "delivers" });
  writeFileSync(join(s.ws.path, "late.txt"), "written after completion\n");
  // tree rule が返ってから印を消す前に process が死ぬ —— failedTeardown の question は立たない。
  releaseWorkspace(s.db, s.ws, getTask(s.db, s.task.id)!, s.clock.now(), true, undefined, undefined, true);
  const question = quarantineQuestion(s.db, "workspace", s.ws.name)!;
  const reason = `written to after task ${s.task.id} reported done`;
  expect(question.purpose).toContain(reason);
  const deps = restarted(s);

  await resumeUnfinishedTeardown(deps);

  expectLateWriteQuarantinePreserved(s, deps, question.id, reason);
});

it("退避の commit が落ちて Quarantine に返った tree rule の受理は、同じ question に quarantine_refired を1つ足す(ADR 0345 決定4)", async () => {
  const s = await settledSession("interrupted");
  writeFileSync(join(s.ws.path, "wip.txt"), "wip\n");
  failGitCommits();
  await teardownThrewAfterTreeRule(s);
  expect(head(s)).toBe(s.branch);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectOneQuestionRefiredOnce(s, "fixture commit failed");
  expect(head(s)).toBe(s.branch);
});

it("merge back の conflict で Quarantine に返った tree rule の受理は、子の HEAD のまま同じ conflict に着き、同じ question に quarantine_refired を1つ足す(ADR 0345 決定3・4 / ADR 0356 決定5)", async () => {
  const s = await settledSession("completed", { parent: "conflicts" });
  await teardownThrewAfterTreeRule(s);
  expect(head(s)).toBe(s.branch);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectOneQuestionRefiredOnce(s, "does not merge cleanly");
  expect(head(s)).toBe(s.branch);
  expect(git(s.ws.path, "status", "--porcelain")).toBe("");
});

it.each([
  [
    "HEAD が old(タスクブランチ)なら tree rule は通常どおり走って退避する",
    (s: Session) => {
      dropBoardAtHeadFold(s, () => {});
      writeFileSync(join(s.ws.path, "wip.txt"), "wip\n");
    },
    "WIP: task",
  ],
  [
    "HEAD が new(休止位置)なら退避と比較を飛ばす",
    (s: Session) => dropBoardAtHeadFold(s, () => git(s.ws.path, "checkout", "main")),
    "add work.txt",
  ],
] as const)("予告と畳みの間で落ちた2値の HEAD 行: %s(ADR 0243 決定2 / ADR 0345 決定3)", async (_, droppedBoard, tipSubject) => {
  const s = await settledSession("interrupted");
  droppedBoard(s);

  releaseWorkspace(s.db, s.ws, getTask(s.db, s.task.id)!, s.clock.now());

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(head(s)).toBe("main");
  expect(git(s.ws.path, "log", "-1", "--format=%s", s.branch)).toContain(tipSubject);
});

it("merge back の conflict は HEAD を動かさず、ignored の入れ子 repo は残る(ADR 0352 決定1 / ADR 0356 決定5)", async () => {
  const s = await settledSession("completed", { parent: "conflicts" });
  commitWork(s.ws.path, ".gitignore", "build/\n");
  const nested = join(s.ws.path, "build", "nested");
  mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  writeFileSync(join(nested, "out.txt"), "generated\n");

  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)?.purpose).toContain("does not merge cleanly");
  expect(head(s)).toBe(s.branch);
  expect(existsSync(join(s.ws.path, "build"))).toBe(true);
});

it("帰り先へ届いた merge back の後の再実行は、帰り先を動かさず休止位置へ戻る(ADR 0345 決定3)", async () => {
  const s = await settledSession("completed", { parent: "delivers" });
  await teardownThrewAfterTreeRule(s);
  const delivered = git(s.ws.path, "rev-parse", s.branch);
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);

  await acceptTeardownQuarantine(s.deps, s.task.id);

  expectCleanRerun(s, s.deps, "done");
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);
});

it("remote-backed の完了の merge back の後の再実行は、fetch が動かした写しを違反と読まず、park の ff-only で休止位置を remote に追従させる(ADR 0345 決定3)", async () => {
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
  expect(git(s.ws.path, "rev-parse", "main")).toBe(git(s.ws.path, "rev-parse", "origin/main"));
  expect(git(s.ws.path, "show", "main:merged.txt")).toBe("merged on GitHub");
  expect(git(s.ws.path, "rev-parse", s.parentBranch)).toBe(delivered);
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

  await expect(prepareWorkspaceAtPickup(s.db, s.ws, next)).rejects.toThrow(`now: ${moved} refs/heads/main`);
  expect(head(s)).toBe("main");
});

it("盤面が HEAD を休止位置へ動かして畳む前に落ちた後始末の再実行は、比較を飛ばしてもタスクブランチの行を今の tip に畳み、次の pickup は止まらない(ADR 0351 決定2 / ADR 0345 決定1)", async () => {
  const s = await settledSession("interrupted");
  dropBoardAtHeadFold(s, () => git(s.ws.path, "checkout", "main"));

  releaseWorkspace(s.db, s.ws, getTask(s.db, s.task.id)!, s.clock.now());

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  const next = registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, s.clock.now(), ...HUMAN_WEBUI);
  await prepareWorkspaceAtPickup(s.db, s.ws, next);
  expect(head(s)).toBe(`task/${next.id}`);
});

it("休止位置の checkout の予告で盤面 DB が書きを拒むと、checkout の失敗に包まずに投げる(ADR 0342 決定4)", async () => {
  const s = await settledSession("completed");
  s.db.pragma("query_only = true");

  await expect(firePickupPredicates(s.db, s.ws, checkoutPickupPredicates(s.ws), "after-open")).rejects.toMatchObject({ code: "SQLITE_READONLY" });
});
