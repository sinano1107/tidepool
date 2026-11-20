import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { loadRegistry } from "../src/registry.js";
import { refreshProtectedBranch, resolveExecutionWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { publishWorkspace } from "../src/workspace-create.js";
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
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  runNow,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
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

function commitOn(path: string, file: string, body: string, message: string): void {
  writeFileSync(join(path, file), body);
  git(path, "add", "-A");
  git(path, "commit", "-m", message);
}

/** 名前の場所に HEAD の上の commit を1つ作る(ref は書かない)—— 盤面の口の外で ref を動かす先。 */
const outOfBandCommit = (path: string) => git(path, "commit-tree", git(path, "rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-m", "out of band");

// 旧: 人間が名前の場所に main を作り直してから答えた。ADR 0373 決定1 の後は作った branch も動いた ref で、出口は registry の `branch` を直すこと(text A12 の H10)
it("保護ブランチが無い停止は落ちた項を名指し、修復回答を拒み、registry の `branch` を直した回答の後に pickup できる(ADR 0329 決定10・14、#2775、ADR 0373 決定16)", async () => {
  const workspace = await makeWorkspace("sandbox");
  // registry のエントリの `branch` —— 人間が直す値
  let branch: string | undefined;
  t = await bootTidepool({ workspace, resolveWorkspace: () => ({ ...workspace, branch }) });
  git(workspace.path, "checkout", "-b", "rescue");
  git(workspace.path, "branch", "-D", "main");
  const task = await registerWork(t, "needs main");
  await t.clock.advance(HOUR);
  const stops = async () => (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json.filter((e: any) => e.kind === "pickup_stopped");
  await vi.waitFor(async () => expect(await stops()).toHaveLength(1));
  const reason = (await stops())[0].payload.reason;
  expect(reason).toContain("workspace sandbox");
  expect(reason).toContain("protected branch 'main'");
  expect(reason).toMatch(/The check that failed: .*protected branch `main`/);
  expect(reason).toContain("cannot be checked out: ");
  const question = await servedQuarantineQuestion(t, "workspace", workspace.name);
  const answer = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired"] });
  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(reason);

  branch = "rescue";
  expect((await answer()).status).toBe(200);
  await runNow(t, task.id);
  await vi.waitFor(() => expect(t.worker.started.map((s) => s.id)).toContain(task.id));
  expect(await stops()).toHaveLength(1);
});

// 旧: 名前の場所の main を手で戻してから答えた。ADR 0373 決定1 の後は手の reset も動いた ref で、出口は自分の clone から origin へ push すること(text A12 の H9)
it.each(["ahead", "diverged", "unreachable"])("remote 正本の %s は停止と回答で同じ項が拒み、復元後の回答だけが次の pickup を通す(ADR 0329 決定10・14、ADR 0373 決定16)", async (fault) => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  if (fault === "unreachable") renameSync(workspace.repo!, `${workspace.repo}-saved`);
  else {
    commitOn(workspace.path, "local.txt", "local only\n", "unpublished local commit");
    if (fault === "diverged") publish("remote.txt", "remote only\n", "remote commit");
  }
  const task = await registerWork(t, `repair ${fault}`);
  await t.clock.advance(HOUR);
  const stops = async () => (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json.filter((e: any) => e.kind === "pickup_stopped");
  await vi.waitFor(async () => expect(await stops()).toHaveLength(1));
  const reason = (await stops())[0].payload.reason;
  const check = reason.split("The check that failed: ")[1];
  expect(check).toContain(fault === "unreachable" ? "can be fetched" : "can be checked out");
  const question = await servedQuarantineQuestion(t, "workspace", workspace.name);
  const answer = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired"] });
  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(`The check that failed: ${check}`);
  expect(t.worker.started.map((s) => s.id)).not.toContain(task.id);

  if (fault === "unreachable") renameSync(`${workspace.repo}-saved`, workspace.repo!);
  else {
    // 名前の場所の ref は動かさず、自分の clone で名前の場所の commit を origin の main に入れて push する
    const clone = await tempDir("tidepool-own-clone-");
    git(clone, "clone", "--quiet", workspace.repo!, ".");
    git(clone, "fetch", "--quiet", workspace.path, "main:named-main");
    git(clone, "merge", "--quiet", "--no-edit", "named-main");
    git(clone, "push", "--quiet", "origin", "main");
  }
  expect((await answer()).status).toBe(200);
  await runNow(t, task.id);
  await vi.waitFor(() => expect(t.worker.started.map((s) => s.id)).toContain(task.id));
  expect(await stops()).toHaveLength(1);
});

// ADR 0064 決定1/2: 見張るのは `refs/*` 全部で、除外は自分のタスクブランチ1本のみ。
// 別の非保護ブランチへ寄り道して戻ってくる形は、checkout の HEAD の位置を読んでも見えない
// —— 終了時点の HEAD は自分のタスクブランチだからである。ref の基準の比較が拾う。
it("worker が別の非保護ブランチを変更して自ブランチへ戻っても quarantine に落ちる", async () => {
  const ws = await makeWorkspace("sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "wanders onto a sibling branch");
  await t.clock.advance(HOUR);

  git(ws.path, "checkout", "sibling");
  commitOn(ws.path, "elsewhere.txt", "not my branch\n", "worker commits on a sibling branch");
  git(ws.path, "checkout", `task/${task.id}`);

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.title).toContain("workspace sandbox needs human attention");
});

// 旧(#234 のケース1): worker が別ブランチのまま終了すると、終了時の HEAD 検査が commit を拒んで quarantine に落ちた。
// worker は task の checkout で走り、盤面が読むのはタスクブランチ1本なので、checkout の HEAD の位置は読まない。
it("worker が task の checkout で別ブランチのまま終了しても、盤面はタスクブランチを読み、quarantine に落ちない(ADR 0356 決定4)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "wanders off and stays there");
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  commitOn(checkout, "work.txt", "my own work\n", "worker's own commit");

  git(checkout, "checkout", "-b", "sibling");

  await complete(t, task.id);

  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
  expect(git(ws.path, "show", `task/${task.id}:work.txt`)).toBe("my own work");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

// ADR 0064 の「測定」表のケース2。purely-local はここが**新規に捕まる側**である ——
// `parkOnProtectedBranch` は `isRemoteBacked` で早期 return するので、今日は着地
// (ff-only)まで無防備で、着地判断が hold なら永久に捕まらない。
it("purely-local で保護ブランチを変更してタスクブランチへ戻っても quarantine に落ちる", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "writes on main and comes back");
  await t.clock.advance(HOUR);

  git(ws.path, "checkout", "main");
  commitOn(ws.path, "on-main.txt", "written on the protected branch\n", "worker writes on main");
  git(ws.path, "checkout", `task/${task.id}`);

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.title).toContain("workspace sandbox needs human attention");
});

it("remote 正本を宣言した workspace でも同じく quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "writes on main and comes back");
  await t.clock.advance(HOUR);

  git(workspace.path, "checkout", "main");
  commitOn(workspace.path, "on-main.txt", "written on the protected branch\n", "worker on main");
  git(workspace.path, "checkout", `task/${task.id}`);

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.title).toContain("workspace sandbox needs human attention");
});

// ADR 0064 決定1 が「守るのは操作の列ではなく最終的な Git 状態」であること: checkout を
// 一度もせずに ref だけを直接書き換える形も、同じ1つの述語が捕まえる。
it("checkout を経ずに ref を直接書き換えても quarantine に落ちる", async () => {
  const ws = await makeWorkspace("sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "rewrites a ref in place");
  await t.clock.advance(HOUR);

  commitOn(ws.path, "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "branch", "-f", "sibling", `task/${task.id}`);

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.title).toContain("workspace sandbox needs human attention");
});

// ADR 0064 決定2: 削除が最も静かな破壊である。タスクブランチは決着後も「そのタスクが
// 産んだ差分の恒久記録」であり続けるので、`git branch -D` は監査記録を消して痕跡を
// どこにも残さない —— 移動だけを見る綴りはこれを通す。
it("兄弟のタスクブランチを削除しても quarantine に落ちる", async () => {
  const ws = await makeWorkspace("sandbox");
  git(ws.path, "branch", "task/sibling-record");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "erases a sibling's record");
  await t.clock.advance(HOUR);

  git(ws.path, "branch", "-D", "task/sibling-record");

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.title).toContain("workspace sandbox needs human attention");
});

// ADR 0064 の「測定」節が名指しした既存の潜在バグ。今日この経路は park の位置検査を
// **比較の両側が同じ偽値になる**ことで通り抜け、次の pickup の fetch が真の値へ戻した
// あと、**その次の無実のセッション**の解放で位置検査が落ちる。走ったセッション自身で
// 捕まえるのがこの検査である。
// 旧: worker が名前の場所で偽造した。基準が見張るのは名前の場所だけなので(ADR 0356 決定4)、偽造は名前の場所に書かれたものとして捕まる
it("名前の場所の refs/remotes の偽造は、その間に走ったセッション自身の解放で捕まる(ADR 0356 決定4)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "forges the remote-tracking ref");
  await t.clock.advance(HOUR);

  commitOn(checkoutOf(t.db, task.id), "work.txt", "my own work\n", "worker's own commit");
  git(workspace.path, "update-ref", "refs/remotes/origin/main", outOfBandCommit(workspace.path));

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "out of my authority",
      questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  await client.close();

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose).toContain("refs/remotes/origin/main");
});

// ADR 0243 の予告と畳み。**盤面自身がセッション実行中に同じ workspace の ref を
// 書く**経路は、すべて人間面から入るので slot=1 でも並行する —— タスクA の着地 question に
// 人間が答えた瞬間にタスクB が走っていれば、B の解放で不変条件が落ちる。無実のセッションの
// quarantine である。盤面が書く ref の行だけを、書く前に予告し書いた後に畳むことでこれを防ぐ。
it("セッション中に盤面が保護ブランチを動かしても、そのセッションは quarantine されない", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const landing = await registerWork(t, "lands through the merge question");
  await t.clock.advance(HOUR);
  commitWork(checkoutOf(t.db, landing.id), "landed.txt", "finished\n");
  await complete(t, landing.id);
  await completeIntegrationReviews(t, landing.id);
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.question_pending_local_merge_task_id === landing.id,
  );

  const running = await registerWork(t, "runs while the human answers");
  await t.clock.advance(HOUR);
  commitWork(checkoutOf(t.db, running.id), "in-flight.txt", "still working\n");

  expect(
    (await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["merge"] }))
      .status,
  ).toBe(200);
  expect(git(ws.path, "rev-parse", "main")).toBe(git(ws.path, "rev-parse", `task/${landing.id}`));

  await complete(t, running.id);

  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
  expect(git(ws.path, "show", `task/${running.id}:in-flight.txt`)).toBe("still working");
});

// ADR 0064 決定2: 違反メッセージは**動いた ref を名指しする**。quarantine の確認
// question の本文がそのまま人間の修理手順になるためで、ハッシュだけを比べて「どれかが
// 動いた」としか言えない実装は選ばない。
it("違反メッセージは動いた ref を名指しし、消えた行と増えた行を出す", async () => {
  const ws = await makeWorkspace("sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "moves a sibling branch");
  await t.clock.advance(HOUR);
  const before = git(ws.path, "rev-parse", "sibling");

  // 旧: worker が自分の commit を作って名前の場所の sibling を動かした。今は名前の場所の ref だけが基準に載る(ADR 0356 決定4)
  commitOn(checkoutOf(t.db, task.id), "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "branch", "-f", "sibling", outOfBandCommit(ws.path));
  const after = git(ws.path, "rev-parse", "sibling");

  await complete(t, task.id);

  const purpose = (await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose;
  expect(purpose).toContain(`was: ${before} refs/heads/sibling`);
  expect(purpose).toContain(`now: ${after} refs/heads/sibling`);
});

// ADR 0081: `for-each-ref` は symref を**解決値で**出すので、盤面が `origin/main` を
// 1本書くとスナップショット上は2行動く —— 口(ADR 0243)は名指しした1行しか畳まない
// ので、連動した `origin/HEAD` の行が古いまま取り残され、無実の quarantine になる。
// 指し先で数えれば symref の行は指し先が動いても不変で、取り残しが生じない。
it("盤面が origin/main を書いても、連動する origin/HEAD で quarantine されない", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("sandbox");
  // clone が持つ既定ブランチの symref。テンプレートの clone はこれを張らないので明示する
  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "runs while the board refreshes the protected branch copy");
  await t.clock.advance(HOUR);
  const before = git(workspace.path, "rev-parse", "refs/remotes/origin/main");
  publish("merged.txt", "merged on GitHub\n", "merged while the session runs");

  // 収束が保護ブランチの写しを進める書き込み(ADR 0241 決定1)—— 口は origin/main の1行だけを予告して畳む
  await refreshProtectedBranch(t.db, workspace, undefined);
  expect(git(workspace.path, "rev-parse", "refs/remotes/origin/main")).not.toBe(before);

  await complete(t, task.id);

  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
});

// ADR 0081: symref 自身の可動部は不変条件に残る —— 状態は解決値ではなく**指し先**で
// あり、worker は `git symbolic-ref` / `git remote set-head` でそれを動かせる。
// 付け替えは行差分にそのまま出て、動いた ref が名指しされる。
it("worker が symref を付け替えれば、指し先の差として quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
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

  const purpose = (await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose;
  expect(purpose).toContain("was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD");
  expect(purpose).toContain("now: symref=refs/remotes/origin/develop refs/remotes/origin/HEAD");
});

// ADR 0081: 削除は default branch の検査にも掛からない(ADR 0377 決定7 で registry clone だけを見て、`origin/HEAD`
// 不在は合格扱い —— spec #3273 の読み)—— この不変条件だけが捕まえる。
it("worker が symref を削除すれば quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "deletes the remote default branch symref");
  await t.clock.advance(HOUR);

  git(workspace.path, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose).toContain(
    "was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD",
  );
});

// ADR 0081: 新規 symref の作成はどの守りにも掛かっていなかった —— 指し先で数えることで
// 行が増え、名指しで出る。
it("worker が symref を新規に作れば quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "creates a symref that was not there");
  await t.clock.advance(HOUR);

  git(workspace.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose).toContain(
    "now: symref=refs/remotes/origin/main refs/remotes/origin/HEAD",
  );
});

// ADR 0066 決定4 / issue #285: `publish` は `refs/remotes/origin/*` を**新規に作る**唯一の
// 経路である。checkout は動かさないので ADR 0064 の「走っているセッションの作業ツリーを
// 奪わない」線は無傷だが、N 本の写しを予告して畳まなければ(ADR 0243)無実のセッションが
// 解放時に quarantine へ落ちる。
async function publishableBoard(name: string): Promise<{
  ws: WorkspaceConfig;
  dest: string;
  boot: Parameters<typeof bootTidepool>[0];
}> {
  const ws = await makeWorkspace(name);
  const registryDir = await makeRegistry({ "workspaces.yaml": `${name}:\n  path: ${ws.path}\n` });
  const workspacesBaseDir = await tempDir("tidepool-ws-base-");
  const tokenDir = await tempDir("tidepool-token-");
  const dest = await tempDir("tidepool-dest-");
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
      resolveWorkspace: (taskWorkspace) => resolveExecutionWorkspace(loadRegistry(registryDir, deps.registry.mode), name, taskWorkspace, workspacesBaseDir),
      workspaceAdmin: { publish: (input) => publishWorkspace(input, { ...deps, db: t.db }) },
      boardState: { paths: [], listWorkspaces: () => [ws] },
    },
  };
}

it("セッション中に publish しても、そのセッションは quarantine されない", async () => {
  const { ws, dest, boot } = await publishableBoard("sandbox");
  t = await bootTidepool(boot);
  const task = await registerWork(t, "runs while the human publishes");
  await t.clock.advance(HOUR);
  commitOn(checkoutOf(t.db, task.id), "in-flight.txt", "still working\n", "worker's own commit");

  expect(
    (await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest })).status,
  ).toBe(200);
  expect(git(ws.path, "rev-parse", "refs/remotes/origin/main")).toBe(git(ws.path, "rev-parse", "main"));
  // ADR 0119 決定3: pause the next pickup to observe the release of this session on its own.
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });

  await complete(t, task.id);

  expect(await servedQuarantineQuestion(t, "workspace", "sandbox")).toBeUndefined();
});

// 盤面が書く行だけを予告して畳むことの裏側(ADR 0243): 全 ref を撮り直せば、その瞬間までに worker が
// 動かした ref も新しい基準に飲み込まれ、解放時の比較が素通りする。publish が触るのは
// `refs/remotes/origin/*` だけなので、`refs/heads/*` の逸脱は今までどおり捕まる。
// 旧: worker が名前の場所の ref を動かした。基準は名前の場所だけが持つ(ADR 0356 決定4)
it("publish が触っていない名前の場所の ref が動けば、今までどおり quarantine に落ちる(ADR 0356 決定4)", async () => {
  const { ws, dest, boot } = await publishableBoard("sandbox");
  git(ws.path, "branch", "sibling");
  t = await bootTidepool(boot);
  const task = await registerWork(t, "moves a sibling while the human publishes");
  await t.clock.advance(HOUR);
  commitOn(checkoutOf(t.db, task.id), "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "branch", "-f", "sibling", outOfBandCommit(ws.path));

  expect(
    (await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest })).status,
  ).toBe(200);

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose).toContain("refs/heads/sibling");
});

// ADR 0243: 予告するのは盤面が**これから書く** ref の行だけ。publish 後に checkout を
// 覗いて `refs/remotes/origin/*` を列挙すると、worker が窓の中で偽造した
// remote-tracking ref まで「盤面が書いた」に化ける —— ADR 0064 が閉じたはずの
// 潜在バグ(偽造 `refs/remotes` → 無実の次セッションへの誤帰属)がそのまま戻る。
// 予告する集合は push の直前に確定していなければならない。
it("publish が push していない origin ref を worker が偽造すれば quarantine に落ちる", async () => {
  const { ws, dest, boot } = await publishableBoard("sandbox");
  t = await bootTidepool(boot);
  const task = await registerWork(t, "forges a remote-tracking ref");
  await t.clock.advance(HOUR);
  commitOn(checkoutOf(t.db, task.id), "work.txt", "my own work\n", "worker's own commit");
  git(ws.path, "update-ref", "refs/remotes/origin/forged", `task/${task.id}`);

  expect(
    (await api(t.baseUrl, "POST", "/api/workspaces/sandbox/publish", { repo: dest })).status,
  ).toBe(200);

  await complete(t, task.id);

  expect((await servedQuarantineQuestion(t, "workspace", "sandbox"))?.purpose).toContain("refs/remotes/origin/forged");
});
