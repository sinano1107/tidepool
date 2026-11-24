import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { DomainError } from "../src/domain-error.js";
import { GitHubAuth } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import { getTask, listBoard } from "../src/tasks.js";
import { afterCiRead, awaitWindow, FakeGitHubClient, fakeHead } from "./fakes.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, makeLandingWorkspace } from "./harness.js";
import {
  afterEachPush,
  answerHoldOnPr,
  answerMergeQuestion,
  autoMerging,
  boardEvents,
  CI_RED_PURPOSE,
  CONFLICT,
  commitThroughTaskCheckout,
  convergeOn,
  finish,
  forkHead,
  landingWork,
  mergeQuestion,
  mergeQuestions,
  openBoard,
  openPushedPr,
  profile,
  promotionFailures,
  pushedRoot,
  pushOutsideBoard,
  queueAutoMerge,
  readOnNextTick,
  recordPrOpenedOutsideConvergence,
  textA4c,
} from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0387 決定1: 無人 merge は head が盤面の最後に push した sha と一致するときだけ merge する。
// 以下がこの判定を述べる唯一の場所(ADR 0107)。

// ADR 0387 決定4: 収束の記録済みの PR への push は、push の前から最後に push した値を書くまで in-flight 印を持つ
const IN_FLIGHT = "PR #1 is being merged or pushed to by the board right now — answer again in a moment";

/** 盤面の知らない commit の、推奨 hold の merge question の本文。 */
const outsideHeadBody = (head: string, lastPushed: string) =>
  `"ship": PR #1's head ${head} holds commits the board did not push — the board last pushed ${lastPushed}. ` +
  `See them with \`git log ${lastPushed}..${head}\`. Merge, or hold?`;

const UNREADABLE_PATHS = "\n\nThe board could not compare this PR head with the protected branch to check which paths require a human merge.";

it.each(["success", "pending", "unreported", "failure"] as const)("外から進んだ head は CI が %s でも無人で merge されず、キューを外れて盤面の知らない commit を言う推奨 hold の merge question が1つ立つ", async (ci) => {
  const pr = await openPushedPr(`outside-head-ci-${ci}`, "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus(ci);

  await pr.landing.tick("auto_merge");

  expect(pr.github.merged).toEqual([]);
  expect(await readOnNextTick(pr.landing, pr.github)).toEqual([]);
  expect(mergeQuestions(pr.db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold",
      purpose: outsideHeadBody(head, lastPushed) + (ci === "failure" ? '\n\n"ship"\'s auto_if_ci_green auto-merge found CI red on PR #1.' : "") },
  ]);
});

it("最後に push した sha が手元に無いまま head が違えば、祖先関係を確かめられない head として merge されず question が立つ", async () => {
  const { workspace } = await makeLandingWorkspace("outside-head-last-pushed-missing");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  queueAutoMerge(db, clock, 1, workspace);
  github.scriptHead(1, "head-the-board-did-not-push");

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db).map(({ recommendation, purpose }) => ({ recommendation, purpose }))).toEqual([
    { recommendation: "hold", purpose: outsideHeadBody("head-the-board-did-not-push", fakeHead(1)) + UNREADABLE_PATHS },
  ]);
});

/** origin にも手元にも無い sha。 */
const NOWHERE = "0123456789abcdef0123456789abcdef01234567";

it("GitHub の head が手元にも出元 repo にも無ければ、取れない head として merge されずキューを外れ、推奨 hold の question になる", async () => {
  const pr = await openPushedPr("outside-head-unfetchable", "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  pr.github.scriptHead(1, NOWHERE);

  await pr.landing.tick("auto_merge");

  expect(pr.github.merged).toEqual([]);
  expect(mergeQuestions(pr.db).map(({ recommendation, purpose }) => ({ recommendation, purpose }))).toEqual([
    { recommendation: "hold", purpose: outsideHeadBody(NOWHERE, lastPushed) + UNREADABLE_PATHS },
  ]);
  expect(await readOnNextTick(pr.landing, pr.github)).toEqual([]);
});

// 書き換え・巻き戻しの head は ADR 0376 決定7 が受ける —— 着地するタスクのブランチが手元に無くても、祖先関係で確かめた書き換えは書き換え
it.each(["success", "failure", "pending"] as const)("手元に根のタスクブランチが無い PR の head が書き換えられれば、CI が %s でも落ちた内容の推奨 hold の question が立つ", async (ci) => {
  const { workspace } = await makeLandingWorkspace(`outside-head-rewritten-no-local-branch-${ci}`);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", "scratch");
  commitWork(workspace.path, "feature.txt", "ready\n");
  const lastPushed = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "push", "head-repo", `scratch:task/${work.id}`);
  git(workspace.path, "checkout", "main");
  git(workspace.path, "branch", "-D", "scratch");
  github.scriptPullRequestOnBranch(`task/${work.id}`, 1);
  recordPrOpenedOutsideConvergence(db, work, 1, clock.now(), { authority: { merge: "auto_if_ci_green" }, head: lastPushed, workspace });
  await pushOutsideBoard(workspace, work.id, `${lastPushed}~1`);
  github.scriptCiStatus(ci);

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([{
    pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold",
    purpose: textA4c(`task/${work.id}`) + (ci === "failure" ? '\n\n"ship"\'s auto_if_ci_green auto-merge found CI red on PR #1.' : ""),
  }]);
});

/** 人間の「merge」の回答。拒否なら DomainError の文を、通れば undefined を返す。 */
const answerMerge = (pr: Awaited<ReturnType<typeof openPushedPr>>) =>
  answerMergeQuestion(pr).then(
    () => undefined,
    (err: unknown) => {
      expect(err).toBeInstanceOf(DomainError);
      return (err as Error).message;
    },
  );

/** 盤面の知らない commit を列挙し、立て直した question を名指す拒否文(ADR 0394 決定3)。`commits` は新しい順の
 *  [sha, `pushOutsideBoard` が書いた file]。 */
const listedRefusal = (head: string, lastPushed: string, commits: Array<[string, string]>, replacement: string) =>
  `PR #1's head ${head} holds commits the board did not push (the board last pushed ${lastPushed}): ` +
  `${commits.map(([sha, file]) => `${sha} add ${file}`).join("; ")}. ` +
  `This question is closed — question ${replacement} now asks about this head; answer \`merge\` there to merge it.`;

/** PR #1 の開いている merge question。 */
const openQuestion = (pr: Awaited<ReturnType<typeof openPushedPr>>) => listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;

// ADR 0394 決定5・7: tick の question への hold も同じ記録を刻む。tick はキューの行を外しているので立て直さない
it("tick が立てた盤面の知らない commit の merge question に「hold」と答えると、question の内容を根に刻み、次の tick は question を立て直さない", async () => {
  const pr = await openPushedPr("outside-head-tick-held", "auto_if_ci_green");
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  await pr.landing.tick("auto_merge");

  const held = await answerHoldOnPr(pr);

  expect(boardEvents(pr.db, pr.work.id, "landing_declined")).toEqual([{
    actor_id: HUMAN_ACTOR_ID,
    origin: "webui",
    payload: { kind: "landing_declined", question_id: held.id, tip: held.question_landing_tip, outside: { kind: "not_pushed", sha: head }, missing_branches: null },
  }]);
  expect(await readOnNextTick(pr.landing, pr.github)).toEqual([]);
  expect(mergeQuestions(pr.db)).toEqual([]);
});

// ADR 0394 決定5: hold は外の部分が今と違っても拒まない —— 断るのは人間が見た question の内容
it("CI 赤の merge question が開いた後に head が外から進んでも、その question への「hold」は拒まれず、question が問うた内容(外の head 無し)を刻む", async () => {
  const pr = await openPushedPr("outside-head-hold-after-move", "auto_if_ci_green");
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge");
  await pushOutsideBoard(pr.workspace, pr.work.id);

  const held = await answerHoldOnPr(pr);

  expect(getTask(pr.db, held.id)).toMatchObject({ status: "done", question_answer: ["hold"] });
  expect(boardEvents(pr.db, pr.work.id, "landing_declined").map(({ payload }) => payload)).toEqual([
    { kind: "landing_declined", question_id: held.id, tip: held.question_landing_tip, outside: null, missing_branches: null },
  ]);
});

it("盤面の知らない commit を言う merge question への最初の「merge」は拒まれずに merge する", async () => {
  const pr = await openPushedPr("outside-head-question-merges", "auto_if_ci_green");
  await pushOutsideBoard(pr.workspace, pr.work.id);
  await pr.landing.tick("auto_merge");

  await expect(answerMerge(pr)).resolves.toBeUndefined();

  expect(pr.github.merged.map(({ number }) => number)).toEqual([1]);
});

it("キューにいる PR の merge question が開いたまま外から進んだ head を tick が読むと、古い question は閉じ、新しい question への最初の「merge」が通る", async () => {
  const pr = await openPushedPr("outside-head-question-already-open", "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  const registered = mergeQuestion(pr.db, pr.clock, { pending_merge_pr: 1, root: pr.work.id }, pr.work.workspace ?? undefined);
  const original = getTask(pr.db, registered.id)!;
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);

  await pr.landing.tick("auto_merge");

  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([outsideHeadBody(head, lastPushed)]);
  expect(getTask(pr.db, original.id)).toEqual({ ...original, status: "done" });
  const replacement = openQuestion(pr);
  expect(boardEvents(pr.db, pr.work.id, "pr_merge_question_replaced")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merge_question_replaced", question_id: original.id, replacement_question_id: replacement.id } },
  ]);
  await expect(submitAnswer(
    { ...pr, pollNow: () => {} }, getTask(pr.db, original.id)!, ["merge"], undefined, () => pr.clock.now(), "webui",
  )).rejects.toThrow("question closed");
  expect(pr.github.merged).toEqual([]);
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([head]);
});

it("人間の merge が執行中なら収束は question を取り替えず、執行が終われば書き換えを問い直す", async () => {
  const pr = await openPushedPr("rewrite-during-executing-answer", "escalate");
  const original = openQuestion(pr);
  const fork = git(pr.workspace.path, "rev-parse", "HEAD~1");
  const executing = awaitWindow();
  const prepareMerge = pr.github.prepareMerge.bind(pr.github);
  vi.spyOn(pr.github, "prepareMerge").mockImplementationOnce(async (ref) => {
    const merge = await prepareMerge(ref);
    return async (head) => {
      await executing.hold();
      await merge(head);
    };
  });
  const answer = answerMerge(pr);
  await executing.entered;

  try {
    finish(pr.db, pr.clock, pr.work);
    await commitThroughTaskCheckout(pr.db, pr.clock, pr.workspace, pr.work, "repair.txt", "fixed\n");
    await pushOutsideBoard(pr.workspace, pr.work.id, fork);
    await convergeOn(pr.landing, pr.work.id);

    expect(listBoard(pr.db).filter((q) => q.question_pending_merge_pr === 1)).toEqual([original]);
  } finally {
    executing.open();
  }

  expect(await answer).toContain("Head branch was modified");
  await convergeOn(pr.landing, pr.work.id);
  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([textA4c(`task/${pr.work.id}`)]);
  expect(getTask(pr.db, original.id)?.status).toBe("done");
});

it("無人 merge の執行中に収束が書き換えを読んでも、merge が済む PR に question を立てない", async () => {
  const c = await pushedRoot("rewrite-during-auto-merge-write", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ form: "open_pull_request_updated" });
  const pushed = forkHead(c.workspace, c.work.id);
  const executing = awaitWindow();
  const prepareMerge = c.github.prepareMerge.bind(c.github);
  vi.spyOn(c.github, "prepareMerge").mockImplementationOnce(async (ref) => {
    const merge = await prepareMerge(ref);
    return async (head) => {
      await executing.hold();
      await merge(head);
    };
  });
  const tick = c.landing.tick("auto_merge");
  await executing.entered;
  try {
    await commitThroughTaskCheckout(c.db, c.clock, c.workspace, c.work, "another-repair.txt", "fixed\n");
    await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${pushed}~1`));
    await convergeOn(c.landing, c.work.id);
    c.github.scriptHead(1, pushed);
  } finally {
    executing.open();
    await tick;
  }

  expect(c.github.mergedHeads).toEqual([pushed]);
  expect(boardEvents(c.db, c.work.id, "pr_merged")).toHaveLength(1);
  expect(mergeQuestions(c.db)).toEqual([]);
});

it("着地の面が question 側へ変わった PR の外から進んだ head に立った question への最初の「merge」は、question が問うた head として拒まれずに merge する", async () => {
  const pr = await openPushedPr("outside-head-surface-changed", "auto_if_ci_green");
  const landing = autoMerging(pr.db, pr.clock, pr.workspace, pr.github, () => profile("escalate"));
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);

  await landing.tick("auto_merge");
  expect(mergeQuestions(pr.db)).toEqual([{
    pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold",
    purpose: outsideHeadBody(head, lastPushed) + '\n\n"ship"\'s PR #1 was queued for auto_if_ci_green auto-merge, but its landing surface changed after it was queued: the merge dial is now escalate.',
  }]);

  await expect(answerMerge({ ...pr, landing })).resolves.toBeUndefined();
  expect(pr.github.merged.map(({ number }) => number)).toEqual([1]);
});

it("CI 赤の question が開いた後に外から進んだ head への「merge」は commit を列挙して拒まれ、古い question が閉じて立て直した question を名指し、立て直した question への「merge」が merge する。さらに commit が足されればまた拒まれて立て直す", async () => {
  const pr = await openPushedPr("outside-head-after-ci-red", "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge");
  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([CI_RED_PURPOSE]);
  const ciRed = openQuestion(pr);
  const first = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("success");

  const refusal = await answerMerge(pr);
  const asked = openQuestion(pr);
  expect(refusal).toBe(listedRefusal(first, lastPushed, [[first, "outside.txt"]], asked.id));
  expect(getTask(pr.db, ciRed.id)?.status).toBe("done");
  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([outsideHeadBody(first, lastPushed)]);
  expect(pr.github.merged).toEqual([]);

  const second = await pushOutsideBoard(pr.workspace, pr.work.id, undefined, "outside-again.txt");
  const again = await answerMerge(pr);
  expect(getTask(pr.db, asked.id)?.status).toBe("done");
  expect(again).toBe(listedRefusal(second, lastPushed, [
    [second, "outside-again.txt"],
    [first, "outside.txt"],
  ], openQuestion(pr).id));
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([second]);
});

it("merge 失敗の question が開いた後に人間が conflict を解いて push した head への「merge」は、push した commit を列挙し立て直した question を名指して拒まれ、その question への「merge」が merge する", async () => {
  const pr = await openPushedPr("outside-head-after-conflict", "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  vi.spyOn(pr.github, "prepareMerge").mockResolvedValueOnce(() => Promise.reject(new Error(CONFLICT)));
  await pr.landing.tick("auto_merge");
  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([expect.stringContaining(`could not merge PR #1: ${CONFLICT}.`)]);
  expect(openQuestion(pr).purpose).toContain("merge main into the PR's head in your own clone and push it");
  const resolved = await pushOutsideBoard(pr.workspace, pr.work.id, undefined, "resolved.txt");

  const refusal = await answerMerge(pr);
  expect(refusal).toBe(listedRefusal(resolved, lastPushed, [[resolved, "resolved.txt"]], openQuestion(pr).id));
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([resolved]);
});

it("conflict and outside-head questions name the branch GitHub reports for an older PR", async () => {
  const pr = await openPushedPr("outside-head-previous-fork", "auto_if_ci_green");
  const headRef = { branch: `task/${pr.work.id}`, repo: "acme/previous-fork" };
  const read = pr.github.readPullRequest.bind(pr.github);
  vi.spyOn(pr.github, "readPullRequest").mockImplementation(async (ref) => {
    const current = await read(ref);
    return current.state === "unreadable" ? current : { ...current, headRef };
  });
  vi.spyOn(pr.github, "prepareMerge").mockResolvedValueOnce(() => Promise.reject(new Error(CONFLICT)));
  await pr.landing.tick("auto_merge");

  expect(openQuestion(pr).purpose).toContain(`merge main into ${headRef.branch} in your own clone and push it to head repo ${headRef.repo}`);
  const outside = await pushOutsideBoard(pr.workspace, pr.work.id);

  expect(await answerMerge(pr)).toContain(`PR #1's head ${outside} (${headRef.branch} on head repo ${headRef.repo}) holds commits the board did not push`);
  expect(openQuestion(pr).purpose).toContain(`${headRef.branch} on head repo ${headRef.repo}`);
});


// ADR 0387 Status 追記 (1) / ADR 0394 決定3: 一方の立て直しを、もう一方が見ないまま通らない —— もう一方は question が開いているかの読み直しで拒まれる
it("同じ question に同時に走る2つの「merge」の回答は、一方が commit を列挙して立て直し、もう一方は question closed で拒まれ、立て直した question への「merge」が merge する", async () => {
  const pr = await openPushedPr("outside-head-concurrent-answers", "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge");
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("success");

  const [first, second] = await Promise.all([answerMerge(pr), answerMerge(pr)]);

  const replacement = openQuestion(pr);
  expect(first).toBe(listedRefusal(head, lastPushed, [[head, "outside.txt"]], replacement.id));
  expect(second).toContain("question closed");
  expect(listBoard(pr.db).filter((q) => q.question_pending_merge_pr === 1).map((q) => q.id)).toEqual([replacement.id]);
  expect(pr.github.merged).toEqual([]);
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([head]);
});

// ADR 0394 決定1・3: 回答が立て直す question も、外の本文の後ろにほかの理由を1行添える —— 回答が読んだ CI が赤ならそれを言う
it("CI が赤のまま盤面が push していない head への「merge」が立て直す question は、外の head を先に言い、CI が赤であることを後ろに添える", async () => {
  const pr = await openPushedPr("outside-head-reraised-on-red-ci", "escalate");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");

  expect(await answerMerge(pr)).toBe(listedRefusal(head, lastPushed, [[head, "outside.txt"]], openQuestion(pr).id));

  expect(mergeQuestions(pr.db)).toEqual([{
    pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold",
    purpose: `${outsideHeadBody(head, lastPushed)}\n\n"ship"'s PR #1 has CI red.`,
  }]);
});

// ADR 0288 決定2(印の後): 比べる await の間に別の回答が印を取って merge を始めれば、その question を取り下げず答え直させる
it("回答が head を比べる間に同じ PR に in-flight 印が付けば、question を立て直さずに答え直させる", async () => {
  const pr = await openPushedPr("outside-head-marked-during-compare", "escalate");
  const asked = openQuestion(pr);
  await pushOutsideBoard(pr.workspace, pr.work.id);
  const githubAuth = new GitHubAuth(join(await tempDir("tidepool-token-"), "token"));
  const ensureToken = githubAuth.ensureToken.bind(githubAuth);
  let release: (() => void) | null = null;
  // head は手元に無いので、比べる前に取る —— その token の await の間に印を取る
  vi.spyOn(githubAuth, "ensureToken").mockImplementationOnce(async (repo, options) => {
    release = pr.landing.takeInFlightMark(pr.work.id);
    return ensureToken(repo, options);
  });

  const refusal = await answerMergeQuestion({ ...pr, githubAuth }).then(() => undefined, (err: Error) => err.message);

  expect(release).not.toBeNull();
  expect(refusal).toBe(IN_FLIGHT);
  expect(openQuestion(pr).id).toBe(asked.id);
  expect(boardEvents(pr.db, pr.work.id, "pr_merge_question_replaced")).toEqual([]);
});

// ADR 0387 Status 追記 (1) / ADR 0288 決定2: 問うた head を読んだ回答も、merge の前にもう一方の回答が立て直していれば、question が開いているかの
// 読み直しで拒まれる
it("一方の「merge」が問うた head を読んだ後、merge の前にもう一方の「merge」が立て直せば、先に読んだ回答は question closed で拒まれ merge しない", async () => {
  const pr = await openPushedPr("outside-head-reraised-before-mark", "escalate");
  const asked = openQuestion(pr);
  let reraising: Promise<string | undefined> | undefined;
  const read = pr.github.readPullRequest.bind(pr.github);
  pr.github.readPullRequest = async (ref) => {
    const status = await read(ref);
    pr.github.readPullRequest = read;
    await pushOutsideBoard(pr.workspace, pr.work.id);
    reraising = answerMerge(pr);
    await reraising;
    return status;
  };

  const first = await answerMerge(pr);

  const replacement = openQuestion(pr);
  expect(replacement.id).not.toBe(asked.id);
  expect(first).toContain("question closed");
  expect(await reraising).toContain(`This question is closed — question ${replacement.id} now asks about this head`);
  expect(pr.github.merged).toEqual([]);
});

it("回答が PR を読んでいる間に収束が push して最後に push した値を書けば、回答は判定せず答え直させ、question も立て直さず、次の「merge」が盤面の push した head を merge する", async () => {
  const pr = await openPushedPr("outside-head-pushed-during-answer-read", "escalate");
  commitWork(pr.workspace.path, "repair.txt", "fixed\n");
  finish(pr.db, pr.clock, pr.work);
  const read = pr.github.readPullRequest.bind(pr.github);
  pr.github.readPullRequest = async (ref) => {
    const status = await read(ref);
    pr.github.readPullRequest = read;
    await expect(convergeOn(pr.landing, pr.work.id)).resolves.toMatchObject({ form: "open_pull_request_updated" });
    return status;
  };

  const asked = openQuestion(pr);
  expect(await answerMerge(pr)).toBe(IN_FLIGHT);
  expect(openQuestion(pr).id).toBe(asked.id);
  expect(boardEvents(pr.db, pr.work.id, "pr_merge_question_replaced")).toEqual([]);

  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([forkHead(pr.workspace, pr.work.id)]);
});

it("転送の後に失敗と報告された収束の push も、出元 repo に載っていれば盤面の push として記録され、次の tick が盤面の push した head を merge する", async () => {
  const c = await pushedRoot("outside-head-push-fails-after-transfer", { pr: "recorded", merge: "auto_if_ci_green" });
  c.github.scriptPushFailure(new Error("push rejected"));
  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "failed", error: "push rejected" });
  c.github.scriptPushFailure(null);

  await c.landing.tick("auto_merge");

  expect(mergeQuestions(c.db)).toEqual([]);
  expect(c.github.mergedHeads).toEqual([forkHead(c.workspace, c.work.id)]);
});

it("回答が head を読んだ時点で同じ PR に in-flight 印が付いていれば、判定せずに答え直させて question を立て直さず、印が放された後の「merge」が立て直して拒まれる", async () => {
  const pr = await openPushedPr("outside-head-marked-during-read", "auto_if_ci_green");
  const lastPushed = forkHead(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge");
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("success");
  let release: (() => void) | null = null;
  afterCiRead(pr.github, () => {
    release ??= pr.landing.takeInFlightMark(pr.work.id);
  });

  const asked = openQuestion(pr);
  expect(await answerMerge(pr)).toBe(IN_FLIGHT);
  expect(openQuestion(pr).id).toBe(asked.id);
  expect(boardEvents(pr.db, pr.work.id, "pr_merge_question_replaced")).toEqual([]);

  release!();
  const refusal = await answerMerge(pr);
  expect(refusal).toBe(listedRefusal(head, lastPushed, [[head, "outside.txt"]], openQuestion(pr).id));
  expect(getTask(pr.db, asked.id)?.status).toBe("done");
});

it("無人 merge の tick が in-flight 印を持つ間、収束は記録済みの PR へ push せず次の突きに回し、retry の回答は答え直させる", async () => {
  const c = await pushedRoot("outside-head-convergence-waits-for-mark", { pr: "recorded", merge: "auto_if_ci_green", openFailure: true });
  const release = c.landing.takeInFlightMark(c.work.id)!;

  expect(await c.retry(promotionFailures(c.db, c.work.id)[0]!)).toBe(IN_FLIGHT);
  expect(c.github.pushes).toEqual([]);

  release();
  await expect(c.retry(promotionFailures(c.db, c.work.id)[0]!)).resolves.toBeUndefined();
  expect(c.github.pushes).toHaveLength(1);
});

it("in-flight 印が付いている間の突きでは収束は push せず、印が放された次の突きで push する", async () => {
  const c = await pushedRoot("outside-head-poke-waits-for-mark", { pr: "recorded", merge: "auto_if_ci_green" });
  const release = c.landing.takeInFlightMark(c.work.id)!;

  await expect(convergeOn(c.landing, c.work.id)).resolves.toBeUndefined();
  expect(c.github.pushes).toEqual([]);

  release();
  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
});

it("収束が push して最後に push した値を書く前に tick が回っても、tick はその PR を飛ばして question を立てず、次の tick が盤面の push した head を merge する", async () => {
  const c = await pushedRoot("outside-head-tick-during-push", { pr: "recorded", merge: "auto_if_ci_green" });
  let ticking: Promise<void> | undefined;
  afterEachPush(c.github, () => {
    ticking = c.landing.tick("auto_merge");
  });

  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await ticking;

  expect(mergeQuestions(c.db)).toEqual([]);
  expect(c.github.merged).toEqual([]);
  await c.landing.tick("auto_merge");
  expect(c.github.mergedHeads).toEqual([forkHead(c.workspace, c.work.id)]);
});
