import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
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

// ADR 0052 決定7: 「クリーンに戻す」には**休止位置**も含まれる。理由は盤面の正しさでは
// なく**人間の誤読**である —— 盤面はもう checkout の位置を読まないが、人間はホスト上で
// その checkout を覗く。最後に走ったタスクのブランチが居座った clone は、覗いた人間に
// 「今この workspace はこうなっている」と嘘をつく。
it("slot 解放で checkout が保護ブランチへ戻る", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "leaves work behind");
  await t.clock.advance(HOUR);
  writeFileSync(join(ws.path, "notes.txt"), "half-finished work\n");

  await complete(t, task.id);

  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  // 退避そのものは無傷 — WIP はタスクブランチに残っている
  expect(git(ws.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished work");
});

// remote 正本を宣言した workspace では、休止位置は「ローカルの保護ブランチ」ではなく
// 「リモートに追従したローカルの保護ブランチ」である。追従させずに戻すと、覗いた人間は
// merge 済みのはずの成果が無い main を見る。
it("remote 正本を宣言した workspace では、休止位置がリモートへ追従している", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  publish("merged.txt", "landed on the remote\n", "merge on the remote");

  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "runs while the remote moves");
  await t.clock.advance(HOUR);
  await complete(t, task.id);

  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(workspace.path, "rev-parse", "main")).toBe(
    git(workspace.path, "rev-parse", "refs/remotes/origin/main"),
  );
  expect(git(workspace.path, "show", "main:merged.txt")).toBe("landed on the remote");
});

// ff できない = 帯域外の手作業でローカルの保護ブランチが分岐している。盤面はそれを
// 黙って捨てない(`checkout -B` で上書きすれば人間の作業が消える)—— quarantine に
// 落として人間に見せる。
it("ローカルの保護ブランチが分岐していて ff できなければ quarantine に落ちる", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  // 帯域外の手作業: ホスト上でローカル main に直接コミットした
  writeFileSync(join(workspace.path, "by-hand.txt"), "committed on the host\n");
  git(workspace.path, "add", "-A");
  git(workspace.path, "commit", "-m", "out-of-band local work");
  // リモート側は別の道を進んだ
  publish("merged.txt", "landed on the remote\n", "merge on the remote");

  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "runs on a diverged clone");
  await t.clock.advance(HOUR);
  await complete(t, task.id);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  expect(question?.title).toContain("workspace sandbox needs human attention");
  // 人間の帯域外コミットは消えていない
  expect(git(workspace.path, "show", "main:by-hand.txt")).toBe("committed on the host");
});

// 分岐の**片側だけ**の姿。ローカルが先行しているだけならリモートへの ff は「もう最新」
// として通ってしまうが、休止位置としては嘘である —— そこに載っているのは push されて
// いないローカル専用のコミットで、リモートを見ている人間の理解と食い違う。決定7 が
// 求めているのは「ff コマンドが成功したこと」ではなく「リモートへ追従していること」
// なので、検査は位置の一致で行う(/code-review Spec 軸の指摘)。
it("ローカルの保護ブランチがリモートより先行しているだけでも quarantine に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  // 帯域外の手作業: ホスト上でローカル main に直接コミットしたが push していない。
  // リモートは動いていないので、ff は「もう最新」として黙って成功する
  writeFileSync(join(workspace.path, "by-hand.txt"), "committed on the host\n");
  git(workspace.path, "add", "-A");
  git(workspace.path, "commit", "-m", "out-of-band local work, never pushed");

  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "runs on a clone that is ahead");
  await t.clock.advance(HOUR);
  await complete(t, task.id);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  expect(question?.title).toContain("workspace sandbox needs human attention");
  expect(git(workspace.path, "show", "main:by-hand.txt")).toBe("committed on the host");
});
