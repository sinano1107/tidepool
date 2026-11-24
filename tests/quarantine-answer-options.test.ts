import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { latestEventOfTask, listEventsOfKinds } from "../src/events.js";
import { GitHubAuth, HEAD_REPO_REMOTE } from "../src/github-auth.js";
import { type QuarantineCheckDeps, quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { repositoryLabel } from "../src/repo-access.js";
import { getTask, registerTask, type Task } from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import { announceHeadRepo, assertRememberedHeadRepo, boardRefWriter, quarantineWorkspace, releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeLandingWorkspace, makeRemoteBackedWorkspace, makeWorkspace, pickUpInterviewRoot, prepareAtPickup, quarantineQuestion, rememberFixtureHeadRepos, restedInterviewRoom, shimGit } from "./harness.js";
import { fetchHeldAtToken } from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

// workspace の Quarantine の回答が盤面の行為を選ぶ(ADR 0373 決定2〜5・8・11、ADR 0380 決定4、#3277 / #3285)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T00:00:00.000Z");

function work(db: Db, title: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
}

/** 1件を拾って解放し(基準の行と `task/<id>` が残る)、workspace の Quarantine が開いた盤面。 */
async function quarantinedWorkspace(name: string, remoteBacked = false) {
  return quarantined(remoteBacked ? (await makeLandingWorkspace(name)).workspace : await makeWorkspace(name));
}

async function quarantined(ws: WorkspaceConfig, remember = rememberFixtureHeadRepos) {
  const db = openDb(":memory:");
  remember(db);
  const task = work(db, "leaves a task branch");
  releaseWorkspace(db, await prepareAtPickup(db, ws, task), task, NOW);
  quarantineWorkspace(db, ws.name, new Error("a human touched the checkout"), NOW);
  return { ws, db, task, question: quarantineQuestion(db, "workspace", ws.name)! };
}

/** 名前 `name` の開いている workspace の Quarantine に人間が `text` で答える(回答の口)。 */
function answerAs(db: Db, name: string, checks: Omit<QuarantineCheckDeps, "db" | "quarantineResolvers">, text: string) {
  return submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db, ...checks }) }, quarantineQuestion(db, "workspace", name)!, [text], undefined, () => NOW, "webui");
}

/** `ws` は回答の時点で引ける workspace。 */
const answer = (db: Db, ws: WorkspaceConfig, text: string) => answerAs(db, ws.name, { workspace: ws }, text);
const answerRoom = (db: Db, rootId: string, base: string, text: string) => answerAs(db, rootId, { workspacesDir: base }, text);

/** 次の pickup の比較の答え —— 通れば "passes"、止まればその文。基準の行が何を持つかを、盤面がそれを読む場所で読む。 */
const nextComparison = (db: Db, ws: WorkspaceConfig) => prepareAtPickup(db, ws, work(db, "reads the baseline")).then(() => "passes", (err: Error) => err.message);

/** 面接室の基準の行が残っている —— 面接室に人間が作った branch を、開き直す root の pickup の比較が名指す(行が無ければ最初の撮りで通る)。 */
async function expectRoomRowKept(db: Db, root: Task, room: WorkspaceConfig, ws: WorkspaceConfig) {
  git(room.path, "branch", "probe-row");
  await expect(pickUpInterviewRoot(db, root, ws)).rejects.toThrow("refs/heads/probe-row");
}

const GIVE_UP = "give up the lost refs and restore the baseline";
const restoredEvents = (db: Db) => listEventsOfKinds(db, ["baseline_restored"]).map(({ payload }) => payload);

/** text B2 の比較器の文の後ろ。 */
const B2_EXIT =
  ". The board does not accept moved refs. Answer `restore the baseline` to put them back; the values it removes stay under `refs/keep-around/<sha>`, " +
  "and to keep that content you merge or cherry-pick it in a workbench afterwards.";

/** ref の名前と値 —— object を読まないので、壊した object を指す ref があっても読める。 */
const refsOf = (ws: WorkspaceConfig) => git(ws.path, "for-each-ref", "--format=%(objectname) %(refname)");

/** 拒まれた回答の文。 */
const refusal = (answering: Promise<unknown>) => answering.then(() => "accepted", (err: Error) => err.message);

it("`repaired by hand` は動いた・作られた・消された ref をそれぞれ比較器の形で名指す text B2 で拒み、ref も基準の行も書かず、question は開いたまま(ADR 0373 決定1・7・16、pin B1)", async () => {
  const { ws, db, task, question } = await quarantinedWorkspace("by-hand-refused");
  const main = git(ws.path, "rev-parse", "main");
  const taskRef = `refs/heads/task/${task.id}`;
  const taskTip = git(ws.path, "rev-parse", taskRef);
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const moved = git(ws.path, "rev-parse", "main");
  git(ws.path, "branch", "extra");
  git(ws.path, "branch", "-D", `task/${task.id}`);
  const refsBefore = refsOf(ws);
  const comparisonBefore = await nextComparison(db, ws);

  const message = await refusal(answer(db, ws, "repaired by hand"));

  expect(message).toMatch(new RegExp(`^workspace ${ws.name}: refs changed since the board's baseline — `));
  for (const line of [`was: ${main} refs/heads/main`, `was: ${taskTip} ${taskRef}`, `now: ${moved} refs/heads/main`, `now: ${moved} refs/heads/extra`]) expect(message).toContain(line);
  expect(message.endsWith(B2_EXIT)).toBe(true);
  expect(refsOf(ws)).toBe(refsBefore);
  expect(await nextComparison(db, ws)).toBe(comparisonBefore);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("1回目の比較を通って後の検査で拒まれた回答は ref を書かないが、落ちた盤面が残した2値の行を ref が持つ側に畳んでいる(spec #3273 の受理の順、pin B1)", async () => {
  const { ws, db } = await quarantinedWorkspace("by-hand-folds-then-refused");
  const tip = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "the board wrote this, then dropped");
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, ws)("refs/heads/written", tip, () => git(ws.path, "update-ref", "refs/heads/written", tip))).toThrow("the board dropped");
  reopen();
  writeFileSync(join(ws.path, "README.md"), "uncommitted\n");
  const refsBefore = refsOf(ws);

  await expect(answer(db, ws, "repaired by hand")).rejects.toThrow("still has uncommitted changes");

  expect(refsOf(ws)).toBe(refsBefore);
  // 2値の行(作成の予告)のままなら、ref を消しても比較は通る —— 畳んだ行は書いた値の1値なので、消した ref を名指す
  git(ws.path, "checkout", "--", "README.md");
  git(ws.path, "update-ref", "-d", "refs/heads/written");
  expect(await nextComparison(db, ws)).toContain(`was: ${tip} refs/heads/written`);
  db.close();
});

it("どの ref も基準と同じなら `repaired by hand` は受理され、基準の行は撮り直されない(ADR 0373 決定1、pin B2)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("by-hand-accepted");

  await answer(db, ws, "repaired by hand");

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(await nextComparison(db, ws)).toBe("passes");
  db.close();
});

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
  // HEAD の symref の行を付け替える(tree は main と同じ)—— 名前なので戻すだけ
  git(ws.path, "symbolic-ref", "HEAD", keep);
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
  // 撮り直しは走っていない —— 退避した ref も戻した ref も口を通って基準に入り、消した人間の keep-around の ref は基準に残らない
  expect(await nextComparison(db, ws)).toBe("passes");
  db.close();
});

it("戻す先の object が1つでも無ければ、`restore the baseline` はその ref を名指して拒み、何も書かない(ADR 0373 決定3)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-lost-object");
  const lost = loseRef(db, ws, "refs/heads/lost");
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const refsBefore = refsOf(ws);
  const comparisonBefore = await nextComparison(db, ws);

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(
    `cannot restore refs/heads/lost to ${lost}: that commit no longer exists in ${ws.path}. Nothing was written. If these are lost for good, answer \`give up the lost refs and restore the baseline\`.`,
  );

  expect(refsOf(ws)).toBe(refsBefore);
  expect(await nextComparison(db, ws)).toBe(comparisonBefore);
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

it("registry の `path` を別の checkout へ差し替えると、`repaired by hand` は違いの文 B2 で拒み、`restore the baseline` は無い object を名指す B3 で拒み、どちらも何も書かない(ADR 0373 決定6、pin B11)", async () => {
  const { ws, db, task, question } = await quarantinedWorkspace("swapped-path");
  // 差し替え先に無い object を基準に持たせる —— fixture の最初の commit は2つの repo で同じ sha になりうる
  const onlyHere = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "only in the registered checkout");
  boardWrites(db, ws, "refs/heads/only-here", onlyHere);
  const other = await makeWorkspace("swapped-path-other");
  const swapped = { ...ws, path: other.path };
  const refsBefore = git(other.path, "for-each-ref");

  const byHand = await refusal(answer(db, swapped, "repaired by hand"));
  const restored = await refusal(answer(db, swapped, "restore the baseline"));

  expect(byHand).toMatch(new RegExp(`^workspace ${ws.name}: refs changed since the board's baseline — `));
  expect(byHand).toContain(`was: ${git(ws.path, "rev-parse", `task/${task.id}`)} refs/heads/task/${task.id}`);
  expect(byHand).toContain(`was: ${onlyHere} refs/heads/only-here`);
  expect(byHand.endsWith(B2_EXIT)).toBe(true);
  expect(restored).toContain(`cannot restore refs/heads/only-here to ${onlyHere}: that commit no longer exists in ${other.path}`);
  expect(restored).toContain("Nothing was written. If these are lost for good, answer `give up the lost refs and restore the baseline`.");
  expect(git(other.path, "for-each-ref")).toBe(refsBefore);
  expect(git(other.path, "for-each-ref", "refs/keep-around/")).toBe("");
  // 差し替え先の ref を基準に入れていれば、登録した checkout の次の比較が名指す
  expect(await nextComparison(db, ws)).toBe("passes");
  expect(restoredEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("在り処が消えた記録済みの面接室に手で `git init` してからの `repaired by hand` は、消えた ref を名指す B2 で拒まれる —— 保護ブランチの無い面接室を受理しない(ADR 0373 決定1・11、#3277 の穴)", async () => {
  const { db, root, room, base } = await restedInterviewRoom("hand-init-room", false);
  const main = git(room.path, "rev-parse", "main");
  rmSync(room.path, { recursive: true, force: true });
  git(base, "init", "--quiet", "--initial-branch=main", room.path);
  quarantineWorkspace(db, root.id, new Error("the interview room is gone"), NOW);

  const message = await refusal(answerRoom(db, root.id, base, "repaired by hand"));

  expect(message).toContain(`was: ${main} refs/heads/main`);
  expect(message.endsWith(B2_EXIT)).toBe(true);
  expect(getTask(db, quarantineQuestion(db, "workspace", root.id)!.id)!.status).toBe("todo");
  db.close();
});

it("面接室の名前への受理の比較は面接室だけを読み、Interview の root が読む実環境で動いた ref を名指さない(ADR 0373 決定7、pin B21)", async () => {
  const { db, ws, root, base } = await restedInterviewRoom("room-compares-room-only", false);
  git(ws.path, "branch", "moved-in-the-real-environment");
  quarantineWorkspace(db, root.id, new Error("the interview room needs a look"), NOW);
  const question = quarantineQuestion(db, "workspace", root.id)!;

  await answerRoom(db, root.id, base, "repaired by hand");

  expect(getTask(db, question.id)!.status).toBe("done");
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

const DISCARD = "Discard them with `git reset --hard` then `git clean -fd` until `git status --porcelain` is empty";
const FIX_BRANCH = "Fix `branch` in the registry entry.";
const PUSH_COMMITS = "Push those commits to origin from your own clone. If the branches stay diverged, cancel the tasks, delete the workspace and register it again.";

it("ref を動かさない直し方(text A12): dirty な tree の拒否は捨てるコマンドを、無い保護ブランチの拒否は registry の `branch` を言い、Quarantine の検査の一覧も同じ直し方を言う(ADR 0373 決定16)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("no-ref-move-repairs");
  writeFileSync(join(ws.path, "README.md"), "uncommitted\n");

  await expect(answer(db, ws, "repaired by hand")).rejects.toThrow(`workspace ${ws.name} still has uncommitted changes. ${DISCARD}`);
  git(ws.path, "checkout", "--", "README.md");
  await expect(answer(db, { ...ws, branch: "missing" }, "repaired by hand")).rejects.toThrow(`protected branch 'missing' cannot be checked out`);
  const missing = await refusal(answer(db, { ...ws, branch: "missing" }, "repaired by hand"));
  expect(missing).toContain(`If the branch is missing: ${FIX_BRANCH}`);
  // 直し方は落ちた項の説明に1度だけ載る
  expect(missing.split(FIX_BRANCH)).toHaveLength(2);

  expect(question.purpose).toContain(`Discard uncommitted changes with \`git reset --hard\``);
  expect(question.purpose).toContain(`If the branch is missing: ${FIX_BRANCH}`);
  expect(question.purpose).toContain(`If local commits are ahead of or diverged from origin: ${PUSH_COMMITS}`);
  db.close();
});

it("remote-backed で盤面が書いた local の保護ブランチが origin より先行していれば、受理の拒否は push して直す道を言い、branch を作らせない(text A12 の H9)", async () => {
  const { ws, db } = await quarantinedWorkspace("no-ref-move-ahead", true);
  boardWrites(db, ws, "refs/heads/main", git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "never pushed"));

  const message = await refusal(answer(db, ws, "repaired by hand"));

  expect(message).toContain("is ahead of refs/remotes/origin/main");
  expect(message).toContain(`If local commits are ahead of or diverged from origin: ${PUSH_COMMITS}`);
  // 直し方は落ちた項の説明に1度だけ載る
  expect(message.split(PUSH_COMMITS)).toHaveLength(2);
  db.close();
});

it("面接室の名前の検査の一覧は registry の `branch` を直す道を言わない —— 面接室の保護ブランチは registry に無い(text A12 の H10)", async () => {
  const { db, root } = await restedInterviewRoom("room-no-registry-branch", false);
  quarantineWorkspace(db, root.id, new Error("the interview room broke"), NOW);

  expect(quarantineQuestion(db, "workspace", root.id)!.purpose).not.toContain(FIX_BRANCH);
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
  "選択肢と完全に一致しない回答(%s)は `repaired by hand` の道を通る —— ref が違う間は拒まれて何も書き戻さず、違いが無くなれば受理され、文は修理メモとして残る(ADR 0373 決定2、pin B3 / B25)",
  async (text) => {
    const { ws, db, question } = await quarantinedWorkspace("free-text-answer");
    git(ws.path, "branch", "extra");
    const extra = git(ws.path, "rev-parse", "extra");

    await expect(answer(db, ws, text)).rejects.toThrow(`now: ${extra} refs/heads/extra${B2_EXIT}`);
    expect(git(ws.path, "rev-parse", "extra")).toBe(extra);
    expect(getTask(db, question.id)!.status).toBe("todo");
    git(ws.path, "branch", "-D", "extra");
    const answered = await answer(db, ws, text);

    expect(getTask(db, question.id)!.status).toBe("done");
    expect(git(ws.path, "for-each-ref", "refs/keep-around/")).toBe("");
    expect(restoredEvents(db)).toEqual([]);
    expect(answered.notice).toBeUndefined();
    expect(JSON.stringify(latestEventOfTask(db, question.id, "question_answered")!.payload)).toContain(JSON.stringify(text));
    db.close();
  },
);

it("同じ workspace への2つ目の回答は、1つ目の検査中は拒まれ、何も書かない(ADR 0373 決定8)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("in-flight-key");

  // 1つ目は1回目の比較を通ってから待つ —— その間に作った branch を、拒まれなかった2つ目の `restore the baseline` なら書き戻す
  const first = answer(db, ws, "repaired by hand");
  git(ws.path, "branch", "extra");
  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(
    `another answer or operation for workspace ${ws.name} is being checked — try again once it has finished.`,
  );
  // 1つ目は2回目の比較がその branch を名指して拒む
  await expect(first).rejects.toThrow("refs/heads/extra");

  expect(git(ws.path, "for-each-ref", "refs/heads/extra")).not.toBe("");
  expect(git(ws.path, "for-each-ref", "refs/keep-around/")).toBe("");
  expect(restoredEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it.each(["repaired by hand", "restore the baseline", "a free-text note"])(
  "その workspace で session か後始末が走っている間は、どの選択肢(%s)も拒まれ、何も書かない(ADR 0373 帰結)",
  async (text) => {
    const { ws, db, question } = await quarantinedWorkspace("session-running");
    // ADR 0373 決定7: 違う ref があれば `repaired by hand` は走行中の検査より前の比較で拒まれる —— 違いを運ぶのは戻す選択肢だけ
    const restoring = text === "restore the baseline";
    if (restoring) git(ws.path, "branch", "extra");
    const refsBefore = refsOf(ws);
    const releasing = work(db, "its release raised the Quarantine");
    markTeardown(db, releasing.id, NOW);

    await expect(answer(db, ws, text)).rejects.toThrow(`a session or its teardown is still running in workspace ${ws.name} — answer again once it has finished`);

    expect(refsOf(ws)).toBe(refsBefore);
    expect(restoredEvents(db)).toEqual([]);
    expect(getTask(db, question.id)!.status).toBe("todo");
    if (restoring) expect(await nextComparison(db, ws)).toContain("now: ");
    db.close();
  },
);

it.each(["repaired by hand", "restore the baseline"])("repo の無い面接室への `%s` は比べる前に拒まれ、何も書かない(ADR 0373 決定11)", async (text) => {
  const { db, ws, root, room, base } = await restedInterviewRoom("gone-room-other-option", false);
  renameSync(room.path, `${room.path}.aside`);
  quarantineWorkspace(db, root.id, new Error("the interview room is gone"), NOW);

  await expect(answerRoom(db, root.id, base, text)).rejects.toThrow("has no git repository");

  expect(existsSync(room.path)).toBe(false);
  expect(restoredEvents(db)).toEqual([]);
  renameSync(`${room.path}.aside`, room.path);
  await expectRoomRowKept(db, root, room, ws);
  db.close();
});

it.each([
  ["出題済みの面接室", true, false, "has already posed"],
  ["repo が残っている面接室", false, true, "still holds a git repository"],
] as const)("%sへの `run with an empty room` は拒まれ、何も書かない(ADR 0373 決定11)", async (_, pose, keepRepository, refusal) => {
  const { db, ws, root, room, base } = await restedInterviewRoom("empty-room-refused", pose);
  if (!keepRepository) renameSync(room.path, `${room.path}.aside`);
  quarantineWorkspace(db, root.id, new Error("the interview room broke"), NOW);

  await expect(answerRoom(db, root.id, base, "run with an empty room")).rejects.toThrow(refusal);

  expect(existsSync(join(room.path, ".git"))).toBe(keepRepository);
  if (!keepRepository) renameSync(`${room.path}.aside`, room.path);
  await expectRoomRowKept(db, root, room, ws);
  db.close();
});

it("面接室を開く session の後始末が走っている間は、`run with an empty room` も拒まれ、何も書かない(ADR 0373 帰結)", async () => {
  const { db, ws, root, room, base } = await restedInterviewRoom("empty-room-teardown", false);
  renameSync(room.path, `${room.path}.aside`);
  quarantineWorkspace(db, root.id, new Error("the interview room is gone"), NOW);
  markTeardown(db, root.id, NOW);

  await expect(answerRoom(db, root.id, base, "run with an empty room")).rejects.toThrow(`a session or its teardown is still running in workspace ${root.id}`);

  expect(existsSync(room.path)).toBe(false);
  renameSync(`${room.path}.aside`, room.path);
  await expectRoomRowKept(db, root, room, ws);
  db.close();
});

const B1 = (place: string) =>
  `Answering checks that every ref of ${place} equals the board's baseline; nothing that moved is accepted. ` +
  "`repaired by hand`: you repaired something other than refs — the board checks and refuses if a ref differs. " +
  "`restore the baseline`: the board writes every differing ref back to the baseline and keeps each value it removes under `refs/keep-around/<sha>`. " +
  "`give up the lost refs and restore the baseline`: the same, and refs whose commits no longer exist — here, and on the remote when the workspace has one — are accepted as they are now, except a lost task branch `task/<id>`: the board keeps its current value under `refs/keep-around/<sha>` and deletes it, and the next pickup or start_work of an unsettled task makes it again; landing ends for a completed task whose branch was lost: its open landing questions close, it leaves the auto-merge queue, and an open PR is left on GitHub as it is; the reviews and repairs attached to work that was lost with its branch, and to work that returns into it, are cancelled. " +
  "If a merge back conflicts, the refusal says where to resolve it.";

it("workspace の Quarantine の本文は選択肢がそれぞれ何をするかを言い、選択肢は `repaired by hand`・`restore the baseline`・`give up the lost refs and restore the baseline` の常設の3つ(ADR 0373 決定2・16、#3273 text B1)", async () => {
  const { ws, question } = await quarantinedWorkspace("body-workspace");

  expect(question.purpose).toContain(`\n${B1(`workspace ${ws.name}`)}\n`);
  expect(question.purpose).not.toContain("run with an empty room");
  expect(question.question_items).toEqual([expect.objectContaining({ options: ["repaired by hand", "restore the baseline", GIVE_UP], recommendation: "repaired by hand" })]);
});

it("面接室の名前の Quarantine は `run with an empty room` の説明と選択肢を加える —— 出題済みでも出し分けない(ADR 0373 決定2・11、#3273 text B1)", async () => {
  const { db, root } = await restedInterviewRoom("body-room", true);
  quarantineWorkspace(db, root.id, new Error("the interview room broke"), NOW);
  const question = quarantineQuestion(db, "workspace", root.id)!;

  expect(question.purpose).toContain(`\n${B1(`the interview room ${root.id}`)} \`run with an empty room\`: the board re-creates the room empty.\n`);
  expect(question.question_items).toEqual([expect.objectContaining({ options: ["repaired by hand", "restore the baseline", GIVE_UP, "run with an empty room"], recommendation: "repaired by hand" })]);
  db.close();
});

it.each(["repaired by hand", "restore the baseline"])("基準の行が無い名前への `%s` は比べずに通り、何も書き戻さず、行も作らない(ADR 0373 決定7、pin B21)", async (text) => {
  const ws = await makeWorkspace("answer-without-row");
  const db = openDb(":memory:");
  git(ws.path, "branch", "extra");
  quarantineWorkspace(db, ws.name, new Error("the first pickup stopped before any capture"), NOW);
  const refsBefore = refsOf(ws);

  await answer(db, ws, text);

  expect(refsOf(ws)).toBe(refsBefore);
  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(restoredEvents(db)).toEqual([]);
  // 行を作っていれば、次の pickup の比較が後から作った branch を名指す
  git(ws.path, "branch", "after-the-answer");
  expect(await nextComparison(db, ws)).toBe("passes");
  db.close();
});

it("人間が作った refs/heads/a/b を消してから基準の refs/heads/a を戻す —— 書き戻しは削除が先(ADR 0373 決定3)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-dir-file-conflict");
  const tip = git(ws.path, "rev-parse", "main");
  boardRefWriter(db, ws)("refs/heads/a", tip, () => git(ws.path, "update-ref", "refs/heads/a", tip));
  git(ws.path, "update-ref", "-d", "refs/heads/a");
  git(ws.path, "update-ref", "refs/heads/a/b", tip);

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "for-each-ref", "--format=%(refname)", "refs/heads/a", "refs/heads/a/")).toBe("refs/heads/a");
  db.close();
});

it("detached の HEAD が持っていた sha は、ほかの値と同じに refs/keep-around/<sha> と event と応答に残る —— HEAD の symref の行は名前なので持たない(ADR 0373 決定4)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-detached-head");
  const main = git(ws.path, "rev-parse", "main");
  git(ws.path, "checkout", "-q", "--detach");
  commitWork(ws.path, "detached.txt", "committed on a detached HEAD\n");
  const detached = git(ws.path, "rev-parse", "HEAD");

  const answered = await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(ws.path, "rev-parse", "HEAD")).toBe(main);
  expect(git(ws.path, "rev-parse", `refs/keep-around/${detached}`)).toBe(detached);
  expect(restoredEvents(db)[0]!.kept).toEqual([{ ref: "HEAD", sha: detached }]);
  expect(answered.notice).toBe(`HEAD was ${detached}, kept as refs/keep-around/${detached}`);
  db.close();
});

it("書き戻しの途中で update-ref が落ちても、HEAD とその branch は元の tip のままで tree もそれに揃い、`baseline_restored` は書けた分だけを残す(ADR 0373 決定3・4)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-fails-midway");
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const moved = git(ws.path, "rev-parse", "main");
  const commit = (message: string) => git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", message);
  const [extra, tagged] = [commit("extra"), commit("tagged")] as [string, string];
  git(ws.path, "branch", "extra", extra);
  git(ws.path, "tag", "x", tagged);
  // 残った lock が refs/tags/x の削除だけを落とす
  writeFileSync(join(ws.path, ".git", "refs", "tags", "x.lock"), "");

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow("refs/tags/x");

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(ws.path, "rev-parse", "main")).toBe(moved);
  expect(existsSync(join(ws.path, "by-hand.txt"))).toBe(true);
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "for-each-ref", "refs/heads/extra")).toBe("");
  expect(git(ws.path, "rev-parse", "refs/tags/x")).toBe(tagged);
  const [event] = restoredEvents(db);
  expect(event!.restored).toEqual(["refs/heads/extra"]);
  expect(event!.kept).toEqual(expect.arrayContaining([{ ref: "refs/heads/main", sha: moved }, { ref: "refs/heads/extra", sha: extra }, { ref: "refs/tags/x", sha: tagged }]));
  expect(event!.kept).toHaveLength(3);
  db.close();
});

it("object の無い値を指す ref は消すだけで、その値は refs/keep-around に持たない(ADR 0373 決定4)", async () => {
  const { ws, db } = await quarantinedWorkspace("restore-missing-current");
  const missing = "1111111111111111111111111111111111111111";
  writeFileSync(join(ws.path, ".git", "refs", "heads", "ghost"), `${missing}\n`);

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "for-each-ref", "refs/heads/ghost")).toBe("");
  expect(git(ws.path, "for-each-ref", "refs/keep-around/")).toBe("");
  expect(restoredEvents(db)[0]).toMatchObject({ restored: ["refs/heads/ghost"], kept: [] });
  db.close();
});

it("`.git` が消えても在り処にファイルが残る面接室への `run with an empty room` は、書く前に拒まれ、在り処も行も変わらない(ADR 0373 決定11)", async () => {
  const { db, ws, root, room, base } = await restedInterviewRoom("empty-room-leftover-files", false);
  const aside = `${room.path}.git-aside`;
  renameSync(join(room.path, ".git"), aside);
  writeFileSync(join(room.path, "left-behind.txt"), "a file the gone repository left\n");
  quarantineWorkspace(db, root.id, new Error("the interview room is gone"), NOW);

  await expect(answerRoom(db, root.id, base, "run with an empty room")).rejects.toThrow(`the interview room ${root.id} at ${room.path} is not empty`);

  expect(readdirSync(room.path)).toEqual(["left-behind.txt"]);
  renameSync(aside, join(room.path, ".git"));
  rmSync(join(room.path, "left-behind.txt"));
  await expectRoomRowKept(db, root, room, ws);
  db.close();
});

const lostEvents = (db: Db) => listEventsOfKinds(db, ["lost_refs_accepted"]).map(({ payload }) => payload);

/** 盤面が口で `ref` を `sha` に書く —— 基準に入る。 */
const boardWrites = (db: Db, ws: WorkspaceConfig, ref: string, sha: string) => boardRefWriter(db, ws)(ref, sha, () => git(ws.path, "update-ref", ref, sha));

/** 人間が `refs` を消し、どこからも届かなくなった commit を gc で手元から失わせる。 */
function dropAndPrune(ws: WorkspaceConfig, ...refs: string[]) {
  for (const ref of refs) git(ws.path, "update-ref", "-d", ref);
  git(ws.path, "reflog", "expire", "--expire=now", "--all");
  git(ws.path, "gc", "--quiet", "--prune=now");
}

/** 盤面が口で `ref` を main の上の新しい commit に書き(基準に入る)、人間がその ref を消すか `movedTo` へ動かし、commit を gc で失わせる。失われた sha を返す。
 *  `keptOn` の repo(origin や出元 repo)は、その commit を持ったまま残る。 */
function loseRef(db: Db, ws: WorkspaceConfig, ref: string, movedTo?: string, keptOn?: string): string {
  const lost = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", `only on ${ref}`);
  boardWrites(db, ws, ref, lost);
  if (keptOn !== undefined) git(keptOn, "fetch", "--quiet", ws.path, `${lost}:refs/heads/kept-${lost}`);
  if (movedTo !== undefined) git(ws.path, "update-ref", ref, movedTo);
  dropAndPrune(ws, ...(movedTo === undefined ? [ref] : []));
  return lost;
}

/** origin だけが `refs/heads/other` を別の commit で持つ —— commit は origin の中で作り、checkout には入れない。 */
function originHoldsOther(ws: WorkspaceConfig) {
  git(ws.repo!, "update-ref", "refs/heads/other", git(ws.repo!, "commit-tree", "main^{tree}", "-p", "main", "-m", "origin's own other head"));
}

// 根が refname 順で先 —— 根の head が先に届き、そこから届く子の tip は sha で取り直さない
const ROOT = "refs/heads/task/a-root";
const CHILD = "refs/heads/task/b-child";

/** 根 `ROOT` とその merge back が届いている子 `CHILD` を盤面が書き、根の head だけを出元 repo へ push してから手元で失わせる。 */
function loseRootAndChildKeptOnFork(db: Db, ws: WorkspaceConfig) {
  const child = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "the child's tip");
  const root = git(ws.path, "commit-tree", "main^{tree}", "-p", child, "-m", "the root's head, merged back from the child");
  boardWrites(db, ws, CHILD, child);
  boardWrites(db, ws, ROOT, root);
  // 出元 repo の側から取る —— git 2.56 から、remote と同じ URL への push は写しの ref も書き、残った写しが gc から commit を守る
  git(ws.head_repo!, "fetch", "--quiet", ws.path, `${ROOT}:${ROOT}`);
  dropAndPrune(ws, CHILD, ROOT);
  return { child, root };
}

it("`give up the lost refs and restore the baseline` は戻す先の object が無い ref だけを今の値で基準に入れ(ref が無ければ行を消す)、ほかは基準へ戻し、`lost_refs_accepted` に ref と失われた sha を残す(ADR 0373 決定5、pin B8)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("give-up-core");
  const main = git(ws.path, "rev-parse", "main");
  const gone = loseRef(db, ws, "refs/heads/gone");
  const movedTo = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "a human moved the lost ref here");
  const moved = loseRef(db, ws, "refs/heads/moved", movedTo);
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const byHand = git(ws.path, "rev-parse", "main");

  await answer(db, ws, GIVE_UP);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(ws.path, "rev-parse", "main")).toBe(main);
  expect(git(ws.path, "rev-parse", `refs/keep-around/${byHand}`)).toBe(byHand);
  expect(git(ws.path, "for-each-ref", "refs/heads/gone")).toBe("");
  expect(git(ws.path, "rev-parse", "refs/heads/moved")).toBe(movedTo);
  expect(git(ws.path, "for-each-ref", "refs/keep-around/")).not.toContain(movedTo);
  expect(lostEvents(db)).toEqual([{ kind: "lost_refs_accepted", workspace: ws.name, lost: expect.arrayContaining([{ ref: "refs/heads/gone", sha: gone }, { ref: "refs/heads/moved", sha: moved }]) }]);
  expect(lostEvents(db)[0]!.lost).toHaveLength(2);
  expect(restoredEvents(db)[0]!.restored).toEqual(["refs/heads/main"]);
  expect(await nextComparison(db, ws)).toBe("passes");
  db.close();
});

it("失われた ref が無ければ `give up the lost refs and restore the baseline` は `restore the baseline` を名指して拒み、何も書かない(ADR 0373 決定5、pin B8、text B4a)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("give-up-nothing-lost");
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const refsBefore = refsOf(ws);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(`no ref of workspace ${ws.name} is lost — answer \`restore the baseline\`.`);

  expect(refsOf(ws)).toBe(refsBefore);
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("保護ブランチの無い repo(空の `git init`)への `give up the lost refs and restore the baseline` は、ref も event も書く前に拒む(ADR 0373 決定5、pin B8、text B4b)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("give-up-no-protected-branch");
  for (const entry of readdirSync(ws.path)) rmSync(join(ws.path, entry), { recursive: true, force: true });
  git(ws.path, "init", "--quiet", "--initial-branch=main");
  const comparisonBefore = await nextComparison(db, ws);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(
    `${ws.path} has no 'main' branch. Nothing was written. Put a commit on main there (re-clone the repository, or commit on main), then answer again.`,
  );

  expect(refsOf(ws)).toBe("");
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  expect(await nextComparison(db, ws)).toBe(comparisonBefore);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("remote-backed: `restore the baseline` は object の無いタスクブランチの sha を出元 repo から取ってから戻す —— 根の head が届けば、そこから届く子の tip も戻り、失われたとは数えない(ADR 0380 決定4、pin B24)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-fetches-lost", true);
  const { child, root } = loseRootAndChildKeptOnFork(db, ws);
  expect(() => git(ws.path, "cat-file", "-e", child)).toThrow();
  const calls = await shimGit();

  await answer(db, ws, "restore the baseline");

  // 取ったのは根の head だけ —— 子の tip は根と一緒に届いた
  const fetched = calls().flatMap(({ args }) => args.filter((arg) => arg.endsWith(":refs/board/fetched")).map((arg) => arg.split(":")[0]));
  expect(fetched.filter((sha) => sha === root || sha === child)).toEqual([root]);
  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(ws.path, "rev-parse", ROOT)).toBe(root);
  expect(git(ws.path, "rev-parse", CHILD)).toBe(child);
  expect(lostEvents(db)).toEqual([]);
  db.close();
});

it("remote-backed: `give up the lost refs and restore the baseline` も取ってから数える —— 届いた根と子は戻って失われたと数えず、origin が別の sha で持つ branch はその sha へ戻さず今の値で入れる(ADR 0380 決定4、pin B24)", async () => {
  const { ws, db } = await quarantinedWorkspace("give-up-fetches-lost", true);
  const { child, root } = loseRootAndChildKeptOnFork(db, ws);
  originHoldsOther(ws);
  const lost = loseRef(db, ws, "refs/heads/other");

  await answer(db, ws, GIVE_UP);

  expect(git(ws.path, "rev-parse", ROOT)).toBe(root);
  expect(git(ws.path, "rev-parse", CHILD)).toBe(child);
  expect(git(ws.path, "for-each-ref", "refs/heads/other")).toBe("");
  expect(lostEvents(db)).toEqual([{ kind: "lost_refs_accepted", workspace: ws.name, lost: [{ ref: "refs/heads/other", sha: lost }] }]);
  db.close();
});

it("remote-backed の give-up が残す lost_refs_accepted・task_branch_lost・baseline_restored の時刻は、出元 repo から取る前の token を待った後の時刻(#3384)", async () => {
  const { ws, db, task } = await quarantinedWorkspace("give-up-time", true);
  loseRef(db, ws, `refs/heads/task/${task.id}`);
  commitWork(ws.path, "by-hand.txt", "committed on main by hand\n");
  const clock = new FakeClock();
  const { window, githubAuth } = fetchHeldAtToken();

  const answering = answerAs(db, ws.name, { workspace: ws, clock, githubAuth }, GIVE_UP);
  await window.entered;
  await clock.advance(60_000);
  const afterTheToken = clock.now().toISOString();
  window.open();
  await answering;

  expect(listEventsOfKinds(db, ["lost_refs_accepted", "task_branch_lost", "baseline_restored"]).map(({ payload, created_at }) => [payload.kind, created_at])).toEqual([
    ["lost_refs_accepted", afterTheToken],
    ["task_branch_lost", afterTheToken],
    ["baseline_restored", afterTheToken],
  ]);
  db.close();
});

/** B4c の文: token を取れずに取りに行けなかった sha と、その失敗をそのまま挟む。 */
const unreachable = (sha: string) => new RegExp(`^could not reach origin to look for ${sha} \\(.+\\)\\. Nothing was written; answer again once origin is reachable\\.$`, "s");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** text T2 の文(ADR 0409 決定5): 取れたが相手が無いとは言わなかった sha と git の失敗をそのまま挟む。出元 repo なら出口に差し替えを足す。 */
const notSaidLacking = (sha: string, location = "origin") =>
  new RegExp(
    `^fetching ${sha} from ${escaped(location)} failed \\(.+\\), and ${escaped(location)} did not say it lacks it\\. Nothing was written; ` +
      `answer again once the fetch can succeed${location === "origin" ? "" : ", or change the workspace's head repo"}\\.$`,
    "s",
  );
/** text T3 の文(ADR 0409 決定5): 手元で在るか無いか分からない sha と git の報告(版と path で揺れるので中身は照合しない)。 */
const cannotTell = (sha: string, path: string) =>
  new RegExp(`^could not tell whether ${sha} is in ${escaped(path)} \\(.+\\)\\. Nothing was written; fix what git reports there, then answer again\\.$`, "s");
/** 網の fetch(盤面 repo の hop1)のうち `sha` を取るものだけを、curl 28 の stall で落とす。 */
const stalling = (sha: string) => shimGit({ fails: [`${sha}:refs/board/fetched`, "error: RPC failed; curl 28 Operation too slow. Less than 1 bytes/sec transferred the last 30 seconds"] });
/** 何も書いていない —— ref も基準の行も event も変わらず、question は開いたまま。 */
async function expectNothingWritten(db: Db, ws: WorkspaceConfig, question: Task, refsBefore: string, comparisonBefore: string) {
  expect(refsOf(ws)).toBe(refsBefore);
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  expect(listEventsOfKinds(db, ["task_branch_lost"])).toEqual([]);
  expect(await nextComparison(db, ws)).toBe(comparisonBefore);
  expect(getTask(db, question.id)!.status).toBe("todo");
}

it("give-up leaves a lost task ref unresolved when the workspace has no head repo", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("lost-task-without-head-repo");
  const { ws, db, task, question } = await quarantined(workspace);
  const lost = loseRef(db, ws, `refs/heads/task/${task.id}`);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(
    `could not reach the head repo to look for ${lost} (workspace ${ws.name} has no declared head repo (head_repo)`,
  );
  expect(lostEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it.each(["restore the baseline", GIVE_UP])("remote-backed: `%s` は origin が脇へ動いて fetch が落ちれば T2 で拒み、何も書かず、失われたとも数えない(ADR 0409 決定1・3、pin B24、text T2)", async (text) => {
  const { ws, db, question } = await quarantinedWorkspace("lost-origin-unreachable", true);
  const lost = loseRef(db, ws, "refs/heads/gone");
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  renameSync(ws.repo!, `${ws.repo}.aside`);

  await expect(answer(db, ws, text)).rejects.toThrow(notSaidLacking(lost));

  // 次の pickup の比較は origin を読むので、戻してから確かめる
  renameSync(`${ws.repo}.aside`, ws.repo!);
  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  // 数えていない —— origin が戻れば、失われた ref は次の give-up で初めて数えられる
  await answer(db, ws, GIVE_UP);
  expect(lostEvents(db)).toEqual([expect.objectContaining({ lost: [{ ref: "refs/heads/gone", sha: lost }] })]);
  db.close();
});

// #3607 の再現: origin が sha を持ったまま fetch だけが stall すると、2度の probe が通って give-up が受理されていた
it.each(["restore the baseline", GIVE_UP])("remote-backed: origin が持つ sha の fetch だけが stall した `%s` は T2 で拒み、`ls-remote` を撃たず、何も書かず、失われたと数えない(ADR 0409 決定1・3、text T2)", async (text) => {
  const { ws, db, question } = await quarantinedWorkspace("lost-fetch-stalls", true);
  const lost = loseRef(db, ws, "refs/heads/gone", undefined, ws.repo);
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  const calls = await stalling(lost);

  await expect(answer(db, ws, text)).rejects.toThrow(notSaidLacking(lost));

  expect(calls().filter(({ args }) => args.includes("ls-remote"))).toEqual([]);
  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("remote-backed: 別の sha を名指す `not our ref` は「無い」と読まず T2 で拒み、何も書かない(ADR 0409 決定3、text T2)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("lost-other-sha-answer", true);
  const lost = loseRef(db, ws, "refs/heads/gone");
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  await shimGit({ fails: [`${lost}:refs/board/fetched`, `fatal: remote error: upload-pack: not our ref ${"2".repeat(40)}`] });

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(notSaidLacking(lost));

  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("remote-backed: origin が無いと答えた sha と、fetch が落ちた sha が混ざった `restore the baseline` は、B3 ではなく T2 で拒む(ADR 0409 決定4)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("lost-mixed-restore", true);
  loseRef(db, ws, "refs/heads/gone");
  const stalled = loseRef(db, ws, "refs/heads/kept", undefined, ws.repo);
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  await stalling(stalled);

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(notSaidLacking(stalled));

  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("後の段で拒まれた give-up の後は何も失われておらず、次の give-up は `restore the baseline` を名指す B4a で拒まれる(ADR 0373 決定5、spec #3273 の受理の順の帰結)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("give-up-refused-later", true);
  const lost = loseRef(db, ws, "refs/heads/gone");
  // 後半の fetch(受理の 8)が原本の保護ブランチを引けずに拒む
  git(ws.repo!, "update-ref", "-d", "refs/heads/main");

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow("origin has no branch main");
  expect(lostEvents(db)).toEqual([{ kind: "lost_refs_accepted", workspace: ws.name, lost: [{ ref: "refs/heads/gone", sha: lost }] }]);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(`no ref of workspace ${ws.name} is lost — answer \`restore the baseline\`.`);
  expect(lostEvents(db)).toHaveLength(1);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("今の checkout に保護ブランチの ref が無ければ、その object が残っていても `give up the lost refs and restore the baseline` は書き戻しの前に拒み、何も書かない(ADR 0373 決定5、pin B8、text B4b)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("give-up-protected-branch-deleted");
  loseRef(db, ws, "refs/heads/gone");
  git(ws.path, "checkout", "-q", "--detach");
  git(ws.path, "update-ref", "-d", "refs/heads/main");
  const refsBefore = refsOf(ws);
  const comparisonBefore = await nextComparison(db, ws);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(
    `${ws.path} has no 'main' branch. Nothing was written. Put a commit on main there (re-clone the repository, or commit on main), then answer again.`,
  );

  expect(refsOf(ws)).toBe(refsBefore);
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  expect(await nextComparison(db, ws)).toBe(comparisonBefore);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it("remote-backed: origin が `not our ref` と答えた sha へ戻す `restore the baseline` は B3 でその ref を名指して拒み、origin が別の sha で持つ branch をその sha へ戻さず、何も書かない(ADR 0380 決定4、pin B24)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-not-on-origin", true);
  originHoldsOther(ws);
  const lost = loseRef(db, ws, "refs/heads/other");
  const refsBefore = refsOf(ws);

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(
    `cannot restore refs/heads/other to ${lost}: that commit no longer exists in ${ws.path}. Nothing was written. If these are lost for good, answer \`give up the lost refs and restore the baseline\`.`,
  );

  expect(refsOf(ws)).toBe(refsBefore);
  expect(git(ws.path, "for-each-ref", "refs/heads/other")).toBe("");
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

it.each(["restore the baseline", GIVE_UP])("remote-backed: `%s` は仲介が token を出せなければ origin に届かないと読んで拒み、何も書かず、失われたとも数えない(ADR 0380 決定4、pin B24、text B4c)", async (text) => {
  const { workspace } = await makeRemoteBackedWorkspace("lost-token-refused");
  const localOrigin = workspace.repo!;
  // origin の綴りは github.com(= token が要る形)、実際の往復はローカルの bare へ
  const ws = { ...workspace, repo: "https://github.com/acme/lost-token.git" };
  git(ws.path, "remote", "set-url", "origin", ws.repo);
  await shimGit({ route: [ws.repo, localOrigin] });
  const { db, question } = await quarantined(ws);
  const lost = loseRef(db, ws, "refs/heads/gone");
  const refsBefore = refsOf(ws);
  const broker = await startFakeBroker(() => ({ status: 401, body: { error: "invalid_user_token" } }));
  onTestFinished(() => broker.close());
  const tokenFile = join(await tempDir("tidepool-secrets-"), "github-token");
  writeFileSync(tokenFile, "gho_user\n", { mode: 0o600 });

  const refused = answerAs(db, ws.name, { workspace: ws, githubAuth: new GitHubAuth(tokenFile, broker.url) }, text);

  await expect(refused).rejects.toThrow(unreachable(lost));
  await expect(refused).rejects.toThrow("invalid_user_token");
  expect(refsOf(ws)).toBe(refsBefore);
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
  db.close();
});

// 戻れば失われた ref は無く、give-up は B4a で拒まれる —— 戻す側は `restore the baseline` で答える
it.each([
  ["出元 repo が `not our ref` と答え、origin が持つ", "restore the baseline", false, true, "restored"],
  ["出元 repo が `not our ref` 以外で落ち、origin が持つ", "restore the baseline", true, true, "restored"],
  ["出元 repo が `not our ref` 以外で落ち、origin が `not our ref` と答える", "restore the baseline", true, false, "refused"],
  ["出元 repo が `not our ref` 以外で落ち、origin が `not our ref` と答える", GIVE_UP, true, false, "refused"],
  ["出元 repo も origin も `not our ref` と答える", GIVE_UP, false, false, "lost"],
] as const)("remote-backed: タスクブランチの sha は、%s とき、`%s` は —— 出元 repo で取れなければ答えを問わず origin にも聞く(ADR 0409 決定3)", async (_, text, forkGone, onOrigin, outcome) => {
  const { ws, db, task, question } = await quarantinedWorkspace("lost-task-sha", true);
  const ref = `refs/heads/task/${task.id}`;
  const lost = loseRef(db, ws, ref, undefined, onOrigin ? ws.repo : undefined);
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  if (forkGone) renameSync(ws.head_repo!, `${ws.head_repo}.aside`);

  const answered = refusal(answer(db, ws, text));

  if (outcome === "refused") {
    expect(await answered).toMatch(notSaidLacking(lost, `head repo ${repositoryLabel(ws.head_repo!)}`));
    await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  } else {
    expect(await answered).toBe("accepted");
    expect(lostEvents(db)).toEqual(outcome === "lost" ? [expect.objectContaining({ lost: [{ ref, sha: lost }] })] : []);
    expect(git(ws.path, "for-each-ref", "--format=%(objectname)", ref)).toBe(outcome === "lost" ? "" : lost);
  }
  db.close();
});

it("remote-backed: 出元 repo で取れなかったタスクブランチの sha は origin の token を温めてから origin に聞き、token が取れなければ B4c で拒む(ADR 0409 決定3、text B4c)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("lost-task-origin-token");
  const fork = await tempDir("tidepool-lost-task-origin-token-fork-");
  git(fork, "clone", "--quiet", "--bare", workspace.repo!, ".");
  // origin も出元 repo も github.com の綴り(= token が要る形)、実際の往復はそれぞれのローカルの bare へ
  const ws = { ...workspace, repo: "https://github.com/acme/lost-token.git", head_repo: "https://github.com/acme/fork.git" };
  git(ws.path, "remote", "set-url", "origin", ws.repo);
  git(ws.path, "remote", "add", HEAD_REPO_REMOTE, ws.head_repo);
  await shimGit({ route: [ws.repo, workspace.repo!] });
  await shimGit({ route: [ws.head_repo, fork] });
  const { db, task, question } = await quarantined(ws, (db) => {
    announceHeadRepo(db, ws, ws.head_repo);
    assertRememberedHeadRepo(db, ws, NOW);
  });
  const lost = loseRef(db, ws, `refs/heads/task/${task.id}`);
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  const broker = await startFakeBroker(({ repo }) => (repo === "acme/fork" ? issuedToken("ghs_fork") : { status: 401, body: { error: "invalid_user_token" } }));
  onTestFinished(() => broker.close());
  const tokenFile = join(await tempDir("tidepool-secrets-"), "github-token");
  writeFileSync(tokenFile, "gho_user\n", { mode: 0o600 });

  const refused = answerAs(db, ws.name, { workspace: ws, githubAuth: new GitHubAuth(tokenFile, broker.url) }, GIVE_UP);

  await expect(refused).rejects.toThrow(unreachable(lost));
  await expect(refused).rejects.toThrow("invalid_user_token");
  expect(broker.requests.map(({ repo }) => repo)).toEqual(["acme/fork", "acme/lost-token"]);
  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

/** 名前の場所の alternates を存在しない dir へ向ける —— 手元に無い object の読みが stderr を伴う(root でも効く、#2042)。 */
const breakAlternates = (ws: WorkspaceConfig) => writeFileSync(join(ws.path, ".git", "objects", "info", "alternates"), `${ws.path}-nowhere/objects\n`);

it.each([false, true])("手元で在るか無いか分からない戻す先(alternates の先が無い)への give-up は T3 で拒み、token も fetch も求めず、何も書かない(remote-backed: %s、ADR 0409 決定2・4、text T3)", async (remoteBacked) => {
  const { ws, db, question } = await quarantinedWorkspace("lost-unknown-locally", remoteBacked);
  const lost = loseRef(db, ws, "refs/heads/gone");
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  breakAlternates(ws);
  const calls = await shimGit();
  const ensureToken = vi.fn();

  await expect(answerAs(db, ws.name, { workspace: ws, githubAuth: { ensureToken, env: () => process.env } as unknown as GitHubAuth }, GIVE_UP)).rejects.toThrow(cannotTell(lost, ws.path));

  expect(ensureToken).not.toHaveBeenCalled();
  expect(calls().filter(({ args }) => args.includes("fetch"))).toEqual([]);
  rmSync(join(ws.path, ".git", "objects", "info", "alternates"));
  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("在るか無いか分からない sha のある give-up は、保護ブランチが無くても B4b より先に T3 で拒む(ADR 0409 決定4)", async () => {
  const { ws, db } = await quarantinedWorkspace("lost-unknown-before-b4b");
  const lost = loseRef(db, ws, "refs/heads/gone");
  git(ws.path, "checkout", "-q", "--detach");
  git(ws.path, "update-ref", "-d", "refs/heads/main");
  breakAlternates(ws);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(cannotTell(lost, ws.path));
  db.close();
});

/** 盤面が `ref` を main の上の新しい loose な commit に書き(基準に入る)、人間がその ref を main へ動かす。commit の loose の file を返す。 */
function looseTargetMovedAway(db: Db, ws: WorkspaceConfig, ref: string) {
  const sha = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", `the board wrote ${ref}`);
  boardWrites(db, ws, ref, sha);
  git(ws.path, "update-ref", ref, "main");
  return { sha, file: join(ws.path, ".git", "objects", sha.slice(0, 2), sha.slice(2)) };
}

/** loose の object の file を `bytes` で上書きする(loose は読み取り専用で書かれる)。 */
function overwriteLoose(file: string, bytes: Buffer | string) {
  chmodSync(file, 0o644);
  writeFileSync(file, bytes);
}

it("header の読めない loose へ戻す `restore the baseline` は T3 で拒み、何も書かない(ADR 0409 決定2、text T3)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-unreadable-loose");
  const { sha, file } = looseTargetMovedAway(db, ws, "refs/heads/corrupt");
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  overwriteLoose(file, "not a zlib stream");

  await expect(answer(db, ws, "restore the baseline")).rejects.toThrow(cannotTell(sha, ws.path));

  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("keep-around に持つ値が読めない give-up は T3 で拒み、`lost_refs_accepted` を書かない(ADR 0409 決定2・4、text T3)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("give-up-unreadable-kept");
  loseRef(db, ws, "refs/heads/gone");
  const extra = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "a human's branch");
  git(ws.path, "branch", "extra", extra);
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  overwriteLoose(join(ws.path, ".git", "objects", extra.slice(0, 2), extra.slice(2)), "not a zlib stream");

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(cannotTell(extra, ws.path));

  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("在る object の読みに stderr が付いても(alternates の先が無い)在ると読み、その ref へ戻す `restore the baseline` は通る(ADR 0409 決定2)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-present-with-stderr");
  const { sha } = looseTargetMovedAway(db, ws, "refs/heads/back");
  breakAlternates(ws);

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "rev-parse", "refs/heads/back")).toBe(sha);
  expect(getTask(db, question.id)!.status).toBe("done");
  db.close();
});

it("中身だけ壊れて header は読める loose は在ると読む —— 戻す先がそれだけの give-up は、失われた ref が無いとして B4a で拒まれる(ADR 0409 帰結、ADR 0398 決定3 の外からの損傷)", async () => {
  const { ws, db } = await quarantinedWorkspace("give-up-body-corrupt-loose");
  // 圧縮の効かない 200 kB —— header は file の先頭で inflate でき、末尾だけを壊す
  const blobFile = join(await tempDir("tidepool-blob-"), "blob");
  writeFileSync(blobFile, randomBytes(200 * 1024));
  const blob = git(ws.path, "hash-object", "-w", blobFile);
  boardWrites(db, ws, "refs/tags/blob", blob);
  git(ws.path, "update-ref", "-d", "refs/tags/blob");
  const file = join(ws.path, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  const bytes = readFileSync(file);
  bytes.fill(0, bytes.length - 1024);
  overwriteLoose(file, bytes);

  await expect(answer(db, ws, GIVE_UP)).rejects.toThrow(`no ref of workspace ${ws.name} is lost — answer \`restore the baseline\`.`);
  db.close();
});

it("在る object を手元に無い object へ差し替える replace ref があっても在ると読み、`restore the baseline` は戻して失われたと数えない(ADR 0409 決定2)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("restore-through-replace");
  const { sha } = looseTargetMovedAway(db, ws, "refs/heads/replaced");
  // 基準に無い人間の replace ref —— 差し替え先の object を消す(基準にある dangling な replace ref は update-ref 自体を落とす)
  const replacement = git(ws.path, "commit-tree", "main^{tree}", "-m", "a human's replacement");
  git(ws.path, "replace", sha, replacement);
  rmSync(join(ws.path, ".git", "objects", replacement.slice(0, 2), replacement.slice(2)));

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "rev-parse", "refs/heads/replaced")).toBe(sha);
  expect(git(ws.path, "for-each-ref", "refs/replace/")).toBe("");
  expect(getTask(db, question.id)!.status).toBe("done");
  db.close();
});

it("partial clone の名前の場所では手元の読みが網に出ず、どこにも無い sha は失われたと数える(ADR 0409 決定2、ADR 0339 決定5)", async () => {
  const { ws, db } = await quarantinedWorkspace("give-up-partial-clone", true);
  const lost = loseRef(db, ws, "refs/heads/gone");
  // 読みが lazy fetch すれば、origin の `not our ref` が stderr に乗って T3 で拒まれる
  git(ws.path, "config", "core.repositoryformatversion", "1");
  git(ws.path, "config", "extensions.partialClone", "origin");
  git(ws.path, "config", "remote.origin.promisor", "true");
  git(ws.path, "config", "remote.origin.partialclonefilter", "blob:none");

  await answer(db, ws, GIVE_UP);

  expect(lostEvents(db)).toEqual([expect.objectContaining({ lost: [{ ref: "refs/heads/gone", sha: lost }] })]);
  db.close();
});

it("remote-backed: 回答が token を待つ間に手元から消えた戻す先の sha は T5 で拒み、何も書かない(ADR 0409 決定4、text T5)", async () => {
  const { ws, db, task, question } = await quarantinedWorkspace("restore-target-vanishes", true);
  // 失われたタスクブランチが token を待たせる
  loseRef(db, ws, `refs/heads/task/${task.id}`);
  const { sha } = looseTargetMovedAway(db, ws, "refs/heads/vanishing");
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  const { window, githubAuth } = fetchHeldAtToken();

  const answering = refusal(answerAs(db, ws.name, { workspace: ws, githubAuth }, GIVE_UP));
  await window.entered;
  dropAndPrune(ws);
  window.open();

  expect(await answering).toBe(`the restore target ${sha} of refs/heads/vanishing went missing in ${ws.path} while the board was answering. Nothing was written; answer again.`);
  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});

it("remote-backed: origin から届いた sha を戻す先に持つタスクブランチは、出元 repo へ取りに行かない —— 出元 repo が無くても `restore the baseline` は両方を戻す(ADR 0409 決定4 の読み (2))", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("lost-shared-sha");
  const { ws, db, task, question } = await quarantined(workspace);
  const taskRef = `refs/heads/task/${task.id}`;
  const lost = git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "on a ref and a task branch");
  boardWrites(db, ws, "refs/heads/gone", lost);
  boardWrites(db, ws, taskRef, lost);
  git(ws.repo!, "fetch", "--quiet", ws.path, `${lost}:refs/heads/kept`);
  dropAndPrune(ws, "refs/heads/gone", taskRef);

  await answer(db, ws, "restore the baseline");

  expect(git(ws.path, "rev-parse", "refs/heads/gone")).toBe(lost);
  expect(git(ws.path, "rev-parse", taskRef)).toBe(lost);
  expect(getTask(db, question.id)!.status).toBe("done");
  db.close();
});

it("remote-backed: 出元 repo から origin へ回る途中で起きた repo の食い違いは、T2 にも B4c にも包まずに拒む(ADR 0409 決定3、ADR 0378 決定6〜8)", async () => {
  const { ws, db, task } = await quarantinedWorkspace("lost-task-origin-mismatch", true);
  loseRef(db, ws, `refs/heads/task/${task.id}`);
  const refsBefore = refsOf(ws);
  // origin の token を待つ間に、覚えた repo が別の値になる
  let calls = 0;
  const ensureToken = async () => {
    if (++calls === 2) db.prepare("UPDATE workspace_state SET remembered_repo = ? WHERE name = ?").run(JSON.stringify(`${ws.repo}-elsewhere`), ws.name);
  };
  const githubAuth = { ensureToken, env: () => process.env } as unknown as GitHubAuth;

  const message = await refusal(answerAs(db, ws.name, { workspace: ws, githubAuth }, GIVE_UP));

  expect(calls).toBe(2);
  expect(message).toMatch(new RegExp(`^workspace ${ws.name} was registered for repo .+, but its registry entry now says `));
  expect(refsOf(ws)).toBe(refsBefore);
  expect(lostEvents(db)).toEqual([]);
  expect(restoredEvents(db)).toEqual([]);
  db.close();
});

it("remote-backed: token を待った後の「もう届いたか」の読みで在るか無いか分からなければ T3 で拒み、取りに行かず、何も書かない(ADR 0409 決定4 の読み (2)、text T3)", async () => {
  const { ws, db, question } = await quarantinedWorkspace("lost-unknown-after-token", true);
  const lost = loseRef(db, ws, "refs/heads/gone");
  const [refsBefore, comparisonBefore] = [refsOf(ws), await nextComparison(db, ws)];
  const calls = await shimGit();
  const { window, githubAuth } = fetchHeldAtToken();

  const answering = refusal(answerAs(db, ws.name, { workspace: ws, githubAuth }, GIVE_UP));
  await window.entered;
  breakAlternates(ws);
  window.open();

  expect(await answering).toMatch(cannotTell(lost, ws.path));
  expect(calls().filter(({ args }) => args.includes("fetch"))).toEqual([]);
  rmSync(join(ws.path, ".git", "objects", "info", "alternates"));
  await expectNothingWritten(db, ws, question, refsBefore, comparisonBefore);
  db.close();
});
