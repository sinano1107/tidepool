import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { DomainError } from "../src/domain-error.js";
import { getTask, listBoard } from "../src/tasks.js";
import { afterCiRead, FakeGitHubClient, fakeHead } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, makeRemoteBackedWorkspace } from "./harness.js";
import {
  afterEachPush,
  answerMergeQuestion,
  autoMerging,
  boardEvents,
  CI_RED_PURPOSE,
  CONFLICT,
  convergeOn,
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
} from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0387 決定1: 無人 merge は head が盤面の最後に push した sha と一致するときだけ merge する。
// 以下がこの判定を述べる唯一の場所(ADR 0107)。

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
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: outsideHeadBody(head, lastPushed) },
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

it("キューにいる PR の merge question が開いたまま外から進んだ head を tick が読んでも、伝えた記録は残らず、最初の「merge」は commit を列挙して1回拒まれる", async () => {
  const pr = await openPushedPr("outside-head-question-already-open", "auto_if_ci_green");
  const lastPushed = originHead(pr.workspace, pr.work.id);
  mergeQuestion(pr.db, pr.clock, { pending_merge_pr: 1 }, pr.work.workspace ?? undefined);
  const head = await pushOutsideBoard(pr.workspace, pr.work.id);

  await pr.landing.tick("auto_merge", pr.clock.now());

  expect(mergeQuestions(pr.db).map(({ purpose }) => purpose)).toEqual(["a human decides whether to land"]);
  expect(await answerMerge(pr)).toBe(listedRefusal(head, lastPushed, [[head, "outside.txt"]]));
});

it("着地の面が question 側へ変わった PR の外から進んだ head に立った question への最初の「merge」は、伝えた head として拒まれずに merge する", async () => {
  const pr = await openPushedPr("outside-head-surface-changed", "auto_if_ci_green");
  const landing = autoMerging(pr.db, pr.clock, pr.workspace, pr.github, () => profile("escalate"));
  await pushOutsideBoard(pr.workspace, pr.work.id);

  await landing.tick("auto_merge", pr.clock.now());
  expect(mergeQuestions(pr.db).map(({ recommendation }) => recommendation)).toEqual(["hold"]);

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

// ADR 0387 決定4: 収束の記録済みの PR への push は、push の前から最後に push した値を書くまで in-flight 印を持つ
const IN_FLIGHT = "PR #1 is being merged or pushed to by the board right now — answer again in a moment";

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
