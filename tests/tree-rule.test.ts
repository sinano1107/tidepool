import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  api,
  bootTidepool,
  checkoutOf,
  commitWork,
  completeIntegrationReviews,
  FULL_HANDOFF as fullHandoff,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  registerWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
const KNOWN_SANDBOX_SHADOW_PATHS = [
  ".bash_profile",
  ".bashrc",
  ".gitconfig",
  ".profile",
  ".zprofile",
  ".zshrc",
  ".ripgreprc",
  ".gitmodules",
  ".idea",
  ".mcp.json",
  ".vscode",
  ".claude/agents",
  ".claude/commands",
  ".claude/hooks",
  ".claude/launch.json",
  ".claude/loop.md",
  ".claude/output-styles",
  ".claude/routines",
  ".claude/scheduled_tasks.json",
  ".claude/workflows",
] as const;
afterEach(async () => {
  await t?.stop();
});

// 旧: pickup が名前の場所でタスクブランチを checkout した
it("pickup 時に名前の場所にタスクブランチの ref が作られ、worker の task の checkout はそのブランチの上にいる(ADR 0356 決定1)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "build the thing");
  await t.clock.advance(HOUR);

  // ブランチ規律は tidepool 本体が敷く: フェイクワーカーは何もしていないのに
  // task の checkout はタスクブランチの上にいる(main 直書きは構造的に起きない)
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  const checkout = checkoutOf(t.db, task.id);
  expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(git(ws.path, "rev-parse", "--verify", `task/${task.id}`)).not.toBe("");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

// ADR 0084 以降、完了は例外である: worker のコミットが門で要求されるので、完了の
// 解放で WIP が生まれることはもう無い(退避は完了**以外**の解放の手段になった)
it("complete による解放ではツリーがクリーンに戻り、WIP コミットは増えない", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write things");
  await t.clock.advance(HOUR);

  commitWork(checkoutOf(t.db, task.id), "notes.txt", "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "log", "--format=%s", `task/${task.id}`)).not.toContain("WIP: task");
  expect(git(ws.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished work");
  // main には何も書かれていない
  expect(() => git(ws.path, "show", "main:notes.txt")).toThrow();
});

it("complete_task explains a board-side ref write failure and can be retried in the same session", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write things");
  await t.clock.advance(HOUR);

  commitWork(checkoutOf(t.db, task.id), "notes.txt", "finished work\n");
  const lock = join(ws.path, ".git", "refs", "heads", "task", `${task.id}.lock`);
  writeFileSync(lock, "");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const complete = () => client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  try {
    expect(await complete()).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/the board could not record the task branch tip.*retry complete_task or escalate/is) }],
    });
    expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
    expect(await servedQuarantineQuestion(t, "workspace", ws.name)).toBeUndefined();

    rmSync(lock);
    expect((await complete()).isError ?? false).toBe(false);
    expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
  } finally {
    await client.close();
  }
});

it("release は既知パス・untracked・0バイトをすべて満たす sandbox shadow だけを WIP から除く", async () => {
  const ws = await makeWorkspace("sandbox");
  writeFileSync(join(ws.path, ".profile"), "");
  git(ws.path, "add", ".profile");
  git(ws.path, "commit", "-m", "tracked empty profile");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write while sandbox shadows exist");
  await t.clock.advance(HOUR);

  // ADR 0356 決定1: worker は task の checkout で書く
  const checkout = checkoutOf(t.db, task.id);
  for (const path of KNOWN_SANDBOX_SHADOW_PATHS) {
    if (path === ".profile" || path === ".zshrc") continue;
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), "");
  }
  commitWork(checkout, ".zshrc", "real workspace content\n");
  commitWork(checkout, ".future-shadow", "");
  commitWork(checkout, "notes.txt", "work product\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  const taskRef = `task/${task.id}`;
  const taskFiles = git(ws.path, "ls-tree", "-r", "--name-only", taskRef).split("\n");
  for (const path of KNOWN_SANDBOX_SHADOW_PATHS) {
    if (path === ".profile" || path === ".zshrc") continue;
    expect(taskFiles).not.toContain(path);
  }
  expect(git(ws.path, "show", `${taskRef}:.profile`)).toBe("");
  expect(git(ws.path, "show", `${taskRef}:.zshrc`)).toBe("real workspace content");
  expect(git(ws.path, "show", `${taskRef}:.future-shadow`)).toBe("");
  expect(git(ws.path, "show", `${taskRef}:notes.txt`)).toBe("work product");
  expect(git(ws.path, "status", "--porcelain")).toBe("");
});

it("WIP 退避コミットの author は Tidepool 名義(bot noreply)— 盤面の機械的執行でエージェントの行為ではない(issue #53)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write things");
  await t.clock.advance(HOUR);

  // 退避が生まれるのは完了**以外**の解放(ADR 0084)—— エスカレーションで測る
  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "outside my authority",
      questions: [{ title: "which approach?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  await client.close();

  // WIP は盤面の tree rule が機械的に打つコミット — quarantine/watchdog question
  // が Tidepool 名義で登録されるのと同じ線を git author に延長する。email は
  // ADR 0093 決定9: App の bot noreply(GitHub 上で `tidepool-board[bot]` に紐づく)。
  expect(git(ws.path, "log", "-1", "--format=%an", `task/${task.id}`)).toBe("tidepool");
  expect(git(ws.path, "log", "-1", "--format=%ae", `task/${task.id}`)).toBe(
    "319381852+tidepool-board[bot]@users.noreply.github.com",
  );
});

// 旧: 再開は名前の場所で自ブランチを checkout し直した
it("エスカレーション解放でも WIP が退避され、再開は自ブランチから作り直した task の checkout で WIP を持って始まる(ADR 0356 決定2)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "risky work");
  await t.clock.advance(HOUR);

  // 作業途中でエスカレーション — コミットしないまま slot を手放す
  const first = checkoutOf(t.db, task.id);
  writeFileSync(join(first, "draft.txt"), "work in flight\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "escalate",
    arguments: {
      context: "two viable approaches, outside my authority",
      questions: [{ title: "which approach?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  // 完了と同じ tree rule が走る: WIP 退避 + task の checkout は消える
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:draft.txt`)).toBe("work in flight");
  expect(existsSync(first)).toBe(false);

  // 待つ間に別タスクが同じ workspace を自分のブランチで通過する
  const other = await registerWork(t, "other work");
  await t.clock.advance(HOUR);
  const otherCheckout = checkoutOf(t.db, other.id);
  expect(git(otherCheckout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${other.id}`);
  const c2 = await mcpClient(t.mcpBaseUrl, other.id);
  await c2.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await c2.close();
  // その後始末の完走が契機になり(ADR 0119 決定3)、other の統合点レビューが tick を待たずに枠へ入る
  await completeIntegrationReviews(t, other.id);
  await new Promise((r) => setImmediate(r));

  // 回答 → 親が先頭復帰して即 pickup。再開は自ブランチの checkout だけで、
  // WIP がそのまま作業ツリーに戻っている
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["a"] });
  expect(t.worker.started.filter((x) => x.type === "work").map((x) => x.id)).toEqual([task.id, other.id, task.id]);
  const resumed = checkoutOf(t.db, task.id);
  expect(resumed).not.toBe(first);
  expect(git(resumed, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(readFileSync(join(resumed, "draft.txt"), "utf8")).toBe("work in flight\n");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("tree rule の失敗で workspace が needs-human になり、pickup が止まり、question が生まれる", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "doomed work");
  await t.clock.advance(HOUR);

  // 名前の場所の main へ帯域外に commit して解放を失敗させる(盤面が書いていない ref の移動、ADR 0351 —— コンフリクト等の代役)。
  // 旧: .git を消した —— 完了の門が名前の場所へ tip を引けず、完了そのものが成立しなくなった(ADR 0356 決定3)
  commitWork(ws.path, "junk.txt", "out of band\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false); // 完了自体は成立している
  await client.close();

  // task はルートに子を持たないまま done — ツリー全体が settled になり board からは
  // 退くが、個別取得(GET /tasks/:id)では引き続き参照できる(issue #35)
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");

  // 人間への question が生成されている(workspace 名で特定できる)
  const question = await servedQuarantineQuestion(t, "workspace", "sandbox");
  expect(question).toBeDefined();
  expect(question.status).toBe("todo");
  expect(question.title).toContain("sandbox");

  // needs-human の workspace を使うタスクは pickup されない
  await registerWork(t, "stalled work");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);

  // question は盤面自身の名義で登録される — 自分の失敗をエージェントに帰属させない
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").actor_id).toBe("tidepool");
});

// 旧: sandbox shadow を削除してから退避し、削除の失敗は workspace を quarantine した
it("task の checkout の sandbox shadow は消さずに完了の検査から除き、workspace を quarantine せず後続 pickup を止めない(ADR 0356 決定3)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "finish while a sandbox mount survives");
  await t.clock.advance(HOUR);

  const shadowDir = join(checkoutOf(t.db, task.id), ".claude");
  mkdirSync(shadowDir);
  writeFileSync(join(shadowDir, "agents"), "");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  expect((await api(t.baseUrl, "GET", "/api/tasks")).json.some((x: any) => x.type === "question" && x.title.includes("sandbox"))).toBe(false);
  expect(git(ws.path, "ls-tree", "-r", "--name-only", `task/${task.id}`)).not.toContain(".claude/agents");
});

// 旧: ワーカーが名前の場所で main に逃げていたら WIP の commit を拒んで workspace を隔離した(#234 ケース1)
it("ワーカーが task の checkout で別のブランチに逃げても、盤面はタスクブランチ1本を読み、main には何も載らず隔離もしない(ADR 0356 決定4)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "rogue work");
  await t.clock.advance(HOUR);

  // 規律を破るワーカー: セッション中に別のブランチへ checkout し、散らかしたままエスカレート
  // する(完了は ADR 0084 の門がコミット済みを要求するので、退避が生まれる解放で測る)
  const checkout = checkoutOf(t.db, task.id);
  git(checkout, "checkout", "-b", "main");
  writeFileSync(join(checkout, "rogue.txt"), "must not land on main\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "escalate",
    arguments: {
      context: "stuck after wandering off the branch",
      questions: [{ title: "what now?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  // 名前の場所の main には何もコミットされていない(初期コミットのみ)—— WIP はタスクブランチにだけ着く
  expect(git(ws.path, "log", "--format=%s", "main")).toBe("initial");
  expect(git(ws.path, "show", `task/${task.id}:rogue.txt`)).toBe("must not land on main");
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.type === "question" && x.title.includes("sandbox"))).toBeUndefined();
  const next = await registerWork(t, "next work");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, next.id]);
});
