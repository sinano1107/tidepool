import { afterEach, expect, it, vi } from "vitest";
import {
  bootTidepool,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  registerWork,
  servedQuarantineQuestion,
  shimGit,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

async function quarantineReason(board: Tidepool): Promise<string | undefined> {
  return (await servedQuarantineQuestion(board, "workspace", "sandbox"))?.purpose;
}

/** ADR 0378 決定1: the checkout and declaration agree, and the transport can fail independently. */
const DECLARED = "https://github.com/sinano1107/tidepool.git";
const UNREACHABLE = "/nonexistent/sandbox-remote";

it("仲介が token を出せなければ、元の原因に install の案内を連ねて quarantine に落ちる(ADR 0093 決定8)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  git(workspace.path, "remote", "set-url", "origin", DECLARED);
  await shimGit({ route: [DECLARED, UNREACHABLE] });

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
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  git(workspace.path, "remote", "set-url", "origin", DECLARED);
  await shimGit({ route: [DECLARED, UNREACHABLE] });

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  const reason = await quarantineReason(t);
  expect(reason).toContain("/nonexistent/sandbox-remote");
  expect(reason).not.toContain("/installations/new");
});

it("非 GitHub の remote では probe が発火せず、今日どおりの quarantine のままである", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  git(workspace.path, "remote", "set-url", "origin", UNREACHABLE);

  t = await bootTidepool({ workspace: { ...workspace, repo: UNREACHABLE } });
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.github.repoAccessCalls).toBe(0);
  expect(await quarantineReason(t)).toContain("/nonexistent/sandbox-remote");
});

// この issue の不変条件そのもの: 正常時のネットワーク呼び出しは1つも増えない。
// 数でしか確かめられないので、fake の呼び出し回数で受ける。
it("正常に通る pickup では repo アクセスの probe が1つも撃たれない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  git(workspace.path, "remote", "set-url", "origin", DECLARED);
  await shimGit({ route: [DECLARED, workspace.repo!] });

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  await registerWork(t, "reachable");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toHaveLength(1);
  expect(t.github.repoAccessCalls).toBe(0);
});
