import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IssueGoneError } from "../src/github.js";
import { registerQuarantine } from "../src/quarantine.js";
import { registerTask } from "../src/tasks.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  humanDecomposeTaskViaWebui,
  makeWorkspace,
  nextPoll,
  questions,
  queueWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";

/** issue 展開の一時的失敗(ADR 0328): pickup で GitHub を読む task をその poll から外して次の head へ進み、
 *  成功を挟まず10分続けば確認 question を立てる。 */
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const MINUTE = 60 * 1000;

const issueBacked = (number: number) =>
  registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: number }, t.clock.now(), ...HUMAN_WEBUI);

it("自分の issue の展開が一時的に失敗しても、同じ poll で後ろの通常 task を拾い、2つ目の gh は撃たず、poll は成功に数える", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  const failing = issueBacked(49);
  issueBacked(50);
  const ordinary = queueWork(t, "ordinary");
  registerQuarantine(t.db, "pollFailure", null, "an earlier poll threw", t.clock.now());
  t.github.scriptIssueFailure(new Error("GitHub is down"));

  await t.clock.advance(HOUR);
  expect(t.github.issueFetches.length).toBe(1);

  expect(t.worker.started.map((task) => task.id)).toEqual([ordinary.id]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.lastPollFailure).toBeUndefined();
  expect(queue.lastIssueExpansionFailure).toEqual({ at: t.clock.now().toISOString(), message: "GitHub is down", taskId: failing.id });
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((task: any) => task.type === "question" && task.status === "todo")).toEqual([]);
});

it("issue-backed の親の文面の読みで投げても、同じ poll で後ろの通常 task を拾い、後ろの issue-backed task の gh は撃たない", async () => {
  const workspace = await makeWorkspace("tidepool");
  t = await bootTidepool({ workspace });
  const parent = issueBacked(49);
  git(workspace.path, "branch", `task/${parent.id}`);
  const [child] = humanDecomposeTaskViaWebui(t.db, parent, {
    reason: "split off the implementation",
    children: [{ title: "implement", purpose: "implement the plan", completion_criteria: "implemented" }],
  }, t.clock.now());
  issueBacked(50);
  const ordinary = queueWork(t, "ordinary");
  t.github.scriptIssueFailure(new Error("GitHub is down"));

  await t.clock.advance(HOUR);
  expect(t.github.issueFetches.map((ref) => ref.number)).toEqual([49]);

  expect(t.worker.started.map((task) => task.id)).toEqual([ordinary.id]);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.lastIssueExpansionFailure.taskId).toBe(child!.id);
});

it("registry drift で門が止めた head はその head だけを外し、同じ poll で次の head を拾う", async () => {
  const workspace = await makeWorkspace("tidepool");
  t = await bootTidepool({
    workspace,
    resolveWorkspace: (name) => {
      if (name === "gone") throw new UnknownWorkspaceError("gone");
      return workspace;
    },
  });
  registerTask(t.db, { type: "work", workspace: "gone", github_issue_number: 49 }, t.clock.now(), ...HUMAN_WEBUI);
  const ordinary = queueWork(t, "ordinary");

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((task) => task.id)).toEqual([ordinary.id]);
  expect(await servedQuarantineQuestion(t, "workspace", "gone")).toBeDefined();
});

it("Registry reachability の検査は、門が head を外して次へ進んでも poll で1回だけ走る", async () => {
  let checks = 0;
  t = await bootTidepool({
    workspace: await makeWorkspace("tidepool"),
    registryReachability: async () => {
      checks++;
      return { available: true };
    },
  });
  issueBacked(49);
  const ordinary = queueWork(t, "ordinary");
  t.github.scriptIssueFailure(new Error("GitHub is down"));

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((task) => task.id)).toEqual([ordinary.id]);
  expect(checks).toBe(1);
});

/** 成功を挟まず失敗を3回: 1時間の tick、9分後、さらに1分後(最初から10分)。 */
async function failThreeTimesOverTenMinutes() {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  const task = issueBacked(49);
  t.github.scriptIssueFailure(new Error("down 1"));
  await t.clock.advance(HOUR);
  const firstAt = t.clock.now().toISOString();
  t.github.scriptIssueFailure(new Error("down 2"));
  await t.clock.advance(9 * MINUTE);
  await nextPoll(t);
  const before = await servedQuarantineQuestion(t, "issueExpansion", null);
  t.github.scriptIssueFailure(new Error("down 3"));
  await t.clock.advance(MINUTE);
  await nextPoll(t);
  return { task, firstAt, before };
}

it("成功を挟まず失敗が10分以上続けば issueExpansion の question を1枚立て、本文はいつから・何回・最初と最新の例外・最後に止めた task を言う", async () => {
  const { task, firstAt, before } = await failThreeTimesOverTenMinutes();
  expect(before).toBeUndefined();

  const question = await servedQuarantineQuestion(t, "issueExpansion", null);
  expect(question.purpose).toContain(`issue expansion has failed 3 times since ${firstAt} with no successful expansion in between.`);
  expect(question.purpose).toContain(`The last task it stopped is ${task.id}.`);
  expect(question.purpose).toContain("First exception: down 1");
  expect(question.purpose).toContain("Latest exception: down 3");

  await nextPoll(t);
  expect((await questions(t)).filter((q: any) => q.question_quarantine_kind === "issueExpansion")).toHaveLength(1);
  expect(t.worker.started).toEqual([]);
});

it("回答は最後に失敗した参照の読み直しで確かめる —— まだ投げれば本文つきで拒み、通れば観測決着の形で返る", async () => {
  await failThreeTimesOverTenMinutes();
  const question = await servedQuarantineQuestion(t, "issueExpansion", null);
  const answer = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });

  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe("the board cannot confirm it reads GitHub issues again: down 3");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");

  t.github.scriptIssueFailure(null);
  t.github.scriptIssue(49, { title: "restored", body: "b", comments: [] });
  const accepted = await answer();
  expect(accepted.status).toBe(200);
  expect(accepted.json.settled_by_observation).toBe("quarantine_released");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
});

it("読み直しが IssueGoneError なら API が答えた証拠として受理する", async () => {
  await failThreeTimesOverTenMinutes();
  const question = await servedQuarantineQuestion(t, "issueExpansion", null);
  t.github.scriptIssueFailure(new IssueGoneError({ path: "/x", number: 49 }, "not_found"));

  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });

  expect(accepted.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
});

it("展開が1つ通れば question は回答なしで決着し、queue の lastIssueExpansionFailure は消える", async () => {
  const { task } = await failThreeTimesOverTenMinutes();
  const question = await servedQuarantineQuestion(t, "issueExpansion", null);
  t.github.scriptIssueFailure(null);
  t.github.scriptIssue(49, { title: "restored", body: "b", comments: [] });

  await nextPoll(t);

  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.lastIssueExpansionFailure).toBeUndefined();
});

it("IssueGoneError は連続を戻す —— その後の失敗から10分未満なら question は立たない", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  issueBacked(49);
  t.github.scriptIssueFailure(new Error("GitHub is down"));
  await t.clock.advance(HOUR);
  t.github.scriptIssueFailure(new IssueGoneError({ path: "/x", number: 49 }, "not_found"));
  await t.clock.advance(5 * MINUTE);
  await nextPoll(t);

  issueBacked(50);
  t.github.scriptIssueFailure(new Error("GitHub is down again"));
  await t.clock.advance(6 * MINUTE);
  await nextPoll(t);

  expect((await api(t.baseUrl, "GET", "/api/queue")).json.lastIssueExpansionFailure.message).toBe("GitHub is down again");
  expect(await servedQuarantineQuestion(t, "issueExpansion", null)).toBeUndefined();
});

it("連続が開いている間、queue は GitHub を読む task を skipped に見せる", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  const failing = issueBacked(49);
  const ordinary = queueWork(t, "ordinary");
  const waiting = queueWork(t, "waiting behind the slot");
  t.github.scriptIssueFailure(new Error("GitHub is down"));
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([ordinary.id]);

  const rows = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks;
  expect(rows.find((row: any) => row.id === failing.id).status).toBe("skipped");
  expect(rows.find((row: any) => row.id === waiting.id).status).toBe("todo");
});

it("連続が開いている間、GitHub を読む task は Pickable head ではない —— 下の行の ↑ を飲まない(ADR 0328 決定7 / GLOSSARY.md「Pickable head」)", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  issueBacked(49);
  t.github.scriptIssueFailure(new Error("GitHub is down"));
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  // 素の先頭は issue-backed のままだが、候補の先頭は下の runnable。1回の ↑ が空振りしないことが、
  // Pickable head が GitHub を読む task を外している証拠である
  const runnable = queueWork(t, "GitHub を読まないので走る");
  await api(t.baseUrl, "POST", `/api/tasks/${runnable.id}/move`, { after: null });
  expect(t.worker.started.map((task) => task.id)).toEqual([runnable.id]);
});
