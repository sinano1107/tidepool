import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { type FakeBroker, startFakeBroker } from "./fake-broker.js";
import {
  api,
  bootTidepool,
  commitWork,
  completeViaMcp,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  registerWork,
  type Tidepool,
} from "./harness.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

let t: Tidepool;
const dirs: string[] = [];
const brokers: FakeBroker[] = [];
afterEach(async () => {
  await t?.stop();
  for (const broker of brokers.splice(0)) await broker.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function questionTitles(board: Tidepool): Promise<string[]> {
  const list = (await api(board.baseUrl, "GET", "/api/tasks")).json;
  return list.filter((x: any) => x.type === "question").map((x: any) => x.title);
}

async function quarantineReason(board: Tidepool): Promise<string | undefined> {
  const list = (await api(board.baseUrl, "GET", "/api/tasks")).json;
  return list.find((x: any) => x.type === "question")?.purpose;
}

// ADR 0052 決定5: 一般 workspace の fetch 失敗は**既存の workspace quarantine に乗る**
// —— その workspace のタスクだけが止まればよく、資源単位の原則がそのまま適用できる。
// 狭められないのは registry の側だけである(あらゆる spawn の入力だから)。
it("remote 正本を宣言した workspace の refresh が失敗すると、その workspace が quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  // remote は宣言どおり張られているが届かない = credential の失効やホスティング障害
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/workspace-remote");

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
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  // 宣言だけが残り、実態が消えた状態(`git remote remove` は tracking ref も消す)
  git(workspace.path, "remote", "remove", "origin");

  t = await bootTidepool({ workspace });
  await registerWork(t, "declared remote is gone");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  // git の生のエラーではなく、読める理由が人間に届く
  expect(await quarantineReason(t)).toContain("declares a remote source of truth");
});

// 逆向きのずれ。こちらは黙って通ってしまうほうが危ない —— fork 元がローカルの
// 保護ブランチのままなので、merge 済みの成果が見えない地点からタスクが始まり続け、
// 症状は「PR が毎回コンフリクトする」という遠い場所に出る。
it("repo を宣言していないのに clone に remote がある workspace は quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  const undeclared = { ...workspace, repo: undefined };

  t = await bootTidepool({ workspace: undeclared });
  await registerWork(t, "undeclared remote");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  expect(await quarantineReason(t)).toContain("declares no remote source of truth");
});

// issue #211 やること6: registry clone は「registry の正本」(合成 root の宣言)と
// 「workspace」(`workspaces.yaml` の repo)の**両方**の役を持つので、宣言も2つ持つ。
// 1本化はできない —— workspace エントリを読むには先に registry を読む必要があり循環
// する —— ので、pickup 時に突き合わせる。
//
// この2件は上の「宣言と実態」の検査では捕まらない。どちらも workspace の宣言と clone の
// 実態は一致しており、食い違っているのは registry 側の宣言だけである。
it("registry clone の2つの宣言が食い違えば quarantine に落ちる — registry は remote-backed、workspace は purely-local", async () => {
  // remote を持たない clone を registry として remote-backed と宣言した盤面。workspace
  // としての宣言(repo 無し)は実態と一致しているので、捕まえられるのはこの突き合わせだけ
  const registryDir = await makeRegistry();
  dirs.push(registryDir);

  t = await bootTidepool({
    workspace: { name: "tidepool", path: registryDir },
    registry: { dir: registryDir, mode: "remote-backed" },
  });
  await registerWork(t, "registry edit");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  expect(await quarantineReason(t)).toContain("two declarations disagree");
});

it("registry clone の2つの宣言が食い違えば quarantine に落ちる — registry は purely-local、workspace は remote-backed", async () => {
  const { registryDir } = await makeRemoteBackedRegistry();
  dirs.push(registryDir);

  t = await bootTidepool({
    workspace: { name: "tidepool", path: registryDir, repo: "https://example.invalid/registry.git" },
    registry: { dir: registryDir, mode: "purely-local" },
  });
  await registerWork(t, "registry edit");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  expect(await quarantineReason(t)).toContain("two declarations disagree");
});

// 突き合わせるのは registry clone だけ。別の checkout の workspace は registry の役を
// 持たないので、盤面の registryMode と一致する義理が無い(registry が purely-local な
// 盤面に remote-backed な workspace が並ぶのは正当な構成である)。
it("registry clone でない workspace は盤面の registryMode と突き合わせない", async () => {
  const registryDir = await makeRegistry();
  dirs.push(registryDir);
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");

  t = await bootTidepool({ workspace, registry: { dir: registryDir, mode: "purely-local" } });
  const task = await registerWork(t, "unrelated workspace");
  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(await questionTitles(t)).toEqual([]);
});

// ADR 0093 決定7: 仲介が token を出せない(不達 / user token 失効 / 5xx)ことは
// 「GitHub が遠い」の一形態であって、盤面側に新しい失敗の資源も語彙も作らない ——
// fetch できない workspace として、上と**同じ** quarantine に落ちる。
it("仲介が installation token を出せない workspace は、fetch 失敗と同じ quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  // 宣言も remote も正しく github.com を指す = token が要る形。仲介が断るので
  // fetch は撃たれる前に止まる(実ネットワークへは出ない)
  git(workspace.path, "remote", "set-url", "origin", "https://github.com/acme/sandbox.git");
  const broker = await startFakeBroker(() => ({
    status: 401,
    body: { error: "invalid_user_token" },
  }));
  brokers.push(broker);
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  dirs.push(dir);
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
  expect(await quarantineReason(t)).toContain("invalid_user_token");
});

// ADR 0093 決定7 の完了側: token の取得は `releaseWorkspace` の手前で await されるが、
// そこで投げると verb は着地済みなのに tree rule も slot の解放も走らない。失敗は
// fetch が落ちたのと同じ位置へ持ち越され、同じ quarantine に落ちる。
it("完了時の merge back で仲介が token を出せなくても、WIP は退避され workspace が quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  const localOrigin = workspace.repo!;
  // origin の綴りは github.com(= token が要る形)、実際の往復は insteadOf でローカルの
  // bare へ —— 実ネットワークへは出ない
  git(workspace.path, "remote", "set-url", "origin", "https://github.com/acme/sandbox.git");
  git(workspace.path, "config", `url.${localOrigin}.insteadOf`, "https://github.com/acme/sandbox.git");
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
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  dirs.push(dir);
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
  commitWork(workspace.path, "work.txt", "done\n");
  brokerDown = true;

  const result = await completeViaMcp(t, task.id);

  expect(result.isError).toBeFalsy();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(await questionTitles(t)).toEqual([
    expect.stringContaining("workspace sandbox needs human attention"),
  ]);
  expect(await quarantineReason(t)).toContain("invalid_user_token");
});
