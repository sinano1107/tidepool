import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { type FakeBroker, startFakeBroker } from "./fake-broker.js";
import {
  api,
  bootTidepool,
  checkoutOf,
  commitWork,
  completeViaMcp,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  registerWork,
  servedQuarantineQuestion,
  shimGit,
  type Tidepool,
} from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
const brokers: FakeBroker[] = [];
afterEach(async () => {
  await t?.stop();
  for (const broker of brokers.splice(0)) await broker.close();
});

async function questionTitles(board: Tidepool): Promise<string[]> {
  const list = (await api(board.baseUrl, "GET", "/api/tasks")).json;
  return list.filter((x: any) => x.type === "question").map((x: any) => x.title);
}

async function quarantineReason(board: Tidepool, workspace: string): Promise<string | undefined> {
  return (await servedQuarantineQuestion(board, "workspace", workspace))?.purpose;
}

// ADR 0052 決定5: 一般 workspace の fetch 失敗は**既存の workspace quarantine に乗る**
// —— その workspace のタスクだけが止まればよく、資源単位の原則がそのまま適用できる。
// 狭められないのは registry の側だけである(あらゆる spawn の入力だから)。
it("remote 正本を宣言した workspace の refresh が失敗すると、その workspace が quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  // remote は宣言どおり張られているが届かない = credential の失効やホスティング障害
  workspace.repo = "/nonexistent/workspace-remote";
  git(workspace.path, "remote", "set-url", "origin", workspace.repo);

  t = await bootTidepool({ workspace });
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  // spawn はされていない: 古いままの checkout で走らせるより止まるほうを選ぶ
  expect(t.worker.started).toEqual([]);
  expect(await questionTitles(t)).toEqual([
    expect.stringContaining("workspace sandbox needs human attention"),
  ]);
});

// ADR 0052 決定3 の対偶: 宣言は clone を覗いた推測ではないので、宣言と実態がずれた
// ときに**どこかが赤くならなければならない**。推測(remote の有無で毎回切り替える)
// なら remote が失われた瞬間に古い挙動へ静かに戻り、どこも赤くならない —— それが
// この ADR が名指しで却下した道である。
it("repo を宣言しているのに clone に remote が無い workspace は quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  // 宣言だけが残り、実態が消えた状態(`git remote remove` は tracking ref も消す)
  git(workspace.path, "remote", "remove", "origin");

  t = await bootTidepool({ workspace });
  await registerWork(t, "declared remote is gone");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  // git の生のエラーではなく、読める理由が人間に届く
  expect(await quarantineReason(t, "sandbox")).toContain("declares a remote source of truth");
});

it("remote 宣言と clone のずれが残るうちは workspace quarantine への回答が拒まれ、予告にその項が並ぶ(ADR 0329 追記 決定6)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  git(workspace.path, "remote", "remove", "origin");

  t = await bootTidepool({ workspace });
  await registerWork(t, "declared remote is gone");
  await t.clock.advance(HOUR);

  const quarantine = await servedQuarantineQuestion(t, "workspace", "sandbox");
  expect(quarantine.purpose).toContain("it has an `origin` remote exactly when it declares a remote source of truth");
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, { answers: ["repaired by hand"] });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("declares a remote source of truth");
});

// 逆向きのずれ。こちらは黙って通ってしまうほうが危ない —— fork 元がローカルの
// 保護ブランチのままなので、merge 済みの成果が見えない地点からタスクが始まり続け、
// 症状は「PR が毎回コンフリクトする」という遠い場所に出る。
it("repo を宣言していないのに clone に remote がある workspace は quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  const undeclared = { ...workspace, repo: undefined };

  t = await bootTidepool({ workspace: undeclared });
  await registerWork(t, "undeclared remote");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  expect(await quarantineReason(t, "sandbox")).toContain("declares no remote source of truth");
});

// ADR 0093 決定7: 仲介が token を出せない(不達 / user token 失効 / 5xx)ことは
// 「GitHub が遠い」の一形態であって、盤面側に新しい失敗の資源も語彙も作らない ——
// fetch できない workspace として、上と**同じ** quarantine に落ちる。
it("仲介が installation token を出せない workspace は、fetch 失敗と同じ quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  // 宣言も remote も正しく github.com を指す = token が要る形。仲介が断るので
  // fetch は撃たれる前に止まる(実ネットワークへは出ない)
  workspace.repo = "https://github.com/acme/sandbox.git";
  git(workspace.path, "remote", "set-url", "origin", workspace.repo);
  const broker = await startFakeBroker(() => ({
    status: 401,
    body: { error: "invalid_user_token" },
  }));
  brokers.push(broker);
  const dir = await tempDir("tidepool-secrets-");
  const tokenFile = join(dir, "github-token");
  await writeFile(tokenFile, "gho_user\n");
  await chmod(tokenFile, 0o600);

  t = await bootTidepool({ workspace, githubAuth: new GitHubAuth(tokenFile, broker.url) });
  await registerWork(t, "needs a token for the remote");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  expect(await questionTitles(t)).toEqual([
    expect.stringContaining("workspace sandbox needs human attention"),
  ]);
  // 人間が読む理由に仲介の断り方が残る —— #423 が案内文(再ログインのコマンド)を
  // 足すまでの間、診断できる材料はこれである
  expect(await quarantineReason(t, "sandbox")).toContain("invalid_user_token");
});

// ADR 0093 決定7 の完了側: token の取得は `releaseWorkspace` の手前で await されるが、
// そこで投げると verb は着地済みなのに tree rule も slot の解放も走らない。失敗は
// fetch が落ちたのと同じ位置へ持ち越され、同じ quarantine に落ちる。
it("完了時の merge back で仲介が token を出せなくても、WIP は退避され workspace が quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  const localOrigin = workspace.repo!;
  // origin の綴りは github.com(= token が要る形)、実際の往復はローカルの bare へ —— 実ネットワークへは出ない
  workspace.repo = "https://github.com/acme/sandbox.git";
  git(workspace.path, "remote", "set-url", "origin", workspace.repo);
  await shimGit({ route: ["https://github.com/acme/sandbox.git", localOrigin] });
  // 1回目(pickup)は 4 分だけ有効な token を出す —— 5 分の余白を切っているので完了時の
  // ensure は取り直しに行き、2回目で仲介が断る
  let brokerDown = false;
  const broker = await startFakeBroker(() =>
    brokerDown
      ? { status: 401, body: { error: "invalid_user_token" } }
      : {
          status: 200,
          body: { token: "ghs_short", expires_at: new Date(Date.now() + 4 * 60_000).toISOString() },
        },
  );
  brokers.push(broker);
  const dir = await tempDir("tidepool-secrets-");
  const tokenFile = join(dir, "github-token");
  await writeFile(tokenFile, "gho_user\n");
  await chmod(tokenFile, 0o600);

  t = await bootTidepool({ workspace, githubAuth: new GitHubAuth(tokenFile, broker.url) });
  const task = await registerWork(t, "completes while the broker is down");
  await t.clock.advance(HOUR);
  // pickup は仲介への実 HTTP 往復を含むので、fake clock の1 tick 分の settle では
  // 足りない —— worker が立つまで待つ
  for (let i = 0; i < 200 && t.worker.started.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(t.worker.started).toHaveLength(1);
  commitWork(checkoutOf(t.db, task.id), "work.txt", "done\n");
  brokerDown = true;

  const result = await completeViaMcp(t, task.id);

  expect(result.isError).toBeFalsy();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  // 完了時レビューが未決着で門が閉じているので、着地は門で待ち失敗 question を重ねない(ADR 0241 決定3)
  expect(await questionTitles(t)).toEqual([expect.stringContaining("workspace sandbox needs human attention")]);
  expect(await quarantineReason(t, "sandbox")).toContain("invalid_user_token");
});
