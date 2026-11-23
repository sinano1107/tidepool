import { expect, it, vi } from "vitest";
import { createLanding } from "../src/landing.js";
import { loadRegistry } from "../src/registry.js";
import { getTask, listBoard } from "../src/tasks.js";
import { releaseWorkspace, resolveExecutionWorkspace } from "../src/workspace.js";
import { FakeGitHubClient } from "./fakes.js";
import { checkoutTaskBranch, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, makeLandingWorkspace, prepareAtPickup } from "./harness.js";
import { convergeOn, finish, landingWork, mergeQuestions, openBoard, profile, pushPrHead, recordPrOpenedOutsideConvergence } from "./landing-fixture.js";
import { makeRegistry, setWorkspaceEntry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定4: `branch` は記録しない。PR の base と宣言の食い違いは ADR 0395 決定4 の `retargeted` の経路で merge question に回る
// (spec #3595 の振る舞い 10、#3584)。宣言の `branch` は registry の workspaces.yaml を書き換えて変える —— 設定の扉は `branch` を受けない。

/** registry に宣言した `reef` で、PR #1 を開いて無人 merge キューにいる根(`opened: false` なら PR をまだ開いていない done の根)。
 *  origin には `release` ブランチもある。 */
async function queuedRoot({ opened = true } = {}) {
  const { workspace: fixture } = await makeLandingWorkspace("reef");
  const { db, clock } = await openBoard();
  const clone = await tempDir("tidepool-reef-release-");
  git(clone, "clone", fixture.repo!, ".");
  git(clone, "push", "origin", "main:release");
  const registryDir = await makeRegistry({
    "workspaces.yaml": `reef:\n  path: ${fixture.path}\n  repo: ${fixture.repo}\n  head_repo: ${fixture.head_repo}\n`,
  });
  const workspacesBaseDir = await tempDir("tidepool-ws-base-");
  const resolve = (name: string | null) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), name ?? "reef", null, workspacesBaseDir);
  const github = new FakeGitHubClient();
  const workspace = resolve("reef");
  const root = landingWork(db, clock, "reef");
  checkoutTaskBranch(db, workspace, root.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  if (opened) {
    const head = pushPrHead(github, workspace, root.id, 1);
    recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "auto_if_ci_green" }, head, workspace });
  }
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github, resolveAuthority: () => profile("auto_if_ci_green") });
  const declareBranch = (branch: string) => setWorkspaceEntry(registryDir, "reef", "branch", branch);
  // #3613: 収束は新しい保護ブランチを fetch しないので、その写しを手元に持ってくる pickup を先に通す
  const pickUpAnother = async () => {
    const other = landingWork(db, clock, "reef");
    releaseWorkspace(db, await prepareAtPickup(db, resolve("reef"), other), getTask(db, other.id)!, clock.now());
  };
  return { db, clock, github, landing, workspace, root: getTask(db, root.id)!, declareBranch, pickUpAnother };
}

it("宣言の branch が変わらなければ、キューの PR は tick で merge される(対照)", async () => {
  const { db, github, landing, workspace } = await queuedRoot();

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
  expect(mergeQuestions(db)).toEqual([]);
});

it("開いた PR を持つ根を残して宣言の branch を変えると、tick は merge せず retargeted の merge question を立てる", async () => {
  const { db, github, landing, declareBranch } = await queuedRoot();
  declareBranch("release");

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toMatchObject([
    { pr: 1, purpose: expect.stringContaining('This PR targets "main". The workspace\'s protected branch is "release".') },
  ]);
  // 同じ観測に扱いを2つ作らない(ADR 0399 決定4): 開いている question は merge question だけ
  expect(listBoard(db).filter((q) => q.status === "todo").map((q) => q.question_pending_merge_pr)).toEqual([1]);
});

it("GitHub で保護ブランチを改名して PR の base が付け替わり、宣言も新しい名前に直れば、tick は止まらず merge する", async () => {
  const { db, github, landing, workspace, declareBranch } = await queuedRoot();
  git(workspace.repo!, "branch", "-m", "main", "trunk");
  github.scriptPullRequestBase(1, "trunk");
  declareBranch("trunk");

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
  expect(mergeQuestions(db)).toEqual([]);
});

it("まだ PR の無い根は、宣言の branch を変えた後、新しい宣言の branch 宛てに PR を作る", async () => {
  const { github, landing, root, declareBranch, pickUpAnother } = await queuedRoot({ opened: false });
  declareBranch("release");
  await pickUpAnother();

  expect(await convergeOn(landing, root.id)).toMatchObject({ kind: "landed", form: "pull_request_opened", prNumber: 1 });

  expect(github.requests).toMatchObject([{ branch: `task/${root.id}`, base: "release" }]);
});

// 作成の後・記録の前に落ちた盤面の PR は、収束が head で探して拾い直す(ADR 0241 決定4)。拾った PR の base も PR を開く所の読みで比べる
it("head で探して拾い直した PR の base が古い branch なら、retargeted の merge question を立て、作らず merge もしない", async () => {
  const { db, github, landing, root, workspace, declareBranch, pickUpAnother } = await queuedRoot({ opened: false });
  pushPrHead(github, workspace, root.id, 1);
  declareBranch("release");
  await pickUpAnother();

  expect(await convergeOn(landing, root.id)).toMatchObject({ kind: "landed", form: "pull_request_opened", prNumber: 1 });
  await landing.tick("auto_merge");

  expect(github.requests).toEqual([]);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toMatchObject([
    { pr: 1, purpose: expect.stringContaining('This PR targets "main". The workspace\'s protected branch is "release".') },
  ]);
});

it("head で探して拾い直した PR の base が読めなければ、既存の読めない扱いで merge question を立てる", async () => {
  const { db, github, landing, root, workspace } = await queuedRoot({ opened: false });
  pushPrHead(github, workspace, root.id, 1);
  github.scriptPullRequestBase(1, "gone");

  expect(await convergeOn(landing, root.id)).toMatchObject({ kind: "landed", form: "pull_request_opened", prNumber: 1 });
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toMatchObject([
    { pr: 1, purpose: expect.stringContaining("The board could not compare this PR head with the protected branch") },
  ]);
});
