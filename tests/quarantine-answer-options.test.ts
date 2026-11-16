import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { latestEventOfTask, listEventsOfKinds } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { getTask, registerTask } from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import { boardRefWriter, commitRoomCopy, openInterviewRoom, quarantineWorkspace, refValues, releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { unusedLanding } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, pickUpInterviewRoot, poseAccepted, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// workspace の Quarantine の回答が盤面の行為を選ぶ(ADR 0373 決定2〜4・8・11、#3277)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T00:00:00.000Z");

function work(db: Db, title: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
}

/** 1件を拾って解放し(基準の行と `task/<id>` が残る)、workspace の Quarantine が開いた盤面。 */
async function quarantinedWorkspace(name: string) {
  const ws = await makeWorkspace(name);
  const db = openDb(":memory:");
  const task = work(db, "leaves a task branch");
  releaseWorkspace(db, await prepareAtPickup(db, ws, task), task, NOW);
  quarantineWorkspace(db, ws.name, new Error("a human touched the checkout"), NOW);
  return { ws, db, task, question: quarantineQuestion(db, "workspace", ws.name)! };
}

/** 開いている workspace の Quarantine に人間が `text` で答える(回答の口)。`ws` は回答の時点で引ける workspace。 */
function answer(db: Db, ws: WorkspaceConfig, text: string) {
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  return submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspace: ws }) }, question, [text], undefined, () => NOW, "webui");
}

/** 基準の行(refname → 値)。撮り直しが走らない場面で、口を通った書き込みが基準に入ったかを読む。 */
const baseline = (db: Db, name: string) => refValues(db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(name) as string);

const restoredEvents = (db: Db) => listEventsOfKinds(db, ["baseline_restored"]).map(({ payload }) => payload);

it("`restore the baseline` は動いた・作られた・消された ref を基準へ書き戻し、外した値を refs/keep-around/<sha> と event と応答に残し、clean だった tree を HEAD に揃え、次の比較は通る(ADR 0373 決定3・4)", async () => {
  const { ws, db, task, question } = await quarantinedWorkspace("restore-core");
  const main = git(ws.path, "rev-parse", "main");
  const taskRef = `refs/heads/task/${task.id}`;
  const taskTip = git(ws.path, "rev-parse", taskRef);
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const moved = git(ws.path, "rev-parse", "main");
  const extra = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "another hand");
  git(ws.path, "branch", "extra", extra);
  git(ws.path, "branch", "-D", `task/${task.id}`);

  const answered = await answer(db, ws, "restore the baseline");

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(ws.path, "rev-parse", "main")).toBe(main);
  expect(git(ws.path, "rev-parse", taskRef)).toBe(taskTip);
  expect(git(ws.path, "for-each-ref", "refs/heads/extra")).toBe("");
  expect(existsSync(join(ws.path, "by-hand.txt"))).toBe(false);
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "for-each-ref", "--format=%(objectname) %(refname)", "refs/keep-around/").split("\n").sort()).toEqual(
    [`${moved} refs/keep-around/${moved}`, `${extra} refs/keep-around/${extra}`].sort(),
  );
  const lines = [`refs/heads/main was ${moved}, kept as refs/keep-around/${moved}`, `refs/heads/extra was ${extra}, kept as refs/keep-around/${extra}`];
  const [event] = restoredEvents(db);
  expect(event).toMatchObject({ workspace: ws.name });
  expect(event!.kept).toHaveLength(2);
  expect(event!.kept).toEqual(expect.arrayContaining([{ ref: "refs/heads/main", sha: moved }, { ref: "refs/heads/extra", sha: extra }]));
  expect(event!.restored).toEqual(expect.arrayContaining(["refs/heads/main", "refs/heads/extra", taskRef]));
  for (const line of lines) expect(answered.notice).toContain(line);
  await expect(prepareAtPickup(db, ws, work(db, "after the restore"))).resolves.toBeDefined();
  db.close();
});

it("`restore the baseline` の細部: HEAD と symref の行は戻すだけで持たず、人間が作った keep-around の ref は消して値を持ち、予告中の行はどの値とも違えば予告の前の値へ戻って予告のもう一方の値は持たず、後の段で拒まれても書き戻しと event と基準の行は残る(ADR 0373 決定3・4)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-details");
  const main = git(ws.path, "rev-parse", "main");
  const commit = (message: string) => git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", message);
  const [announcedFrom, announcedTo, movedTo, human, own] = ["from", "to", "moved", "human", "own"].map(commit) as [string, string, string, string, string];
  const keep = "refs/heads/keep";
  boardRefWriter(db, ws)(keep, announcedFrom, () => git(ws.path, "update-ref", keep, announcedFrom));
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, ws)(keep, announcedTo, () => {})).toThrow("the board dropped");
  reopen();
  git(ws.path, "update-ref", keep, movedTo);
  git(ws.path, "checkout", "-q", "--detach");
  git(ws.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main");
  git(ws.path, "update-ref", "refs/keep-around/mine", human);
  git(ws.path, "update-ref", `refs/keep-around/${own}`, own);

  // 保護ブランチが引けない —— 書き戻しの後の後半の項(休止)で拒まれる
  await expect(answer(db, { ...ws, branch: "missing" }, "restore the baseline")).rejects.toThrow("protected branch 'missing' cannot be checked out");

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(ws.path, "rev-parse", "main")).toBe(main);
  expect(git(ws.path, "for-each-ref", "refs/remotes/origin/HEAD")).toBe("");
  expect(git(ws.path, "rev-parse", keep)).toBe(announcedFrom);
  const keptRefs = [movedTo, human, own].map((sha) => `${sha} refs/keep-around/${sha}`).sort();
  expect(git(ws.path, "for-each-ref", "--format=%(objectname) %(refname)", "refs/keep-around/").split("\n").sort()).toEqual(keptRefs);
  expect(restoredEvents(db)).toHaveLength(1);
  expect(restoredEvents(db)[0]!.kept).toEqual(expect.arrayContaining([{ ref: keep, sha: movedTo }, { ref: "refs/keep-around/mine", sha: human }, { ref: `refs/keep-around/${own}`, sha: own }]));
  expect(restoredEvents(db)[0]!.kept).toHaveLength(3);
  // 撮り直しは走っていない —— 退避した ref は口を通って基準に入った
  const row = baseline(db, ws.name);
  for (const sha of [movedTo, human, own]) expect(row.get(`refs/keep-around/${sha}`)).toBe(sha);
  expect(row.get(keep)).toBe(announcedFrom);
  expect(row.has("refs/keep-around/mine")).toBe(false);
  db.close();
});

it("戻す先の object が1つでも無ければ、`restore the baseline` はその ref を名指して拒み、何も書かない(ADR 0373 決定3)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-lost-object");
  const lost = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "only on a branch the baseline holds");
  boardRefWriter(db, ws)("refs/heads/lost", lost, () => git(ws.path, "update-ref", "refs/heads/lost", lost));
  git(ws.path, "update-ref", "-d", "refs/heads/lost");
  git(ws.path, "reflog", "expire", "--expire=now", "--all");
  git(ws.path, "gc", "--quiet", "--prune=now");
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const refsBefore = git(ws.path, "for-each-ref");
  const rowBefore = baseline(db, ws.name);

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(
    `cannot restore refs/heads/lost to ${lost}: that commit no longer exists in ${ws.path} Nothing was written.`,
  );

  expect(git(ws.path, "for-each-ref")).toBe(refsBefore);
  expect(baseline(db, ws.name)).toEqual(rowBefore);
  expect(restoredEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("`restore the baseline` は update-ref で書く —— linked worktree が checkout した branch も戻せ、消せる(ADR 0373 決定3・15)", async () => {
  const { ws, db, task } = await quarantinedWorkspace("restore-linked-worktree");
  const taskRef = `refs/heads/task/${task.id}`;
  const taskTip = git(ws.path, "rev-parse", taskRef);
  const moved = await tempDir("restore-linked-worktree-moved-");
  const made = await tempDir("restore-linked-worktree-made-");
  git(ws.path, "worktree", "add", "-q", moved, `task/${task.id}`);
  commitWork(moved, "in-the-worktree.txt", "committed in a linked worktree\n");
  git(ws.path, "worktree", "add", "-q", "-b", "made-there", made);

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "rev-parse", taskRef)).toBe(taskTip);
  expect(git(ws.path, "for-each-ref", "refs/heads/made-there")).toBe("");
  db.close();
});

it("回答が始まってから書き戻しまでに動いた ref も書き戻す —— 違いは書き戻しの同期区間で比べ直す(ADR 0373 決定3・7)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-moved-during");
  const late = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "made while the answer was checked");

  const answering = answer(db, ws, "restore the baseline");
  git(ws.path, "branch", "late", late);
  await answering;

  expect(git(ws.path, "for-each-ref", "refs/heads/late")).toBe("");
  expect(git(ws.path, "rev-parse", `refs/keep-around/${late}`)).toBe(late);
  db.close();
});

it("同じ repo を clone し直して object が全部そろった checkout は、`restore the baseline` で復元される(ADR 0373 決定3)", async () => {
  const { ws, db, task } = await quarantinedWorkspace("restore-reclone");
  const refs = git(ws.path, "for-each-ref", "--format=%(objectname) %(refname)");
  const reclone = await tempDir("restore-reclone-");
  git(reclone, "clone", "--quiet", "--no-checkout", ws.path, ".");
  git(reclone, "remote", "remove", "origin");
  git(reclone, "checkout", "-q", "main");
  expect(git(reclone, "for-each-ref", `refs/heads/task/${task.id}`)).toBe("");

  await answer(db, { ...ws, path: reclone }, "restore the baseline");

  expect(git(reclone, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/tags/")).toBe(refs);
  db.close();
});

it("`restore the baseline` は基準に無い refs/stash を消し、reflog の各件を refs/keep-around/<sha> に持つ(ADR 0373 決定4)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-stash");
  for (const body of ["first\n", "second\n"]) {
    writeFileSync(join(ws.path, "README.md"), body);
    git(ws.path, "stash", "push", "-q");
  }
  const entries = git(ws.path, "log", "-g", "--format=%H", "refs/stash").split("\n");
  expect(entries).toHaveLength(2);

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "for-each-ref", "refs/stash")).toBe("");
  for (const sha of entries) expect(git(ws.path, "rev-parse", `refs/keep-around/${sha}`)).toBe(sha);
  expect(restoredEvents(db)[0]!.kept).toEqual(entries.map((sha) => ({ ref: "refs/stash", sha })));
  db.close();
});

it("tree が dirty なら `restore the baseline` は拒み、何も書かない(ADR 0373 決定3)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-dirty");
  git(ws.path, "branch", "extra");
  writeFileSync(join(ws.path, "README.md"), "uncommitted\n");

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow("still has uncommitted changes");

  expect(git(ws.path, "for-each-ref", "refs/heads/extra")).not.toBe("");
  expect(git(ws.path, "for-each-ref", "refs/keep-around/")).toBe("");
  expect(restoredEvents(db)).toEqual([]);
  db.close();
});

it.each(["I deleted the stray branch's twin by hand — restore the baseline", "run with an empty room"])(
  "選択肢と完全に一致しない回答(%s)は `repaired by hand` の道を通り、ref を書き戻さず、文は修理メモとして残る(ADR 0373 決定2)",
  async (text) => {
    const { ws, db, question } = await quarantinedWorkspace("free-text-answer");
    git(ws.path, "branch", "extra");
    const extra = git(ws.path, "rev-parse", "extra");

    const answered = await answer(db, ws, text);

    expect(getTask(db, question.id)!.status).toBe("done");
    expect(git(ws.path, "rev-parse", "extra")).toBe(extra);
    expect(git(ws.path, "for-each-ref", "refs/keep-around/")).toBe("");
    expect(restoredEvents(db)).toEqual([]);
    expect(answered.notice).toBeUndefined();
    expect(JSON.stringify(latestEventOfTask(db, question.id, "question_answered")!.payload)).toContain(JSON.stringify(text));
    db.close();
  },
);

it("同じ workspace への2つ目の回答は、1つ目の検査中は拒まれ、何も書かない(ADR 0373 決定8)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("in-flight-key");
  git(ws.path, "branch", "extra");

  const first = answer(db, ws, "repaired by hand");
  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(
    `another answer or operation for workspace ${ws.name} is being checked — try again once it has finished.`,
  );
  expect(git(ws.path, "for-each-ref", "refs/keep-around/")).toBe("");
  await first;

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(ws.path, "for-each-ref", "refs/heads/extra")).not.toBe("");
  expect(restoredEvents(db)).toEqual([]);
  db.close();
});

it.each(["repaired by hand", "restore the baseline", "a free-text note"])(
  "その workspace で session か後始末が走っている間は、どの選択肢(%s)も拒まれ、何も書かない(ADR 0373 帰結)",
  async (text) => {
    const { ws, db, question } = await quarantinedWorkspace("session-running");
    git(ws.path, "branch", "extra");
    const refsBefore = git(ws.path, "for-each-ref");
    const rowBefore = baseline(db, ws.name);
    const releasing = work(db, "its release raised the Quarantine");
    markTeardown(db, releasing.id, NOW);

    await expect(answer(db, ws, text)).rejects.toThrow(`a session or its teardown is still running in workspace ${ws.name} — answer again once it has finished`);

    expect(git(ws.path, "for-each-ref")).toBe(refsBefore);
    expect(baseline(db, ws.name)).toEqual(rowBefore);
    expect(restoredEvents(db)).toEqual([]);
    expect(getTask(db, question.id)!.status).toBe("todo");
    db.close();
  },
);

/** 面接室を開いて root を1度拾って解放した盤面(面接室の基準の行と sparse の pin がある)。`pose` なら出題もする。 */
async function restedRoom(name: string, pose = false) {
  const db = openDb(":memory:");
  const ws = await makeWorkspace(name);
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: ws.name, interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir(`${name}-rooms-`);
  openInterviewRoom(db, root, base, NOW);
  const { room, place } = await pickUpInterviewRoot(db, root, ws);
  if (pose) poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, place, root.id));
  releaseWorkspace(db, place, root, NOW);
  expect(baseline(db, root.id).size).toBeGreaterThan(0);
  return { db, ws, root, room, base };
}

const sparsePin = (db: Db, name: string) => db.prepare("SELECT policy FROM workspace_sparse_policies WHERE name = ?").pluck().get(name);
const stateRow = (db: Db, name: string) => db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(name);

/** 面接室の名前の Quarantine に `text` で答える。 */
function answerRoom(db: Db, rootId: string, base: string, text: string) {
  return submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspacesDir: base }) }, quarantineQuestion(db, "workspace", rootId)!, [text], undefined, () => NOW, "webui");
}

it.each(["repaired by hand", "restore the baseline"])("repo の無い面接室への `%s` は比べる前に拒まれ、何も書かない(ADR 0373 決定11)", async (text) => {
  const { db, root, room, base } = await restedRoom("gone-room-other-option");
  rmSync(room.path, { recursive: true, force: true });
  quarantineWorkspace(db, root.id, new Error("the interview room is gone"), NOW);
  const rowBefore = stateRow(db, root.id);

  await expect(answerRoom(db, root.id, base, text)).rejects.toThrow("has no git repository");

  expect(existsSync(room.path)).toBe(false);
  expect(stateRow(db, root.id)).toBe(rowBefore);
  expect(restoredEvents(db)).toEqual([]);
  db.close();
});

it.each([
  ["出題済みの面接室", true, false, "has already posed"],
  ["repo が残っている面接室", false, true, "still holds a git repository"],
] as const)("%sへの `run with an empty room` は拒まれ、何も書かない(ADR 0373 決定11)", async (_, pose, keepRepository, refusal) => {
  const { db, root, room, base } = await restedRoom("empty-room-refused", pose);
  if (!keepRepository) rmSync(room.path, { recursive: true, force: true });
  quarantineWorkspace(db, root.id, new Error("the interview room broke"), NOW);
  const rowBefore = stateRow(db, root.id);
  const pinBefore = sparsePin(db, root.id);

  await expect(answerRoom(db, root.id, base, "run with an empty room")).rejects.toThrow(refusal);

  expect(existsSync(join(room.path, ".git"))).toBe(keepRepository);
  expect(stateRow(db, root.id)).toBe(rowBefore);
  expect(sparsePin(db, root.id)).toBe(pinBefore);
  db.close();
});

it("面接室を開く session の後始末が走っている間は、`run with an empty room` も拒まれ、何も書かない(ADR 0373 帰結)", async () => {
  const { db, root, room, base } = await restedRoom("empty-room-teardown");
  rmSync(room.path, { recursive: true, force: true });
  quarantineWorkspace(db, root.id, new Error("the interview room is gone"), NOW);
  const rowBefore = stateRow(db, root.id);
  markTeardown(db, root.id, NOW);

  await expect(answerRoom(db, root.id, base, "run with an empty room")).rejects.toThrow(`a session or its teardown is still running in workspace ${root.id}`);

  expect(existsSync(room.path)).toBe(false);
  expect(stateRow(db, root.id)).toBe(rowBefore);
  db.close();
});

const B1 = (place: string) =>
  `Answering checks that every ref of ${place} equals the board's baseline; nothing that moved is accepted. ` +
  "`repaired by hand`: you repaired something other than refs — the board checks and refuses if a ref differs. " +
  "`restore the baseline`: the board writes every differing ref back to the baseline and keeps each value it removes under `refs/keep-around/<sha>`. " +
  "If a merge back conflicts, the refusal says where to resolve it.";

it("workspace の Quarantine の本文は選択肢がそれぞれ何をするかを言い、選択肢は `repaired by hand` と `restore the baseline` の常設の2つ(ADR 0373 決定2・16、text B1)", async () => {
  const { ws, question } = await quarantinedWorkspace("body-workspace");

  expect(question.purpose).toContain(`\n${B1(`workspace ${ws.name}`)}\n`);
  expect(question.purpose).not.toContain("run with an empty room");
  expect(question.question_items).toEqual([expect.objectContaining({ options: ["repaired by hand", "restore the baseline"], recommendation: "repaired by hand" })]);
});

it("面接室の名前の Quarantine は `run with an empty room` の説明と選択肢を加える —— 出題済みでも出し分けない(ADR 0373 決定2・11、text B1)", async () => {
  const { db, root } = await restedRoom("body-room", true);
  quarantineWorkspace(db, root.id, new Error("the interview room broke"), NOW);
  const question = quarantineQuestion(db, "workspace", root.id)!;

  expect(question.purpose).toContain(`\n${B1(`the interview room ${root.id}`)} \`run with an empty room\`: the board re-creates the room empty.\n`);
  expect(question.question_items).toEqual([expect.objectContaining({ options: ["repaired by hand", "restore the baseline", "run with an empty room"], recommendation: "repaired by hand" })]);
  db.close();
});
