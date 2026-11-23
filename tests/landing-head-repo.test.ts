import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GhCliClient } from "../src/github.js";
import { GitHubAuth } from "../src/github-auth.js";
import { createLanding } from "../src/landing.js";
import { announceHeadRepo } from "../src/workspace.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeGitHubClient } from "./fakes.js";
import {
  addTaskChange,
  api,
  bootTidepool,
  checkoutOf,
  checkoutTaskBranch,
  commitWork,
  completeIntegrationReviews,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  MATCHING_GH,
  makeLandingWorkspace,
  makeRemoteBackedWorkspace,
  mcpClient,
  registerWork,
  shimGit,
  type Tidepool,
} from "./harness.js";
import { commitThroughTaskCheckout, convergeOn, finish, landingWork, mergeQuestions, openBoard, profile, promotionFailures, pushedRoot, recordPrOpenedOutsideConvergence } from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool | undefined;
const servers: FakeBroker[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const server of servers.splice(0)) await server.close();
  vi.unstubAllEnvs();
});

it("convergence sees and fetches a fork-only commit before pushing a root with no PR", async () => {
  const { workspace: local } = await makeRemoteBackedWorkspace("fork-only-head");
  const fork = await tempDir("tidepool-head-repo-");
  git(fork, "clone", "--bare", local.repo!, ".");
  git(local.path, "remote", "add", "head-repo", fork);
  const workspace = { ...local, head_repo: fork };
  const { db, clock } = await openBoard();
  announceHeadRepo(db, local, fork);
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "board.txt", "board\n");
  finish(db, clock, work);
  const branch = `task/${work.id}`;
  const outside = await tempDir("tidepool-fork-writer-");
  git(outside, "clone", fork, ".");
  commitWork(outside, "outside.txt", "fork only\n");
  const head = git(outside, "rev-parse", "HEAD");
  git(outside, "push", "origin", `HEAD:refs/heads/${branch}`);
  expect(() => git(workspace.path, "cat-file", "-e", head)).toThrow();

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "failed", reason: "promotion_failed", error: expect.stringContaining(`Head repo ${fork}'s ${branch} holds commits the board did not push (${head}).`),
  });

  expect(promotionFailures(db, work.id)[0]?.purpose).toContain(`Head repo ${fork}'s ${branch} holds commits`);
  expect(git(workspace.path, "show", `${head}:outside.txt`)).toBe("fork only");
  expect(git(fork, "rev-parse", `refs/heads/${branch}`)).toBe(head);
  expect(git(local.repo!, "for-each-ref", "refs/heads/task/")).toBe("");
  expect(github.requests).toEqual([]);
});

it.each([false, true])("convergence explains the missing head repo before consulting GitHub (protected workspace = %s)", async (isProtected) => {
  const { workspace } = await makeRemoteBackedWorkspace("without-head-repo");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const find = vi.spyOn(github, "findPullRequestByHead");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, isProtectedWorkspace: () => isProtected });
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "board.txt", "board\n");
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "failed", reason: "promotion_failed", error: expect.stringContaining(`workspace ${workspace.name} has no declared head repo (head_repo)`),
  });

  expect(promotionFailures(db, work.id)[0]?.purpose).toContain("Set its fork in workspace settings");
  expect(find).not.toHaveBeenCalled();
  expect(github.requests).toEqual([]);
  expect(git(workspace.repo!, "for-each-ref", "refs/heads/task/")).toBe("");
});

it("a repair does not push to the replacement fork when its open PR still uses the previous fork", async () => {
  const { workspace: previous } = await makeLandingWorkspace("changed-head-repo");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  let workspace = previous;
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveWorkspace: () => workspace });
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "board.txt", "board\n");
  finish(db, clock, work);
  const branch = `refs/heads/task/${work.id}`;
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ form: "pull_request_opened", prNumber: 1 });
  const previousHead = git(previous.head_repo, "rev-parse", branch);
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  const replacement = await tempDir("tidepool-replacement-fork-");
  git(replacement, "clone", "--bare", previous.repo!, ".");
  announceHeadRepo(db, workspace, replacement);
  git(workspace.path, "remote", "set-url", "head-repo", replacement);
  workspace = { ...workspace, head_repo: replacement };

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "failed", reason: "promotion_failed", error: expect.stringContaining(`pushed to head repo ${previous.head_repo}, but workspace ${previous.name} now declares head repo ${replacement}`),
  });

  expect(git(previous.head_repo, "rev-parse", branch)).toBe(previousHead);
  expect(git(replacement, "for-each-ref", branch)).toBe("");
});

it("the merge path floor reads a recorded head that is only available from the fork", async () => {
  const { workspace } = await makeLandingWorkspace("fork-merge-paths");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => profile("auto_if_ci_green") });
  const work = landingWork(db, clock, workspace.name);
  const branch = `task/${work.id}`;
  const outside = await tempDir("tidepool-fork-writer-");
  git(outside, "clone", workspace.head_repo, ".");
  commitWork(outside, "CODEOWNERS", "* @maintainer\n");
  const head = git(outside, "rev-parse", "HEAD");
  git(outside, "push", "origin", `HEAD:refs/heads/${branch}`);
  github.scriptPullRequestOnBranch(branch);
  recordPrOpenedOutsideConvergence(db, finish(db, clock, work), 1, clock.now(), { head, authority: { merge: "auto_if_ci_green" }, workspace });
  expect(() => git(workspace.path, "cat-file", "-e", head)).toThrow();

  await landing.tick("auto_merge", clock.now());

  expect(mergeQuestions(db)).toMatchObject([{ pr: 1, purpose: expect.stringContaining("CODEOWNERS") }]);
  expect(github.merged).toEqual([]);
});

it("a repair uses the rewound head returned by the fork identity lookup", async () => {
  const { workspace, work, target, db, landing, github } = await pushedRoot("head-rewound-during-lookup", { pr: "recorded", merge: "auto_if_ci_green" });
  const rewound = git(workspace.head_repo, "rev-parse", "main");
  const find = github.findPullRequestByHead.bind(github);
  vi.spyOn(github, "findPullRequestByHead").mockImplementationOnce((input) => {
    git(workspace.head_repo, "update-ref", `refs/heads/${target}`, rewound);
    return find(input);
  });

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ form: "merge_question", prNumber: 1 });

  expect(mergeQuestions(db)).toMatchObject([{ recommendation: "hold" }]);
  expect(git(workspace.head_repo, "rev-parse", target)).toBe(rewound);
  expect(github.pushes).toEqual([]);
});

it.each([false, true])("the path floor fetches the observed fork head at PR opening or recovery (recovery = %s)", async (recovery) => {
  const { workspace } = await makeLandingWorkspace("opening-fork-merge-paths");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => profile("auto_if_ci_green") });
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "board.txt", "ready\n");
  finish(db, clock, work);
  const branch = `task/${work.id}`;
  if (recovery) {
    git(workspace.head_repo, "update-ref", `refs/heads/${branch}`, git(workspace.head_repo, "rev-parse", "main"));
    github.scriptPullRequestOnBranch(branch);
  }
  const outside = await tempDir("tidepool-opening-fork-writer-");
  const read = github.getPullRequestState.bind(github);
  vi.spyOn(github, "getPullRequestState").mockImplementationOnce(async (input) => {
    git(outside, "clone", "--branch", branch, workspace.head_repo, ".");
    commitWork(outside, "CODEOWNERS", "* @maintainer\n");
    git(outside, "push", "origin", branch);
    return read(input);
  });

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ form: "pull_request_opened" });

  expect(mergeQuestions(db)).toMatchObject([{ pr: 1, purpose: expect.stringContaining("CODEOWNERS") }]);
});

it("the board updates an old task branch on the head repo before opening its PR on the declared repo", async () => {
  const { workspace: local } = await makeRemoteBackedWorkspace("cross-repo-landing");
  const origin = local.repo!;
  const fork = await tempDir("tidepool-head-repo-");
  git(fork, "clone", "--bare", origin, ".");
  const workspace = { ...local, repo: "acme/widget", head_repo: "reef-org/widget-fork" };
  const baseUrl = "https://github.com/acme/widget.git";
  const headUrl = "https://github.com/reef-org/widget-fork.git";
  git(workspace.path, "remote", "set-url", "origin", baseUrl);
  git(workspace.path, "remote", "add", "head-repo", headUrl);
  const bin = await tempDir("tidepool-head-repo-bin-");
  await shimGit({ route: [baseUrl, origin] });
  await shimGit({ route: [headUrl, fork] });
  // a public declared repo: the fork PR workflow settings are not read
  writeFileSync(join(bin, "gh"), "#!/bin/sh\ncase \"$3\" in --jq) echo false;; *) printf '[]';; esac\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const tokenFile = join(bin, "token");
  writeFileSync(tokenFile, "board-human\n", { mode: 0o600 });
  const broker = await startFakeBroker(({ repo }) => issuedToken(`installation-${repo}`));
  servers.push(broker);
  let headAtCreate: string | undefined;
  const rest = await startFakeBroker(({ body }) => {
    headAtCreate = git(fork, "rev-parse", `refs/heads/${String(body.head).split(":")[1]}`);
    return { status: 201, body: { number: 42, html_url: "https://github.com/acme/widget/pull/42" } };
  });
  servers.push(rest);
  const auth = new GitHubAuth(tokenFile, broker.url);
  t = await bootTidepool({ workspace, githubAuth: auth, github: new GhCliClient(auth, { ...MATCHING_GH, apiUrl: rest.url }) });
  announceHeadRepo(t.db, local, workspace.head_repo);
  const task = await registerWork(t, "land the worker branch from its fork");
  const branch = `task/${task.id}`;
  const old = git(origin, "rev-parse", "refs/heads/main");
  git(fork, "update-ref", `refs/heads/${branch}`, old);
  await t.clock.advance(HOUR);
  const checkout = checkoutOf(t.db, task.id);
  addTaskChange(checkout, task.id);
  const tip = git(checkout, "rev-parse", "HEAD");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed = await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  expect(completed.isError, JSON.stringify(completed)).not.toBe(true);
  await completeIntegrationReviews(t, task.id);

  await vi.waitFor(async () => {
    expect((await api(t!.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(42);
  }, { timeout: 5000 });
  expect(headAtCreate).toBe(tip);
  expect(git(origin, "for-each-ref", "refs/heads/task/")).toBe("");
  expect(rest.requests).toMatchObject([{ path: "/repos/acme/widget/pulls", body: { head: `reef-org:${branch}`, base: "main" } }]);
});

// #3564: private の宣言の repo が fork の PR に書ける token か secrets を送るなら、出元 repo へ push せず PR も開かない。
// 設定が読めなければ同じく止める(fail-closed)。public は設定を読まない —— visibility で分ける読みは domain 層の client のテストが言う
const PERMISSION = "The tidepool-board App needs the Administration: read repository permission";
it.each([
  ["write tokens or secrets reach fork PRs", ["send_write_tokens_to_workflows"], "sends credentials to workflows from fork pull requests (Send write tokens to workflows from fork pull requests)", true],
  ["the App may not read the settings", new Error("gh: Resource not accessible by integration (HTTP 403)"), PERMISSION, true],
  // a failure that is not the permission keeps its own cause and does not blame the App's permission
  ["the settings read times out", new Error("`gh api repos/x` timed out after 1000 ms"), "(`gh api repos/x` timed out after 1000 ms)", false],
] as const)("the board does not push to the head repo or open a PR when %s, and lands once they are off", async (_, answer, reason, namesSettingsPage) => {
  const { workspace } = await makeLandingWorkspace("fork-pr-credentials");
  t = await bootTidepool({ workspace, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "escalate" }) });
  t.github.scriptForkPrCredentialSettings(answer instanceof Error ? answer : [...answer]);
  const task = await registerWork(t, "land only where fork PRs get no credentials");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  const failure = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.question_pending_pr_promotion_task_id === task.id);
  expect(failure.purpose).toContain(reason);
  expect(failure.purpose.includes("Fork pull request workflows in private repositories")).toBe(namesSettingsPage);
  expect(failure.purpose.includes(PERMISSION)).toBe(reason === PERMISSION);
  expect(t.github.requests).toEqual([]);
  expect(git(workspace.head_repo, "for-each-ref", "refs/heads/task/")).toBe("");

  t.github.scriptForkPrCredentialSettings([]);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["retry"] })).status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(1);
  expect(git(workspace.head_repo, "for-each-ref", "--format=%(refname)", "refs/heads/task/")).toBe(`refs/heads/task/${task.id}`);
});
