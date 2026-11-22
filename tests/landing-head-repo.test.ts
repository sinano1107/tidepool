import { readFileSync, writeFileSync } from "node:fs";
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
  makeLandingWorkspace,
  makeRemoteBackedWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";
import { commitThroughTaskCheckout, convergeOn, finish, landingWork, mergeQuestions, openBoard, profile, promotionFailures, recordPrOpenedViaWorker } from "./landing-fixture.js";
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
    kind: "failed", reason: "promotion_failed", error: expect.stringContaining(`PR #1 does not have an open head at head repo ${replacement}`),
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
  recordPrOpenedViaWorker(db, finish(db, clock, work), 1, "tako", clock.now(), { head, authority: { merge: "auto_if_ci_green" } });
  expect(() => git(workspace.path, "cat-file", "-e", head)).toThrow();

  await landing.tick("auto_merge", clock.now());

  expect(mergeQuestions(db)).toMatchObject([{ pr: 1, purpose: expect.stringContaining("CODEOWNERS") }]);
  expect(github.merged).toEqual([]);
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
  const gitLog = join(bin, "git-network.log");
  writeFileSync(gitLog, "");
  // Real Git still transfers between independent repos. Redirect only at the transport boundary and record its token.
  writeFileSync(join(bin, "git"), `#!/bin/sh
for arg do
  case "$arg" in
    ${baseUrl}|${headUrl}) printf '%s %s\\n' "$GH_TOKEN" "$*" >> '${gitLog}' ;;
  esac
done
exec /usr/bin/env PATH='${process.env.PATH}' git \
  -c 'url.${origin}.insteadOf=${baseUrl}' -c 'url.${fork}.insteadOf=${headUrl}' "$@"
`, { mode: 0o755 });
  const ghLog = join(bin, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s %s\\n' "$GH_TOKEN" "$*" >> '${ghLog}'
printf '[]'
`, { mode: 0o755 });
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
  t = await bootTidepool({ workspace, githubAuth: auth, githubClient: new GhCliClient(auth, { apiUrl: rest.url }) });
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
  expect(git(fork, "rev-parse", `refs/heads/${branch}`)).toBe(tip);
  expect(headAtCreate).toBe(tip);
  expect(git(origin, "for-each-ref", "refs/heads/task/")).toBe("");
  expect(rest.requests).toMatchObject([{ path: "/repos/acme/widget/pulls", bearer: "board-human", body: { head: `reef-org:${branch}`, base: "main" } }]);
  expect(readFileSync(ghLog, "utf8")).toContain(`installation-acme/widget api repos/acme/widget/pulls --method GET -f head=reef-org:${branch}`);
  expect(readFileSync(gitLog, "utf8").split("\n")).toContainEqual(expect.stringMatching(new RegExp(`^installation-reef-org/widget-fork .* push -- ${headUrl} ${tip}:refs/heads/${branch}$`)));
});
