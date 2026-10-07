import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  completeViaMcp,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  questions,
  registerWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;

afterEach(async () => {
  await t?.stop();
});

/** その work の着地 question の行。 */
async function landingQuestionFor(board: Tidepool, taskId: string): Promise<any> {
  const found = (await questions(board)).find(
    (candidate) => candidate.question_pending_local_merge_task_id === taskId,
  );
  expect(found).toBeDefined();
  return found;
}

/** ADR 0103 決定2 の直列ペア(#468 のライブ実測の形): 独立に登録された2件を続けて
 *  完了させ、1件目を着地させて保護ブランチを進めたうえで、非 ff になった2件目の
 *  着地 question を返す。`occupySlot` は3件目に slot を占めさせる(HEAD がそのタスクブランチへ移る)。 */
async function serialPairLanding(
  board: Tidepool,
  workspacePath: string,
  { occupySlot = false } = {},
): Promise<{ first: any; second: any; third: any; question: any }> {
  // 登録と解放はどちらも pickup の契機(ADR 0119 決定2・3)なので、後続は前のタスクの統合点
  // レビューが済んでから登録する —— 先に積むと、解放が撃つ poll がレビューより先に後続を
  // slot へ入れる。どちらも1件目の着地(下の回答)より前の保護ブランチから fork するのは同じ
  const first = await registerWork(board, "first of the serial pair");
  commitWork(workspacePath, "one.txt", "from the first task\n");
  await completeViaMcp(board, first.id);
  await completeIntegrationReviews(board, first.id);
  const second = await registerWork(board, "second of the serial pair");
  commitWork(workspacePath, "two.txt", "from the second task\n");
  await completeViaMcp(board, second.id);
  await completeIntegrationReviews(board, second.id);
  // 3件目が登録と同時に slot を取り、HEAD は自分のタスクブランチへ移る
  const third = occupySlot
    ? await registerWork(board, "occupies the slot while the landing arrives")
    : undefined;
  const firstQuestion = await landingQuestionFor(board, first.id);
  expect(
    (
      await api(board.baseUrl, "POST", `/api/tasks/${firstQuestion.id}/answer`, {
        answers: ["merge"],
      })
    ).status,
  ).toBe(200);
  return { first, second, third, question: await landingQuestionFor(board, second.id) };
}

it("purely-local の root work 完了は PR を試みず、代わりに着地 question を1本立てる", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  expect(completed.isError ?? false).toBe(false);
  expect(t.github.requests).toEqual([]);
  const questions = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.type === "question",
  );
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({
    purpose: expect.stringContaining("has no GitHub merge surface"),
    question_items: [{ options: ["merge", "hold"], recommendation: "merge" }],
  });
  expect(questions[0].title).not.toContain("PR promotion failed");
});

it("purely-local では auto_if_ci_green を無人 merge に使わず、観測不能の理由を question に書く", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "ship automatically");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "automatic.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "question",
  );
  expect(question.purpose).toContain(
    "CI cannot be observed and auto_if_ci_green cannot auto-merge",
  );
  expect(t.github.requests).toEqual([]);
  await t.clock.advance(60 * 1000);
  expect(t.github.merged).toEqual([]);
});

it("着地 question に merge と答えると保護ブランチを task branch へ fast-forward する", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("1");
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "question",
  );

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("0");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["merge"],
  });
});

// ADR 0103 決定2(#468 のライブ実測): 同じ workspace に**独立に**登録された連続タスクの
// 2件目は、1件目が着地させる**前**の保護ブランチから fork するので、1件目の着地のあとは
// 必ず非 ff になる。これは帯域外の書き込みではなく盤面自身が作った正当な直列進行であり、
// 隔離ではなく merge commit で追いつかせる。
it("直列に登録された2件目の着地は、1件目が進めた保護ブランチへ merge commit で追いつく", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const { first, second, question } = await serialPairLanding(t, workspace.path);
  const taskSha = git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${second.id}`)).toBe("0");
  // 1件目の成果を道連れに消していない = 追いついた形は真の merge(親2つ)である
  expect(git(workspace.path, "rev-list", "--count", `main..task/${first.id}`)).toBe("0");
  expect(git(workspace.path, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
  expect(git(workspace.path, "log", "-1", "--format=%an %cn", "main")).toBe("tidepool tidepool");
  // ADR 0053 根拠1: タスクブランチは差分の恒久記録であって、着地で書き換えられない
  expect(git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`)).toBe(taskSha);
  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
});

// ADR 0103 決定3 / ADR 0064: 盤面は走っているセッションの checkout を動かさない。
it("走行中の slot を占めたまま来た非 ff の着地は、ref だけを進め HEAD と作業ツリーに触れない", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const { second, third, question } = await serialPairLanding(t, workspace.path, {
    occupySlot: true,
  });
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${third.id}`);
  writeFileSync(join(workspace.path, "wip.txt"), "the running session's work in progress\n");
  const head = git(workspace.path, "rev-parse", "HEAD");
  const status = git(workspace.path, "status", "--porcelain");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${second.id}`)).toBe("0");
  expect(git(workspace.path, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
  expect(git(workspace.path, "log", "-1", "--format=%an %cn", "main")).toBe("tidepool tidepool");
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${third.id}`);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(head);
  expect(git(workspace.path, "status", "--porcelain")).toBe(status);
  expect(readFileSync(join(workspace.path, "wip.txt"), "utf8")).toBe(
    "the running session's work in progress\n",
  );
  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
  // ADR 0064 決定4: 盤面が進めた行は撮り直されているので、走っていたセッションの解放は
  // 盤面自身のこの2度の書き込みを違反として読まない
  commitWork(workspace.path, "wip.txt", "the running session's work in progress\n");
  await completeViaMcp(t, third.id);
  await completeIntegrationReviews(t, third.id);
  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
});

// 帯域外判定そのもの(不一致・巻き戻し・記録の欠落・quarantine の型分け・コンフリクトは隔離しない否定側)は
// tests/landing.test.ts が述べる(ADR 0107)。ここは境界の写像だけ: 409、理由、盤面への出現。
it("帯域外で進んだ保護ブランチへの merge は 409 で、理由を返し workspace の quarantine question を開く", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land without overwriting main");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  await completeIntegrationReviews(t, task.id);
  const landingQuestion = await landingQuestionFor(t, task.id);
  commitWork(workspace.path, "out-of-band.txt", "moved by hand\n");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${landingQuestion.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(409);
  expect(answered.json.error).toContain("moved out of band");
  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeDefined();
});

it("着地 question に hold と答えると保護ブランチを動かさず決着し、再提示しない", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "keep the result on its task branch");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "held.txt", "held result\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_local_merge_task_id === task.id,
  );

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["hold"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("1");
  await t.clock.advance(HOUR);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["hold"],
  });
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(
    board.filter(
      (candidate: any) =>
        candidate.status === "todo" &&
        candidate.question_pending_local_merge_task_id === task.id,
    ),
  ).toEqual([]);
});
