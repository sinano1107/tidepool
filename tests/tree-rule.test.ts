import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF as fullHandoff,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
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
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("pickup 時にタスクブランチが作成・checkout され、作業はそのブランチ上で行われる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "build the thing");
  await t.clock.advance(HOUR);

  // ブランチ規律は tidepool 本体が敷く: フェイクワーカーは何もしていないのに
  // workspace はタスクブランチの上にいる(main 直書きは構造的に起きない)
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
});

// ADR 0084 以降、完了は例外である: worker のコミットが門で要求されるので、完了の
// 解放で WIP が生まれることはもう無い(退避は完了**以外**の解放の手段になった)
it("complete による解放ではツリーがクリーンに戻り、WIP コミットは増えない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write things");
  await t.clock.advance(HOUR);

  commitWork(ws.path, "notes.txt", "half-finished work\n");
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

it("release は既知パス・untracked・0バイトをすべて満たす sandbox shadow だけを WIP から除く", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  writeFileSync(join(ws.path, ".profile"), "");
  git(ws.path, "add", ".profile");
  git(ws.path, "commit", "-m", "tracked empty profile");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write while sandbox shadows exist");
  await t.clock.advance(HOUR);

  for (const path of KNOWN_SANDBOX_SHADOW_PATHS) {
    if (path === ".profile" || path === ".zshrc") continue;
    mkdirSync(dirname(join(ws.path, path)), { recursive: true });
    writeFileSync(join(ws.path, path), "");
  }
  commitWork(ws.path, ".zshrc", "real workspace content\n");
  commitWork(ws.path, ".future-shadow", "");
  commitWork(ws.path, "notes.txt", "work product\n");

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
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write things");
  await t.clock.advance(HOUR);

  // 退避が生まれるのは完了**以外**の解放(ADR 0084)—— エスカレーションで測る
  writeFileSync(join(ws.path, "notes.txt"), "half-finished work\n");
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

it("エスカレーション解放でも WIP が退避され、再開は自ブランチの checkout だけで済む", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "risky work");
  await t.clock.advance(HOUR);

  // 作業途中でエスカレーション — コミットしないまま slot を手放す
  writeFileSync(join(ws.path, "draft.txt"), "work in flight\n");
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

  // 完了と同じ tree rule が走る: WIP 退避 + クリーンツリー
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:draft.txt`)).toBe("work in flight");

  // 待つ間に別タスクが同じ workspace を自分のブランチで通過する
  const other = await registerWork(t, "other work");
  await t.clock.advance(HOUR);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${other.id}`);
  const c2 = await mcpClient(t.mcpBaseUrl, other.id);
  await c2.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await c2.close();

  // 回答 → 親が先頭復帰して即 pickup。再開は自ブランチの checkout だけで、
  // WIP がそのまま作業ツリーに戻っている
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["a"] });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, other.id, task.id]);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(readFileSync(join(ws.path, "draft.txt"), "utf8")).toBe("work in flight\n");
});

it("tree rule の失敗で workspace が needs-human になり、pickup が止まり、question が生まれる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "doomed work");
  await t.clock.advance(HOUR);

  // リポジトリ自体を壊して WIP コミットを失敗させる(コンフリクト等の代役)
  commitWork(ws.path, "junk.txt", "uncommittable\n");
  await rm(join(ws.path, ".git"), { recursive: true, force: true });
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

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // 人間への question が生成されている(workspace 名で特定できる)
  const question = list.find((x: any) => x.type === "question");
  expect(question).toBeDefined();
  expect(question.status).toBe("todo");
  expect(question.title).toContain("sandbox");

  // needs-human の workspace を使うタスクは pickup されない
  await registerWork(t, "stalled work");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);

  // question は盤面自身の名義で登録される — 自分の失敗をエージェントに帰属させない
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").worker_id).toBe("tidepool");
});

it("sandbox shadow の削除失敗は workspace を quarantine し、後続 pickup を止める", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "finish while a sandbox mount survives");
  await t.clock.advance(HOUR);

  const shadowDir = join(ws.path, ".claude");
  mkdirSync(shadowDir);
  writeFileSync(join(shadowDir, "agents"), "");
  chmodSync(shadowDir, 0o555);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  } finally {
    chmodSync(shadowDir, 0o755);
    await client.close();
  }

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.question_quarantine_workspace === "sandbox");
  expect(question?.purpose).toContain("unlink");

  await registerWork(t, "must wait for workspace repair");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("ワーカーが main に逃げていても WIP は main にコミットされず、workspace が隔離される", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "rogue work");
  await t.clock.advance(HOUR);

  // 規律を破るワーカー: セッション中に main へ checkout し、散らかしたままエスカレート
  // する(完了は ADR 0084 の門がコミット済みを要求するので、退避が生まれる解放で測る)
  git(ws.path, "checkout", "main");
  writeFileSync(join(ws.path, "rogue.txt"), "must not land on main\n");
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

  // main には何もコミットされていない(初期コミットのみ)— tree rule は
  // タスクブランチ以外への WIP コミットを拒否する
  expect(git(ws.path, "log", "--format=%s", "main")).toBe("initial");
  // 拒否は隔離として扱われる: workspace の question が生まれ、pickup が止まる
  // (エスカレーション自身の question とは別に立つ)
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(
    list.find((x: any) => x.type === "question" && x.title.includes("sandbox")),
  ).toBeDefined();
  await registerWork(t, "stalled work");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});
