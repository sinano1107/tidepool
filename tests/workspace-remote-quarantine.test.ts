import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
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
