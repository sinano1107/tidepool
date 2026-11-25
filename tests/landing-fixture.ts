
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents, listEventsOfKinds } from "../src/events.js";
import { GitHubAuth, networkDestination } from "../src/github-auth.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import {
  createLanding,
  type Landing,
  registerPrPromotionFailureQuestion,
  taskIdsAwaitingLandingInWorkspace,
} from "../src/landing.js";
import { type AuthorityProfile, loadRegistry, type MergeDial, UnknownAgentError } from "../src/registry.js";
import {
  completeTask,
  countUnsettledTasksReferencing,
  getTask,
  listBoard,
  recordPrOpened,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { raiseObjection } from "../src/triage.js";
import { workbenchPath } from "../src/workbench.js";
import {
  announceHeadRepo,
  assertRememberedHeadRepo,
  buildWorkspaceResolver,
  finishHeadRepoChange,
  protectedBranch,
  recordDeclaredRepo,
  recordHeadRepo,
  recordTaskCheckoutTip,
  refreshProtectedBranch,
  releaseWorkspace,
  resolveExecutionWorkspace,
  taskRunPlaceForBoard,
  type WorkspaceConfig,
  writeBoardRefs,
} from "../src/workspace.js";
import { createWorkspace, deleteWorkspace } from "../src/workspace-create.js";
import { awaitWindow, FakeClock, FakeGitHubClient, fakeHead, unusedLanding } from "./fakes.js";
import {
  checkoutTaskBranch,
  commitWork,
  FULL_HANDOFF,
  git,
  HUMAN_WEBUI,
  makeLandingWorkspace,
  makeWorkspace,
  prepareAtPickup,
  rememberFixtureHeadRepos,
  settleReviews,
  squashTaskIntoOrigin,
} from "./harness.js";
import { makeRegistry, setWorkspaceEntry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

let opened: Db | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  opened?.close();
  opened = undefined;
});

export async function openBoard(): Promise<{ db: Db; clock: FakeClock }> {
  const boardDir = await tempDir("tidepool-landing-");
  const database = openDb(join(boardDir, "board.sqlite"));
  rememberFixtureHeadRepos(database);
  opened = database;
  return { db: database, clock: new FakeClock() };
}

/** 収束を通さずに PR を開いた記録を刻む。pickup 前の fixture には `workspace` の repo を記録する(省略時は purely-local)。`workspace` の
 *  出元 repo は、PR の前の最初の push が記録したものとして記録する(ADR 0399 決定1)。
 *  `head` を渡さない PR の head はどこにも無い sha —— 収束が push する根には `pushPrHead` の実在する head を渡す(ADR 0376 決定1)。 */
export function recordPrOpenedOutsideConvergence(
  db: Db,
  task: Task,
  prNumber: number,
  now: Date,
  { authority, isProtected, head = fakeHead(prNumber), workspace = { path: "." } }: { authority?: Parameters<typeof recordPrOpened>[5]; isProtected?: boolean; head?: string; workspace?: Pick<WorkspaceConfig, "path" | "repo" | "head_repo"> } = {},
): void {
  recordDeclaredRepo(db, task.id, workspace);
  recordPushedHeadRepo(db, task.id, workspace);
  recordPrOpened(db, task, prNumber, head, now, authority, isProtected);
}

/** 収束を通さずに `workspace` の出元 repo へ push した根の記録 —— 着地の最初の push が届いたときに書く記録と同じ(ADR 0399 決定1)。 */
export function recordPushedHeadRepo(db: Db, taskId: string, workspace: Pick<WorkspaceConfig, "path" | "head_repo">): void {
  if (workspace.head_repo !== undefined) recordHeadRepo(db, taskId, networkDestination(workspace.head_repo, workspace.path));
}

/** PR #`prNumber` の実在する head を作る: 今のタスクブランチの先端を出元 repo へ push し、GitHub に今の宣言の `branch` を base とする
 *  その PR を置いて sha を返す。この後にブランチへ載る commit が、盤面のまだ push していない内容になる。写しは書かない —— 記録済みの PR の最後に push した値は記録から読む
 *  (ADR 0376 決定3)。git の版によっては URL への push でも写しが動くので、push の前の写しへ戻す(CI の git 2.56 で、
 *  写しの無い前提のテストが落ちた)。 */
export function pushPrHead(github: FakeGitHubClient, workspace: WorkspaceConfig, taskId: string, prNumber: number): string {
  const copy = `refs/remotes/head-repo/task/${taskId}`;
  let before: string | null = null;
  try {
    before = git(workspace.path, "rev-parse", "--verify", "--quiet", copy);
  } catch {
    // 写しが無い
  }
  git(workspace.path, "push", workspace.head_repo!, `task/${taskId}`);
  if (before === null) git(workspace.path, "update-ref", "-d", copy);
  else git(workspace.path, "update-ref", copy, before);
  github.scriptPullRequestOnBranch(`task/${taskId}`, prNumber, undefined, protectedBranch(workspace));
  return git(workspace.path, "rev-parse", `task/${taskId}`);
}

export function promotionFailures(board: Db, taskId: string) {
  return listBoard(board).filter(
    (candidate) => candidate.question_pending_pr_promotion_task_id === taskId,
  );
}

/** 別タスクのセッションを盤面の書き込み `boardWrite` をまたいで走らせ、解放する。
 *  盤面の書き込みの予告と畳み(ADR 0243)を解放の比較で見る形 —— 休止中の書き込みは次の pickup の比較が
 *  見る(ADR 0351 決定2)。`workerForges` は、そのセッションの間に盤面の外の書き手が名前の場所に偽造する ref
 *  (ADR 0356 決定1 の後、worker は task の checkout で走り名前の場所の ref に届かない)。 */
export async function straddle(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  boardWrite: () => Promise<unknown>,
  workerForges?: string,
): Promise<void> {
  const straddler = landingWork(board, clock);
  const place = await prepareAtPickup(board, workspace, straddler);
  if (workerForges) git(workspace.path, "update-ref", workerForges, "HEAD");
  await boardWrite();
  commitWork(place.path, "straddler.txt", "work\n");
  releaseWorkspace(board, place, straddler, clock.now());
}

/** fake の push のたびに、転送の後で `effect` を撃つ —— push が失敗と報告されても撃つ。 */
export function afterEachPush(github: FakeGitHubClient, effect: () => void): void {
  const prepare = github.preparePush.bind(github);
  github.preparePush = async (input) => {
    const push = await prepare(input);
    return (sha) => {
      try {
        push(sha);
      } finally {
        effect();
      }
    };
  };
}

/** 予告だけを残して落ちた盤面(ADR 0243 決定5): 口の書き込みの中で transaction を開き、畳みをその中に入れて捨てる ——
 *  落ちた盤面の畳みはディスクに届かない。ref は動かさない(動かすなら呼び手が後で書く)。 */
export function announceThenCrash(board: Db, workspace: WorkspaceConfig, ref: string, newSha: string): void {
  writeBoardRefs(board, workspace, [[ref, newSha]], () => board.exec("BEGIN"));
  board.exec("ROLLBACK");
}

/** 収束を1回走らせ、`taskId` の根の verdict を返す。その回で扱わなかった(根でない・候補から外れた)なら undefined。 */
export async function convergeOn(landing: Landing, taskId: string, answering?: string) {
  const verdicts = await landing.converge(answering === undefined ? undefined : { answering: { question: answering, answerer: HUMAN_ANSWERER } });
  return verdicts.find((root) => root.taskId === taskId)?.verdict;
}

/** タスクを完了し、盤面の完了時レビューを決着させる —— 収束が根に読むのは done の work だけである。 */
export function finish(board: Db, clock: FakeClock, task: Task): Task {
  completeTask(board, getTask(board, task.id)!, FULL_HANDOFF, "worker", clock.now(), "worker");
  settleReviews(board, clock.now());
  return getTask(board, task.id)!;
}

/** 盤面の経路で `task`(done の根でもよい)のタスクブランチに commit を1つ載せる: 拾い、task の checkout で commit し、解放する。
 *  名前の場所は保護ブランチに休む(ADR 0356 決定1)。基準の後に名前の場所へ手で書くと、着地の比較が帯域外と読む(ADR 0370 決定1)。 */
export async function commitThroughTaskCheckout(board: Db, clock: FakeClock, workspace: WorkspaceConfig, task: Task, file: string, content: string) {
  const place = await prepareAtPickup(board, workspace, task);
  commitWork(place.path, file, content);
  releaseWorkspace(board, place, getTask(board, task.id)!, clock.now());
}

/** 盤面の経路で `task` を完了させる: 拾い(lineage の帰り先から fork)、task の checkout で commit し、完了の門が tip を名前の場所へ
 *  引き(ADR 0356 決定3)、完了の後始末が帰り先へ merge back する(ADR 0053 決定2 —— 帰り先が保護ブランチなら merge back しない)。 */
export async function completeThroughTaskCheckout(board: Db, clock: FakeClock, workspace: WorkspaceConfig, task: Task, file: string, content: string) {
  const place = await prepareAtPickup(board, workspace, task);
  commitWork(place.path, file, content);
  recordTaskCheckoutTip(board, place, task.id);
  const done = finish(board, clock, task);
  releaseWorkspace(board, place, done, clock.now(), true, undefined, undefined, true);
  return done;
}

// issue #1851: 盤面の停止は列を閉じ、走っている回と列に入った回の終わりを待つ
export const settle = () => new Promise((resolve) => setImmediate(resolve));

// ADR 0241 決定1(spec #1839 A): merge 済みの PR の根は、根自身のブランチを保護ブランチと比べる
/** 収束が PR #1 を開いた根。checkout は根のタスクブランチに残る。 */
export async function rootWithOpenedPr(name: string) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, root.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);
  await landing.converge();
  return { workspace, db, clock, github, landing, root: getTask(db, root.id)! };
}

/** GitHub が PR を merge する —— 出元 repo のタスクブランチ(PR の head)を origin の保護ブランチへ squash する。
 *  手元の保護ブランチの写しは動かさない(盤面が fetch するまで古い)。 */
export async function mergeOnGitHub(workspace: WorkspaceConfig, taskId: string) {
  const merger = await tempDir("tidepool-github-merge-");
  git(merger, "clone", workspace.repo!, ".");
  git(merger, "fetch", workspace.head_repo!, `task/${taskId}`);
  git(merger, "merge", "--squash", "FETCH_HEAD");
  git(merger, "commit", "-m", "squash the PR on GitHub");
  git(merger, "push", "origin", "main");
}

/** 追いつきの conflict(H6): fork 元が squash 着地した後、origin の保護ブランチが修理と同じ行を変えた根。`openFailure` なら収束の前に
 *  別の失敗で昇格失敗 question が開いている(回答が先に conflict に当たる)。 */
export async function catchUpConflictRoot(name: string, { openFailure = false, undeliveredChild = false } = {}) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const workbenchBase = await tempDir("tidepool-task-checkouts-");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, workspacesDir: workbenchBase });
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "ship the parent change", completion_criteria: "the parent PR exists" }, clock.now(), ...HUMAN_WEBUI);
  checkoutTaskBranch(db, workspace, parent.id);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, parent, 1, clock.now(), { workspace });
  const repair = registerTask(
    db,
    { type: "work", parent_id: parent.id, title: "repair", purpose: "repair the landed result", completion_criteria: "a repair PR exists" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  checkoutTaskBranch(db, workspace, repair.id, `task/${parent.id}`);
  await squashTaskIntoOrigin(workspace, parent.id);
  const publisher = await tempDir("tidepool-protected-change-");
  git(publisher, "clone", workspace.repo!, ".");
  commitWork(publisher, "repair.txt", "protected version\n");
  git(publisher, "push", "origin", "main");
  git(workspace.path, "fetch", "origin", "main");
  commitWork(workspace.path, "repair.txt", "task version\n");
  git(workspace.path, "checkout", "main");
  // 根の分解ツリーに、merge back が根へ届いていない done の子(#3347 の形)
  if (undeliveredChild) await settleRepairNotMergedBack(db, clock, workspace, repair.id, "child.txt");
  finish(db, clock, repair);
  if (openFailure) registerPrPromotionFailureQuestion(db, getTask(db, repair.id)!, "push failed", clock.now());
  const target = `task/${repair.id}`;
  const workbench = () => realpathSync(workbenchPath(workbenchBase, { task: repair.id }, "origin/main"));
  /** spec #3273 text A2 の要素: 作業台の在り処、そこで打つ merge、答え直す回答。 */
  const expectA2 = (text: unknown) => {
    expect(text).toEqual(expect.stringMatching(/^main does not merge cleanly into /));
    for (const element of [`the workbench at ${workbench()}`, "`git merge board/origin/main`", "Then answer `retry`."]) expect(text).toContain(element);
  };
  /** origin の保護ブランチを外で1つ進め、盤面の fetch で名前の場所の写しへ引く(手の fetch は着地の比較が帯域外と読む、ADR 0370 決定1)。 */
  const advanceOrigin = async () => {
    commitWork(publisher, "later.txt", "after the human's merge\n");
    git(publisher, "push", "origin", "main");
    await refreshProtectedBranch(db, workspace, undefined, () => clock.now());
  };
  /** 人間が作業台で origin の保護ブランチを merge し、conflict を保護ブランチの側で解いて commit する。 */
  const resolve = () => {
    expect(() => git(workbench(), "merge", "board/origin/main")).toThrow();
    writeFileSync(join(workbench(), "repair.txt"), "protected version\n");
    writeFileSync(join(workbench(), "repair-only.txt"), "resolved repair\n");
    git(workbench(), "add", "repair.txt", "repair-only.txt");
    git(workbench(), "commit", "--no-edit");
  };
  return { workspace, db, clock, github, landing, repair: getTask(db, repair.id)!, target, workbenchBase, workbench, expectA2, advanceOrigin, resolve };
}

/** spec #3273 text D2 の全文 —— 出元 repo の `target` が `head` へ巻き戻され、盤面が最後に push した値 `pushed` を持たない。 */
export const textD2 = (workspace: WorkspaceConfig, target: string, pushed: string, head: string, foundPr?: number) =>
  `head repo ${workspace.head_repo}'s ${target} was rewound outside the board: it is at ${head} and no longer contains ${pushed}, which the board pushed. The board does not push over a rewind. ` +
  `Either push the dropped commits back to head repo ${workspace.head_repo}'s ${target} (a fast-forward from ${head} to ${pushed}; those commits are in the board's checkout at ${workspace.path} — ` +
  `fetch them from there into your clone, and never push from there), or delete head repo ${workspace.head_repo}'s ${target} and the board re-creates it` +
  `${foundPr === undefined ? "" : ` — deleting it closes PR #${foundPr}`}. Then answer \`retry\`.`;

/** ADR 0376: 出元 repo に `task/<root>` が載っている根 —— 盤面の push だけが載り、写しはその値。`pr` が無ければ PR も event も無い(push の後に
 *  PR の作成が落ちた根の形。publish の push が残す形は、下でその扉を実際に通す)。`found` は GitHub にだけ PR #1 がある(作成の後・記録の前に落ちた盤面)。`recorded` は
 *  PR #1 を記録した後に、盤面の経路で根のブランチへ届いた未 push の修理を持つ。名前の場所は保護ブランチに休む。`openFailure` なら別の失敗で
 *  昇格失敗 question が開いている。 */
export async function pushedRoot(
  name: string,
  {
    pr,
    openFailure = false,
    commits = 1,
    merge,
    resolveAuthority = merge && (() => profile(merge)),
    recordedSha,
  }: {
    pr?: "found" | "recorded";
    openFailure?: boolean;
    commits?: number;
    merge?: MergeDial;
    resolveAuthority?: () => AuthorityProfile;
    /** 記録する最後に push した値 —— 既定は実際に push した sha。 */
    recordedSha?: string;
  } = {},
) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const workbenchBase = await tempDir("tidepool-task-checkouts-");
  /** この盤面の landing を同じ材料で作る —— `pickupIdle` だけを足せる。 */
  const landingWith = ({ pickupIdle }: { pickupIdle?: () => Promise<void> } = {}) =>
    createLanding({ defaultAgentName: "tako", db, clock, workspace, github, workspacesDir: workbenchBase, resolveAuthority, pickupIdle });
  const landing = landingWith();
  const work = landingWork(db, clock);
  const target = `task/${work.id}`;
  git(workspace.path, "checkout", "-b", target);
  recordDeclaredRepo(db, work.id, workspace);
  for (let n = 1; n <= commits; n++) commitWork(workspace.path, `feature-${n}.txt`, "ready\n");
  git(workspace.path, "push", "head-repo", target);
  git(workspace.path, "checkout", "main");
  finish(db, clock, work);
  const pushed = git(workspace.path, "rev-parse", target);
  if (pr) github.scriptPullRequestOnBranch(target);
  if (pr === "recorded") {
    recordPushedHeadRepo(db, work.id, workspace);
    recordPrOpened(db, getTask(db, work.id)!, 1, recordedSha ?? pushed, clock.now(), merge && { merge }, undefined);
    await commitThroughTaskCheckout(db, clock, workspace, getTask(db, work.id)!, "repair.txt", "fixed\n");
  }
  if (openFailure) registerPrPromotionFailureQuestion(db, getTask(db, work.id)!, "push failed", clock.now());
  const local = git(workspace.path, "rev-parse", target);
  const workbenchAt = workbenchPath(workbenchBase, { task: work.id }, `origin/${target}`);
  const workbench = () => realpathSync(workbenchAt);
  /** spec #3273 text D1 の全文。 */
  const d1 = (head: string) =>
    `Head repo ${workspace.head_repo}'s ${target} holds commits the board did not push (${head}). See them with \`git log --stat ${target}..board/origin/${target}\` in the workbench at ${workbench()}. ` +
    `The board does not merge outside commits itself: there, on ${target}, run \`git merge board/origin/${target}\` (or, in your own clone with the workbench as a remote: fetch it, ` +
    `\`git merge <remote>/board/origin/${target}\`, and push ${target} to it). Your tip must contain both ${target} as the board has it now (\`board/${target}\`) and ${target} on head repo ${workspace.head_repo} (\`board/origin/${target}\`), ` +
    "with nothing uncommitted. Then answer `retry`.";
  const d2 = (head: string, foundPr?: number) => textD2(workspace, target, pushed, head, foundPr);
  /** 何も運ばれていない: local のタスクブランチも、最後に push した値の写しも動かず、取り込みも push も PR の作成も無い。 */
  const expectNothingCarried = () => {
    expect(git(workspace.path, "rev-parse", target)).toBe(local);
    expect(git(workspace.path, "rev-parse", `refs/remotes/head-repo/${target}`)).toBe(pushed);
    expect(listEventsOfKinds(db, ["workbench_taken_in"])).toEqual([]);
    expect(github.pushes).toEqual([]);
    expect(github.requests).toEqual([]);
  };
  /** retry の回答。拒否なら DomainError の文を、通れば undefined を返す。 */
  const retry = (failure: { id: string }) =>
    answerPromotion(db, clock, landing, workspace, failure, "retry").then(
      () => undefined,
      (err: unknown) => {
        expect(err).toBeInstanceOf(DomainError);
        return (err as Error).message;
      },
    );
  /** 人間が作業台で出元 repo の head を merge する。 */
  const mergeInWorkbench = () => {
    git(workbench(), "merge", "--quiet", "--no-edit", `board/origin/${target}`);
    return git(workbench(), "rev-parse", target);
  };
  /** PR #1 の merge question への「merge」。拒否なら DomainError の文を、通れば undefined を返す。 */
  const answerMerge = () =>
    answerMergeQuestion({ db, clock, github, workspace, landing, workspacesDir: workbenchBase }).then(
      () => undefined,
      (err: unknown) => {
        expect(err).toBeInstanceOf(DomainError);
        return (err as Error).message;
      },
    );
  return { workspace, db, clock, github, landing, work: getTask(db, work.id)!, target, pushed, workbenchAt, workbench, d1, d2, expectNothingCarried, retry, mergeInWorkbench, answerMerge, landingWith };
}

/** 盤面の外の clone。出元 repo のタスクブランチを force-push で `refspec` に書き換えるのに使う(巻き戻し・削除・push し直し)。 */
export async function outsideClone(workspace: WorkspaceConfig) {
  const clone = await tempDir("tidepool-outside-clone-");
  git(clone, "clone", workspace.head_repo!, ".");
  return { clone, push: (refspec: string) => git(clone, "push", "--force", "origin", refspec) };
}

/** spec #3273 text A4c(`lacks` は `<branches>` の句、text A4d で分かれる)。 */
export const textA4c = (lacks: string, headBranch?: string) =>
  `"ship": PR #1's head${headBranch === undefined ? "" : ` (${headBranch})`} was moved outside the board and lacks the content of ${lacks}. Merge, or hold? ` +
  "The first `merge` is refused once and opens a workbench where you decide whether that content comes back.";

/** spec #3273 text A4a の全文。 */
export const textA4a = (c: Awaited<ReturnType<typeof pushedRoot>>, head: string, lacks: string) =>
  `PR #1's head was moved outside the board to ${head}, which lacks the content of ${lacks}. The board opened the workbench at ${c.workbench()}. ` +
  `Answer \`merge\` again and the board pushes that content back. To discard it instead, first run there, on ${c.target}: ` +
  `\`git merge -s ours --no-commit board/origin/${c.target}\`, \`git read-tree -u --reset board/origin/${c.target}\`, \`git commit\` ` +
  `(or the same in your own clone, then push ${c.target} to the workbench); then answer \`merge\` again.`;

// landingAnnotation は DB の状態だけで決まる — blocked_by の規則はここ(domain 層)で1度だけ述べる(ADR 0107)。
// サーバ境界のテストは「読み口が注釈を写す」ことだけを述べる。
export function landingWork(db: Db, clock: FakeClock, workspace?: string) {
  return registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship an agreed change",
      completion_criteria: "the change is ready",
      workspace,
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
}

export function mergeQuestion(
  db: Db,
  clock: FakeClock,
  pending: { pending_local_merge_task_id: string } | { pending_merge_pr: number; root: string },
  workspace?: string,
) {
  return registerTask(
    db,
    {
      type: "question",
      title: "land it",
      workspace,
      purpose: "a human decides whether to land",
      completion_criteria: "the answer is recorded",
      question: [{ title: "land it", options: ["merge", "hold"], recommendation: "merge" }],
      question_kind:
        "pending_merge_pr" in pending
          ? { kind: "pr_merge", task_id: pending.root, pr: pending.pending_merge_pr, tip: null, outside: null, missingBranches: null, reason: "pr_opened" }
          : { kind: "local_merge", task_id: pending.pending_local_merge_task_id, tip: null },
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
}

export function attachUnsettledChild(db: Db, clock: FakeClock, parentId: string) {
  return registerTask(
    db,
    {
      type: "work",
      title: "repair",
      purpose: "repair the landing task",
      completion_criteria: "the repair is ready",
      parent_id: parentId,
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
}

export function raiseUnbundledObjection(db: Db, clock: FakeClock, taskId: string) {
  const entryId = appendEvent(db, {
    taskId,
    actorId: "worker",
    origin: "worker",
    payload: { kind: "decision_logged", line: "ship this implementation" },
    at: clock.now(),
  });
  raiseObjection(db, entryId, "the implementation still misses the edge case", clock.now());
}

// ADR 0217 決定1・2: 無人 merge キューの PR は merge の瞬間に着地の面を読み直す。
// 以下はこの読み直しを述べる唯一の場所(ADR 0107)。
export const profile = (merge: MergeDial) => ({
  name: "standard",
  guidance: "",
  merge,
});

/** auto_if_ci_green で PR を開き、無人 merge キューへ入れる。 */
export function queueAutoMerge(db: Db, clock: FakeClock, prNumber: number, workspace?: Pick<WorkspaceConfig, "path" | "repo" | "head_repo">): Task {
  const work = landingWork(db, clock);
  recordPrOpenedOutsideConvergence(db, work, prNumber, clock.now(), {
    authority: { merge: "auto_if_ci_green" },
    workspace,
  });
  return work;
}

export function mergeQuestions(db: Db) {
  return listBoard(db)
    .filter((q) => q.question_pending_merge_pr !== null)
    .map((q) => {
      const { actor_id, origin } = listEvents(db, q.id).find((e) => e.kind === "task_registered")!;
      return {
        pr: q.question_pending_merge_pr,
        registrant: [actor_id, origin],
        recommendation: q.question_items?.[0]?.recommendation,
        purpose: q.purpose,
      };
    });
}

// ADR 0217 決定1・2(#1644): CI 赤の question も盤面の名義の行為なので、立てる直前に merge の枝と
// 同じ順(profile → 門 → 着地の面、ADR 0232)で読み直す。CI を読んでいる間に変えるのは、既存の「merge の直前」と同じ形
export const CI_RED_PURPOSE = '"ship"\'s auto_if_ci_green auto-merge found CI red on PR #1. Merge anyway, or hold?';

// ADR 0229: merge できない PR は状態で分けてキューから外す。tick は reject せず、1件の失敗は後ろの PR を巻き込まない
// キューに残った行は次の tick で CI を読み直される —— 行の有無は行の直読みでなく振る舞いで見る(ADR 0107 決定2)
export async function readOnNextTick(landing: Landing, github: FakeGitHubClient): Promise<number[]> {
  const before = github.ciChecks.length;
  await landing.tick("auto_merge");
  return github.ciChecks.slice(before).map((ref) => ref.number);
}

export function autoMerging(db: Db, clock: FakeClock, workspace: WorkspaceConfig, github: FakeGitHubClient, dial = () => profile("auto_if_ci_green")) {
  return createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: dial });
}

export function boardEvents(db: Db, taskId: string, kind: string) {
  return listEvents(db, taskId)
    .filter((e) => e.kind === kind)
    .map(({ actor_id, origin, payload }) => ({ actor_id, origin, payload }));
}

export const closeObserved = (pr_number: number) => [
  { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number } },
];

/** キューの行の行方を記録する event — 残っていなければ、PR はキューに残ったまま何も起きていない。 */
export const autoMergeOutcomeEvents = (db: Db, taskId: string) =>
  ["pr_merged", "pr_merge_observed", "pr_close_observed", "auto_merge_withdrawn"].flatMap((kind) =>
    boardEvents(db, taskId, kind),
  );

export const CONFLICT = "Pull request is not mergeable: the merge commit cannot be cleanly created.";

// ADR 0231 決定4: 盤面の外で push された head の猶予は、盤面がその head を初めて読んだ時点から数える
/** 盤面を通さず、別の clone からタスクブランチへ commit を push する —— `onto` を渡せば、その commit の上に作って
 *  force-push する。PR の head はその sha になり、盤面の checkout の写しは動かない。 */
export async function pushOutsideBoard(workspace: WorkspaceConfig, taskId: string, onto?: string, file = "outside.txt"): Promise<string> {
  const clone = await tempDir("tidepool-outside-push-");
  git(clone, "clone", "--branch", `task/${taskId}`, workspace.head_repo!, ".");
  if (onto) git(clone, "reset", "--hard", onto);
  commitWork(clone, file, "pushed on GitHub\n");
  git(clone, "push", "--force", "origin", `task/${taskId}`);
  return git(clone, "rev-parse", "HEAD");
}

// ADR 0231 決定2・3 / ADR 0239: 積み残しは回答時と merge 時に読み、門にも着地の登録にも混ぜない。
// 以下がこの検査を述べる唯一の場所(ADR 0107)。
/** タスクブランチを push して PR #1 を開く。auto_if_ci_green なら無人 merge キューに入り、
 *  escalate なら merge question が立つ。checkout はタスクブランチに残る。 */
export async function openPushedPr(name: string, merge: MergeDial) {
  const { workspace, publish } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const { id } = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, id);
  const work = getTask(db, id)!;
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "push", "-u", "head-repo", `task/${work.id}`);
  github.scriptPullRequestOnBranch(`task/${work.id}`);
  recordPushedHeadRepo(db, work.id, workspace);
  recordPrOpened(db, work, 1, git(workspace.path, "rev-parse", "HEAD"), clock.now(), { merge }, undefined);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile(merge),
  });
  return { workspace, publish, db, clock, github, work: getTask(db, work.id)!, landing };
}

/** 修理(`parentId` の付帯子)を盤面の経路で done にする: 拾い(lineage の帰り先から fork し、名前の場所は保護ブランチに休む)、
 *  task の checkout で `repair.txt` を commit し、完了の門が tip を名前の場所へ引く(ADR 0356 決定3)。後始末(解放の merge back)は
 *  まだ走っていない —— 走らせるのは `tearDownRepair`。門は開いている。 */
export async function settleRepairNotMergedBack(db: Db, clock: FakeClock, workspace: WorkspaceConfig, parentId: string, file = "repair.txt") {
  const repair = attachUnsettledChild(db, clock, parentId);
  const place = await prepareAtPickup(db, workspace, repair);
  commitWork(place.path, file, "fixed\n");
  recordTaskCheckoutTip(db, place, repair.id);
  completeTask(db, repair, FULL_HANDOFF, "worker", clock.now(), "worker");
  return getTask(db, repair.id)!;
}

/** `settleRepairNotMergedBack` の修理の後始末: 完了の後始末と同じ旗で解放し、記録した tip を帰り先へ merge back する(ADR 0053 決定2)。 */
export function tearDownRepair(db: Db, clock: FakeClock, workspace: WorkspaceConfig, repair: Task) {
  releaseWorkspace(db, taskRunPlaceForBoard(db, repair, () => workspace), getTask(db, repair.id)!, clock.now(), true, undefined, undefined, true);
}

// ADR 0240 決定4: workspace の quarantine の受理の検査は、内容が帰り先に届いていない done の work の merge back を
// やり直す。以下がこの検査を述べる唯一の場所(ADR 0107)。
export function answerWorkspaceQuarantine(
  { db, clock, workspace, landing, workbenchBase }: { db: Db; clock: FakeClock; workspace: WorkspaceConfig; landing: Landing; workbenchBase?: string },
  question: Task,
  pollNow: () => void = () => {},
) {
  return submitAnswer(
    { db, pollNow, landing, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db, workspace, workspacesDir: workbenchBase }) },
    getTask(db, question.id)!,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

export const head = (workspace: WorkspaceConfig) => git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");

export const HUMAN_ANSWERER = { actorId: HUMAN_ACTOR_ID, origin: "webui" } as const;

/** 出元 repo のタスクブランチの先端 —— GitHub が報告する PR の head。 */
export const forkHead = (workspace: WorkspaceConfig, taskId: string) =>
  git(workspace.path, "ls-remote", "head-repo", `refs/heads/task/${taskId}`).split("\t")[0]!;

// ADR 0242 決定1: merge の門は GitHub が報告した head と比べる —— 盤面の checkout の写しは読まない
/** PR #1 の merge question に人間が「merge」と答える。 */
export function answerMergeQuestion({
  db,
  clock,
  github,
  workspace,
  githubAuth,
  landing = unusedLanding,
  workspacesDir,
}: { db: Db; clock: FakeClock; github: FakeGitHubClient; workspace: WorkspaceConfig; githubAuth?: GitHubAuth; landing?: Landing; workspacesDir?: string }) {
  const question = getTask(db, listBoard(db).find((q) => q.question_pending_merge_pr === 1)!.id)!;
  return submitAnswer(
    { db, pollNow: () => {}, landing, workspace, github, githubAuth, workspacesDir },
    question,
    ["merge"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

/** PR #1 の開いている merge question。 */
export const openPrMergeQuestion = (db: Db) => listBoard(db).find((q) => q.question_pending_merge_pr === 1 && q.status === "todo");

/** PR #1 の開いている merge question に人間が「hold」と答える。答えた question を返す。 */
export async function answerHoldOnPr({ db, clock, landing, workspace, github }: { db: Db; clock: FakeClock; landing: Landing; workspace: WorkspaceConfig; github?: FakeGitHubClient }) {
  const question = getTask(db, openPrMergeQuestion(db)!.id)!;
  await submitAnswer({ db, pollNow: () => {}, landing, workspace, github }, question, ["hold"], undefined, () => clock.now(), "webui");
  return question;
}

/** `dropRepairOutsideBoard` の形を作業台の在る根で作る: 修理を merge back して収束が push した後、別の clone が PR のブランチを修理より前へ
 *  巻き戻す。 */
export async function droppedRepair(name: string) {
  const c = await pushedRoot(name, { pr: "recorded", merge: "auto_if_ci_green" });
  const repair = await settleRepairNotMergedBack(c.db, c.clock, c.workspace, c.work.id, "dropped.txt");
  tearDownRepair(c.db, c.clock, c.workspace, repair);
  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  (await outsideClone(c.workspace)).push(`${c.pushed}:refs/heads/${c.target}`);
  return { c, repair };
}

/** 盤面 DB の文のうち `fragment` を含むものを1回だけ落とす —— 着地の想定外の例外の題材。落ちたら元に戻す。 */
export function failPrepareOnce(db: Db, fragment: string, message: string): void {
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (!sql.includes(fragment)) return prepare(sql);
    spy.mockRestore();
    throw new Error(message);
  }) as typeof db.prepare);
}

/** `breakPackedRefs` の checkout に当たった着地の拒否文 —— 読めない ref を言い、workspace の Quarantine を名指す(ADR 0403 決定4)。 */
export const unreadableRefsRefusal = (workspace: Pick<WorkspaceConfig, "name">) =>
  new RegExp(
    `^could not verify refs for workspace "${workspace.name}" before landing: .*git for-each-ref.*not a packed ref; ` +
      `answer the quarantine question of workspace "${workspace.name}" before landing$`,
    "s",
  );

/** ref を読む git が exit 128 で落ちる checkout にする —— `rev-parse --verify --quiet` も「無い」(exit 1)とは答えない。 */
export const breakPackedRefs = (workspace: Pick<WorkspaceConfig, "path">) =>
  appendFileSync(join(workspace.path, ".git", "packed-refs"), "not a packed ref\n");

/** `breakPackedRefs` の行を取り除いて直す。 */
export function repairPackedRefs(workspace: Pick<WorkspaceConfig, "path">): void {
  const packed = join(workspace.path, ".git", "packed-refs");
  writeFileSync(packed, readFileSync(packed, "utf8").replace("not a packed ref\n", ""));
}

// ADR 0289 決定2: ローカル着地の merge 回答も同じ述語で拒み、比べる相手はローカルのタスクブランチ
/** purely-local の workspace で W を pickup して commit し、完了の後始末で休止位置へ戻し、収束が local merge question を立てた盤面。
 *  後始末を通すのは実経路の順(release → 次の pickup)—— 基準は切れないので、通さずに次を拾うと W のブランチを違反と読む(ADR 0351 決定2)。 */
export async function landLocally(name: string) {
  const workspace = await makeWorkspace(name);
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const work = landingWork(db, clock, workspace.name);
  const place = await prepareAtPickup(db, workspace, work);
  commitWork(place.path, "feature.txt", "ready\n");
  recordTaskCheckoutTip(db, place, work.id);
  const done = finish(db, clock, work);
  releaseWorkspace(db, place, done, clock.now(), true, undefined, undefined, true);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ form: "local_merge_question" });
  const question = openLocalMergeQuestions(db, work.id)[0]!;
  // 作業台の基点 —— 解放と回答が同じものを読む
  const base = await tempDir("tidepool-task-checkouts-");
  return { workspace, db, clock, landing, work, question, base };
}

/** `workId` の開いている local merge question。 */
export function openLocalMergeQuestions(db: Db, workId: string) {
  return listBoard(db).filter((q) => q.question_pending_local_merge_task_id === workId && q.status === "todo");
}

export function answerLocalMerge(
  { db, clock, workspace, question, base }: Awaited<ReturnType<typeof landLocally>>,
  answer: "merge" | "hold" = "merge",
  answering: { id: string } = question,
) {
  return submitAnswer(
    { db, pollNow: () => {}, landing: unusedLanding, workspace, workspacesDir: base },
    getTask(db, answering.id)!,
    [answer],
    undefined,
    () => clock.now(),
    "webui",
  );
}

// ADR 0217 決定3: 着地の2点 — PR を開く時点と、無人 merge キューの PR に CI を読んだ後で行為する瞬間 — で
// profile が解決できなければ、ダイヤルを推測せず agent を quarantine に落とす。以下はこの判定を述べる唯一の場所(ADR 0107)。
export const unresolvable = (): AuthorityProfile => {
  throw new UnknownAgentError("tako");
};

export function agentQuarantines(db: Db) {
  return listBoard(db).filter((q) => q.question_quarantine_kind === "agent" && q.status === "todo");
}

/** 着地 question に人間が WebUI から merge と答える。 */
export function answerMerge(board: Db, clock: FakeClock, workspace: WorkspaceConfig, question: Task, workspacesDir?: string) {
  return submitAnswer(
    { db: board, pollNow: () => {}, landing: unusedLanding, workspace, workspacesDir },
    question,
    ["merge"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

export function answerPromotion(
  board: Db,
  clock: FakeClock,
  landing: ReturnType<typeof createLanding>,
  workspace: WorkspaceConfig | undefined,
  question: { id: string },
  answer: "retry" | "abandon promotion",
) {
  return submitAnswer(
    { db: board, pollNow: () => {}, landing, workspace },
    getTask(board, question.id)!,
    [answer],
    undefined,
    () => clock.now(),
    "webui",
  );
}

export function openPromotionQuestions(board: Db, taskId: string) {
  return promotionFailures(board, taskId).filter((q) => q.status === "todo");
}

/** 盤面の外の書き手が名前の場所のブランチ `branch` に内容のある commit を積む(HEAD は保護ブランチへ戻す)。動かした先の sha を返す。 */
export function commitOutOfBand(workspace: WorkspaceConfig, branch: string): string {
  git(workspace.path, "checkout", branch);
  commitWork(workspace.path, "intruder.txt", "written outside the board\n");
  const moved = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "checkout", "main");
  return moved;
}

/** 保護ブランチの fetch の token の await で止まる盤面の身元 —— その間に名前の場所を動かす題材。 */
export function fetchHeldAtToken() {
  const window = awaitWindow();
  return { window, githubAuth: { ensureToken: () => window.hold(), env: () => process.env } as unknown as GitHubAuth };
}

/** The name `reef` registered for `old`'s checkout: the registry, the doors' materials, and the resolver that reads it fresh. */
export async function registeredReef(old: WorkspaceConfig) {
  const registryDir = await makeRegistry({ "workspaces.yaml": `reef:\n  path: ${old.path}\n  repo: ${old.repo}\n` });
  const admin = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-") };
  const resolve = (name: string | null) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), name ?? "reef", null, admin.workspacesBaseDir);
  return { registryDir, admin, resolve };
}

export type RegisteredReef = Awaited<ReturnType<typeof registeredReef>>;

/** 削除の扉 → 登録の扉(register)で `reef` を `moved` の checkout に登録し直す —— 扉は checkout の origin から `repo:` を書く。`between` は
 *  削除の後・登録の前の人間の手(checkout の origin を向け替えるなど)。`moved` が出元 repo を持てば `giveHeadRepo` で足す。 */
export async function reRegister(db: Db, reef: RegisteredReef, moved: WorkspaceConfig, between = () => {}): Promise<void> {
  await deleteWorkspace({ name: "reef", confirm: true }, {
    ...reef.admin,
    db,
    unsettledTaskCount: countUnsettledTasksReferencing(db, "workspace", "reef"),
    awaitingLandingTaskIds: taskIdsAwaitingLandingInWorkspace(db, buildWorkspaceResolver(reef.resolve, undefined), "reef"),
  });
  between();
  await createWorkspace({ name: "reef", mode: "register", path: moved.path, confirm: true }, { ...reef.admin, db });
  expect(reef.resolve("reef").repo).toBe(moved.repo);
  if (moved.head_repo !== undefined) giveHeadRepo(db, reef, moved.head_repo);
}

/** `reef` に出元 repo を足す。設定の扉(updateWorkspace)は GitHub の owner/name しか受けず fixture の local path を通せないので、扉が書く
 *  もの —— 覚えた値の予告・registry の宣言・畳み・覚えた値の確かめ —— を扉の順で置く(checkout の remote は fixture が置いた)。 */
export function giveHeadRepo(db: Db, reef: RegisteredReef, headRepo: string): void {
  announceHeadRepo(db, reef.resolve("reef"), headRepo);
  setWorkspaceEntry(reef.registryDir, "reef", "head_repo", headRepo);
  finishHeadRepoChange(db, reef.resolve("reef"));
  assertRememberedHeadRepo(db, reef.resolve("reef"), new Date());
}
