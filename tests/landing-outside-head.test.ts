import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { DomainError } from "../src/domain-error.js";
import { submitAnswer } from "../src/human-verbs.js";
import { getTask, listBoard } from "../src/tasks.js";
import { afterCiRead, awaitWindow, FakeGitHubClient, fakeHead } from "./fakes.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, makeRemoteBackedWorkspace } from "./harness.js";
import {
  afterEachPush,
  answerMergeQuestion,
  autoMerging,
  boardEvents,
  CI_RED_PURPOSE,
  CONFLICT,
  commitThroughTaskCheckout,
  convergeOn,
  finish,
  landingWork,
  mergeQuestion,
  mergeQuestions,
  openBoard,
  openPushedPr,
  originHead,
  profile,
  promotionFailures,
  pushedRoot,
  pushOutsideBoard,
  queueAutoMerge,
  readOnNextTick,
  recordPrOpenedViaWorker,
  textA4c,
} from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0387 決定1: 無人 merge は head が盤面の最後に push した sha と一致するときだけ merge する。
// 以下がこの判定を述べる唯一の場所(ADR 0107)。

// ADR 0387 決定4: 収束の記録済みの PR への push は、push の前から最後に push した値を書くまで in-flight 印を持つ
const IN_FLIGHT = "PR #1 is being merged or pushed to by the board right now — answer again in a moment";

/** 盤面の知らない commit の、推奨 hold の merge question の本文。 */
const outsideHeadBody = (head: string, lastPushed: string) =>
  `"ship": PR #1's head ${head} holds commits the board did not push — the board last pushed ${lastPushed}. ` +
  `See them with \`git log ${lastPushed}..${head}\`. Merge, or hold?`;

it.each(["success", "pending", "unreported", "failure"] as const)("外から進んだ head は CI が %s でも無人で merge されず、キューを外れて盤面の知らない commit を言う推奨 hold の merge question が1つ立つ", async (ci) => {
  const pr = await openPushedPr(`outside-head-ci-${ci}`, "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus(ci);

  await pr.landing.tick("auto_merge", pr.clock.now());

  expect(pr.github.merged).toEqual([]);
  expect(await readOnNextTick(pr.landing, pr.github, pr.clock.now())).toEqual([]);
  expect(mergeQuestions(pr.db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold",
      purpose: outsideHeadBody(head, lastPushed) + (ci === "failure" ? '\n\n"ship"\'s auto_if_ci_green auto-merge found CI red on PR #1.' : "") },
  ]);
});

it("最後に push した sha が手元に無いまま head が違えば、祖先関係を確かめられない head として merge されず question が立つ", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("outside-head-last-pushed-missing");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  queueAutoMerge(db, clock, 1);
  github.scriptHead(1, "head-the-board-did-not-push");

  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db).map(({ recommendation, purpose }) => ({ recommendation, purpose }))).toEqual([
    { recommendation: "hold", purpose: outsideHeadBody("head-the-board-did-not-push", fakeHead(1)) },
  ]);
});

/** origin にも手元にも無い sha。 */
const NOWHERE = "0123456789abcdef0123456789abcdef01234567";

it("GitHub の head が手元にも origin にも無ければ、取れない head として merge されずキューを外れ、推奨 hold の question になる", async () => {
  const pr = await openPushedPr("outside-head-unfetchable", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  pr.github.scriptHead(1, NOWHERE);

  await pr.landing.tick("auto_merge", pr.clock.now());

  expect(pr.github.merged).toEqual([]);
  expect(mergeQuestions(pr.db).map(({ recommendation, purpose }) => ({ recommendation, purpose }))).toEqual([
    { recommendation: "hold", purpose: outsideHeadBody(NOWHERE, lastPushed) },
  ]);
  expect(await readOnNextTick(pr.landing, pr.github, pr.clock.now())).toEqual([]);
});

// 書き換え・巻き戻しの head は ADR 0376 決定7 が受ける —— 着地するタスクのブランチが手元に無くても、祖先関係で確かめた書き換えは書き換え
it.each(["success", "failure", "pending"] as const)("手元に根のタスクブランチが無い PR の head が書き換えられれば、CI が %s でも落ちた内容の推奨 hold の question が立つ", async (ci) => {
  const { workspace } = await makeRemoteBackedWorkspace(`outside-head-rewritten-no-local-branch-${ci}`);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", "scratch");
  commitWork(workspace.path, "feature.txt", "ready\n");
  const lastPushed = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "push", "origin", `scratch:task/${work.id}`);
  git(workspace.path, "checkout", "main");
  git(workspace.path, "branch", "-D", "scratch");
  github.scriptPullRequestOnBranch(`task/${work.id}`, 1);
  recordPrOpenedViaWorker(db, work, 1, "worker", clock.now(), { authority: { merge: "auto_if_ci_green" }, head: lastPushed });
  await pushOutsideBoard(workspace, work.id, `${lastPushed}~1`);
  github.scriptCiStatus(ci);

  await landing.tick("auto_merge", clock.now());

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

/** 盤面の知らない commit を列挙する拒否文。`commits` は新しい順の [sha, `pushOutsideBoard` が書いた file]。 */
const listedRefusal = (head: string, lastPushed: string, commits: Array<[string, string]>) =>
  `PR #1's head ${head} holds commits the board did not push (the board last pushed ${lastPushed}): ` +
  `${commits.map(([sha, file]) => `${sha} add ${file}`).join("; ")}. Answer \`merge\` again to merge them.`;

it("盤面の知らない commit を言う merge question への最初の「merge」は拒まれずに merge する", async () => {
  const pr = await openPushedPr("outside-head-question-merges", "auto_if_ci_green");
  await pushOutsideBoard(pr.workspace, pr.work.id);
  await pr.landing.tick("auto_merge", pr.clock.now());

  await expect(answerMerge(pr)).resolves.toBeUndefined();

  expect(pr.github.merged.map(({ number }) => number)).toEqual([1]);
});

it("キューにいる PR の merge question が開いたまま外から進んだ head を tick が読むと、古い question は閉じ、新しい question への最初の「merge」が通る", async () => {
  const pr = await openPushedPr("outside-head-question-already-open", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  const registered = mergeQuestion(pr.db, pr.clock, { pending_merge_pr: 1 }, pr.work.workspace ?? undefined);
  const original = getTask(pr.db, registered.id)!;
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);

  await pr.landing.tick("auto_merge", pr.clock.now());

  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([outsideHeadBody(head, lastPushed)]);
  expect(getTask(pr.db, original.id)).toEqual({ ...original, status: "done" });
  const replacement = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;
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
  const original = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;
  const fork = git(pr.workspace.path, "rev-parse", "HEAD~1");
  const executing = awaitWindow();
  const merge = pr.github.mergePullRequest.bind(pr.github);
  vi.spyOn(pr.github, "mergePullRequest").mockImplementationOnce(async (ref, head) => {
    await executing.hold();
    await merge(ref, head);
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
  const pushed = originHead(c.workspace, c.work.id);
  const executing = awaitWindow();
  const merge = c.github.mergePullRequest.bind(c.github);
  vi.spyOn(c.github, "mergePullRequest").mockImplementationOnce(async (ref, head) => {
    await executing.hold();
    await merge(ref, head);
  });
  const tick = c.landing.tick("auto_merge", c.clock.now());
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

it("着地の面が question 側へ変わった PR の外から進んだ head に立った question への最初の「merge」は、伝えた head として拒まれずに merge する", async () => {
  const pr = await openPushedPr("outside-head-surface-changed", "auto_if_ci_green");
  const landing = autoMerging(pr.db, pr.clock, pr.workspace, pr.github, () => profile("escalate"));
  const lastPushed = originHead(pr.workspace, pr.work.id);
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);

  await landing.tick("auto_merge", pr.clock.now());
  expect(mergeQuestions(pr.db)).toEqual([{
    pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold",
    purpose: outsideHeadBody(head, lastPushed) + '\n\n"ship"\'s PR #1 was queued for auto_if_ci_green auto-merge, but its landing surface changed after it was queued: the merge dial is now escalate.',
  }]);

  await expect(answerMerge({ ...pr, landing })).resolves.toBeUndefined();
  expect(pr.github.merged.map(({ number }) => number)).toEqual([1]);
});

it("CI 赤の question が開いた後に外から進んだ head への最初の「merge」は commit を列挙して1回拒まれ、同じ head への次の「merge」が merge する。さらに commit が足されればまた1回拒まれる", async () => {
  const pr = await openPushedPr("outside-head-after-ci-red", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge", pr.clock.now());
  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([CI_RED_PURPOSE]);
  const first = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("success");

  expect(await answerMerge(pr)).toBe(listedRefusal(first, lastPushed, [[first, "outside.txt"]]));
  const question = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;
  expect(getTask(pr.db, question.id)?.status).toBe("todo");
  expect(pr.github.merged).toEqual([]);

  const second = await pushOutsideBoard(pr.workspace, pr.work.id, undefined, "outside-again.txt");
  expect(await answerMerge(pr)).toBe(listedRefusal(second, lastPushed, [
    [second, "outside-again.txt"],
    [first, "outside.txt"],
  ]));
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([second]);
});

it("merge 失敗の question が開いた後に人間が conflict を解いて push した head への最初の「merge」は、push した commit を列挙して1回拒まれ、次の「merge」が merge する", async () => {
  const pr = await openPushedPr("outside-head-after-conflict", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  vi.spyOn(pr.github, "mergePullRequest").mockRejectedValueOnce(new Error(CONFLICT));
  await pr.landing.tick("auto_merge", pr.clock.now());
  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual([
    `"ship"'s auto_if_ci_green auto-merge could not merge PR #1: ${CONFLICT}. Merge once it is fixed, or hold? If PR #1 conflicts with main, ` +
      "merge main into the PR's head in your own clone and push it — do not rebase or force-push; the board treats such a head as rewritten outside — " +
      "then answer `merge`: the board refuses it once, listing the commits you pushed, and the next `merge` merges.",
  ]);
  const resolved = await pushOutsideBoard(pr.workspace, pr.work.id, undefined, "resolved.txt");

  expect(await answerMerge(pr)).toBe(listedRefusal(resolved, lastPushed, [[resolved, "resolved.txt"]]));
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([resolved]);
});


it("同時に走る2つの「merge」の回答は、どちらも伝える前に始まった回答なので両方とも1回拒まれ、その後の「merge」が merge する", async () => {
  const pr = await openPushedPr("outside-head-concurrent-answers", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge", pr.clock.now());
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("success");
  const refusal = listedRefusal(head, lastPushed, [[head, "outside.txt"]]);

  const [first, second] = [answerMerge(pr), answerMerge(pr)];

  expect(await Promise.all([first, second])).toEqual([refusal, refusal]);
  expect(pr.github.merged).toEqual([]);
  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([head]);
});

it("回答が PR を読んでいる間に収束が push して最後に push した値を書けば、回答は判定せず答え直させ、伝えた記録も残さず、次の「merge」が盤面の push した head を merge する", async () => {
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

  expect(await answerMerge(pr)).toBe(IN_FLIGHT);
  expect(boardEvents(pr.db, pr.work.id, "pr_head_conveyed")).toEqual([]);

  await expect(answerMerge(pr)).resolves.toBeUndefined();
  expect(pr.github.mergedHeads).toEqual([originHead(pr.workspace, pr.work.id)]);
});

it("転送の後に失敗と報告された収束の push も、origin に載っていれば盤面の push として記録され、次の tick が盤面の push した head を merge する", async () => {
  const c = await pushedRoot("outside-head-push-fails-after-transfer", { pr: "recorded", merge: "auto_if_ci_green" });
  c.github.scriptPushFailure(new Error("push rejected"));
  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "failed", error: "push rejected" });
  c.github.scriptPushFailure(null);

  await c.landing.tick("auto_merge", c.clock.now());

  expect(mergeQuestions(c.db)).toEqual([]);
  expect(c.github.mergedHeads).toEqual([originHead(c.workspace, c.work.id)]);
});

it("回答が head を読んだ時点で同じ PR に in-flight 印が付いていれば、判定せずに答え直させ、伝えた記録も残さない", async () => {
  const pr = await openPushedPr("outside-head-marked-during-read", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("failure");
  await pr.landing.tick("auto_merge", pr.clock.now());
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);
  pr.github.scriptCiStatus("success");
  let release: (() => void) | null = null;
  afterCiRead(pr.github, () => {
    release ??= pr.landing.takeInFlightMark(pr.work.workspace, 1);
  });

  expect(await answerMerge(pr)).toBe(IN_FLIGHT);
  expect(boardEvents(pr.db, pr.work.id, "pr_head_conveyed")).toEqual([]);

  release!();
  expect(await answerMerge(pr)).toBe(listedRefusal(head, lastPushed, [[head, "outside.txt"]]));
});

it("無人 merge の tick が in-flight 印を持つ間、収束は記録済みの PR へ push せず次の突きに回し、retry の回答は答え直させる", async () => {
  const c = await pushedRoot("outside-head-convergence-waits-for-mark", { pr: "recorded", merge: "auto_if_ci_green", openFailure: true });
  const release = c.landing.takeInFlightMark(c.work.workspace, 1)!;

  expect(await c.retry(promotionFailures(c.db, c.work.id)[0]!)).toBe(IN_FLIGHT);
  expect(c.github.pushes).toEqual([]);

  release();
  await expect(c.retry(promotionFailures(c.db, c.work.id)[0]!)).resolves.toBeUndefined();
  expect(c.github.pushes).toHaveLength(1);
});

it("in-flight 印が付いている間の突きでは収束は push せず、印が放された次の突きで push する", async () => {
  const c = await pushedRoot("outside-head-poke-waits-for-mark", { pr: "recorded", merge: "auto_if_ci_green" });
  const release = c.landing.takeInFlightMark(c.work.workspace, 1)!;

  await expect(convergeOn(c.landing, c.work.id)).resolves.toBeUndefined();
  expect(c.github.pushes).toEqual([]);

  release();
  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
});

it("収束が push して最後に push した値を書く前に tick が回っても、tick はその PR を飛ばして question を立てず、次の tick が盤面の push した head を merge する", async () => {
  const c = await pushedRoot("outside-head-tick-during-push", { pr: "recorded", merge: "auto_if_ci_green" });
  let ticking: Promise<void> | undefined;
  afterEachPush(c.github, () => {
    ticking = c.landing.tick("auto_merge", c.clock.now());
  });

  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await ticking;

  expect(mergeQuestions(c.db)).toEqual([]);
  expect(c.github.merged).toEqual([]);
  await c.landing.tick("auto_merge", c.clock.now());
  expect(c.github.mergedHeads).toEqual([originHead(c.workspace, c.work.id)]);
});
