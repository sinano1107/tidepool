import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerTask } from "../src/tasks.js";
import { quarantineWorkspace } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  checkoutOf,
  FULL_HANDOFF as fullHandoff,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("未コミットの変更を残したまま work タスクを完了しようとすると拒否され、commit を要求される", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "build the thing");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });

  // ツール結果は agent 向けテキスト = 英語で、要求と本文の粒度が読める
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("uncommitted changes");
  expect(res.content[0].text).toContain("what changed and why");
  // 拒否ではタスクもツリーも動かない
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.status).toBe("in_progress");
  const checkout = checkoutOf(t.db, task.id);
  expect(git(checkout, "status", "--porcelain")).toContain("notes.txt");

  // slot もセッションも生きている: commit して呼び直せばそのまま完了する
  git(checkoutOf(t.db, task.id), "add", "-A");
  git(checkoutOf(t.db, task.id), "commit", "-m", "notes: capture the half-finished work");
  const retry: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(retry.isError ?? false).toBe(false);
  await client.close();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("workspace が Quarantine 中でも dirty な work の完了は拒み、commit 後の呼び直しは通る(ADR 0350 決定1)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "finish while the workspace is quarantined");
  await t.clock.advance(HOUR);
  quarantineWorkspace(t.db, ws.name, new Error("unrelated workspace failure"), t.clock.now());
  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "the deliverable\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);

  const result: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("uncommitted changes");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");

  git(checkoutOf(t.db, task.id), "add", "-A");
  git(checkoutOf(t.db, task.id), "commit", "-m", "notes: record the deliverable");
  const retry: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(retry.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

// 門は tree rule と同じ基準で dirty を数える(ADR 0069 の3条件)。`.claude/agents` は
// 丸ごと untracked なディレクトリの下にいるので、porcelain の既定の畳み込みでは
// `?? .claude/` としか見えない —— そこで残骸の除外が効かなくなる形が回帰の本体である
it("sandbox の shadow 残骸だけが残っていても完了の門は通る", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "verify without changing anything");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), ".zshrc"), "");
  mkdirSync(join(checkoutOf(t.db, task.id), ".claude"), { recursive: true });
  writeFileSync(join(checkoutOf(t.db, task.id), ".claude/agents"), "");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

// review は読むだけで書けない —— 完了の門は掛からず、残っていたものは現行どおり
// WIP に退避される
it("review タスクの完了は dirty でも拒否されない", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review the deliverable",
      purpose: "check it against the criteria",
      completion_criteria: "findings are recorded",
    })
  ).json;
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "scratch.txt"), "reviewer leavings\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({ name: "complete_task", arguments: { handoff: { outcome: "no findings" } } });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
  expect(git(ws.path, "log", "--format=%s", `task/${task.id}`)).toContain(`WIP: task ${task.id}`);
});

// escalate / decompose は「作業が終わっていない」解放なので門を掛けない
it("escalate は dirty でも拒否されず、WIP コミットの subject にタスクの title が載る", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "wire up the sensor");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "escalate",
    arguments: {
      context: "the sensor pinout is ambiguous",
      questions: [
        {
          title: "which pinout?",
          options: ["datasheet rev A", "datasheet rev B"],
          recommendation: "datasheet rev A",
        },
      ],
    },
  });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect(git(ws.path, "log", "-1", "--format=%s", `task/${task.id}`)).toBe(
    `WIP: task ${task.id} — wire up the sensor`,
  );
});

// issue-backed の stored title は `#N` プレースホルダのまま —— 退避は同期の機械処理で
// GitHub を叩かないので、subject は素の形に落ちる
it("issue参照タスクの WIP コミット subject はプレースホルダを載せず素の形になる", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = registerTask(
    t.db,
    { type: "work", workspace: ws.name, github_issue_number: 240 },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  t.github.scriptIssue(240, { title: "workerは必ずcommitメッセージを考えてほしい", body: "", comments: [] });
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "the issue is ambiguous",
      questions: [
        { title: "which reading?", options: ["a", "b"], recommendation: "a" },
      ],
    },
  });
  await client.close();

  expect(git(ws.path, "log", "-1", "--format=%s", `task/${task.id}`)).toBe(`WIP: task ${task.id}`);
});

it("decompose は dirty でも拒否されず、WIP がタスクブランチへ退避される", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "split the work");
  await t.clock.advance(HOUR);

  writeFileSync(join(checkoutOf(t.db, task.id), "notes.txt"), "half-finished work\n");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the remaining slice is independent",
      children: [
        {
          title: "implement the slice",
          purpose: "finish one part",
          completion_criteria: "the artifact exists",
        },
      ],
    },
  });
  await client.close();

  expect(res.isError ?? false).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished work");
});
