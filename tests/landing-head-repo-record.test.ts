import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { DomainError } from "../src/domain-error.js";
import { GitHubAuth } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding, rootPrOutcome, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import type { MergeDial } from "../src/registry.js";
import { loadRegistry } from "../src/registry.js";
import { countUnsettledTasksReferencing, getTask, listBoard, recordPrOpened } from "../src/tasks.js";
import { buildWorkspaceResolver, resolveExecutionWorkspace, withDeclaredRepoCheck } from "../src/workspace.js";
import { createWorkspace, deleteWorkspace, HeadRepoTaskBranchesNotSentError, publishWorkspace, updateWorkspace } from "../src/workspace-create.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeGitHubClient } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, makeRemoteBackedWorkspace, makeWorkspace, shimGit } from "./harness.js";
import { boardEvents, commitThroughTaskCheckout, convergeOn, finish, landingWork, openBoard, profile, promotionFailures } from "./landing-fixture.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定1・3・5: 根は最初に `task/<id>` を出元 repo へ push して届いたときにその出元 repo を記録し、PR を扱う所で今の宣言の出元 repo と
// 比べる。出元 repo の足し替えは設定の扉(updateWorkspace)を通す —— 扉は GitHub の owner/name しか受けないので、盤面が組む網の行き先を
// shim で手元の bare へ回す(spec #3595 の振る舞い 8)。

const REPO = "https://github.com/acme/lagoon.git";

/** `lagoon`(宣言の repo は GitHub の acme/lagoon)に、done の根を1つ持つ盤面。`setHeadRepo` は設定の扉で出元 repo を足し替える。 */
async function lagoonWithDoneRoot(merge?: MergeDial) {
  const { db, clock } = await openBoard();
  const { workspace: checkout } = await makeRemoteBackedWorkspace("lagoon");
  const origin = checkout.repo!;
  git(checkout.path, "remote", "set-url", "origin", REPO);
  const registryDir = await makeRegistry({ "workspaces.yaml": `lagoon:\n  path: ${JSON.stringify(checkout.path)}\n  repo: ${REPO}\n` });
  git(registryDir, "branch", "-M", "main");
  const broker = await startFakeBroker((request) => issuedToken(`token-for-${request.repo}`));
  onTestFinished(() => broker.close());
  const tokenFile = join(await tempDir("tidepool-token-"), "token");
  await writeFile(tokenFile, "gho_test\n");
  await chmod(tokenFile, 0o600);
  const githubAuth = new GitHubAuth(tokenFile, broker.url);
  const github = new FakeGitHubClient();
  // the fake reads a PR's base only from a declared repo on disk; this one is GitHub's, which the shim routes to `origin`
  const read = github.getPullRequestState.bind(github);
  github.getPullRequestState = async (ref) => {
    const state = await read(ref);
    return state.base ? state : { ...state, base: { branch: "main", sha: git(origin, "rev-parse", "main") } };
  };
  const admin = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-") };
  const resolve = () => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), "lagoon", null, admin.workspacesBaseDir);
  await shimGit({ route: [REPO, origin] });
  const forks: Record<string, string> = {};
  /** `rejecting` の出元 repo は push を拒む(GitHub が拒む push の形)。扉の写しも拒まれるが、宣言は残る(issue #3563)。 */
  const setHeadRepo = async (fullName: string, { rejecting = false } = {}) => {
    if (!(fullName in forks)) {
      forks[fullName] = await tempDir("tidepool-fork-");
      git(forks[fullName], "clone", "--quiet", "--bare", origin, ".");
      if (rejecting) {
        const hook = join(forks[fullName], "hooks", "pre-receive");
        await writeFile(hook, "#!/bin/sh\necho denied >&2\nexit 1\n");
        await chmod(hook, 0o755);
      }
      await shimGit({ route: [`https://github.com/${fullName}.git`, forks[fullName]] });
      github.scriptRepositoryParent(fullName, "acme/lagoon");
    }
    await updateWorkspace({ name: "lagoon", head_repo: fullName, confirm: true }, { ...admin, db, github, githubAuth, clock }).catch((error: Error) => {
      if (!(rejecting && error instanceof HeadRepoTaskBranchesNotSentError)) throw error;
    });
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github, githubAuth, resolveAuthority: merge && (() => profile(merge)) });
  const work = landingWork(db, clock, "lagoon");
  await commitThroughTaskCheckout(db, clock, resolve(), work, "feature.txt", "ready\n");
  const root = finish(db, clock, work);
  const forkBranch = (fullName: string) => git(forks[fullName]!, "for-each-ref", "--format=%(objectname)", `refs/heads/task/${root.id}`);
  const answer = (option: "merge" | "hold") => {
    const question = listBoard(db).find((task) => task.status === "todo" && task.question_pending_merge_task_id === root.id)!;
    return submitAnswer(
      { db, pollNow: () => {}, landing, resolveWorkspace: resolve, github, workspacesDir: join(admin.workspacesBaseDir, "workbenches") },
      getTask(db, question.id)!, [option], undefined, () => clock.now(), "webui",
    );
  };
  return { db, clock, github, landing, resolve, root, setHeadRepo, forkBranch, answer };
}

/** 根だけが、出元 repo の記録 acme/fork と今の宣言 another/fork を名指す PR 昇格失敗の question を1枚持つ(ADR 0399 決定5)。 */
const expectStoppedNamingBoth = (db: Parameters<typeof promotionFailures>[0], rootId: string) => {
  const [failure, ...rest] = promotionFailures(db, rootId);
  expect(rest).toEqual([]);
  expect(failure?.purpose).toContain("pushed to head repo acme/fork");
  expect(failure?.purpose).toContain("now declares head repo another/fork");
};

it("古い出元 repo に push して PR を開いた根は、扉で出元 repo を差し替えると、新しい出元 repo へ push せず記録と今の宣言を名指して止まる", async () => {
  const { db, clock, github, landing, resolve, root, setHeadRepo, forkBranch } = await lagoonWithDoneRoot();
  await setHeadRepo("acme/fork");
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "pull_request_opened", prNumber: 1 });
  await commitThroughTaskCheckout(db, clock, resolve(), root, "repair.txt", "repair\n");
  await setHeadRepo("another/fork");
  const mirrored = forkBranch("another/fork");

  await landing.converge();

  expect(github.pushes).toEqual([]);
  expect(forkBranch("another/fork")).toBe(mirrored);
  expectStoppedNamingBoth(db, root.id);
  expect(openQuarantineQuestion(db, "workspace", "lagoon")).toBeUndefined();
});

// 扉の写し(sendTaskBranches)は記録を書かない —— 写されただけで PR の無い根は、出元 repo を作り直しても止まらない(spec #3595 の user story 15)
it("出元 repo へ写されただけでまだ push していない根は、扉で出元 repo を差し替えても止まらず、新しい出元 repo へ push して PR を開く", async () => {
  const { db, github, landing, resolve, root, setHeadRepo, forkBranch } = await lagoonWithDoneRoot();
  await setHeadRepo("acme/fork");
  await setHeadRepo("another/fork");

  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "pull_request_opened", prNumber: 1 });

  expect(forkBranch("another/fork")).toBe(git(resolve().path, "rev-parse", `task/${root.id}`));
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`]);
  expect(promotionFailures(db, root.id)).toEqual([]);
});

// fail-closed: 記録の書き漏れで守りが外れない。PR の記録は収束の外で刻む —— 盤面の経路は PR の前に必ず push して記録を書く
it.each([
  ["出元 repo を宣言している", true, "declares head repo acme/fork"],
  ["出元 repo を宣言していない", false, "declares no head repo"],
] as const)("PR を記録しているのに出元 repo の記録が無い根は、%s名前でも PR を読まずに止まる", async (_, declared, declares) => {
  const { db, clock, github, landing, root, setHeadRepo } = await lagoonWithDoneRoot();
  if (declared) await setHeadRepo("acme/fork");
  recordPrOpened(db, root, 1, "f".repeat(40), clock.now(), { merge: "external" }, undefined);

  await landing.converge();

  expect([github.stateChecks, github.pushes, github.requests]).toEqual([[], [], []]);
  const [failure, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(failure?.purpose).toContain("the board has no record of the head repo its PR #1 was pushed from");
  expect(failure?.purpose).toContain(`now ${declares}`);
});

/** 出元 repo acme/fork へ push して PR #1 を開いた根(merge dial は `merge`)を残し、扉で出元 repo を another/fork へ差し替えた盤面。 */
async function prOnReplacedFork(merge: MergeDial) {
  const board = await lagoonWithDoneRoot(merge);
  await board.setHeadRepo("acme/fork");
  await expect(convergeOn(board.landing, board.root.id)).resolves.toMatchObject({ prNumber: 1 });
  await board.setHeadRepo("another/fork");
  return board;
}

// ADR 0399 決定3: 比べる所は根を運ぶ所だけでなく PR を読む所・merge する所の全部(#3600 と同じ場所)
it("無人 merge の tick は、出元 repo を差し替えた後の PR を読まずに、記録と今の宣言を名指して根を止める", async () => {
  const { db, clock, github, landing, root } = await prOnReplacedFork("auto_if_ci_green");

  await landing.tick("auto_merge", clock.now());

  expect([github.ciChecks, github.merged]).toEqual([[], []]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
  expectStoppedNamingBoth(db, root.id);
});

it("外の merge の tick は、出元 repo を差し替えた後の PR を読まずに、記録と今の宣言を名指して根を止める", async () => {
  const { db, clock, github, landing, root } = await prOnReplacedFork("escalate");
  const before = github.stateChecks.length;

  await landing.tick("outside_merge", clock.now());

  expect(github.stateChecks).toHaveLength(before);
  expect(rootPrOutcome(db, root.id)).toBeNull();
  expectStoppedNamingBoth(db, root.id);
});

it("無人 merge の観測は、出元 repo を差し替えた後の PR を読まずに、記録と今の宣言を名指して根を止める", async () => {
  const { db, github, landing, root } = await prOnReplacedFork("auto_if_ci_green");
  const before = github.stateChecks.length;

  await landing.observeAutoMergeOutcomes("tako");

  expect(github.stateChecks).toHaveLength(before);
  expect(rootPrOutcome(db, root.id)).toBeNull();
  expectStoppedNamingBoth(db, root.id);
});

it("出元 repo を差し替えた後の merge の回答は、PR を読む前に記録と今の宣言を名指して拒み、hold は受ける(ADR 0394 決定5)", async () => {
  const { db, github, root, answer } = await prOnReplacedFork("escalate");
  const before = github.stateChecks.length;

  const refusal = await answer("merge").catch((error: Error) => error);

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain("pushed to head repo acme/fork");
  expect((refusal as Error).message).toContain("now declares head repo another/fork");
  expect(github.stateChecks).toHaveLength(before);
  expect([github.ciChecks, github.merged]).toEqual([[], []]);

  const held = await answer("hold");

  expect(getTask(db, held.id)?.status).toBe("done");
  expect(boardEvents(db, root.id, "landing_declined")).toHaveLength(1);
  expect(rootPrOutcome(db, root.id)).toBeNull();
});

// ADR 0399 Status 追記: 記録は push が届いた後に書く —— 届かなかった push は出元 repo に何も置かないので、差し替えで止める理由が無い
it("出元 repo への最初の push が拒まれた根は、扉で出元 repo を差し替えると、retry で新しい出元 repo へ push して PR を開く", async () => {
  const { db, clock, github, landing, resolve, root, setHeadRepo, forkBranch } = await lagoonWithDoneRoot();
  await setHeadRepo("acme/fork", { rejecting: true });
  await landing.converge();
  expect(forkBranch("acme/fork")).toBe("");
  await setHeadRepo("another/fork");
  const [question, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);

  await submitAnswer({ db, pollNow: () => {}, landing, resolveWorkspace: resolve, github }, getTask(db, question!.id)!, ["retry"], undefined, () => clock.now(), "webui");

  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`]);
  expect(forkBranch("another/fork")).toBe(git(resolve().path, "rev-parse", `task/${root.id}`));
  expect(getTask(db, root.id)?.pr_number).toBe(1);
});

// 記録は最初の push が届いたときに書かれ、上書きされない —— PR の作成に落ちた根も記録を持ち、差し替えを重ねても最初の出元 repo を名指す
it("PR の作成に落ちても出元 repo へ push した根は記録を持ち、出元 repo を2度差し替えた後の retry は最初の出元 repo を名指して拒まれる", async () => {
  const { db, clock, github, landing, resolve, root, setHeadRepo } = await lagoonWithDoneRoot();
  await setHeadRepo("acme/fork");
  github.scriptFailure(new Error("PR creation unavailable"));
  await landing.converge();
  github.scriptFailure(null);
  await setHeadRepo("another/fork");
  await setHeadRepo("third/fork");
  const [question] = promotionFailures(db, root.id);

  const refusal = await submitAnswer({ db, pollNow: () => {}, landing, resolveWorkspace: resolve, github }, getTask(db, question!.id)!, ["retry"], undefined, () => clock.now(), "webui")
    .catch((error: Error) => error);

  expect((refusal as Error).message).toContain("pushed to head repo acme/fork");
  expect((refusal as Error).message).toContain("now declares head repo third/fork");
  expect(github.requests).toHaveLength(1);
});

async function lagoonWithPurelyLocalDoneRoot() {
  const { db, clock } = await openBoard();
  const checkout = await makeWorkspace("lagoon");
  const origin = await tempDir("tidepool-lagoon-origin-");
  git(origin, "init", "--quiet", "--bare", "-b", "main");
  const fork = await tempDir("tidepool-fork-");
  const registryDir = await makeRegistry({ "workspaces.yaml": `lagoon:\n  path: ${JSON.stringify(checkout.path)}\n` });
  git(registryDir, "branch", "-M", "main");
  const broker = await startFakeBroker((request) => issuedToken(`token-for-${request.repo}`));
  onTestFinished(() => broker.close());
  const tokenFile = join(await tempDir("tidepool-token-"), "token");
  await writeFile(tokenFile, "gho_test\n");
  await chmod(tokenFile, 0o600);
  const githubAuth = new GitHubAuth(tokenFile, broker.url);
  const github = new FakeGitHubClient();
  github.scriptRepositoryParent("acme/fork", "acme/lagoon");
  const admin = { registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-ws-base-") };
  const doors = { ...admin, db, github, githubAuth, clock };
  const resolve = (name?: string | null) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), name ?? "lagoon", null, admin.workspacesBaseDir);
  await shimGit({ route: [REPO, origin] });
  await shimGit({ route: ["https://github.com/acme/fork.git", fork] });
  const work = landingWork(db, clock, "lagoon");
  await commitThroughTaskCheckout(db, clock, resolve(), work, "feature.txt", "ready\n");
  const root = finish(db, clock, work);
  const addFork = async () => {
    git(fork, "init", "--quiet", "--bare", "-b", "main");
    git(fork, "fetch", "--quiet", origin, "main:main");
    await updateWorkspace({ name: "lagoon", head_repo: "acme/fork", confirm: true }, doors);
  };
  // `external` の根は削除の扉を止めない(ADR 0370 決定1)
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github, githubAuth, resolveAuthority: () => profile("external") });
  const registerAgain = async (path: string) => {
    await deleteWorkspace({ name: "lagoon", confirm: true }, {
      ...doors,
      unsettledTaskCount: countUnsettledTasksReferencing(db, "workspace", "lagoon"),
      awaitingLandingTaskIds: taskIdsAwaitingLandingInWorkspace(db, buildWorkspaceResolver(resolve, undefined), "lagoon"),
    });
    await createWorkspace({ name: "lagoon", mode: "register", path, confirm: true }, doors);
  };
  return { addFork, db, doors, github, landing, registerAgain, resolve, root };
}

it("purely-local で拾われた根は publish では宣言の repo を記録せず、最初の push の直前に記録して PR を開く", async () => {
  const { addFork, db, doors, github, landing, registerAgain, resolve, root } = await lagoonWithPurelyLocalDoneRoot();
  const purelyLocal = resolve();
  await publishWorkspace({ name: "lagoon", repo: REPO }, doors);
  expect(resolve().repo).toBe(REPO);
  expect(() => withDeclaredRepoCheck(db, resolve(), root.id).checkDeclaredRepo!(purelyLocal)).not.toThrow();
  await addFork();
  const preparePush = github.preparePush.bind(github);
  let startedPush = false;
  vi.spyOn(github, "preparePush").mockImplementationOnce(async (input) => {
    const push = await preparePush(input);
    return (sha) => {
      startedPush = true;
      expect(() => withDeclaredRepoCheck(db, input.workspace, root.id).checkDeclaredRepo!(purelyLocal)).toThrow(/repo acme\/lagoon/);
      push(sha);
    };
  });
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "pull_request_opened", prNumber: 1 });
  expect(startedPush).toBe(true);

  // ADR 0399 決定3: 宣言の repo が同じでも、出元 repo を無くした名前では根だけが止まる。
  const replacement = await tempDir("tidepool-lagoon-replacement-");
  git(replacement, "clone", "--quiet", resolve().path, ".");
  git(replacement, "remote", "set-url", "origin", REPO);
  await registerAgain(replacement);
  expect(resolve()).toMatchObject({ repo: REPO });
  expect(resolve().head_repo).toBeUndefined();

  await landing.converge();

  const [failure, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(failure?.purpose).toContain("pushed to head repo acme/fork");
  expect(failure?.purpose).toContain("now declares no head repo");
});

it("publish の後に PR を開いた根は、名前を別の repo に登録し直すと、記録と今の宣言を名指して止まる", async () => {
  const { addFork, db, doors, github, landing, registerAgain, resolve, root } = await lagoonWithPurelyLocalDoneRoot();
  await publishWorkspace({ name: "lagoon", repo: REPO }, doors);
  await addFork();
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "pull_request_opened", prNumber: 1 });
  const { workspace: replacement } = await makeRemoteBackedWorkspace("lagoon-replacement");
  const newRepo = "https://github.com/other/lagoon.git";
  await shimGit({ route: [newRepo, replacement.repo!] });
  git(replacement.path, "remote", "set-url", "origin", newRepo);
  await registerAgain(replacement.path);
  expect(resolve().repo).toBe(newRepo);
  const previousReads = github.stateChecks.length;

  await landing.converge();

  const [failure, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(failure?.purpose).toContain("the board recorded repo acme/lagoon for it");
  expect(failure?.purpose).toContain("now declares repo other/lagoon");
  expect(github.stateChecks).toHaveLength(previousReads);
  expect(openQuarantineQuestion(db, "workspace", "lagoon")).toBeUndefined();
});
