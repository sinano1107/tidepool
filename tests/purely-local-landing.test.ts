import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  completeViaMcp,
  FULL_HANDOFF,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  questions,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];

afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** その work の着地 question の行。 */
async function landingQuestionFor(board: Tidepool, taskId: string): Promise<any> {
  const found = (await questions(board)).find(
    (candidate) => candidate.question_pending_local_merge_task_id === taskId,
  );
  expect(found).toBeDefined();
  return found;
}

/** 隔離の確認 question(CONTEXT.md の Quarantine)の行、無ければ undefined。 */
async function quarantineQuestion(board: Tidepool): Promise<any> {
  return (await questions(board)).find(
    (candidate) => candidate.question_quarantine_workspace !== null,
  );
}

function answerMerge(board: Tidepool, questionId: string): Promise<{ status: number; json: any }> {
  return api(board.baseUrl, "POST", `/api/tasks/${questionId}/answer`, { answers: ["merge"] });
}

it("purely-local の root work 完了は PR を試みず、代わりに着地 question を1本立てる", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
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
  const workspace = await makeWorkspace(dirs, "sandbox");
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
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
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
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const first = await registerWork(t, "first of the serial pair");
  const second = await registerWork(t, "second of the serial pair");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "one.txt", "from the first task\n");
  await completeViaMcp(t, first.id);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "two.txt", "from the second task\n");
  await completeViaMcp(t, second.id);
  expect((await answerMerge(t, (await landingQuestionFor(t, first.id)).id)).status).toBe(200);
  const question = await landingQuestionFor(t, second.id);
  const taskSha = git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`);

  const answered = await answerMerge(t, question.id);

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${second.id}`)).toBe("0");
  // 1件目の成果を道連れに消していない = 追いついた形は真の merge(親2つ)である
  expect(git(workspace.path, "rev-list", "--count", `main..task/${first.id}`)).toBe("0");
  expect(git(workspace.path, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
  expect(git(workspace.path, "log", "-1", "--format=%an", "main")).toBe("tidepool");
  // ADR 0053 根拠1: タスクブランチは差分の恒久記録であって、着地で書き換えられない
  expect(git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`)).toBe(taskSha);
  expect(await quarantineQuestion(t)).toBeUndefined();
});

// ADR 0103 決定3 / ADR 0064: 盤面は走っているセッションの checkout を動かさない。
it("走行中の slot を占めたまま来た非 ff の着地は、ref だけを進め HEAD と作業ツリーに触れない", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const first = await registerWork(t, "first of the serial pair");
  const second = await registerWork(t, "second of the serial pair");
  const third = await registerWork(t, "occupies the slot while the landing arrives");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "one.txt", "from the first task\n");
  await completeViaMcp(t, first.id);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "two.txt", "from the second task\n");
  await completeViaMcp(t, second.id);
  await t.clock.advance(HOUR); // 3件目が slot を取り、HEAD は自分のタスクブランチへ移る
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${third.id}`);
  writeFileSync(join(workspace.path, "wip.txt"), "the running session's work in progress\n");
  await answerMerge(t, (await landingQuestionFor(t, first.id)).id);
  const question = await landingQuestionFor(t, second.id);
  const head = git(workspace.path, "rev-parse", "HEAD");
  const status = git(workspace.path, "status", "--porcelain");

  const answered = await answerMerge(t, question.id);

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${second.id}`)).toBe("0");
  expect(git(workspace.path, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
  expect(git(workspace.path, "log", "-1", "--format=%an", "main")).toBe("tidepool");
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${third.id}`);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(head);
  expect(git(workspace.path, "status", "--porcelain")).toBe(status);
  expect(readFileSync(join(workspace.path, "wip.txt"), "utf8")).toBe(
    "the running session's work in progress\n",
  );
  expect(await quarantineQuestion(t)).toBeUndefined();
  // ADR 0064 決定4: 盤面が進めた行は撮り直されているので、走っていたセッションの解放は
  // 盤面自身のこの2度の書き込みを違反として読まない
  commitWork(workspace.path, "wip.txt", "the running session's work in progress\n");
  await completeViaMcp(t, third.id);
  expect(await quarantineQuestion(t)).toBeUndefined();
});

// 走行中の綴りでも、コンフリクトは回答の拒否であって隔離ではない(ADR 0103 決定4)——
// `merge-tree` は盤面の作業ツリーを使わないので、拒んだ跡も残らない。
it("走行中の slot を占めたまま来た着地がコンフリクトしても、隔離せず作業ツリーも汚さない", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const first = await registerWork(t, "writes the shared line first");
  const second = await registerWork(t, "writes the same line differently");
  const third = await registerWork(t, "occupies the slot while the landing arrives");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "shared.txt", "from the first task\n");
  await completeViaMcp(t, first.id);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "shared.txt", "from the second task\n");
  await completeViaMcp(t, second.id);
  await t.clock.advance(HOUR);
  await answerMerge(t, (await landingQuestionFor(t, first.id)).id);
  const question = await landingQuestionFor(t, second.id);
  const protectedSha = git(workspace.path, "rev-parse", "refs/heads/main");
  const head = git(workspace.path, "rev-parse", "HEAD");

  const answered = await answerMerge(t, question.id);

  expect(answered.status).toBe(409);
  expect(await quarantineQuestion(t)).toBeUndefined();
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(protectedSha);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${third.id}`);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(head);
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");
});

// ADR 0103 決定4: 記録と一致していれば、merge の失敗は回答の拒否であって隔離ではない ——
// 失敗の時点で何も壊れていない(「自動では合わない」と分かっただけ)。
it("snapshot が一致していれば着地のコンフリクトは回答を拒むだけで、workspace を quarantine しない", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const first = await registerWork(t, "writes the shared line first");
  const second = await registerWork(t, "writes the same line differently");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "shared.txt", "from the first task\n");
  await completeViaMcp(t, first.id);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "shared.txt", "from the second task\n");
  await completeViaMcp(t, second.id);
  await answerMerge(t, (await landingQuestionFor(t, first.id)).id);
  const question = await landingQuestionFor(t, second.id);
  const protectedSha = git(workspace.path, "rev-parse", "refs/heads/main");
  const taskSha = git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`);

  const answered = await answerMerge(t, question.id);

  expect(answered.status).toBe(409);
  expect(await quarantineQuestion(t)).toBeUndefined();
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(protectedSha);
  expect(git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`)).toBe(taskSha);
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  // question は開いたまま = 人間は手で直してもう一度答えられる
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");
  const held = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["hold"],
  });
  expect(held.status).toBe(200);
});

it("保護ブランチが帯域外で進んで fast-forward できないと workspace を quarantine し、着地 question を開いたままにする", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land without overwriting main");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const landingQuestion = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_local_merge_task_id === task.id,
  );
  writeFileSync(join(workspace.path, "out-of-band.txt"), "moved by hand\n");
  git(workspace.path, "add", "out-of-band.txt");
  git(workspace.path, "commit", "-m", "out-of-band protected branch move");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${landingQuestion.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(409);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((candidate: any) => candidate.id === landingQuestion.id).status).toBe("todo");
  expect(
    board.find(
      (candidate: any) =>
        candidate.type === "question" && candidate.question_quarantine_workspace === "sandbox",
    ),
  ).toBeDefined();
});

// ADR 0103 決定1: 帯域外の判定は ff の成否ではなく盤面自身の記録(ref snapshot)との
// 突き合わせで下すので、ff が黙って飲み込んでいた**巻き戻し**まで捕まる —— 検知は
// 弱まるのではなく強くなる。
it("保護ブランチが帯域外で巻き戻されると、ff できる位置であっても着地を拒み workspace を quarantine する", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  // タスクブランチの fork 元を2つ目のコミットにして、巻き戻し先を祖先として残す
  commitWork(workspace.path, "base.txt", "the base the task forks from\n");
  const rolledBackTo = git(workspace.path, "rev-parse", "HEAD~1");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land onto a rolled-back protected branch");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const question = await landingQuestionFor(t, task.id);
  // 巻き戻し先はタスクブランチの祖先なので、ff-only の検査だけなら素通りしてしまう位置
  git(workspace.path, "reset", "--hard", rolledBackTo);

  const answered = await answerMerge(t, question.id);

  expect(answered.status).toBe(409);
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(rolledBackTo);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");
  expect((await quarantineQuestion(t))?.question_quarantine_workspace).toBe("sandbox");
});

it("着地 question に hold と答えると保護ブランチを動かさず決着し、再提示しない", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "keep the result on its task branch");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "held.txt", "held result\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
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
