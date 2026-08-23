import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgent } from "../src/agent-create.js";
import { openDb } from "../src/db.js";
import { GitHubAuth } from "../src/github-auth.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import { publishWorkspace } from "../src/workspace-create.js";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF as fullHandoff,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

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
  commitWork(ws.path, "landed.txt", "finished\n");
  await complete(t, landing.id);
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.question_pending_local_merge_task_id === landing.id,
  );

  const running = await registerWork(t, "runs while the human answers");
  await t.clock.advance(HOUR);
  commitWork(ws.path, "in-flight.txt", "still working\n");

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
        provider: "anthropic",
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

// ADR 0081: `for-each-ref` は symref を**解決値で**出すので、盤面が `origin/main` を
// 1本書くとスナップショット上は2行動く —— 外科的再基準化は名指しした1行しか撮り直さない
// ので、連動した `origin/HEAD` の行が古いまま取り残され、無実の quarantine になる。
// 指し先で数えれば symref の行は指し先が動いても不変で、取り残しが生じない。
it("盤面が origin/main を撮り直しても、連動する origin/HEAD で quarantine されない", async () => {
  const { registryDir } = await makeRemoteBackedRegistry();
  dirs.push(registryDir);
  // clone が持つ既定ブランチの symref(本番の registry clone と同じ姿)。push -u は
  // これを張らないので明示する
  git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const workspace = {
    name: "registry",
    path: registryDir,
    repo: git(registryDir, "remote", "get-url", "origin"),
  };
  const registry = { dir: registryDir, mode: "remote-backed" as const };
  t = await bootTidepool({
    workspace,
    registry,
    boardState: { paths: [], listWorkspaces: () => [workspace] },
    agentAdmin: { create: (input) => createAgent(input, { registry }) },
  });
  const task = await registerWork(t, "runs in the registry clone");
  await t.clock.advance(HOUR);
  const before = git(registryDir, "rev-parse", "refs/remotes/origin/main");

  expect(
    (
      await api(t.baseUrl, "POST", "/api/agents", {
        name: "tako",
        authority: "standard",
        provider: "anthropic",
        skills: ["*"],
        description: "General agent",
        systemPrompt: "You are Tako.",
      })
    ).status,
  ).toBe(201);
  expect(git(registryDir, "rev-parse", "refs/remotes/origin/main")).not.toBe(before);

  await complete(t, task.id);

  expect(await quarantineQuestion(t)).toBeUndefined();
});

// ADR 0081: symref 自身の可動部は不変条件に残る —— 状態は解決値ではなく**指し先**で
// あり、worker は `git symbolic-ref` / `git remote set-head` でそれを動かせる。
// 付け替えは行差分にそのまま出て、動いた ref が名指しされる。
it("worker が symref を付け替えれば、指し先の差として quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "repoints the remote default branch");
  await t.clock.advance(HOUR);

  git(
    workspace.path,
    "update-ref",
    "refs/remotes/origin/develop",
    git(workspace.path, "rev-parse", "refs/remotes/origin/main"),
  );
  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");

  await complete(t, task.id);

  const purpose = (await quarantineQuestion(t))?.purpose;
  expect(purpose).toContain("was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD");
  expect(purpose).toContain("now: symref=refs/remotes/origin/develop refs/remotes/origin/HEAD");
});

// ADR 0081: 削除は `guardRegistryDefaultBranch` も素通しする(`origin/HEAD` 不在は
// 「remote 既定なし」として合格扱い)—— この不変条件だけが捕まえる。
it("worker が symref を削除すれば quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "deletes the remote default branch symref");
  await t.clock.advance(HOUR);

  git(workspace.path, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.purpose).toContain(
    "was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD",
  );
});

// ADR 0081: 新規 symref の作成はどの守りにも掛かっていなかった —— 指し先で数えることで
// 行が増え、名指しで出る。
it("worker が symref を新規に作れば quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "creates a symref that was not there");
  await t.clock.advance(HOUR);

  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.purpose).toContain(
    "now: symref=refs/remotes/origin/main refs/remotes/origin/HEAD",
  );
});

// ADR 0081: 保存の形そのもの(db.ts の `workspace_state.ref_snapshot` の契約)。
// symref の行だけが指し先を持ち、解決値の行はどこにも残らない。
it("symref を持つ workspace のスナップショットは、symref の行を指し先で保存する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  t = await bootTidepool({ workspace });
  await registerWork(t, "gets a snapshot at pickup");
  await t.clock.advance(HOUR);

  const db = openDb(join(t.dir, "board.sqlite"));
  const snapshot = (
    db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = 'sandbox'").get() as {
      ref_snapshot: string;
    }
  ).ref_snapshot;
  db.close();

  expect(snapshot.split("\n")).toContain("symref=refs/remotes/origin/main refs/remotes/origin/HEAD");
});

// ADR 0064 決定4 のテーブル**6行目**(ADR 0066 決定4 / issue #285): `publish` は
// `refs/remotes/origin/*` を**新規に作る**唯一の経路である。checkout は動かさないので
// ADR 0064 の「走っているセッションの作業ツリーを奪わない」線は無傷だが、再基準化
// しなければ無実のセッションが解放時に quarantine へ落ちる。
async function publishableBoard(name: string): Promise<{
  ws: WorkspaceConfig;
  dest: string;
  boot: Parameters<typeof bootTidepool>[0];
}> {
  const ws = await makeWorkspace(dirs, name);
  const registryDir = await makeRegistry({ "workspaces.yaml": `${name}:\n  path: ${ws.path}\n` });
  const workspacesBaseDir = await mkdtemp(join(tmpdir(), "tidepool-ws-base-"));
  const tokenDir = await mkdtemp(join(tmpdir(), "tidepool-token-"));
  const dest = await mkdtemp(join(tmpdir(), "tidepool-dest-"));
  dirs.push(registryDir, workspacesBaseDir, tokenDir, dest);
  git(dest, "init", "--bare", "-b", "main");
  writeFileSync(join(tokenDir, "token"), "ghp_test\n");
  const deps = {
    registry: { dir: registryDir, mode: "purely-local" as const },
    workspacesBaseDir,
    githubAuth: new GitHubAuth(join(tokenDir, "token")),
  };
  return {
    ws,
    dest,
    boot: {
      workspace: ws,
      workspaceAdmin: { publish: (input) => publishWorkspace(input, deps) },
      boardState: { paths: [], listWorkspaces: () => [ws] },
    },
  };
}

it("セッション中に publish しても、そのセッションは quarantine されない", async () => {
  const { ws, dest, boot } = await publishableBoard("sandbox");
  t = await bootTidepool(boot);
  const task = await registerWork(t, "runs while the human publishes");
  await t.clock.advance(HOUR);
  commitOn(ws.path, "in-flight.txt", "still working\n", "worker's own commit");

  expect(
    (await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest })).status,
  ).toBe(200);
  expect(git(ws.path, "rev-parse", "refs/remotes/origin/main")).toBe(git(ws.path, "rev-parse", "main"));

  await complete(t, task.id);

  expect(await quarantineQuestion(t)).toBeUndefined();
});

// 外科的であることの裏側(ADR 0064 決定4): 全 ref を撮り直せば、その瞬間までに worker が
// 動かした ref も新しい基準に飲み込まれ、解放時の比較が素通りする。publish が触るのは
// `refs/remotes/origin/*` だけなので、`refs/heads/*` の逸脱は今までどおり捕まる。
it("publish が触っていない ref を worker が動かせば、今までどおり quarantine に落ちる", async () => {
  const { ws, dest, boot } = await publishableBoard("sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool(boot);
  const task = await registerWork(t, "moves a sibling while the human publishes");
  await t.clock.advance(HOUR);
  commitOn(ws.path, "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "branch", "-f", "sibling", `task/${task.id}`);

  expect(
    (await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest })).status,
  ).toBe(200);

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.purpose).toContain("refs/heads/sibling");
});

// ADR 0064 決定4 の「盤面が**実際に書いた** ref の行だけ」。publish 後に checkout を
// 覗いて `refs/remotes/origin/*` を列挙すると、worker が窓の中で偽造した
// remote-tracking ref まで「盤面が書いた」に化ける —— ADR 0064 が閉じたはずの
// 潜在バグ(偽造 `refs/remotes` → 無実の次セッションへの誤帰属)がそのまま戻る。
// 撮り直す集合は push の直前に確定していなければならない。
it("publish が push していない origin ref を worker が偽造すれば quarantine に落ちる", async () => {
  const { ws, dest, boot } = await publishableBoard("sandbox");
  t = await bootTidepool(boot);
  const task = await registerWork(t, "forges a remote-tracking ref");
  await t.clock.advance(HOUR);
  commitOn(ws.path, "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "update-ref", "refs/remotes/origin/forged", `task/${task.id}`);

  expect(
    (await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest })).status,
  ).toBe(200);

  await complete(t, task.id);

  expect((await quarantineQuestion(t))?.purpose).toContain("refs/remotes/origin/forged");
});
