import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
let wsPath: string | undefined;
afterEach(async () => {
  await t?.stop();
  if (wsPath) await rm(wsPath, { recursive: true, force: true });
  wsPath = undefined;
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

/** A real git repository standing in for the workspace — the PRD test policy:
 *  git is never faked, the rule is verified against actual trees. */
async function makeWorkspace(): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
  wsPath = path;
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name: "sandbox", path };
}

async function registerWork(t: Tidepool, title: string) {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
  });
  return res.json;
}

const fullHandoff = {
  outcome: "done as specified",
  deliverables: "notes.txt on the task branch",
  decision_refs: "none",
  dead_ends: "none",
  resume_context: "none needed",
  known_issues: "none",
};

it("pickup 時にタスクブランチが作成・checkout され、作業はそのブランチ上で行われる", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "build the thing");
  await t.clock.advance(HOUR);

  // ブランチ規律は tidepool 本体が敷く: フェイクワーカーは何もしていないのに
  // workspace はタスクブランチの上にいる(main 直書きは構造的に起きない)
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
});

it("complete による解放で WIP コミットが強制され、ツリーがクリーンに戻る", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write things");
  await t.clock.advance(HOUR);

  // エージェントの善意に依存しない: ワーカーはコミットせず散らかしたまま完了する
  writeFileSync(join(ws.path, "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.baseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  // WIP はタスクブランチのコミットとして退避され、ツリーはクリーン
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "log", "--format=%s", `task/${task.id}`)).toContain(`WIP: task ${task.id}`);
  expect(git(ws.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished work");
  // main には何も書かれていない
  expect(() => git(ws.path, "show", "main:notes.txt")).toThrow();
});

it("エスカレーション解放でも WIP が退避され、再開は自ブランチの checkout だけで済む", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "risky work");
  await t.clock.advance(HOUR);

  // 作業途中でエスカレーション — コミットしないまま slot を手放す
  writeFileSync(join(ws.path, "draft.txt"), "work in flight\n");
  const client = await mcpClient(t.baseUrl, task.id);
  const res: any = await client.callTool({
    name: "escalate",
    arguments: {
      title: "which approach?",
      context: "two viable approaches, outside my authority",
      options: ["a", "b"],
      recommendation: "a",
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
  const c2 = await mcpClient(t.baseUrl, other.id);
  await c2.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await c2.close();

  // 回答 → 親が先頭復帰して即 pickup。再開は自ブランチの checkout だけで、
  // WIP がそのまま作業ツリーに戻っている
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "a" });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, other.id, task.id]);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(readFileSync(join(ws.path, "draft.txt"), "utf8")).toBe("work in flight\n");
});

it("tree rule の失敗で workspace が needs-human になり、pickup が止まり、question が生まれる", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "doomed work");
  await t.clock.advance(HOUR);

  // リポジトリ自体を壊して WIP コミットを失敗させる(コンフリクト等の代役)
  writeFileSync(join(ws.path, "junk.txt"), "uncommittable\n");
  await rm(join(ws.path, ".git"), { recursive: true, force: true });
  const client = await mcpClient(t.baseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false); // 完了自体は成立している
  await client.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.id === task.id).status).toBe("done");

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

it("ワーカーが main に逃げていても WIP は main にコミットされず、workspace が隔離される", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "rogue work");
  await t.clock.advance(HOUR);

  // 規律を破るワーカー: セッション中に main へ checkout し、散らかしたまま完了する
  git(ws.path, "checkout", "main");
  writeFileSync(join(ws.path, "rogue.txt"), "must not land on main\n");
  const client = await mcpClient(t.baseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  // main には何もコミットされていない(初期コミットのみ)— tree rule は
  // タスクブランチ以外への WIP コミットを拒否する
  expect(git(ws.path, "log", "--format=%s", "main")).toBe("initial");
  // 拒否は隔離として扱われる: question が生まれ、pickup が止まる
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.type === "question")).toBeDefined();
  await registerWork(t, "stalled work");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});
