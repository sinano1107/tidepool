import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { GhCliClient } from "../src/github.js";
import { GitHubAuth } from "../src/github-auth.js";
import { quarantineChecks } from "../src/human-verbs.js";
import { createLanding } from "../src/landing.js";
import { loadRegistry } from "../src/registry.js";
import { Slot } from "../src/slot.js";
import { completeTask, pickupTask, registerTask } from "../src/tasks.js";
import { runTeardown } from "../src/teardown.js";
import { pickupGate, recordTaskCheckoutTip, resolveExecutionWorkspace } from "../src/workspace.js";
import { createWorkspace } from "../src/workspace-create.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeClock } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeRemoteBackedWorkspace, prepareAtPickup, settleReviews, shimGit } from "./harness.js";
import { makeRegistry, writeUnannounced } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T00:00:00.000Z");

it("refuses pickup and Quarantine acceptance before contacting a re-pointed origin", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("declared");
  const other = await makeRemoteBackedWorkspace("different");
  other.publish("wrong.txt", "different repository\n", "advance the other origin");
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  await leaveBaseline(db, workspace);
  const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-destination-checkouts-");
  const protectedAndCopy = () => git(workspace.path, "rev-parse", "refs/heads/main", "refs/remotes/origin/main");
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

it("refuses first pickup when registration observed a rewritten non-GitHub origin", async ({ onTestFinished }) => {
  const { workspace } = await makeRemoteBackedWorkspace("rewritten");
  const path = workspace.path;
  const origin = "mirror:/repository";
  git(path, "remote", "set-url", "origin", origin);
  git(path, "config", `url.${workspace.repo}.insteadOf`, origin);
  const registry = { dir: await makeRegistry(), mode: "purely-local", writeRef: writeUnannounced } as const;
  const base = await tempDir("tidepool-destination-checkouts-");
  await createWorkspace({ name: "rewritten", mode: "register", path, confirm: true }, { registry, workspacesBaseDir: base });
  const registered = resolveExecutionWorkspace(loadRegistry(registry.dir, registry.mode), "rewritten", "rewritten", base);
  expect(registered.repo).toBe(workspace.repo);
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "first pickup", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const gate = () => pickupGate(db, registered, task, base, registry);
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
  const ghLog = join(bin, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "${ghLog}"
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
  const gh = readFileSync(ghLog, "utf8");
  expect(gh).toMatch(/^pr list .* -R acme\/declared$/m);
  expect(gh).toMatch(/^pr create [\s\S]* -R acme\/declared$/m);
  expect(git(declared.workspace.repo!, "rev-parse", `refs/heads/task/${task.id}`)).toBe(git(workspace.path, "rev-parse", `refs/heads/task/${task.id}`));
  expect(git(other.workspace.repo!, "for-each-ref", "refs/heads/task")).toBe("");
});
