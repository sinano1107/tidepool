import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
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

// ADR 0052 が registry について決めた線を一般 workspace へ広げる(issue #211):
// ホスト上の checkout は正本ではなくキャッシュなので、タスクブランチの fork 元は
// **リモート側の**保護ブランチである。これが成立しないと、タスク1の PR が merge
// された後のタスク2は「タスク1の成果が見えない地点」から始まる。
it("remote 正本を宣言した workspace のタスクブランチは、リモート側の保護ブランチから切られる", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  // タスク1の PR がリモートで merge された、を模す
  publish("merged.txt", "task 1's landed work\n", "merge task 1");
  // remote-tracking ref だけを進める —— ローカルの main は古いまま置く。fork 元が
  // ローカルなら次のタスクはこの成果を見られない、という差がここで作られる
  git(workspace.path, "fetch", "--quiet", "origin", "main");
  expect(() => git(workspace.path, "show", "main:merged.txt")).toThrow();

  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "task 2 builds on task 1");
  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  // タスク2は merge 済みの成果が載った地点から始まっている
  expect(git(workspace.path, "show", "HEAD:merged.txt")).toBe("task 1's landed work");
});

// ADR 0052 決定2 の3つ目の refresh 点を workspace 側にも置く(issue #211 やること4):
// 上のテストは「fork 元がリモート側の ref である」ことだけを測るので、その ref を
// 誰かが進めていなければ意味が無い。ここが測るのは**盤面が pickup の直前に自分で
// fetch する**ことである —— 手で fetch しない限り、リモートの merge は
// remote-tracking ref に届かない。
it("remote 正本を宣言した workspace は pickup の直前に fetch される", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  publish("merged.txt", "task 1's landed work\n", "merge task 1");
  // 手で fetch しない: clone の origin/main はまだ merge を知らない
  const staleRemoteRef = git(workspace.path, "rev-parse", "refs/remotes/origin/main");

  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "task 2 builds on task 1");
  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(git(workspace.path, "rev-parse", "refs/remotes/origin/main")).not.toBe(staleRemoteRef);
  expect(git(workspace.path, "show", "HEAD:merged.txt")).toBe("task 1's landed work");
});
