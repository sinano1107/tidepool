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

/** ADR 0067 が撃つのは `repo` の**宣言**に対してであって clone の origin ではない
 *  (ADR 0052 決定3: 宣言は clone を覗いた推測ではない)。テストはこの2つを分けて
 *  持てる —— 宣言は github.com を指し、origin は届く / 届かないを切り替えられる。 */
const DECLARED = "https://github.com/sinano1107/tidepool";

it("fetch が落ちても、その repo 宛ての招待を受諾して撃ち直せば通る —— quarantine は立たない(ADR 0067 決定2)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  const reachable = workspace.repo as string;
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/sandbox-remote");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  t.github.scriptInvitation(111, "sinano1107/tidepool");
  // 受諾された瞬間に到達可能になる = 本物で collaborator になったときに起きること
  t.github.scriptOnAccept(() => {
    git(workspace.path, "remote", "set-url", "origin", reachable);
  });
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.github.acceptedInvitations).toEqual([111]);
  expect(await quarantineReason(t)).toBeUndefined();
  expect(t.worker.started).toHaveLength(1);
});

it("受諾しても WRITE 未満なら、元の原因に案内を連ねて quarantine に落ちる(実測4: read 招待)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/sandbox-remote");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  t.github.scriptLogin("tidepool-bot");
  t.github.scriptInvitation(111, "sinano1107/tidepool", "read");
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.github.acceptedInvitations).toEqual([111]);
  expect(t.worker.started).toEqual([]);
  const reason = await quarantineReason(t);
  // 元の原因(生の git のエラー)は置き換えられていない
  expect(reason).toContain("/nonexistent/sandbox-remote");
  expect(reason).toContain("only has READ");
  expect(reason).toContain(
    "gh api -X PUT repos/sinano1107/tidepool/collaborators/tidepool-bot -f permission=push",
  );
  // ADR 0067 決定7: 受諾した事実は、いま立った確認 question のイベントとして残る
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(
    events.some((e: any) => e.payload.cause?.includes("accepted a pending repository invitation")),
  ).toBe(true);
});

it("招待が1枚も無ければ受諾は起きず、案内だけを添えて quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/sandbox-remote");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  t.github.scriptLogin("tidepool-bot");
  await registerWork(t, "needs the remote");
  await t.clock.advance(HOUR);

  expect(t.github.acceptedInvitations).toEqual([]);
  const reason = await quarantineReason(t);
  expect(reason).toContain("does not exist or is not visible to tidepool-bot");
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
it("正常に通る pickup では repo アクセスの gh 呼び出しが1つも増えない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");

  t = await bootTidepool({ workspace: { ...workspace, repo: DECLARED } });
  await registerWork(t, "reachable");
  await t.clock.advance(HOUR);

  expect(t.worker.started).toHaveLength(1);
  expect(t.github.repoAccessCalls).toBe(0);
});
