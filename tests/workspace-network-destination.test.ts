import { renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { openDb } from "../src/db.js";
import { GhCliClient } from "../src/github.js";
import { GitHubAuth } from "../src/github-auth.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { createLanding } from "../src/landing.js";
import { loadRegistry } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, pickupTask, registerTask } from "../src/tasks.js";
import { runTeardown } from "../src/teardown.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { boardRefWriter, pickupGate, recordTaskCheckoutTip, refreshProtectedBranch, resolveExecutionWorkspace, withRememberedRepoCheck } from "../src/workspace.js";
import { createWorkspace } from "../src/workspace-create.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeRemoteBackedWorkspace, makeWorkspace, prepareAtPickup, quarantineQuestion, settleReviews, shimGit } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T00:00:00.000Z");

it.each(["no baseline", "unlearned baseline", "purely-local baseline"] as const)("checks a repo declaration with %s", async (history) => {
  const workspace = await makeWorkspace("remembered-repository");
  const { workspace: remote } = await makeRemoteBackedWorkspace("remembered-repository-origin");
  const database = join(await tempDir("tidepool-destination-state-"), "board.sqlite");
  let db = openDb(database);
  onTestFinished(() => { db.close(); });
  if (history !== "no baseline") await leaveBaseline(db, workspace);
  if (history === "unlearned baseline") {
    db.exec("ALTER TABLE workspace_state DROP COLUMN remembered_repo");
    db.close();
    db = openDb(database);
  }
  const base = await tempDir("tidepool-destination-checkouts-");
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  let declared = { ...workspace, repo: remote.repo };
  git(workspace.path, "remote", "add", "origin", remote.repo!);
  const gate = () => pickupGate(db, declared, task, base);

  if (history !== "purely-local baseline") {
    await expect(gate()).resolves.toBeDefined();
    expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
    if (history === "unlearned baseline") {
      git(workspace.path, "config", "--remove-section", "remote.origin");
      declared = { ...workspace, repo: undefined };
      await expect(gate()).rejects.toThrow(`was registered for repo ${remote.repo}, but its registry entry no longer declares one.`);
    }
    return;
  }

  const reason = `workspace ${workspace.name} was registered as purely-local, but its registry entry now declares repo ${remote.repo}. Remove \`repo:\`; to give the workspace a remote, publish it.`;
  await expect(gate()).rejects.toThrow(reason);
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  expect(question.purpose).toContain(reason);
  const answer = () => submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspace, resolveWorkspace: () => declared }) }, question, ["repaired by hand"], undefined, () => NOW, "webui");
  const dirtyFile = join(workspace.path, "uncommitted");
  writeFileSync(dirtyFile, "dirty\n");
  await expect(answer()).rejects.toThrow(reason);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.id).toBe(question.id);

  rmSync(dirtyFile);
  git(workspace.path, "config", "--remove-section", "remote.origin");
  declared = { ...workspace, repo: undefined };
  await answer();
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("remembers where a relative repo declaration resolved when the baseline was captured", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("relative-repo");
  const repo = relative(workspace.path, workspace.repo!);
  git(workspace.path, "remote", "set-url", "origin", repo);
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  await leaveBaseline(db, { ...workspace, repo });

  const moved = await tempDir("tidepool-moved-checkout-");
  const path = join(moved, "checkout");
  renameSync(workspace.path, path);

  await expect(refreshProtectedBranch(db, { ...workspace, path, repo }, undefined)).rejects.toThrow(
    `was registered for repo ${workspace.repo}, but its registry entry now says ${repo}.`,
  );
});

it("rechecks origin before a first pickup can capture a repo edited after the pickup gate", async ({ onTestFinished }) => {
  const original = await makeRemoteBackedWorkspace("first-pickup-repo");
  const changed = await makeRemoteBackedWorkspace("first-pickup-other-repo");
  changed.publish("unexpected.txt", "other repository\n", "advance the other repo");
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  let current = original.workspace;
  const workspace = withRememberedRepoCheck(db, current, () => NOW, () => current);
  const task = registerTask(db, { type: "work", title: "first pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");
  const reads = await pickupGate(db, workspace, task, base);
  const calls = await shimGit();
  current = { ...original.workspace, repo: changed.workspace.repo };

  await expect(prepareAtPickup(db, workspace, task, { reads, workspacesBaseDir: base })).rejects.toThrow(
    `declares repo ${changed.workspace.repo}, but its checkout's origin is ${original.workspace.repo}`,
  );
  expect(calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([]);
  expect(git(workspace.path, "branch", "--list", `task/${task.id}`)).toBe("");

  current = original.workspace;
  await expect(prepareAtPickup(db, workspace, task, { reads, workspacesBaseDir: base })).resolves.toBeDefined();
});

it("refuses pickup and Quarantine acceptance before contacting a re-pointed origin", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("declared");
  const other = await makeRemoteBackedWorkspace("different");
  other.publish("wrong.txt", "different repository\n", "advance the other origin");
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  await leaveBaseline(db, workspace);
  const copyRef = "refs/remotes/origin/main";
  const announced = git(workspace.path, "commit-tree", `${copyRef}^{tree}`, "-p", copyRef, "-m", "announced before interruption");
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, workspace)(copyRef, announced, () => {})).toThrow("the board dropped");
  reopen();
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");
  const protectedAndCopy = () => git(workspace.path, "rev-parse", "refs/heads/main", copyRef);
  const before = protectedAndCopy();
  git(workspace.path, "remote", "set-url", "origin", other.workspace.repo!);
  const calls = await shimGit();
  const reason = `workspace declared declares repo ${workspace.repo}, but its checkout's origin is ${other.workspace.repo}. In ${workspace.path}, run \`git remote set-url origin ${workspace.repo}\`. To move the workspace to another repository, delete it and register it again.`;

  await expect(pickupGate(db, workspace, task, base)).rejects.toThrow(reason);
  const accept = quarantineChecks({ db, workspace }).workspace!;
  await expect(accept(workspace.name, "repaired by hand")).rejects.toThrow(reason);
  expect(calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([]);
  expect(protectedAndCopy()).toBe(before);

  git(workspace.path, "remote", "set-url", "origin", workspace.repo!);
  // The next comparison still accepts the announced value, which a premature fold would lose.
  git(workspace.path, "update-ref", copyRef, announced);
  const reads = await pickupGate(db, workspace, task, base);
  await expect(prepareAtPickup(db, workspace, task, { reads, workspacesBaseDir: base })).resolves.toBeDefined();
  await expect(accept(workspace.name, "repaired by hand")).resolves.toBeUndefined();
});

it("compares raw origin URLs and accepts equivalent spellings of the same GitHub repository", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("spellings");
  const declared = "https://github.com/acme/project.git";
  workspace.repo = declared;
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");
  const different = "https://github.com/acme/other.git";
  git(workspace.path, "remote", "set-url", "origin", different);
  git(workspace.path, "config", "--add", "remote.origin.url", declared);
  git(workspace.path, "config", `url.${declared}.insteadOf`, different);
  expect(git(workspace.path, "remote", "get-url", "origin")).toBe(declared);

  await expect(pickupGate(db, workspace, task, base)).rejects.toThrow(`its checkout's origin is ${different}`);

  git(workspace.path, "config", "--replace-all", "remote.origin.url", "git@GitHub.com:Acme/PROJECT");
  await expect(pickupGate(db, workspace, task, base)).resolves.toBeDefined();
});

it.each([
  ["declares a repo", true],
  ["declares no repo", false],
])("refuses pickup when the checkout's config is a dangling symlink and it %s", async (_, declared) => {
  const { workspace: remoteBacked } = await makeRemoteBackedWorkspace("dangling-config");
  const workspace = declared ? remoteBacked : { ...remoteBacked, repo: undefined };
  const config = join(workspace.path, ".git", "config");
  rmSync(config);
  symlinkSync("missing-config", config);
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);

  await expect(pickupGate(db, workspace, task, await tempDir("tidepool-destination-checkouts-"))).rejects.toThrow(
    `workspace ${workspace.name}: could not read its checkout's origin in ${workspace.path}`,
  );
});

// ADR 0378 決定3: 向け替えられた origin は手元の修理なので、scheduler は token を問い合わせず F1 の文で Quarantine する
it("the scheduler quarantines a re-pointed origin with the repair text and without asking for repo access", async ({ onTestFinished }) => {
  const workspace = { ...(await makeWorkspace("scheduler-repointed")), repo: "https://github.com/acme/widget" };
  git(workspace.path, "remote", "add", "origin", "https://github.com/acme/other.git");
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const github = new FakeGitHubClient();
  const refusal = "the GitHub token broker refused a token for acme/widget (HTTP 404: repo_unreachable)";
  github.scriptUnreachable("acme/widget", refusal);
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db, clock, slot, worker, containers, github,
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: () => workspace, pollNow: () => scheduler.pollNow() }, containers, { defaultWorkspaceName: workspace.name }),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace,
    resolveWorkspace: () => workspace,
    workspacesDir: await tempDir("tidepool-destination-checkouts-"),
  });
  onTestFinished(() => scheduler.stop());

  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined());

  expect(github.repoAccessCalls).toBe(0);
  const purpose = quarantineQuestion(db, "workspace", workspace.name)!.purpose;
  expect(purpose).toContain(`workspace ${workspace.name} declares repo ${workspace.repo}, but its checkout's origin is https://github.com/acme/other.git. In ${workspace.path}, run \`git remote set-url origin ${workspace.repo}\`.`);
  expect(purpose).not.toContain(refusal);
  expect(worker.started).toEqual([]);
  expect(getTask(db, task.id)).toMatchObject({ status: "todo" });
});

it("keeps HTTP credentials out of origin mismatch diagnostics and repair commands", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("credentials");
  const declared = "https://github.com/acme/project.git";
  const origin = "https://github.com/acme/other.git";
  workspace.repo = "https://declared-user:declared-dummy@github.com/acme/project.git";
  git(workspace.path, "remote", "set-url", "origin", "https://origin-user:origin-dummy@github.com/acme/other.git");
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");
  const refusal = () => pickupGate(db, workspace, task, base).then(() => "", (err: Error) => err.message);

  const mismatch = await refusal();
  expect(mismatch).toContain(`declares repo ${declared}, but its checkout's origin is ${origin}.`);
  expect(mismatch).toContain(`git remote set-url origin ${declared}`);
  expect(mismatch).not.toMatch(/declared-user|origin-user|declared-dummy|origin-dummy/);

  git(workspace.path, "config", "--remove-section", "remote.origin");
  const missing = await refusal();
  expect(missing).toContain(`declares a remote source of truth (repo: ${declared})`);
  expect(missing).toContain(`git remote add origin ${declared}`);
  expect(missing).not.toMatch(/declared-user|declared-dummy/);
});

it("directs repairs to the exact private declaration when redaction changes a non-GitHub repository", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("private-declaration");
  const displayRepo = "https://git.example.com/acme/project.git";
  workspace.repo = "https://dummy-user:dummy-secret@git.example.com/acme/project.git?token=dummy-query";
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");
  const refusal = () => pickupGate(db, workspace, task, base).then(() => "", (err: Error) => err.message);

  const mismatch = await refusal();
  expect(mismatch).toContain(`declares repo ${displayRepo}`);
  expect(mismatch).toContain("use the exact private `repo:` value from the registry entry with `git remote set-url origin`");
  expect(mismatch).not.toMatch(/dummy-user|dummy-secret|dummy-query/);

  git(workspace.path, "config", "--remove-section", "remote.origin");
  const missing = await refusal();
  expect(missing).toContain("use the exact private `repo:` value from the registry entry with `git remote add origin`");
  expect(missing).not.toMatch(/dummy-user|dummy-secret|dummy-query/);
});

it("quotes a literal repository path in the origin repair command", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("quoted-declaration");
  workspace.repo = "../owner's repository; $(false)";
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");

  await expect(pickupGate(db, workspace, task, base)).rejects.toThrow(
    "run `git remote set-url origin '../owner'\\''s repository; $(false)'`",
  );
});

it("refuses first pickup when registration observed a rewritten non-GitHub origin", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("rewritten");
  const path = workspace.path;
  const origin = "mirror:/repository";
  git(path, "remote", "set-url", "origin", origin);
  git(path, "config", `url.${workspace.repo}.insteadOf`, origin);
  const registry = { dir: await makeRegistry(), mode: "purely-local" } as const;
  const base = await tempDir("tidepool-destination-checkouts-");
  await createWorkspace({ name: "rewritten", mode: "register", path, confirm: true }, { registry, workspacesBaseDir: base });
  const registered = resolveExecutionWorkspace(loadRegistry(registry.dir, registry.mode), "rewritten", "rewritten", base);
  expect(registered.repo).toBe(workspace.repo);
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "first pickup", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const gate = () => pickupGate(db, registered, task, base);
  await expect(gate()).rejects.toThrow(`declares repo ${workspace.repo}, but its checkout's origin is ${origin}`);
  git(path, "remote", "set-url", "origin", workspace.repo!);
  await expect(gate()).resolves.toBeDefined();
  await expect(quarantineChecks({ db, workspace: registered }).workspace!(registered.name)).resolves.toBeUndefined();

  const locallyDeclared = { ...registered, repo: undefined };
  await expect(pickupGate(db, locallyDeclared, task, base)).rejects.toThrow(
    `workspace rewritten declares no remote source of truth (no repo) but its checkout has an 'origin' remote. In ${path}, run \`git config --remove-section remote.origin\`.`,
  );
  git(path, "config", "--remove-section", "remote.origin");
  await expect(gate()).rejects.toThrow(
    `workspace rewritten declares a remote source of truth (repo: ${workspace.repo}) but its checkout has no 'origin' remote. In ${path}, run \`git remote add origin ${workspace.repo}\`.`,
  );
});

it("teardown and landing use the declared repository after origin changes during the session", async ({ onTestFinished }) => {
  const declared = await makeRemoteBackedWorkspace("session");
  const other = await makeRemoteBackedWorkspace("other");
  const url = "https://github.com/acme/declared.git";
  const workspace = { ...declared.workspace, repo: ` ${url} ` };
  git(workspace.path, "remote", "set-url", "origin", url);
  const gitCalls = await shimGit({ route: [url, declared.workspace.repo!] });
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const clock = new FakeClock();
  const slot = new Slot();
  const registered = registerTask(db, { type: "work", title: "work to land", purpose: "p", completion_criteria: "c", workspace: workspace.name }, clock.now(), ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  const workspacesBaseDir = await tempDir("tidepool-destination-checkouts-");
  const reads = await pickupGate(db, workspace, task, workspacesBaseDir);
  const place = await prepareAtPickup(db, workspace, task, { reads, workspacesBaseDir, now: clock.now() });
  slot.occupy(task.id, 1);
  commitWork(place.path, "work.txt", "work\n");
  git(workspace.path, "remote", "set-url", "origin", other.workspace.repo!);
  expect(git(place.path, "remote")).toBe("");
  recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  settleReviews(db, clock.now());
  declared.publish("merged.txt", "declared repository advanced\n", "advance the declared origin");

  const broker = await startFakeBroker(() => issuedToken("installation-token"));
  onTestFinished(() => broker.close());
  const bin = await tempDir("tidepool-gh-destination-");
  const tokenFile = join(bin, "user-token");
  writeFileSync(tokenFile, "user-token", { mode: 0o600 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$2" in
  list) echo '[]' ;;
  create) echo 'https://github.com/acme/declared/pull/7' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  onTestFinished(() => { process.env.PATH = previousPath; });
  const auth = new GitHubAuth(tokenFile, broker.url);
  const beforeTeardown = gitCalls().length;
  await runTeardown({ db, clock, slot, resolve: () => workspace, pollNow() {}, githubAuth: auth }, task.id, { completion: true });
  const landing = createLanding({ db, clock, workspace, github: new GhCliClient(auth), githubAuth: auth, defaultAgentName: "deckhand" });

  const verdicts = await landing.converge();

  const network = gitCalls().slice(beforeTeardown).filter(({ args }) => args.some((arg) => arg.startsWith("--git-dir=")) && args.some((arg) => ["fetch", "ls-remote", "push"].includes(arg)));
  expect(network.map(({ args, env }) => ({
    verb: args.find((arg) => ["fetch", "ls-remote", "push"].includes(arg)),
    destination: args.find((arg) => [declared.workspace.repo, other.workspace.repo].includes(arg)),
    token: env.GH_TOKEN,
  }))).toEqual(["ls-remote", "fetch", "push"].map((verb) => ({ verb, destination: declared.workspace.repo, token: "installation-token" })));
  expect(broker.requests.map(({ repo }) => repo)).toEqual(["acme/declared"]);
  expect(verdicts).toEqual([expect.objectContaining({ taskId: task.id, verdict: expect.objectContaining({ kind: "landed", prNumber: 7 }) })]);
  expect(git(declared.workspace.repo!, "rev-parse", `refs/heads/task/${task.id}`)).toBe(git(workspace.path, "rev-parse", `refs/heads/task/${task.id}`));
  expect(git(other.workspace.repo!, "for-each-ref", "refs/heads/task")).toBe("");
});
