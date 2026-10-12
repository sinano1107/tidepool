import { afterEach, expect, it, vi } from "vitest";
import { completeTask, getTask, listBoard } from "../src/tasks.js";
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

/** 盤面の完了時レビューを、着地の門だけを開けるために DB で決着させる。 */
function settleReviews(board: Tidepool): void {
  for (const review of listBoard(board.db).filter((task) => task.type === "review" && task.status === "todo")) {
    completeTask(board.db, getTask(board.db, review.id)!, FULL_HANDOFF, "shako", board.clock.now(), "worker");
  }
}

/** 契機を撃たずに、タスクブランチに内容を持つ完了した根を盤面に置く。 */
function silentlyCompletedRoot(board: Tidepool, workspace: WorkspaceConfig) {
  const root = queueWork(board, "landed by the convergence");
  git(workspace.path, "checkout", "-b", `task/${root.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  completeTask(board.db, root, FULL_HANDOFF, "fake-worker", board.clock.now(), "worker");
  settleReviews(board);
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
  settleReviews(t);
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
