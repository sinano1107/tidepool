import { expect, it, vi } from "vitest";
import { createLanding, rootPrOutcome, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { loadRegistry } from "../src/registry.js";
import { countUnsettledTasksReferencing, registerTask, type Task } from "../src/tasks.js";
import {
  announceHeadRepo,
  assertRememberedHeadRepo,
  buildWorkspaceResolver,
  declaredRepoDisagreement,
  resolveExecutionWorkspace,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { createWorkspace, deleteWorkspace } from "../src/workspace-create.js";
import { awaitWindow, FakeGitHubClient } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeLandingWorkspace, makeRemoteBackedWorkspace, makeWorkspace, prepareAtPickup } from "./harness.js";
import {
  commitThroughTaskCheckout,
  finish,
  landingWork,
  openBoard,
  openLocalMergeQuestions,
  promotionFailures,
  pushPrHead,
  recordPrOpenedOutsideConvergence,
} from "./landing-fixture.js";
import { makeRegistry, setWorkspaceEntry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定1・3・5: task は pickup が宣言の repo に届いたときにその repo を記録し、根を運ぶ・PR を読む前に今の宣言と比べ、食い違えば
// その根だけを、記録と今の宣言を名指す PR 昇格失敗の question で止める(spec #3595 の振る舞い 1)。

/** 旧い repo で拾われ PR #1 を開いた done の根を残して、`reef` を削除の扉 → 登録の扉で別の repo の checkout に登録し直し、盤面の経路で
 *  根に修理を載せた盤面 —— 根は運ぶ内容を持ち、PR を読みに行く所まで進む。`external` の根は削除の扉を止めない(ADR 0370 決定1)。 */
async function reRegisteredWithRepairedRoot() {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const { workspace: moved } = await makeLandingWorkspace("reef-new");
  const registryDir = await makeRegistry({ "workspaces.yaml": `reef:\n  path: ${old.path}\n  repo: ${old.repo}\n` });
  const admin = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-") };
  const resolve = (name: string | null) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), name ?? "reef", null, admin.workspacesBaseDir);
  const github = new FakeGitHubClient();

  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "external" } });

  await reRegister(db, admin, resolve, moved, registryDir);
  await commitThroughTaskCheckout(db, clock, resolve("reef"), done, "repair.txt", "repair\n");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github });
  return { db, github, landing, old, moved, root: done };
}

/** 削除の扉 → 登録の扉(register)で `reef` を `moved` の checkout に登録し直す —— 扉は checkout の origin から `repo:` を書く。出元 repo は
 *  設定の扉が書くもの(覚えた値の予告・宣言・確かめ)を扉の順で置く(landing-reregistered.test.ts と同じ)。 */
async function reRegister(
  db: Awaited<ReturnType<typeof openBoard>>["db"],
  admin: { registry: { dir: string; mode: "purely-local" }; workspacesBaseDir: string },
  resolve: (name: string | null) => WorkspaceConfig,
  moved: WorkspaceConfig,
  registryDir: string,
  /** 削除の後・登録の前の人間の手(checkout の origin を向け替えるなど)。 */
  between = () => {},
) {
  await deleteWorkspace({ name: "reef", confirm: true }, {
    ...admin,
    db,
    unsettledTaskCount: countUnsettledTasksReferencing(db, "workspace", "reef"),
    awaitingLandingTaskIds: taskIdsAwaitingLandingInWorkspace(db, buildWorkspaceResolver(resolve, undefined), "reef"),
  });
  between();
  await createWorkspace({ name: "reef", mode: "register", path: moved.path, confirm: true }, admin);
  expect(resolve("reef").repo).toBe(moved.repo);
  if (moved.head_repo !== undefined) giveHeadRepo(db, registryDir, resolve, moved.head_repo);
}

/** 設定の扉が出元 repo を足すときに書くもの —— 覚えた値の予告・registry の宣言・覚えた値の確かめ —— を扉の順で置く。 */
function giveHeadRepo(db: Awaited<ReturnType<typeof openBoard>>["db"], registryDir: string, resolve: (name: string | null) => WorkspaceConfig, headRepo: string) {
  announceHeadRepo(db, resolve("reef"), headRepo);
  setWorkspaceEntry(registryDir, "reef", "head_repo", headRepo);
  assertRememberedHeadRepo(db, resolve("reef"), new Date());
}

/** 根だけが、記録の repo と今の宣言を名指す PR 昇格失敗の question で止まり、workspace の Quarantine は立たない(ADR 0399 決定5)。 */
const stoppedNamingBoth = (db: Awaited<ReturnType<typeof openBoard>>["db"], root: Task, recorded: string, current: string) => {
  const [question, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(question!.purpose).toContain(recorded);
  expect(question!.purpose).toContain(current);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
};

it.each([
  ["merged", (github: FakeGitHubClient, repo: string) => github.scriptMergedOutside(1, repo)],
  ["closed", (github: FakeGitHubClient, repo: string) => github.scriptClosedOutside(1, repo)],
  ["open", (github: FakeGitHubClient, repo: string) => github.scriptPullRequestOnBranch("task/other", 1, undefined, undefined, repo)],
  ["absent", () => {}],
] as const)("別の repo で登録し直した名前の、PR を開いた根は、新しい repo の #1 が %s でも読まずに、記録と今の宣言を名指して止まる", async (_, script) => {
  const { db, github, landing, old, moved, root } = await reRegisteredWithRepairedRoot();
  script(github, moved.repo!);

  await landing.converge();

  expect([github.stateChecks, github.pushes, github.requests]).toEqual([[], [], []]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
  stoppedNamingBoth(db, root, old.repo!, moved.repo!);
});

/** 旧い repo で拾われ PR #1 を開いた根に修理が載った盤面で、`hold` に渡した GitHub の呼び出しの await の間に、同じ checkout の origin を
 *  別の repo へ向けて扉で登録し直す(扉は origin から `repo:` を書く —— #3500 の実測の形)。 */
async function reRegisteredDuringAwait(hold: (github: FakeGitHubClient, wait: () => Promise<void>) => void) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeLandingWorkspace("reef-old");
  const { workspace: other } = await makeRemoteBackedWorkspace("reef-other");
  const registryDir = await makeRegistry({ "workspaces.yaml": `reef:\n  path: ${old.path}\n  repo: ${old.repo}\n` });
  const admin = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-") };
  const resolve = (name: string | null) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), name ?? "reef", null, admin.workspacesBaseDir);
  giveHeadRepo(db, registryDir, resolve, old.head_repo!);
  const github = new FakeGitHubClient();
  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  const head = pushPrHead(github, resolve("reef"), done.id, 1);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "external" }, head });
  await commitThroughTaskCheckout(db, clock, resolve("reef"), done, "repair.txt", "repair\n");
  const window = awaitWindow();
  hold(github, window.hold);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github });

  const converging = landing.converge();
  await window.entered;
  await reRegister(db, admin, resolve, { ...old, repo: other.repo }, registryDir, () => git(old.path, "remote", "set-url", "origin", other.repo!));
  window.open();
  await converging;
  return { db, github, old, other, root: done, head };
}

it("PR の状態を読む前の await(token の取得)の間に扉で別の repo へ登録し直しても、盤面は新しい repo の PR を読まず、記録と今の宣言を名指して止まる", async () => {
  const { db, github, old, other, root } = await reRegisteredDuringAwait((github, wait) => {
    const getPullRequestState = github.getPullRequestState.bind(github);
    github.getPullRequestState = async (ref) => {
      await wait();
      return getPullRequestState(ref);
    };
  });

  expect([github.stateChecks, github.pushes]).toEqual([[], []]);
  stoppedNamingBoth(db, root, old.repo!, other.repo!);
});

// push の門は待った後に名前の場所の ref を比べ直し、その最初の撮りの開く前の項が古い宣言と向け替えた origin の食い違いで先に止まる ——
// 比較はこの経路では後ろの守りで、釘は「push しない」だけ
it("push の準備の await の間に扉で別の repo へ登録し直しても、盤面はその根を push しない", async () => {
  const { github, old, root, head } = await reRegisteredDuringAwait((github, wait) => {
    const preparePush = github.preparePush.bind(github);
    github.preparePush = async (input) => {
      const push = await preparePush(input);
      await wait();
      return push;
    };
  });

  expect([github.pushes, github.requests]).toEqual([[], []]);
  expect(git(old.head_repo!, "rev-parse", `task/${root.id}`)).toBe(head);
});

it("repo を記録した根の名前を、扉で purely-local の checkout に登録し直すと、根はローカル着地の question を立てずに記録と今の宣言を名指して止まる", async () => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const local = await makeWorkspace("reef-local");
  const registryDir = await makeRegistry({ "workspaces.yaml": `reef:\n  path: ${old.path}\n  repo: ${old.repo}\n` });
  const admin = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-") };
  const resolve = (name: string | null) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), name ?? "reef", null, admin.workspacesBaseDir);
  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "external" } });
  await reRegister(db, admin, resolve, local, registryDir);
  await commitThroughTaskCheckout(db, clock, resolve("reef"), done, "repair.txt", "repair\n");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github: new FakeGitHubClient() });

  await landing.converge();

  expect(openLocalMergeQuestions(db, done.id)).toEqual([]);
  stoppedNamingBoth(db, done, old.repo!, "purely-local");
});

it("記録は pickup が宣言の repo に届いた後に書かれ、子の pickup が固定する祖先にも書かれる —— 拾われる前の task は記録が無く食い違う", async () => {
  const { db, clock } = await openBoard();
  const { workspace } = await makeRemoteBackedWorkspace("reef");
  const parent = landingWork(db, clock, "reef");
  const child = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, clock.now(), ...HUMAN_WEBUI);
  expect(declaredRepoDisagreement(db, child.id, workspace)).toMatch(/no record/);

  await prepareAtPickup(db, workspace, child);

  expect([declaredRepoDisagreement(db, child.id, workspace), declaredRepoDisagreement(db, parent.id, workspace)]).toEqual([undefined, undefined]);
});
