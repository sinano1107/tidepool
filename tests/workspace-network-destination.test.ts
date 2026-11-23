import { renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openDb } from "../src/db.js";
import { GhCliClient } from "../src/github.js";
import { GitHubAuth, workspaceHeadRepoDestination, workspaceNetworkDestination } from "../src/github-auth.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { createLanding } from "../src/landing.js";
import { loadRegistry } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, pickupTask, registerTask } from "../src/tasks.js";
import { runTeardown } from "../src/teardown.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { announceHeadRepo, announcePublishedRepo, assertRememberedRepo, boardRefWriter, pickupGate, recordTaskCheckoutTip, refreshProtectedBranch, resolveExecutionWorkspace, WorkspaceRepoMismatchError, withRememberedRepoCheck } from "../src/workspace.js";
import { createWorkspace } from "../src/workspace-create.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, MATCHING_GH, makeRemoteBackedWorkspace, makeWorkspace, prepareAtPickup, quarantineQuestion, settleReviews, shimGit } from "./harness.js";
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
  const answer = () => submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db, workspace, resolveWorkspace: () => declared }) }, question, ["repaired by hand"], undefined, () => NOW, "webui");
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

// ADR 0391 決定1〜3: publish は覚えた repo を `予告の前の値|宛先`(JSON の配列 `[before, destination]` で持つ —— path に `|` が出うる)に
// 予告し、検査は宣言と origin が揃ったときだけ揃った側へ畳む
describe("覚えた repo の予告(ADR 0391)", () => {
  async function announced(name: string, { baseline = true } = {}) {
    const workspace = await makeWorkspace(name);
    const destination = await tempDir(`tidepool-${name}-destination-`);
    git(destination, "init", "--quiet", "--bare", "--initial-branch=main");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    if (baseline) await leaveBaseline(db, workspace);
    announcePublishedRepo(db, { ...workspace, repo: destination });
    const check = (repo?: string) => assertRememberedRepo(db, { ...workspace, repo }, NOW);
    return { db, workspace, destination, check };
  }

  it("宣言が宛先でも origin が無ければ畳まず、宣言も origin も無くなれば予告の前の値へ畳む", async () => {
    const { workspace, destination, check } = await announced("announced-no-origin");

    check(destination);
    check(undefined);

    expect(() => check(destination)).toThrow(
      `workspace ${workspace.name} was registered as purely-local, but its registry entry now declares repo ${destination}.`,
    );
  });

  // 宣言だけで畳むと、remote-backed の registry の古い写しが見せる「宣言無し」へ畳んで戻らない(ADR 0391 決定3)
  it("宣言が無くても origin が宛先なら畳まず、registry に届いた後の死のように宣言と origin が宛先で揃えば宛先へ畳む", async () => {
    const { workspace, destination, check } = await announced("announced-origin");
    git(workspace.path, "remote", "add", "origin", destination);

    check(undefined);
    check(destination);
    git(workspace.path, "config", "--remove-section", "remote.origin");

    expect(() => check(undefined)).toThrow(
      `workspace ${workspace.name} was registered for repo ${destination}, but its registry entry no longer declares one.`,
    );
  });

  it("予告の間に宣言が第3の repo を指せば、今どおり workspace の Quarantine", async () => {
    const { db, workspace, check } = await announced("announced-third");
    const { workspace: third } = await makeRemoteBackedWorkspace("announced-third-repo");
    const reason = `workspace ${workspace.name} was registered as purely-local, but its registry entry now declares repo ${third.repo}. Remove \`repo:\`; to give the workspace a remote, publish it.`;

    expect(() => check(third.repo)).toThrow(new WorkspaceRepoMismatchError(reason));
    expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(reason.slice(0, -1));
  });

  it("基準の行を持たない workspace には予告せず、宣言を比べない", async () => {
    const { db, workspace, check } = await announced("announced-no-baseline", { baseline: false });
    const { workspace: third } = await makeRemoteBackedWorkspace("announced-no-baseline-repo");

    check(third.repo);

    expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  });
});

// #3560: 覚えた出元 repo(ADR 0395 決定2)は覚えた repo(ADR 0378 決定6)と違い、覚えていないことを「学ぶ」と読まない —— 扉の外で
// 足した宣言を通さない。基準の行の有無にも依らない
describe("覚えた出元 repo(ADR 0395 決定2)", () => {
  const HEAD = "https://github.com/acme/fork.git";

  it.each(["no baseline", "baseline"] as const)("覚えた値が無いまま扉の外で宣言に出元 repo を足すと、網に出ずに workspace の Quarantine に落ちる(%s)", async (history) => {
    const { workspace } = await makeRemoteBackedWorkspace(`head-unremembered-${history.replace(" ", "-")}`);
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    if (history === "baseline") await leaveBaseline(db, workspace);
    git(workspace.path, "remote", "add", "head-repo", HEAD);
    const declared = { ...workspace, head_repo: "acme/fork" };
    const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
    const base = await tempDir("tidepool-destination-checkouts-");
    const calls = await shimGit();
    const reason = `workspace ${workspace.name} declares head repo acme/fork, but the board never recorded one for it. Clear the head repo in the workspace settings, or remove \`head_repo:\` by hand, and answer; then set it there to use it.`;

    expect(() => workspaceNetworkDestination(withRememberedRepoCheck(db, declared, () => NOW))).toThrow(new WorkspaceRepoMismatchError(reason));
    await expect(pickupGate(db, declared, task, base)).rejects.toThrow(reason);

    expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(reason.slice(0, -1));
    expect(calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([]);
  });

  it.each([
    ["書き換える", "acme/other-fork", "but its registry entry now says acme/other-fork. Put `head_repo:` back by hand, or clear the head repo in the workspace settings, and answer; then set it there to change it."],
    ["消す", undefined, "but its registry entry no longer declares one. Put `head_repo:` back by hand and answer; then clear it in the workspace settings to drop it."],
  ] as const)("扉の外で宣言の出元 repo を%sと、網に出ずに workspace の Quarantine に落ちる", async (_, edited, tail) => {
    const { workspace } = await makeRemoteBackedWorkspace("head-edited");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    git(workspace.path, "remote", "add", "head-repo", HEAD);
    const declared = { ...workspace, head_repo: "acme/fork" };
    // 扉の書き方: 予告してから checkout と registry を書き、検査が畳む(ADR 0391 決定1・3)
    announceHeadRepo(db, workspace, "acme/fork");
    expect(workspaceNetworkDestination(withRememberedRepoCheck(db, declared, () => NOW))?.url).toBe(workspace.repo);
    const calls = await shimGit();
    const reason = `workspace ${workspace.name} was given head repo acme/fork, ${tail}`;

    expect(() => workspaceNetworkDestination(withRememberedRepoCheck(db, { ...workspace, head_repo: edited }, () => NOW))).toThrow(new WorkspaceRepoMismatchError(reason));

    expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(reason.slice(0, -1));
    expect(calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([]);
  });

  // ADR 0378 決定3・4 を出元 repo の remote に: origin と同じ扱い・同じ「同じ repo」の比べ方
  it("出元 repo の remote が宣言と違う repo を指すと、pickup も Quarantine の受理も網に出ずに拒む", async () => {
    const { workspace } = await makeRemoteBackedWorkspace("head-remote");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    const declared = { ...workspace, head_repo: "acme/fork" };
    git(workspace.path, "remote", "add", "head-repo", "git@GitHub.com:Acme/FORK");
    announceHeadRepo(db, workspace, "acme/fork");
    const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
    const base = await tempDir("tidepool-destination-checkouts-");
    await expect(pickupGate(db, declared, task, base)).resolves.toBeDefined();
    git(workspace.path, "remote", "set-url", "head-repo", "https://github.com/acme/elsewhere.git");
    const calls = await shimGit();
    const reason = `workspace ${workspace.name} declares head repo acme/fork, but its checkout's 'head-repo' remote is https://github.com/acme/elsewhere.git. In ${workspace.path}, run \`git remote set-url head-repo https://github.com/acme/fork.git\`.`;

    await expect(pickupGate(db, declared, task, base)).rejects.toThrow(reason);
    const accept = quarantineChecks({ quarantineResolvers: {}, db, workspace: declared }).workspace!;
    await expect(accept(workspace.name, "repaired by hand", "webui")).rejects.toThrow(reason);
    expect(calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([]);

    git(workspace.path, "config", "--remove-section", "remote.head-repo");
    await expect(pickupGate(db, declared, task, base)).rejects.toThrow(
      `workspace ${workspace.name} declares head repo acme/fork but its checkout has no 'head-repo' remote. In ${workspace.path}, run \`git remote add head-repo https://github.com/acme/fork.git\`.`,
    );
    await expect(pickupGate(db, workspace, task, base)).rejects.toThrow(`workspace ${workspace.name} was given head repo acme/fork, but its registry entry no longer declares one.`);
  });

  // ADR 0378 決定1 / ADR 0395 決定1・2: 網の行き先は宣言 `repo` と宣言の出元 repo だけで、checkout の remote の綴りは使わない
  it("網の行き先は宣言 repo と宣言の出元 repo の2つで、remote の値には出ない", async () => {
    const { workspace } = await makeRemoteBackedWorkspace("head-destination");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    git(workspace.path, "remote", "add", "head-repo", HEAD);
    announceHeadRepo(db, workspace, "acme/fork");
    const declared = withRememberedRepoCheck(db, { ...workspace, head_repo: "acme/fork" }, () => NOW);
    const taskCheckout = { ...declared, path: await tempDir("tidepool-head-task-checkout-"), namedPlace: declared };
    const destinations = (place: typeof declared) => [workspaceNetworkDestination(place), workspaceHeadRepoDestination(place)].map((destination) => destination?.url);
    expect(destinations(declared)).toEqual([workspace.repo, HEAD]);
    // 覚えた後で remote を別の repo へ向けても、行き先は宣言のまま(remote の食い違いは pickup の述語が止める)
    git(workspace.path, "remote", "set-url", "head-repo", "https://github.com/acme/elsewhere.git");

    expect(destinations(declared)).toEqual([workspace.repo, HEAD]);
    expect(destinations(taskCheckout)).toEqual([workspace.repo, HEAD]);
  });

  it("扉が覚えた出元 repo と同じ repo を指す remote を持つ workspace は、pickup・準備・解放を Quarantine なしに通る", async () => {
    const { workspace } = await makeRemoteBackedWorkspace("head-positive");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    git(workspace.path, "remote", "add", "head-repo", HEAD);
    announceHeadRepo(db, workspace, "acme/fork");
    const declared = { ...workspace, head_repo: "acme/fork" };
    const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);

    await expect(pickupGate(db, declared, task, await tempDir("tidepool-destination-checkouts-"))).resolves.toBeDefined();
    await leaveBaseline(db, declared);
    await leaveBaseline(db, declared);

    expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  });

  // ADR 0378 決定3・8 と同じく、出元 repo の remote の食い違いも scheduler が workspace の Quarantine にする
  it("scheduler は出元 repo の remote の食い違いを修理の文で workspace の Quarantine にする", async ({ onTestFinished }) => {
    const workspace = { ...(await makeWorkspace("scheduler-head-repointed")), repo: "https://github.com/acme/widget", head_repo: "acme/fork" };
    git(workspace.path, "remote", "add", "origin", workspace.repo);
    git(workspace.path, "remote", "add", "head-repo", "https://github.com/acme/elsewhere.git");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    announceHeadRepo(db, workspace, "acme/fork");
    const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
    const clock = new FakeClock();
    const worker = new ScriptedWorker(clock);
    const slot = new Slot();
    const containers = fakeContainers();
    const scheduler = startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      converge: async () => [],
      db, clock, slot, worker, containers, github: new FakeGitHubClient(),
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

    expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).toContain(
      `workspace ${workspace.name} declares head repo acme/fork, but its checkout's 'head-repo' remote is https://github.com/acme/elsewhere.git. In ${workspace.path}, run \`git remote set-url head-repo https://github.com/acme/fork.git\`.`,
    );
    expect(worker.started).toEqual([]);
    expect(getTask(db, task.id)).toMatchObject({ status: "todo" });
  });
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
  const accept = quarantineChecks({ quarantineResolvers: {}, db, workspace }).workspace!;
  await expect(accept(workspace.name, "repaired by hand", "webui")).rejects.toThrow(reason);
  expect(calls().filter(({ args }) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([]);
  expect(protectedAndCopy()).toBe(before);

  git(workspace.path, "remote", "set-url", "origin", workspace.repo!);
  // 旧: 次の比較が予告の値をまだ受け入れた。spec #3273 の受理の順の後は、受理の1回目の比較が通った時点で2値行を ref の持つ側へ畳む
  // —— 後の項で拒まれても畳みは残る(pin B1)ので、予告の値への移動はもう受け入れられない
  const reads = await pickupGate(db, workspace, task, base);
  await expect(prepareAtPickup(db, workspace, task, { reads, workspacesBaseDir: base })).resolves.toBeDefined();
  await expect(accept(workspace.name, "repaired by hand", "webui")).resolves.toBeUndefined();
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
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  await createWorkspace({ name: "rewritten", mode: "register", path, confirm: true }, { registry, workspacesBaseDir: base, db });
  const registered = resolveExecutionWorkspace(loadRegistry(registry.dir, registry.mode), "rewritten", "rewritten", base);
  expect(registered.repo).toBe(workspace.repo);
  const task = registerTask(db, { type: "work", title: "first pickup", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const gate = () => pickupGate(db, registered, task, base);
  await expect(gate()).rejects.toThrow(`declares repo ${workspace.repo}, but its checkout's origin is ${origin}`);
  git(path, "remote", "set-url", "origin", workspace.repo!);
  await expect(gate()).resolves.toBeDefined();
  await expect(quarantineChecks({ quarantineResolvers: {}, db, workspace: registered }).workspace!(registered.name, undefined, "webui")).resolves.toBeUndefined();

  const locallyDeclared = { ...registered, repo: undefined };
  await expect(pickupGate(db, locallyDeclared, task, base)).rejects.toThrow(
    `workspace rewritten declares no remote source of truth (no repo) but its checkout has an 'origin' remote. In ${path}, run \`git config --remove-section remote.origin\`.`,
  );
  git(path, "config", "--remove-section", "remote.origin");
  await expect(gate()).rejects.toThrow(
    `workspace rewritten declares a remote source of truth (repo: ${workspace.repo}) but its checkout has no 'origin' remote. In ${path}, run \`git remote add origin ${workspace.repo}\`.`,
  );
});

it("teardown uses the declared repository and landing uses its fork after origin changes during the session", async ({ onTestFinished }) => {
  const declared = await makeRemoteBackedWorkspace("session");
  const other = await makeRemoteBackedWorkspace("other");
  const url = "https://github.com/acme/declared.git";
  const fork = await tempDir("tidepool-declared-destination-fork-");
  git(fork, "clone", "--bare", declared.workspace.repo!, ".");
  const workspace = { ...declared.workspace, repo: ` ${url} `, head_repo: "reef-org/fork" };
  git(workspace.path, "remote", "set-url", "origin", url);
  git(workspace.path, "remote", "add", "head-repo", "https://github.com/reef-org/fork.git");
  const gitCalls = await shimGit({ route: [url, declared.workspace.repo!] });
  await shimGit({ route: ["https://github.com/reef-org/fork.git", fork] });
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  announceHeadRepo(db, declared.workspace, workspace.head_repo);
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
case "$1 $3" in
  "api --jq") echo false ;;
  api*) echo '[]' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 }); // a public declared repo: the fork PR workflow settings are not read
  // ADR 0396 決定3: the PR is opened by the board's own REST request, not by `gh`
  const api = await startFakeBroker(() => ({ status: 201, body: { html_url: "https://github.com/acme/declared/pull/7", number: 7 } }));
  onTestFinished(() => api.close());
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  onTestFinished(() => { process.env.PATH = previousPath; });
  const auth = new GitHubAuth(tokenFile, broker.url);
  const beforeTeardown = gitCalls().length;
  await runTeardown({ db, clock, slot, resolve: () => workspace, pollNow() {}, githubAuth: auth }, task.id, { completion: true });
  const landing = createLanding({ db, clock, workspace, github: new GhCliClient(auth, { ...MATCHING_GH, apiUrl: api.url }), githubAuth: auth, defaultAgentName: "deckhand" });

  const verdicts = await landing.converge();

  const network = gitCalls().slice(beforeTeardown).filter(({ args }) => args.some((arg) => arg.startsWith("--git-dir=")) && args.some((arg) => ["fetch", "ls-remote", "push"].includes(arg)));
  // ADR 0376 決定1 / ADR 0395 決定1: base refresh and task-branch landing use different repositories.
  expect(network.map(({ args, env }) => ({
    verb: args.find((arg) => ["fetch", "ls-remote", "push"].includes(arg)),
    destination: args.find((arg) => [declared.workspace.repo, other.workspace.repo, fork].includes(arg)),
    token: env.GH_TOKEN,
  }))).toEqual([
    ...["ls-remote", "fetch"].map((verb) => ({ verb, destination: declared.workspace.repo, token: "installation-token" })),
    ...["ls-remote", "push"].map((verb) => ({ verb, destination: fork, token: "installation-token" })),
  ]);
  expect(broker.requests.map(({ repo }) => repo)).toEqual(["acme/declared", "reef-org/fork"]);
  expect(api.requests.map(({ path }) => path)).toEqual(["/repos/acme/declared/pulls"]);
  expect(verdicts).toEqual([expect.objectContaining({ taskId: task.id, verdict: expect.objectContaining({ kind: "landed", prNumber: 7 }) })]);
  expect(git(fork, "rev-parse", `refs/heads/task/${task.id}`)).toBe(git(workspace.path, "rev-parse", `refs/heads/task/${task.id}`));
  expect(git(declared.workspace.repo!, "for-each-ref", "refs/heads/task")).toBe("");
  expect(git(other.workspace.repo!, "for-each-ref", "refs/heads/task")).toBe("");
});
