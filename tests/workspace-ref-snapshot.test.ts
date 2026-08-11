import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgent } from "../src/agent-create.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function complete(board: Tidepool, taskId: string): Promise<void> {
  const client = await mcpClient(board.mcpBaseUrl, taskId);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();
}

async function quarantineQuestion(board: Tidepool): Promise<any> {
  const list = (await api(board.baseUrl, "GET", "/api/tasks")).json;
  return list.find((x: any) => x.question_quarantine_workspace !== null);
}

function commitOn(path: string, file: string, body: string, message: string): void {
  writeFileSync(join(path, file), body);
  git(path, "add", "-A");
  git(path, "commit", "-m", message);
}

// ADR 0064 決定1/2: 見張るのは `refs/*` 全部で、除外は自分のタスクブランチ1本のみ。
// 別の非保護ブランチへ寄り道して戻ってくる形は、`releaseTree` の HEAD 検査を素通り
// する —— 終了時点の HEAD は自分のタスクブランチだからである。
it("worker が別の非保護ブランチを変更して自ブランチへ戻っても quarantine に落ちる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "wanders onto a sibling branch");
  await t.clock.advance(HOUR);

  git(ws.path, "checkout", "sibling");
  commitOn(ws.path, "elsewhere.txt", "not my branch\n", "worker commits on a sibling branch");
  git(ws.path, "checkout", `task/${task.id}`);

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.title).toContain("workspace sandbox needs human attention");
});

// 回帰(#234 のケース1): 終了時の HEAD 検査は `releaseTree` が今も先に持っている ——
// スナップショット比較を1本挟んでも、この最も基本的な形の理由が変わってはならない。
it("worker が別ブランチのまま終了すると、今までどおり HEAD 検査で quarantine に落ちる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "wanders off and stays there");
  await t.clock.advance(HOUR);

  git(ws.path, "checkout", "sibling");

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.purpose).toContain("refusing to commit");
});

// ADR 0064 の「測定」表のケース2。purely-local はここが**新規に捕まる側**である ——
// `parkOnProtectedBranch` は `isRemoteBacked` で早期 return するので、今日は着地
// (ff-only)まで無防備で、着地判断が hold なら永久に捕まらない。
it("purely-local で保護ブランチを変更してタスクブランチへ戻っても quarantine に落ちる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "writes on main and comes back");
  await t.clock.advance(HOUR);

  git(ws.path, "checkout", "main");
  commitOn(ws.path, "on-main.txt", "written on the protected branch\n", "worker writes on main");
  git(ws.path, "checkout", `task/${task.id}`);

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.title).toContain("workspace sandbox needs human attention");
});

it("remote 正本を宣言した workspace でも同じく quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "writes on main and comes back");
  await t.clock.advance(HOUR);

  git(workspace.path, "checkout", "main");
  commitOn(workspace.path, "on-main.txt", "written on the protected branch\n", "worker on main");
  git(workspace.path, "checkout", `task/${task.id}`);

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.title).toContain("workspace sandbox needs human attention");
});

// ADR 0064 決定1 が「守るのは操作の列ではなく最終的な Git 状態」であること: checkout を
// 一度もせずに ref だけを直接書き換える形も、同じ1つの述語が捕まえる。
it("checkout を経ずに ref を直接書き換えても quarantine に落ちる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "rewrites a ref in place");
  await t.clock.advance(HOUR);

  commitOn(ws.path, "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "branch", "-f", "sibling", `task/${task.id}`);

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.title).toContain("workspace sandbox needs human attention");
});

// ADR 0064 決定2: 削除が最も静かな破壊である。タスクブランチは決着後も「そのタスクが
// 産んだ差分の恒久記録」であり続けるので、`git branch -D` は監査記録を消して痕跡を
// どこにも残さない —— 移動だけを見る綴りはこれを通す。
it("兄弟のタスクブランチを削除しても quarantine に落ちる", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  git(ws.path, "branch", "task/sibling-record");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "erases a sibling's record");
  await t.clock.advance(HOUR);

  git(ws.path, "branch", "-D", "task/sibling-record");

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.title).toContain("workspace sandbox needs human attention");
});

// ADR 0064 の「測定」節が名指しした既存の潜在バグ。今日この経路は park の位置検査を
// **比較の両側が同じ偽値になる**ことで通り抜け、次の pickup の fetch が真の値へ戻した
// あと、**その次の無実のセッション**の解放で位置検査が落ちる。走ったセッション自身で
// 捕まえるのがこの検査である。
it("refs/remotes の偽造は、偽造したセッション自身の解放で捕まる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "forges the remote-tracking ref");
  await t.clock.advance(HOUR);

  commitOn(workspace.path, "work.txt", "my own work\n", "worker's own commit");
  git(
    workspace.path,
    "update-ref",
    "refs/remotes/origin/main",
    git(workspace.path, "rev-parse", `task/${task.id}`),
  );

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "out of my authority",
      questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  await client.close();

  expect((await quarantineQuestion(t))?.purpose).toContain("refs/remotes/origin/main");
});

// ADR 0064 決定4 の再基準化。**盤面自身がセッション実行中に同じ workspace の ref を
// 書く**経路は、すべて人間面から入るので slot=1 でも並行する —— タスクA の着地 question に
// 人間が答えた瞬間にタスクB が走っていれば、B の解放で不変条件が落ちる。無実のセッションの
// quarantine である。盤面が書いた ref の行だけを撮り直すことでこれを防ぐ。
it("セッション中に盤面が保護ブランチを動かしても、そのセッションは quarantine されない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const landing = await registerWork(t, "lands through the merge question");
  await t.clock.advance(HOUR);
  writeFileSync(join(ws.path, "landed.txt"), "finished\n");
  await complete(t, landing.id);
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.question_pending_local_merge_task_id === landing.id,
  );

  const running = await registerWork(t, "runs while the human answers");
  await t.clock.advance(HOUR);
  writeFileSync(join(ws.path, "in-flight.txt"), "still working\n");

  expect(
    (await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["merge"] }))
      .status,
  ).toBe(200);
  expect(git(ws.path, "rev-parse", "main")).toBe(git(ws.path, "rev-parse", `task/${landing.id}`));

  await complete(t, running.id);

  expect(await quarantineQuestion(t)).toBeUndefined();
  expect(git(ws.path, "show", `task/${running.id}:in-flight.txt`)).toBe("still working");
});

// 再基準化の5経路のうち3つは registry clone を触る。ADR 0064 決定4 が「**最も起きやすい**
// のが registry clone であり、唯一の保護 workspace で不変条件が最も弱くなる」と名指しした
// 経路であり、盤面の書き込みは人間面の settings から実行中のセッションと並行して入る。
it("セッション中の registry 書き込みで、registry clone の workspace は quarantine されない", async () => {
  const registryDir = await makeRegistry();
  dirs.push(registryDir);
  const workspace = { name: "registry", path: registryDir };
  t = await bootTidepool({
    workspace,
    registry: { dir: registryDir, mode: "purely-local" },
    boardState: { paths: [], listWorkspaces: () => [workspace] },
    agentAdmin: {
      create: (input) => createAgent(input, { registry: { dir: registryDir, mode: "purely-local" } }),
    },
  });
  const task = await registerWork(t, "runs in the registry clone");
  await t.clock.advance(HOUR);
  const before = git(registryDir, "rev-parse", "refs/heads/main");

  expect(
    (
      await api(t.baseUrl, "POST", "/api/agents", {
        name: "tako",
        authority: "standard",
        skills: ["*"],
        description: "General agent",
        systemPrompt: "You are Tako.",
      })
    ).status,
  ).toBe(201);
  expect(git(registryDir, "rev-parse", "refs/heads/main")).not.toBe(before);

  await complete(t, task.id);

  expect(await quarantineQuestion(t)).toBeUndefined();
});

// ADR 0064 決定2: 違反メッセージは**動いた ref を名指しする**。quarantine の確認
// question の本文がそのまま人間の修理手順になるためで、ハッシュだけを比べて「どれかが
// 動いた」としか言えない実装は選ばない。
it("違反メッセージは動いた ref を名指しし、消えた行と増えた行を出す", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "moves a sibling branch");
  await t.clock.advance(HOUR);
  const before = git(ws.path, "rev-parse", "sibling");

  commitOn(ws.path, "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "branch", "-f", "sibling", `task/${task.id}`);
  const after = git(ws.path, "rev-parse", "sibling");

  await complete(t, task.id);

  const purpose = (await quarantineQuestion(t))?.purpose;
  expect(purpose).toContain(`was: ${before} refs/heads/sibling`);
  expect(purpose).toContain(`now: ${after} refs/heads/sibling`);
});
