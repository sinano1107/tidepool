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

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function quarantineReason(board: Tidepool): Promise<string | undefined> {
  const list = (await api(board.baseUrl, "GET", "/api/tasks")).json;
  return list.find((x: any) => x.type === "question")?.purpose;
}

/** 修復経路が撃つのは `repo` の**宣言**に対してであって clone の origin ではない
 *  (ADR 0052 決定3: 宣言は clone を覗いた推測ではない)。テストはこの2つを分けて
 *  持てる —— 宣言は github.com を指し、origin は届く / 届かないを切り替えられる。 */
const DECLARED = "https://github.com/sinano1107/tidepool";

it("仲介が token を出せなければ、元の原因に install の案内を連ねて quarantine に落ちる(ADR 0093 決定8)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/sandbox-remote");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  t.github.scriptUnreachable("sinano1107/tidepool");
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  const reason = await quarantineReason(t);
  // 元の原因(生の git のエラー)は案内に置き換えられていない
  expect(reason).toContain("/nonexistent/sandbox-remote");
  expect(reason).toContain("sinano1107/tidepool");
  expect(reason).toContain("/installations/new");
  expect(reason).toContain("HTTP 404: repo_unreachable");
});

it("token は出せるのに fetch が落ちるなら、案内は足さず生の原因だけで quarantine する —— 盤面が撃ち直す手はもう無い", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/sandbox-remote");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  const reason = await quarantineReason(t);
  expect(reason).toContain("/nonexistent/sandbox-remote");
  expect(reason).not.toContain("/installations/new");
});

it("非 GitHub の remote では probe が発火せず、今日どおりの quarantine のままである", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/sandbox-remote");

  t = await bootTidepool({ workspace });
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.github.repoAccessCalls).toBe(0);
  expect(await quarantineReason(t)).toContain("/nonexistent/sandbox-remote");
});

// この issue の不変条件そのもの: 正常時のネットワーク呼び出しは1つも増えない。
// 数でしか確かめられないので、fake の呼び出し回数で受ける。
it("正常に通る pickup では repo アクセスの probe が1つも撃たれない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  await registerWork(t, "reachable");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toHaveLength(1);
  expect(t.github.repoAccessCalls).toBe(0);
});
