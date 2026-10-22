import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { completeTask } from "../src/tasks.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import { awaitWindow, FakeGitHubClient } from "./fakes.js";
import {
  api,
  bootTidepool,
  commitWork,
  completeViaMcp,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  queueWork,
  registerWork,
  settleReviews,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** ADR 0241 決定5 / ADR 0240 決定3: 着地は入口が撃たず、pickup の契機が突く収束が撃つ。ここで述べるのはつなぎ方だけ ——
 *  どの根に何が撃たれるかは tests/landing.test.ts(domain 層)が述べる(ADR 0107)。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const started = () => t.worker.started.map((task) => task.id);

/** PR の作成を窓で止める fake。収束が走っている間を外から見るために使う。 */
function heldGitHub() {
  const github = new FakeGitHubClient();
  const window = awaitWindow();
  const creating: string[] = [];
  const create = github.createPullRequest.bind(github);
  github.createPullRequest = async (input) => {
    creating.push(input.branch);
    await window.hold();
    return create(input);
  };
  return { github, window, creating };
}

/** 契機を撃たずに、タスクブランチに内容を持つ完了した根を盤面に置く。 */
function silentlyCompletedRoot(board: Tidepool, workspace: WorkspaceConfig) {
  const root = queueWork(board, "landed by the convergence");
  git(workspace.path, "checkout", "-b", `task/${root.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  completeTask(board.db, root, FULL_HANDOFF, "fake-worker", board.clock.now(), "worker");
  settleReviews(board.db, board.clock.now());
  return root;
}

it("後始末の途中で落ちた盤面は、再起動で後始末を完走し、その後の起動の収束で着地してから最初の pickup を判定する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("restart-converge");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "one");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "deliverable.txt", "the real work\n");
  t.containers.hold(task.id);
  await completeViaMcp(t, task.id);
  settleReviews(t.db, t.clock.now());
  const next = await registerWork(t, "two");
  await t.stopServer();

  const { github, window, creating } = heldGitHub();
  t = await bootTidepool({ dir: t.dir, workspace, github });
  await window.entered;
  await settle();

  // 後始末の復旧(merge back と休止位置)が済んでから、収束が根の PR を開いている。最初の pickup はまだ判定されない
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(creating).toEqual([`task/${task.id}`]);
  expect(started()).toEqual([]);

  window.open();
  await settle();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(1);
  expect(started()).toEqual([next.id]);
});

// #1766: 後始末が印を消した後、着地の前に落ちた盤面
it("後始末が印を消した後、着地の前に落ちた盤面は、再起動の収束で着地する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("restart-after-teardown");
  t = await bootTidepool({ workspace });
  const root = silentlyCompletedRoot(t, workspace);
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace });

  expect(t.github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}`)).json.pr_number).toBe(1);
});

it.each([
  ["毎時のティック", () => t.clock.advance(HOUR)],
  ["人間の run now", (next: string) => api(t.baseUrl, "POST", `/api/tasks/${next}/move`, { after: null })],
] as const)("%s は収束を突き、pickup は走っている収束が終わってから判定する", async (_, trigger) => {
  const { workspace } = await makeRemoteBackedWorkspace("trigger-converge");
  const { github, window, creating } = heldGitHub();
  t = await bootTidepool({ workspace, github });
  const root = silentlyCompletedRoot(t, workspace);
  const next = queueWork(t, "next");

  const fired = trigger(next.id);
  await window.entered;
  await settle();
  expect(creating).toEqual([`task/${root.id}`]);
  expect(started()).toEqual([]);

  window.open();
  await fired;
  await settle();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}`)).json.pr_number).toBe(1);
  expect(started()).toEqual([next.id]);
});

// CONTEXT.md「収束」: 同じ checkout で pickup の fetch・checkout と着地の push が重ならない —— 逆向きも同じ
it("poll が走っている間に届いた契機の収束は、その poll が終わってから走る", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("converge-after-poll");
  const poll = awaitWindow();
  let holdPoll = false;
  t = await bootTidepool({
    workspace,
    registryReachability: async () => {
      if (holdPoll) await poll.hold();
      return { available: true };
    },
  });
  const next = queueWork(t, "next");
  holdPoll = true;
  const tick = t.clock.advance(HOUR);
  await poll.entered;

  const root = silentlyCompletedRoot(t, workspace);
  await registerWork(t, "registered while the poll runs");
  await settle();
  expect(t.github.requests).toEqual([]);

  poll.open();
  await tick;
  await settle();
  expect(started()).toEqual([next.id]);
  expect(t.github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`]);
});

// issue #1851: `stop()` の resolve は「盤面がもう何も書かない」—— 走っている収束の回を待ってから DB を閉じる
it("収束の回が根の処理中に呼んだ stop は、その回が終わるまで resolve せず、回の記録は DB に残る", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("stop-awaits-convergence");
  const { github, window } = heldGitHub();
  t = await bootTidepool({ workspace, github });
  const root = silentlyCompletedRoot(t, workspace);
  const errors = vi.spyOn(console, "error");
  const fired = t.clock.advance(HOUR);
  await window.entered;

  let stopped = false;
  const stopping = t.stopServer().then(() => {
    stopped = true;
  });
  await settle();
  expect(stopped).toBe(false);

  window.open();
  await stopping;
  await fired;
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    expect(db.prepare("SELECT pr_number FROM tasks WHERE id = ?").get(root.id)).toEqual({ pr_number: 1 });
  } finally {
    db.close();
  }
  expect(errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).not.toContain(
    "database connection is not open",
  );
});

it("収束の回が走っていないときの stop は待たずに resolve する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("stop-without-convergence");
  t = await bootTidepool({ workspace });
  await t.stopServer();
});
