import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GH_CLI_VERSION } from "../src/gh-cli-version.js";
import { registerTask } from "../src/tasks.js";
import {
  addTaskChange,
  api,
  bootTidepool,
  checkoutOf,
  completeIntegrationReviews,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  HUMAN_WEBUI,
  makeLandingWorkspace,
  makeWorkspace,
  mcpClient,
  nextPoll,
  questions,
  queueWork,
  registerWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";

/** 「gh の版」の Quarantine(ADR 0402 決定3): 止めるのは gh を撃つたびの版の門で、question は信号 —— 開いている間も各経路は
 *  撃ち直して門に当たり、版が戻れば次の呼び出しが通って決着する。 */
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const MINUTE = 60 * 1000;
const OLD_GH = "gh version 2.46.0 (Ubuntu 2.46.0-4)";
const MISMATCH = `gh version mismatch: the board runs only gh ${GH_CLI_VERSION} (pinned in gh-cli-version) and found gh 2.46.0`;

const issueBacked = (number: number) =>
  registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: number }, t.clock.now(), ...HUMAN_WEBUI);
const ghVersionQuestions = async () => (await questions(t)).filter((q: any) => q.question_quarantine_kind === "ghVersion");
const otherQuestions = async () => (await questions(t)).filter((q: any) => q.question_quarantine_kind !== "ghVersion" && q.status === "todo");

// 読めない版も同じ型付きの失敗であることは domain 層(tests/github-client.test.ts)が釘を打つ —— ここは不一致の1形だけ
it("宣言と違う版を答える gh では gh 本体を撃たず「gh の版」の question を1枚だけ立て、10分を越えて繰り返しても1枚のまま issueExpansion も立てない", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  issueBacked(49);
  t.github.scriptGhVersion(OLD_GH);

  await t.clock.advance(HOUR);
  await t.clock.advance(9 * MINUTE);
  await nextPoll(t);
  await t.clock.advance(2 * MINUTE);
  await nextPoll(t);

  expect(t.github.issueFetches).toEqual([]);
  const [question, ...rest] = await ghVersionQuestions();
  expect(rest).toEqual([]);
  expect(question.purpose).toContain("found gh 2.46.0");
  expect(question.purpose).toContain(`the board runs only gh ${GH_CLI_VERSION} (pinned in gh-cli-version)`);
  expect(question.purpose).toContain(`restart the Lima VM so its provision installs gh ${GH_CLI_VERSION}`);
  expect(await servedQuarantineQuestion(t, "issueExpansion", null)).toBeUndefined();
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.lastIssueExpansionFailure).toBeUndefined();
});

it("版が不一致の間、GitHub を読む task は pickup されず、通常の task は pickup される", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  issueBacked(49);
  const ordinary = queueWork(t, "ordinary");
  t.github.scriptGhVersion(OLD_GH);

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((task) => task.id)).toEqual([ordinary.id]);
});

it("question は門を持たない —— 開いている間に版が戻れば、回答なしで次の poll の gh が通り question が決着する", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  const task = issueBacked(49);
  t.github.scriptIssue(49, { title: "restored", body: "b", comments: [] });
  t.github.scriptGhVersion(OLD_GH);
  await t.clock.advance(HOUR);
  const [question] = await ghVersionQuestions();

  t.github.scriptGhVersion(`gh version ${GH_CLI_VERSION} (2026-11-18)`);
  await nextPoll(t);

  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
  const settled = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(settled.status).toBe("done");
  expect(settled.settled_by_observation).toBe("quarantine_released");
});

it("回答は gh --version の読み直しで確かめる —— 不一致のままなら版の不一致を名指して拒み、一致すれば受理する", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  issueBacked(49);
  t.github.scriptGhVersion(OLD_GH);
  await t.clock.advance(HOUR);
  const [question] = await ghVersionQuestions();
  const answer = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });

  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe(MISMATCH);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");

  t.github.scriptGhVersion(`gh version ${GH_CLI_VERSION} (2026-11-18)`);
  const accepted = await answer();
  expect(accepted.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
});

/** auto_if_ci_green の work を完了させ、収束に PR #1 を開かせる。 */
async function completeAutoMergeWork() {
  const { workspace } = await makeLandingWorkspace("sandbox");
  t = await bootTidepool({ workspace, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "auto_if_ci_green" }) });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);
  return { workspace, task };
}

it("版が不一致の間、無人 merge キューの PR は merge も question も立てずに待ち、版が戻った後の tick で CI を読み merge へ進む", async () => {
  const { workspace } = await completeAutoMergeWork();
  expect(t.github.requests).toHaveLength(1);
  expect(t.github.merged).toEqual([]);
  t.github.scriptGhVersion(OLD_GH);
  const reads = t.github.ciChecks.length;

  await t.clock.advance(MINUTE);
  await t.clock.advance(MINUTE);

  expect(t.github.ciChecks).toHaveLength(reads);
  expect(t.github.merged).toEqual([]);
  expect(await otherQuestions()).toEqual([]);
  const [question] = await ghVersionQuestions();

  t.github.scriptGhVersion(`gh version ${GH_CLI_VERSION} (2026-11-18)`);
  await t.clock.advance(MINUTE);

  expect(t.github.merged).toEqual([{ path: workspace.path, number: 1 }]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
});

it("版が不一致の間に完了した根の着地は、昇格失敗の question を立てずに待ち、版が戻った後の収束で PR を開く", async () => {
  const { workspace } = await makeLandingWorkspace("sandbox");
  t = await bootTidepool({ workspace, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "auto_if_ci_green" }) });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);
  t.github.scriptGhVersion(OLD_GH);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  expect(t.github.requests).toEqual([]);
  expect(await otherQuestions()).toEqual([]);
  expect(await ghVersionQuestions()).toHaveLength(1);

  t.github.scriptGhVersion(`gh version ${GH_CLI_VERSION} (2026-11-18)`);
  await t.clock.advance(HOUR);

  expect(t.github.requests).toHaveLength(1);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(1);
});

it("版が不一致の間、merge の回答は版の不一致を名指して拒まれ、着地の poll は merge question を開いたまま待つ", async () => {
  const { workspace } = await makeLandingWorkspace("sandbox");
  t = await bootTidepool({ workspace, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "escalate" }) });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);
  const [mergeQuestion] = await otherQuestions();
  t.github.scriptGhVersion(OLD_GH);

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${mergeQuestion.id}/answer`, { answers: ["merge"] });
  t.github.scriptMergedOutside(1);
  await t.clock.advance(10 * MINUTE);

  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(MISMATCH);
  expect(t.github.merged).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${mergeQuestion.id}`)).json.status).toBe("todo");
  expect((await otherQuestions()).map((q: any) => q.id)).toEqual([mergeQuestion.id]);
  expect(await ghVersionQuestions()).toHaveLength(1);
});

it("PR の作成の直後に版がずれても、PR head を比べられなかった merge question を立てず、版が戻った後の収束が作った PR を記録する", async () => {
  const { workspace } = await makeLandingWorkspace("sandbox");
  t = await bootTidepool({ workspace, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "escalate" }) });
  const create = t.github.createPullRequest.bind(t.github);
  t.github.createPullRequest = async (input) => {
    const created = await create(input);
    t.github.scriptGhVersion(OLD_GH);
    return created;
  };
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  expect(t.github.requests).toHaveLength(1);
  expect(await otherQuestions()).toEqual([]);
  expect(await ghVersionQuestions()).toHaveLength(1);

  t.github.scriptGhVersion(`gh version ${GH_CLI_VERSION} (2026-11-18)`);
  await t.clock.advance(HOUR);

  expect(t.github.requests).toHaveLength(1);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(1);
  const [mergeQuestion, ...rest] = await otherQuestions();
  expect(rest).toEqual([]);
  expect(mergeQuestion.purpose).not.toContain("could not compare this PR head");
});

it("CI を読んだ後の merge で版がずれれば、merge の回答の拒否は版の不一致だけを名指す", async () => {
  const { workspace } = await makeLandingWorkspace("sandbox");
  t = await bootTidepool({ workspace, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "escalate" }) });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);
  const [mergeQuestion] = await otherQuestions();
  const read = t.github.readPullRequest.bind(t.github);
  t.github.readPullRequest = async (ref) => {
    const pr = await read(ref);
    t.github.scriptGhVersion(OLD_GH);
    return pr;
  };

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${mergeQuestion.id}/answer`, { answers: ["merge"] });

  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe(MISMATCH);
  expect(t.github.merged).toEqual([]);
});

it("版が不一致の間、issue の取り込み・issue への comment・WebUI の open issue 一覧の読みは版の不一致を名指して拒まれる", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });
  t.github.scriptGhVersion(OLD_GH);

  const imported = await api(t.baseUrl, "POST", "/api/tasks", { type: "work", github_issue_number: 49, workspace: "tidepool" });
  const commented = await api(t.baseUrl, "POST", "/api/issue-comments", { workspace: "tidepool", github_issue_number: 49, body: "suggested" });
  const listed = await api(t.baseUrl, "GET", "/api/github-issues?workspace=tidepool");

  for (const res of [imported, commented, listed]) {
    expect(res.status).toBe(502);
    expect(res.json.error).toBe(MISMATCH);
  }
  expect(t.github.issueFetches).toEqual([]);
  expect(t.github.issueComments).toEqual([]);
  expect(t.github.issueListFetches).toEqual([]);
  expect(await ghVersionQuestions()).toHaveLength(1);
});
