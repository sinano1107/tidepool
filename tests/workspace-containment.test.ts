import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexWorkspaceCheck } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents, listEventsOfKinds } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { GitHubAuth } from "../src/github-auth.js";
import { type CodexWorkspaceCheck, claudeWorkspaceContainment } from "../src/harness-containment.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import type { Provider } from "../src/provider.js";
import { registerQuarantine, workspaceContainmentValue } from "../src/quarantine.js";
import type { Harness } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { workbenchPath } from "../src/workbench.js";
import type { WorkerAdapter } from "../src/worker.js";
import {
  compareContainmentRefs,
  holdsBaseline,
  openHumanContentWorkbench,
  openInterviewRoom,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  rememberPublishedRepo,
  stopContainmentPair,
  type TaskCheckoutPlace,
  takeInHumanContentWorkbench,
  type WorkspaceConfig,
  withRememberedRepoCheck,
  writeBoardRefs,
} from "../src/workspace.js";
import {
  answerSkillsFromDisk,
  CODEX_DISK_SKILL,
  codexSkillsListAt,
  FakeClock,
  fakeAppServerCall,
  healthyOpenai,
  healthyUsageText,
  noRetrospectiveCalls,
  passthroughContainers,
  unusedLanding,
} from "./fakes.js";
import {
  api,
  bootClaudeOn,
  bootTidepool,
  checkoutTaskBranch,
  claudeSpawnOf,
  commitWork,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  humanDecomposeTaskViaWebui,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  prepareAtPickup,
  quarantineQuestion,
  questions,
  queueWork,
  servedQuarantineQuestion,
  sessionId,
  type Tidepool,
  tempDirSync,
} from "./harness.js";
import { tempDir } from "./temp-dir.js";

/** agent 名 → その entry の Provider(並びが順位)。 */
const AGENTS: Record<string, Provider[]> = {
  "claude-agent": ["anthropic"],
  "codex-agent": ["openai"],
  "both-agent": ["anthropic", "openai"],
};

it.each([
  ["同じ workspace B の Codex の task", { workspace: "B", assignee: "codex-agent" }, "openai"],
  ["別の workspace A の Claude の task", { workspace: "A", assignee: "claude-agent" }, "anthropic"],
  ["同じ head の別の Harness の行(B の両刀の agent)", { workspace: "B", assignee: "both-agent" }, "openai"],
] as const)(
  "(claude-code, B) が止まっても、同じ poll で %s は流れる —— 外れるのは B の Claude の行だけ(ADR 0259 決定1)",
  async (_case, next, provider) => {
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const started: Array<[string, Provider]> = [];
    const worker: WorkerAdapter = {
      id: "claude-agent",
      start: (task, _sessionId, setting) => started.push([task.id, setting.provider]),
      gracefulStop() {},
      checkUsage: async () => healthyUsageText(clock.now()),
    };
    const work = (title: string, fields: { workspace: string; assignee: string }) =>
      registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c", ...fields }, clock.now(), ...HUMAN_WEBUI);
    const stopped = work("B の Claude の head", { workspace: "B", assignee: "claude-agent" });
    const flowing = work("次の task", next);
    registerQuarantine(db, "workspaceContainment", "claude-code/B", "unsafe settings", clock.now());
    const scheduler = startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      // task の checkout(ADR 0356 決定2)をホームの既定の基点に作らない
      workspacesDir: tempDirSync("tidepool-task-checkouts-"),
      converge: async () => [],
      db,
      clock,
      slot: new Slot(),
      worker,
      containers: passthroughContainers(),
      onSpawnFailed: () => {},
      onRecordContainerFailed: () => {},
      onPickupStopped: () => {},
      openaiUsage: () => healthyOpenai(clock.now()),
      taskExecutionCandidates: (task) =>
        executionSettingsFor(
          db,
          { provider: AGENTS[task.assignee!]!.map((name) => ({ name, advisor: false })), tier: undefined },
          task,
        ),
    });

    await clock.advance(HOURLY);

    expect(started).toEqual([[flowing.id, provider]]);
    expect(getTask(db, stopped.id)?.status).toBe("todo");
    scheduler.stop();
  },
);

it.each([
  ["agent が別 Harness の行も宣言していれば、次の pickup がその行で同じ task を選び直す", "both-agent", ["anthropic", "openai"], "head"],
  ["宣言が1つの agent なら、戻った task は skipped のまま下の task が拾われる", "claude-agent", ["anthropic", "openai"], "next"],
] as const)(
  "start の中で (claude-code, B) の組が止めた pickup は todo へ戻って枠を空け、tick を待たずに次の pickup が走る —— %s(ADR 0274 決定1)",
  async (_case, assignee, providers, secondRun) => {
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const slot = new Slot();
    const containers = passthroughContainers();
    const started: Array<[string, Provider]> = [];
    // Claude adapter の同期の検査と同じく、start の中で組を quarantine して盤面の一撃を同期に呼ぶ(初回だけ)
    const onPickupStopped = queueReturnHandler({ db, clock, slot, resolve: undefined, pollNow: () => scheduler.pollNow() }, containers, {});
    const worker: WorkerAdapter = {
      id: "claude-agent",
      start: (task, _sessionId, setting) => {
        started.push([task.id, setting.provider]);
        if (started.length > 1) return;
        const stop = { quarantine: "workspaceContainment", value: "claude-code/B", reason: "unsafe settings" } as const;
        registerQuarantine(db, stop.quarantine, stop.value, stop.reason, clock.now());
        onPickupStopped(task.id, sessionId(db, task.id), { kind: "pickup_stopped", ...stop });
      },
      gracefulStop() {},
      checkUsage: async () => healthyUsageText(clock.now()),
    };
    const work = (title: string, fields: { workspace: string; assignee: string }) =>
      registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c", ...fields }, clock.now(), ...HUMAN_WEBUI);
    const head = work("B の head", { workspace: "B", assignee });
    const next = work("次の task", { workspace: "B", assignee: "codex-agent" });
    const scheduler = startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      // task の checkout(ADR 0356 決定2)をホームの既定の基点に作らない
      workspacesDir: tempDirSync("tidepool-task-checkouts-"),
      // server.ts と同じ配線: 収束は走っている poll の終わりを待つ(ADR 0241 決定5)。start の中で撃たれた後始末の契機は
      // この poll の inFlight の間に届くので、契機を守っているのはこの待ちである(#2252)。即解決の converge だと
      // microtask の順序で偶然通る
      converge: () => scheduler.idle().then(() => []),
      db,
      clock,
      slot,
      worker,
      containers,
      onSpawnFailed: () => {},
      onRecordContainerFailed: () => {},
      onPickupStopped,
      openaiUsage: () => healthyOpenai(clock.now()),
      taskExecutionCandidates: (task) =>
        executionSettingsFor(
          db,
          { provider: AGENTS[task.assignee!]!.map((name) => ({ name, advisor: false })), tier: undefined },
          task,
        ),
    });

    await clock.advance(HOURLY);
    await vi.waitFor(() => expect(started).toHaveLength(2));

    expect(started).toEqual([[head.id, providers[0]], [secondRun === "head" ? head.id : next.id, providers[1]]]);
    expect(listEvents(db, head.id).map((e) => e.kind)).toContain("pickup_stopped");
    expect(listEvents(db, head.id).map((e) => e.kind)).not.toContain("spawn_failed");
    if (secondRun === "next") expect(getTask(db, head.id)?.status).toBe("todo");
    scheduler.stop();
  },
);

/** `.claude` を `shared` への symlink として `dir` の今の branch に commit する —— 盤面が隠せない形(ADR 0360 決定1)。 */
async function commitSymlinkedClaude(dir: string) {
  await mkdir(join(dir, "shared"));
  await writeFile(join(dir, "shared", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } }));
  await symlink("shared", join(dir, ".claude"));
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "share settings through a symlink");
}

/** `.claude` を実ディレクトリに直す —— 作業ツリーだけ。commit は呼び手が決める。 */
async function makeClaudeADirectory(dir: string) {
  await rm(join(dir, ".claude"));
  await mkdir(join(dir, ".claude"));
  await writeFile(join(dir, ".claude", "settings.json"), "{}");
}

async function workspaceWithSymlinkedClaude(name: string) {
  const workspace = await makeWorkspace(name);
  await commitSymlinkedClaude(workspace.path);
  return workspace;
}

/** (claude-code, `workspace`) の組の question と、それに答える口(submitAnswer + quarantineChecks)。 */
function claudePairQuestion(workspace: WorkspaceConfig) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  registerQuarantine(db, "workspaceContainment", `claude-code/${workspace.name}`, "unhideable .claude", clock.now());
  const question = quarantineQuestion(db, "workspaceContainment", `claude-code/${workspace.name}`)!;
  const deps = { db, pollNow() {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, resolveWorkspace: () => workspace }) };
  return {
    answer: () => submitAnswer(deps, question, ["repaired by hand"], undefined, () => clock.now(), "webui"),
    status: () => getTask(db, question.id)?.status,
  };
}

it("組を止める理由は記録の ref・名前の場所・隠せない形の path と型を名指し、直す先には保護ブランチと作業台を挙げる(ADR 0360 決定1・3 / spec #3273 text B8)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-reason");
  git(workspace.path, "branch", "trunk");
  const named = { ...workspace, branch: "trunk" };
  const contained = claudeWorkspaceContainment(named);
  const base = await tempDir("tidepool-pair-reason-workbenches-");

  const stop = stopContainmentPair(openDb(":memory:"), "claude-code", named, (contained as { reason: string }).reason, base, new Date(0));

  expect(stop.reason).toBe(
    `the recorded tree of refs/heads/trunk in the named place ${workspace.path} has .claude as a symlink, not a directory — ` +
      "the board cannot hide .claude/settings.json or .claude/settings.local.json behind it from the worker's CLI, " +
      `so commit .claude as a directory on trunk. The board opened the workbench at ${realpathSync(workbenchPath(base, { workspace: workspace.name }))}: commit the fix there on trunk, then answer.`,
  );
}, GIT_FIXTURE_TEST_TIMEOUT);

it("(claude-code, B) の question への回答は、名前の場所の作業ツリーに何があっても保護ブランチの tree にまだ隠せない形があれば拒まれて開いたまま残る(ADR 0360 決定3・ADR 0259 決定5)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-answer");
  const { answer, status } = claudePairQuestion(workspace);

  await makeClaudeADirectory(workspace.path);
  await expect(answer()).rejects.toThrow("has .claude as a symlink");
  expect(status()).toBe("todo");
});

it("remote-backed な workspace の (claude-code, B) の question への回答は、人間が origin へ push した直しを引いてから保護ブランチを読み直す(ADR 0360 決定3)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("pair-answer-remote");
  const human = await tempDir("tidepool-pair-answer-human-");
  git(human, "clone", "--quiet", workspace.repo!, ".");
  await commitSymlinkedClaude(human);
  git(human, "push", "--quiet", "origin", "main");
  git(workspace.path, "fetch", "--quiet", "origin");
  const { answer, status } = claudePairQuestion(workspace);

  await expect(answer()).rejects.toThrow("has .claude as a symlink");
  expect(status()).toBe("todo");

  await makeClaudeADirectory(human);
  git(human, "add", "-A");
  git(human, "commit", "-m", "make .claude a directory");
  git(human, "push", "--quiet", "origin", "main");
  await answer();
  expect(status()).toBe("done");
});

it("保護ブランチの ref が無く、その ref と同じ綴りの tag だけがあれば (claude-code, B) の question への回答は理由つきで拒まれて開いたまま残る(ADR 0259 決定5)", async () => {
  const workspace = await makeWorkspace("pair-answer-unreadable");
  git(workspace.path, "tag", "refs/heads/no-such-branch");
  const { answer, status } = claudePairQuestion({ ...workspace, branch: "no-such-branch" });

  const result = answer();
  await expect(result).rejects.toThrow(DomainError);
  await expect(result).rejects.toThrow("refs/heads/no-such-branch");
  expect(status()).toBe("todo");
});

it("(codex, B) の question への回答は、保護ブランチの tip の使い捨ての checkout で skill の列挙と観測をもう一度走らせ、閉じきれないうちは拒まれて開いたまま残り、閉じきれれば受理される(ADR 0259 決定5 / ADR 0379 決定1)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const workspace = await makeWorkspace("B");
  let leaking = true;
  const appServer = fakeAppServerCall((args, cwds) =>
    codexSkillsListAt(cwds, args.includes("--strict-config") ? (leaking ? "one-enabled" : "closed") : undefined)
  );
  registerQuarantine(db, "workspaceContainment", "codex/B", "flat stays enabled", clock.now());
  const question = quarantineQuestion(db, "workspaceContainment", "codex/B")!;
  const deps = {
    db,
    pollNow() {},
    landing: unusedLanding,
    quarantineChecks: quarantineChecks({
      db,
      resolveWorkspace: () => workspace,
      workspacesDir: await tempDir("tidepool-codex-answer-checkouts-"),
      codexWorkspaceContainment: createCodexWorkspaceCheck({
        executable: "/opt/tidepool/bin/codex",
        codexHome: await tempDir("tidepool-codex-home-"),
        call: appServer.call,
      }),
    }),
  };
  const answer = () => submitAnswer(deps, question, ["repaired by hand"], undefined, () => clock.now(), "webui");

  await expect(answer()).rejects.toThrow("codex containment in workspace B is still not established");
  expect(getTask(db, question.id)?.status).toBe("todo");
  const cwds = appServer.calls.map(({ requests }) => requests[0]!.params.cwds as string[]);
  expect(cwds).toEqual([[expect.stringContaining("@containment-check")], cwds[0]]);
  expect(cwds[0]).not.toEqual([await realpath(workspace.path)]);

  leaking = false;
  await answer();
  expect(getTask(db, question.id)?.status).toBe("done");
});

it("Codex の組の検査が配線されていない盤面では、(codex, B) の question への回答は拒まれて開いたまま残る(ADR 0259 決定5)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const path = await tempDir("tidepool-ws-");
  registerQuarantine(db, "workspaceContainment", "codex/B", "flat stays enabled", clock.now());
  const question = quarantineQuestion(db, "workspaceContainment", "codex/B")!;
  const deps = {
    db,
    pollNow() {},
    landing: unusedLanding,
    quarantineChecks: quarantineChecks({ db, resolveWorkspace: (name) => ({ name: name!, path, branch: "main" }) }),
  };

  await expect(submitAnswer(deps, question, ["repaired by hand"], undefined, () => clock.now(), "webui")).rejects.toThrow(
    "codex containment in workspace B cannot be verified",
  );
  expect(getTask(db, question.id)?.status).toBe("todo");
});

let t: Tidepool | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

it("公開のキューで組の停止は skipped に見え、回答で解ける(ADR 0259)", async () => {
  const workspace = await makeWorkspace("pair-stop");
  t = await bootTidepool({ workspace });
  const task = registerTask(
    t.db,
    { type: "work", title: "Claude work in the stopped pair", purpose: "p", completion_criteria: "c", workspace: workspace.name },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  registerQuarantine(t.db, "workspaceContainment", `claude-code/${workspace.name}`, "unsafe settings", t.clock.now());
  const status = async () =>
    ((await api(t!.baseUrl, "GET", "/api/queue")).json.tasks as any[]).find((x) => x.id === task.id)?.status;

  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect(await status()).toBe("skipped");

  const question = await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`);
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
  expect(res.status).toBe(200);
  expect(await status()).not.toBe("skipped");
});

it("task branch と保護ブランチの両方で .claude が symlink なら (claude-code, workspace) の組が止まり、同じ workspace の Codex の行は候補に残る(ADR 0360 決定3・ADR 0259 決定1)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-symlink");
  const booted = await bootClaudeOn(workspace, {
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t!.db, { provider: [{ name: task.assignee === "codex-agent" ? "openai" : "anthropic", advisor: false }], tier: undefined }, task),
  });
  t = booted.t;
  const claude = queueWork(t, "Claude work", workspace.name);
  git(workspace.path, "branch", `task/${claude.id}`, "refs/heads/main");
  git(workspace.path, "tag", "main", "refs/heads/main^");

  await t.clock.advance(HOUR);
  await vi.waitFor(async () => expect(await servedQuarantineQuestion(t!, "workspaceContainment", `claude-code/${workspace.name}`)).toMatchObject({
    purpose: expect.stringContaining("the recorded tree of refs/heads/main"),
  }));
  expect(claudeSpawnOf(booted.proc, claude.id)).toBeUndefined();
  expect(await servedQuarantineQuestion(t, "workspace", workspace.name)).toBeUndefined();
  expect((await questions(t)).filter((question) => question.parent_id === claude.id)).toEqual([]);

  const codex = queueWork(t, "Codex work", workspace.name, "codex-agent");
  const queued = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  const status = (id: string) => queued.find((x) => x.id === id)?.status;
  expect(status(claude.id)).toBe("skipped");
  expect(status(codex.id)).not.toBe("skipped");
});

it("task branch だけに隠せない .claude があれば abandon 推奨の failure question が立ち、同じ workspace の Claude の次の task は走る(ADR 0360 決定3)", async () => {
  const workspace = await makeWorkspace("task-symlink");
  const booted = await bootClaudeOn(workspace);
  t = booted.t;
  const failed = queueWork(t, "Claude work with a symlink", workspace.name);
  const clean = queueWork(t, "Claude work with a clean branch", workspace.name);
  git(workspace.path, "switch", "-c", `task/${failed.id}`);
  await commitSymlinkedClaude(workspace.path);
  git(workspace.path, "switch", "main");
  git(workspace.path, "tag", `task/${failed.id}`, "refs/heads/main");

  await t.clock.advance(HOUR);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${failed.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "spawn_failed")).toHaveLength(1);
  const question = (await questions(t)).find((candidate) => candidate.parent_id === failed.id);
  expect(question.title).toBe(`worker never started for task: ${failed.title}`);
  // retry は同じ tree を読み直すだけなので選択肢に無い(issue #3289)
  expect(question.question_items[0]).toMatchObject({ options: ["abandon"], recommendation: "abandon" });
  expect(question.purpose).toContain(".claude as a symlink");
  expect(question.purpose).not.toContain('"retry"');
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["retry"] });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(`answer "retry" is not one of item 0's options: abandon`);
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, failed.id)).toBeUndefined();
  await vi.waitFor(() => expect(claudeSpawnOf(booted.proc, clean.id)).toBeDefined());
  expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["abandon"] })).status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failed.id}`)).json.status).toBe("cancelled");
});

it("面接室の tree に隠せない .claude があっても Interview root の失敗になり、面接室の名前で組は止まらない(ADR 0360 決定3)", async () => {
  const workspace = await makeWorkspace("interview-symlink");
  const booted = await bootClaudeOn(workspace);
  t = booted.t;
  const root = registerTask(t.db, {
    type: "interview",
    title: "Interview with a symlink",
    hypothesis: "the targets write the parser",
    tier: "standard",
    workspace: workspace.name,
    interview_targets: [{ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }],
  }, t.clock.now(), ...HUMAN_WEBUI);
  const workspacesDir = join(t.dir, "workspaces");
  openInterviewRoom(t.db, root, workspacesDir, t.clock.now());
  // ADR 0360 決定3: root の branch が継ぐ面接室の main に形があっても、組の検査の入力にはならない。
  await commitSymlinkedClaude(join(workspacesDir, root.id));

  await t.clock.advance(HOUR);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "spawn_failed")).toHaveLength(1);
  const question = (await questions(t)).find((candidate) => candidate.parent_id === root.id);
  expect(question.question_items[0]).toMatchObject({ options: ["abandon"], recommendation: "abandon" });
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${root.id}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, root.id)).toBeUndefined();
});

it("隠せない .claude を継いだ同じ分解判断の兄弟は failure question 1枚で held になり、abandon で両方 cancel される(ADR 0360 決定3・ADR 0048)", async () => {
  const workspace = await makeWorkspace("decomposition-symlink");
  ({ t } = await bootClaudeOn(workspace));
  const parent = queueWork(t, "Parent with a symlink", workspace.name);
  checkoutTaskBranch(t.db, workspace, parent.id);
  await commitSymlinkedClaude(workspace.path);
  git(workspace.path, "switch", "main");
  const [first, second] = humanDecomposeTaskViaWebui(t.db, parent, {
    reason: "split the work",
    children: [
      { title: "First child", purpose: "first part", completion_criteria: "first part done" },
      { title: "Second child", purpose: "second part", completion_criteria: "second part done" },
    ],
  }, t.clock.now());

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  const failureQuestions = (await questions(t)).filter((question) => question.parent_id === first!.id || question.parent_id === second!.id);
  expect(failureQuestions).toMatchObject([{ parent_id: first!.id }]);
  const status = async (id: string) => (await api(t!.baseUrl, "GET", `/api/tasks/${id}`)).json.status;
  expect(await status(second!.id)).toBe("held");

  const answer = await api(t.baseUrl, "POST", `/api/tasks/${failureQuestions[0].id}/answer`, { answers: ["abandon"] });
  expect(answer.status).toBe(200);
  expect(await status(first!.id)).toBe("cancelled");
  expect(await status(second!.id)).toBe("cancelled");
}, GIT_FIXTURE_TEST_TIMEOUT);

describe("封じ込めの修理の作業台(ADR 0373 決定7〜10 / ADR 0382 決定4〜6、spec #3273 の pin A7・A19・B12・B15・B23)", { timeout: GIT_FIXTURE_TEST_TIMEOUT }, () => {
  const anotherAnswerInFlight = (name: string) => `another answer or operation for workspace ${name} is being checked — try again once it has finished.`;

  /** pickup を1度済ませて基準の行がある workspace の盤面(既定は保護ブランチに隠せない `.claude` を持つ)。`pickup: false` は基準の行が無い盤面。 */
  async function board(name: string, options: { workspace?: WorkspaceConfig; codex?: CodexWorkspaceCheck; githubAuth?: GitHubAuth; pickup?: boolean } = {}) {
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const ws = options.workspace ?? (await workspaceWithSymlinkedClaude(name));
    const base = await tempDir("tidepool-containment-workbenches-");
    const picked = registerTask(db, { type: "work", title: "the pickup", purpose: "p", completion_criteria: "c", workspace: ws.name }, clock.now(), ...HUMAN_WEBUI);
    if (options.pickup !== false) await prepareAtPickup(db, ws, picked);
    let current = ws;
    const checks = quarantineChecks({
      db,
      clock,
      // 本番の resolver と同じく、宣言の確かめは今の registry を読む
      resolveWorkspace: () => withRememberedRepoCheck(db, current, () => clock.now(), () => current),
      workspacesDir: base,
      codexWorkspaceContainment: options.codex,
      githubAuth: options.githubAuth,
    });
    const deps = { db, pollNow() {}, landing: unusedLanding, quarantineChecks: checks };
    const value = (harness: Harness) => workspaceContainmentValue(harness, ws.name);
    const stop = (harness: Harness = "claude-code", reason = "the pair's reason") => stopContainmentPair(db, harness, ws, reason, base, clock.now());
    const question = (harness: Harness = "claude-code") => quarantineQuestion(db, "workspaceContainment", value(harness))!;
    const answer = (harness: Harness = "claude-code") => submitAnswer(deps, question(harness), ["repaired by hand"], undefined, () => clock.now(), "webui");
    const answerWorkspace = () => submitAnswer(deps, quarantineQuestion(db, "workspace", ws.name)!, ["repaired by hand"], undefined, () => clock.now(), "webui");
    const workbench = () => realpathSync(workbenchPath(base, { workspace: ws.name }));
    /** 作業台で `.claude` を実ディレクトリに直して commit し、その tip を返す。 */
    const repairInWorkbench = async () => {
      await makeClaudeADirectory(workbench());
      git(workbench(), "add", "-A");
      git(workbench(), "commit", "-m", "make .claude a directory");
      return git(workbench(), "rev-parse", "HEAD");
    };
    const takenIn = () => listEventsOfKinds(db, ["workbench_taken_in"]);
    /** 今の保護ブランチを控え、拒否が何も書いていないことを確かめる手を返す。 */
    const unchanged = (harness: Harness = "claude-code") => {
      const main = git(ws.path, "rev-parse", "refs/heads/main");
      const id = question(harness).id;
      return () => {
        expect(git(ws.path, "rev-parse", "refs/heads/main")).toBe(main);
        expect(takenIn()).toEqual([]);
        expect(getTask(db, id)?.status).toBe("todo");
      };
    };
    return { db, clock, ws, base, stop, question, answer, answerWorkspace, workbench, repairInWorkbench, takenIn, unchanged, publish: (published: WorkspaceConfig) => { current = published; } };
  }

  /** 盤面の workspace を bare の origin へ公開して remote-backed にし、origin の在り処を返す。 */
  async function becomeRemoteBacked(b: Awaited<ReturnType<typeof board>>) {
    const origin = await tempDir("tidepool-became-remote-origin-");
    git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
    // 本番の publish と同じく origin を足し、remote-tracking ref は盤面の口を通して書く
    writeBoardRefs(b.db, b.ws, [["refs/remotes/origin/main", git(b.ws.path, "rev-parse", "main")]], () => {
      git(b.ws.path, "remote", "add", "origin", origin);
      git(b.ws.path, "push", "--quiet", "origin", "main");
    });
    const published = { ...b.ws, repo: origin };
    rememberPublishedRepo(b.db, published);
    b.publish(published);
    return origin;
  }

  /** 検査を止めておける (codex, workspace) の検査 —— `release` まで答えない。 */
  function heldCodexCheck() {
    let release!: (capability: { available: true }) => void;
    const check: CodexWorkspaceCheck = vi.fn(() => new Promise<{ available: true }>((resolve) => { release = resolve; }));
    return { check, release: () => release({ available: true }) };
  }

  describe("組の登録", () => {
    it("purely-local の (claude-code, B) の登録は保護ブランチの作業台を開き、止めた資源と question の本文は同じ理由を運ぶ", async () => {
      const b = await board("pair-register");

      const stop = b.stop();

      expect(stop).toMatchObject({ quarantine: "workspaceContainment", value: "claude-code/pair-register" });
      expect(git(b.workbench(), "rev-parse", "HEAD")).toBe(git(b.ws.path, "rev-parse", "main"));
      expect(b.question().purpose).toContain(`${stop.reason} Workspaces that have not captured a baseline yet`);
    });

    it("purely-local の (codex, B) の登録も作業台を開き、理由は今の文に、原因が記録にある場合の道を足す(text G1)", async () => {
      const b = await board("pair-register-codex");

      const { reason } = b.stop("codex");

      expect(reason).toBe(`the pair's reason. If the skill is tracked in the repository: The board opened the workbench at ${b.workbench()}: commit the fix there on main, then answer.`);
      expect(git(b.workbench(), "rev-parse", "HEAD")).toBe(git(b.ws.path, "rev-parse", "main"));
    });

    it("remote-backed の (codex, B) の登録は作業台を開かず、原因が記録にある場合の道は origin を言う(text G1)", async () => {
      const { workspace } = await makeRemoteBackedWorkspace("pair-register-codex-remote");
      const b = await board("pair-register-codex-remote", { workspace });

      expect(b.stop("codex").reason).toBe("the pair's reason. If the skill is tracked in the repository: Push the fix to origin's main from your own clone, then answer.");

      expect(existsSync(workbenchPath(b.base, { workspace: workspace.name }))).toBe(false);
    });

    it("remote-backed の workspace には作業台を開かず、理由は origin へ push する道を言う(text B8)", async () => {
      const { workspace } = await makeRemoteBackedWorkspace("pair-register-remote");
      const b = await board("pair-register-remote", { workspace });

      expect(b.stop().reason).toBe("the pair's reason. Push the fix to origin's main from your own clone, then answer.");

      expect(existsSync(workbenchPath(b.base, { workspace: workspace.name }))).toBe(false);
    });

    it("面接室の名前の組には作業台を開かない", async () => {
      const db = openDb(":memory:");
      const clock = new FakeClock();
      const ws = await makeWorkspace("pair-register-room");
      const base = await tempDir("tidepool-containment-workbenches-");
      const root = registerTask(db, { type: "interview", title: "an interview", hypothesis: "h", tier: "standard", workspace: ws.name, interview_targets: [{ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }] }, clock.now(), ...HUMAN_WEBUI);

      const stop = stopContainmentPair(db, "codex", { ...ws, name: root.id }, "the room's reason", base, clock.now());

      expect(stop.reason).toBe("the room's reason");
      expect(existsSync(workbenchPath(base, { workspace: root.id }))).toBe(false);
      expect(quarantineQuestion(db, "workspaceContainment", workspaceContainmentValue("codex", root.id))).toBeDefined();
    });

    it("作業台を開けなくても組は止まり、理由は開けなかったことと開き直す手を言う(fail-closed)", async () => {
      const b = await board("pair-register-failed");
      const notADirectory = join(b.base, "a-file");
      await writeFile(notADirectory, "");

      const stop = stopContainmentPair(b.db, "claude-code", b.ws, "the pair's reason", notADirectory, b.clock.now());

      expect(stop.reason).toMatch(/^the pair's reason\. The board could not open the workbench \(.+\); open it with `open_workbench`, commit the fix there on main, then answer\.$/s);
      expect(b.question().purpose).toContain("The board could not open the workbench");
    });

    it("作業台が保護ブランチに無い commit をすでに持てば、理由はそれと捨て方を言い、commit は動かさない(ADR 0382 決定4)", async () => {
      const b = await board("pair-register-held");
      b.stop("codex");
      commitWork(b.workbench(), "notes.txt", "the human's\n");
      const held = git(b.workbench(), "rev-parse", "HEAD");

      const stop = b.stop();

      expect(stop.reason).toBe(
        `the pair's reason. The board opened the workbench at ${b.workbench()}: commit the fix there on main, then answer. ` +
          "The workbench already holds commits that main does not have; to start over from the board's value, run `git reset --hard board/main` there.",
      );
      expect(git(b.workbench(), "rev-parse", "HEAD")).toBe(held);
    });

    it("disk にある作業台は次の組の停止が作り直さず、無視された file が残り、board/* だけを引き直す(ADR 0373 決定9)", async () => {
      const workspace = await workspaceWithSymlinkedClaude("pair-register-idempotent");
      commitWork(workspace.path, ".gitignore", ".env\n");
      const b = await board("pair-register-idempotent", { workspace });
      b.stop("codex");
      await writeFile(join(b.workbench(), ".env"), "SECRET=1\n");
      git(b.ws.path, "commit", "--quiet", "--allow-empty", "-m", "the protected branch moves on");

      b.stop();

      expect(readFileSync(join(b.workbench(), ".env"), "utf8")).toBe("SECRET=1\n");
      expect(git(b.workbench(), "rev-parse", "board/main")).toBe(git(b.ws.path, "rev-parse", "main"));
    });

    it("書く先の branch が無い作りかけは次の組の停止が作り直す(ADR 0382 決定5・6)", async () => {
      const b = await board("pair-register-half-made");
      b.stop("codex");
      git(b.workbench(), "symbolic-ref", "HEAD", "refs/heads/elsewhere");
      git(b.workbench(), "update-ref", "-d", "refs/heads/main");

      b.stop();

      expect(git(b.workbench(), "rev-parse", "refs/heads/main")).toBe(git(b.ws.path, "rev-parse", "main"));
    });

    it("盤面 DB の拒否は組の停止の外へ届く(ADR 0342 決定4)", async () => {
      const b = await board("pair-register-db-refusal");
      const refusal = new Database.SqliteError("database or disk is full", "SQLITE_FULL");
      const refusing = { ...b.ws, checkRememberedRepo: () => { throw refusal; } };

      expect(() => stopContainmentPair(b.db, "claude-code", refusing, "the pair's reason", b.base, b.clock.now())).toThrow(refusal);

      expect(quarantineQuestion(b.db, "workspaceContainment", "claude-code/pair-register-db-refusal")).toBeUndefined();
    });
  });

  describe("purely-local の (claude-code, B) の回答", () => {
    it("作業台の直しを検査して取り込み、作業台を残して text C6 を返す —— 人間しか書けない path も通る(pin A7・A19)", async () => {
      const b = await board("repair-intake");
      b.stop();
      const before = git(b.ws.path, "rev-parse", "main");
      const tip = await b.repairInWorkbench();
      const id = b.question().id;

      const answered = await b.answer();

      expect(getTask(b.db, id)?.status).toBe("done");

      const main = git(b.ws.path, "rev-parse", "main");
      expect(git(b.ws.path, "rev-list", "--parents", "-n", "1", "main").split(" ")).toEqual([main, before, tip]);
      expect(git(b.ws.path, "show", "main:.claude/settings.json")).toBe("{}");
      expect(b.takenIn().map((event) => event.payload)).toEqual([
        { kind: "workbench_taken_in", workspace: b.ws.name, target: "refs/heads/main", tip, commit: main, entry: "containment_quarantine" },
      ]);
      expect(answered.notice).toBe(`took ${tip} in as ${main} on main. In a clone, fetch the workbench and fast-forward to \`board/main\` before you write on.`);
      expect(git(b.workbench(), "rev-parse", "main")).toBe(main);
    });

    it("書き込む tree がまだ隠せない形を持てば、ref を書く前に拒み保護ブランチは動かない(pin A19)", async () => {
      const b = await board("repair-still-unhideable");
      b.stop();
      commitWork(b.workbench(), "notes.txt", "not the fix\n");
      const nothingWritten = b.unchanged();

      await expect(b.answer()).rejects.toThrow(
        new DomainError(`the tip of the workbench at ${b.workbench()} changes .claude, which is a shape the board cannot hide; take that change out and commit, then answer again.`),
      );

      nothingWritten();
    });

    it("取り込むものが無ければ検査だけをする —— 保護ブランチに形が残れば組の検査の文で拒み、text A8b では拒まない(pin A19)", async () => {
      const b = await board("repair-nothing-refused");
      b.stop();
      const nothingWritten = b.unchanged();

      await expect(b.answer()).rejects.toThrow(`claude-code containment in workspace ${b.ws.name} is still not established: the recorded tree of refs/heads/main`);

      nothingWritten();
    });

    it("組の検査の拒否は直す先に作業台を言う(text B8)", async () => {
      const b = await board("repair-refusal-names-workbench");
      b.stop();

      await expect(b.answer()).rejects.toThrow(/ on main\. The board opened the workbench at .+: commit the fix there on main, then answer\.$/);
      await expect(b.answer()).rejects.toThrow(` The board opened the workbench at ${b.workbench()}: `);
    });

    it("作業台が disk に無ければ、組の検査の拒否は `open_workbench` の出口で終わる", async () => {
      const b = await board("repair-refusal-no-workbench");
      b.stop();
      await rm(b.workbench(), { recursive: true });

      await expect(b.answer()).rejects.toThrow(/ on main\. No workbench is open: open it with `open_workbench`, commit the fix there on main, then answer\.$/);
    });

    it("workspace の Quarantine が開いている間、取り込むものがある回答は text A8a で拒み何も書かない(ADR 0371 決定6)", async () => {
      const b = await board("repair-workspace-quarantined");
      b.stop();
      await b.repairInWorkbench();
      quarantineWorkspace(b.db, b.ws.name, new Error("a stop of the workspace"), b.clock.now());
      const nothingWritten = b.unchanged();

      await expect(b.answer()).rejects.toThrow(
        new DomainError(`workspace ${b.ws.name} is quarantined — answer question ${quarantineQuestion(b.db, "workspace", b.ws.name)!.id} first.`),
      );

      nothingWritten();
    });

    it("workspace の Quarantine が開いていても、取り込むものが無ければ検査だけをして受理する", async () => {
      const b = await board("repair-quarantined-nothing", { workspace: await makeWorkspace("repair-quarantined-nothing") });
      b.stop();
      quarantineWorkspace(b.db, b.ws.name, new Error("a stop of the workspace"), b.clock.now());
      const id = b.question().id;

      await b.answer();

      expect(getTask(b.db, id)?.status).toBe("done");
    });

    it("取り込むものが無く保護ブランチに形が無ければ、何も取り込まずに受理する(pin A19)", async () => {
      const b = await board("repair-nothing-accepted", { workspace: await makeWorkspace("repair-nothing-accepted") });
      b.stop();
      const main = git(b.ws.path, "rev-parse", "main");
      const id = b.question().id;

      const answered = await b.answer();

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(git(b.ws.path, "rev-parse", "main")).toBe(main);
      expect(b.takenIn()).toEqual([]);
      expect(answered.notice).toBeUndefined();
    });

    it("未決着の task の commit を持つ tip は、相手の question と reset の出口を言って拒む(text A8c)", async () => {
      const b = await board("repair-other-task");
      const other = registerTask(b.db, { type: "work", title: "another task", purpose: "p", completion_criteria: "c", workspace: b.ws.name }, b.clock.now(), ...HUMAN_WEBUI);
      const place = await prepareAtPickup(b.db, b.ws, other);
      commitWork(place.path, "other.txt", "the task's\n");
      recordTaskCheckoutTip(b.db, place as TaskCheckoutPlace, other.id);
      const landing = registerTask(b.db, {
        type: "question", title: "land it", purpose: "a human decides", completion_criteria: "answered",
        question: [{ title: "land it", options: ["merge", "hold"], recommendation: "merge" }],
        question_kind: { kind: "local_merge", task_id: other.id },
      }, b.clock.now(), ...HUMAN_WEBUI);
      b.stop();
      git(b.workbench(), "merge", "--quiet", "--no-edit", `board/task/${other.id}`);
      await b.repairInWorkbench();
      const nothingWritten = b.unchanged();

      await expect(b.answer()).rejects.toThrow(
        new DomainError(
          `the tip of the workbench at ${b.workbench()} contains commits of task/${other.id}, and that task's work enters main only through its landing — answer \`merge\` on question ${landing.id}. ` +
            "To take in only your own commits, start main in the workbench over with `git reset --hard board/main`, commit them again and answer again.",
        ),
      );

      nothingWritten();
    });

    it("書く先の branch が無い作業台は、開き直して答え直すよう拒む(ADR 0382 決定6)", async () => {
      const b = await board("repair-half-made");
      b.stop();
      git(b.workbench(), "symbolic-ref", "HEAD", "refs/heads/elsewhere");
      git(b.workbench(), "update-ref", "-d", "refs/heads/main");
      const nothingWritten = b.unchanged();

      await expect(b.answer()).rejects.toThrow(
        new DomainError(`the workbench at ${b.workbench()} has no main branch, so the board cannot tell what to take in. Open it again, then answer again.`),
      );

      nothingWritten();
    });

    it("回答の時点で remote-backed になっていれば何も取り込まず origin の道を通り、拒むときは text A8e を言う", async () => {
      const b = await board("repair-became-remote");
      b.stop();
      await b.repairInWorkbench();
      const origin = await becomeRemoteBacked(b);
      const nothingWritten = b.unchanged();

      await expect(b.answer()).rejects.toThrow(
        ` Push the fix to origin's main from your own clone, then answer. Commits you made in the workbench at ${b.workbench()} are not taken in: fetch them from the workbench into your own clone and carry them from there.`,
      );
      nothingWritten();

      const human = await tempDir("tidepool-repair-became-remote-human-");
      git(human, "clone", "--quiet", origin, ".");
      await makeClaudeADirectory(human);
      git(human, "add", "-A");
      git(human, "commit", "-m", "make .claude a directory");
      git(human, "push", "--quiet", "origin", "main");
      const id = b.question().id;

      await b.answer();

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(b.takenIn()).toEqual([]);
    });
  });

  it("remote-backed の (claude-code, B) の回答の拒否も origin の道を言う(ADR 0379 決定7)", async () => {
    const { workspace } = await makeRemoteBackedWorkspace("claude-remote-refusal-route");
    const human = await tempDir("tidepool-claude-remote-route-human-");
    git(human, "clone", "--quiet", workspace.repo!, ".");
    await commitSymlinkedClaude(human);
    git(human, "push", "--quiet", "origin", "main");
    git(workspace.path, "fetch", "--quiet", "origin");
    const b = await board("claude-remote-refusal-route", { workspace });
    b.stop();

    await expect(b.answer()).rejects.toThrow(/ Push the fix to origin's main from your own clone, then answer\.$/);
  });

  describe("基準との比較", () => {
    it.each(["claude-code", "codex"] as const)("先頭で ref が基準と違えば (%s, B) の回答を拒み、workspace の Quarantine を立ててその id を言い、基準は撮り直さない(pin B15)", async (harness) => {
      const check = vi.fn<CodexWorkspaceCheck>(async () => ({ available: true }));
      const b = await board(`compare-head-${harness}`, { codex: check });
      b.stop(harness);
      if (harness === "claude-code") await b.repairInWorkbench();
      const stray = git(b.ws.path, "rev-parse", "main");
      git(b.ws.path, "branch", "stray");
      const nothingWritten = b.unchanged(harness);

      const refusal = await b.answer(harness).catch((err: unknown) => err as Error);

      const workspaceQuestion = quarantineQuestion(b.db, "workspace", b.ws.name)!;
      expect(refusal).toBeInstanceOf(DomainError);
      expect((refusal as Error).message).toBe(
        `workspace ${b.ws.name}: refs changed while the containment Quarantine was open — now: ${stray} refs/heads/stray. Answer the workspace Quarantine (question ${workspaceQuestion.id}) first.`,
      );
      expect(check).not.toHaveBeenCalled();
      nothingWritten();
      // 基準を撮り直していれば、次の回答は通る
      await expect(b.answer(harness)).rejects.toThrow(`now: ${stray} refs/heads/stray.`);
    });

    it("remote-backed になった workspace の先頭の比較の拒否も text A8e を言う", async () => {
      const b = await board("compare-became-remote");
      b.stop();
      await becomeRemoteBacked(b);
      git(b.ws.path, "branch", "stray");

      await expect(b.answer()).rejects.toThrow(
        new RegExp(`refs/heads/stray\\. Answer the workspace Quarantine \\(question [^)]+\\) first\\. Push the fix to origin's main from your own clone, then answer\\. Commits you made in the workbench at .+ are not taken in: `),
      );
    });

    it("remote-backed の回答は fetch の間に動いた ref を fetch の後の比較で捕まえる(pin B15)", async () => {
      const { workspace } = await makeRemoteBackedWorkspace("compare-after-fetch");
      git(workspace.path, "fetch", "--quiet", "origin");
      let during = () => {};
      const githubAuth = { ensureToken: async () => during(), env: () => process.env } as unknown as GitHubAuth;
      const b = await board("compare-after-fetch", { workspace, githubAuth });
      b.stop();
      during = () => git(workspace.path, "branch", "moved-during-the-fetch");

      await expect(b.answer()).rejects.toThrow(/refs\/heads\/moved-during-the-fetch\. Answer the workspace Quarantine \(question [^)]+\) first\.$/);

      expect(quarantineQuestion(b.db, "workspace", workspace.name)).toBeDefined();
      expect(getTask(b.db, b.question().id)?.status).toBe("todo");
    });

    it("remote-backed の回答は origin の直しを引いても基準と食い違わず受理される", async () => {
      const { workspace, publish } = await makeRemoteBackedWorkspace("compare-remote-clean");
      git(workspace.path, "fetch", "--quiet", "origin");
      const b = await board("compare-remote-clean", { workspace });
      b.stop();
      publish("fix.txt", "the fix\n", "the fix on origin");
      const id = b.question().id;

      await b.answer();

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(quarantineQuestion(b.db, "workspace", workspace.name)).toBeUndefined();
    });

    it("purely-local の回答は先頭で1回だけ比べる —— 検査の間に動いた ref では拒まない(pin B23)", async () => {
      const held = heldCodexCheck();
      const b = await board("compare-once", { codex: held.check });
      b.stop("codex");
      const id = b.question("codex").id;

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());
      git(b.ws.path, "branch", "moved-during-the-check");
      held.release();
      await answering;

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(quarantineQuestion(b.db, "workspace", b.ws.name)).toBeUndefined();
    });

    it("基準の行が無い名前は比べず行も作らない(ADR 0373 決定7)", async () => {
      const db = openDb(":memory:");
      const clock = new FakeClock();
      const workspace = await makeWorkspace("B");
      registerQuarantine(db, "workspaceContainment", "codex/B", "flat stays enabled", clock.now());
      const question = quarantineQuestion(db, "workspaceContainment", "codex/B")!;
      const checks = quarantineChecks({ db, resolveWorkspace: () => workspace, workspacesDir: await tempDir("tidepool-no-baseline-checkouts-"), codexWorkspaceContainment: async () => ({ available: true }) });

      await submitAnswer({ db, pollNow() {}, landing: unusedLanding, quarantineChecks: checks }, question, ["repaired by hand"], undefined, () => clock.now(), "webui");

      expect(getTask(db, question.id)?.status).toBe("done");
      expect(holdsBaseline(db, "B")).toBe(false);
    });

    it("基準の行が無い名前の比較は repo でない場所を読まない(ADR 0373 決定7)", async () => {
      const db = openDb(":memory:");
      const path = await realpath(await tempDir("tidepool-not-a-repository-"));

      expect(() => compareContainmentRefs(db, { name: "B", path, branch: "main" }, new Date(0))).not.toThrow();

      expect(holdsBaseline(db, "B")).toBe(false);
    });

    it("基準の行が無い名前の作業台に取り込むものがあれば、比べずに書かず開き直しを言う(ADR 0383 決定2)", async () => {
      const b = await board("repair-no-baseline", { pickup: false });
      b.stop();
      await b.repairInWorkbench();
      const main = git(b.ws.path, "rev-parse", "main");

      await expect(b.answer()).rejects.toThrow(`the board holds no baseline for workspace ${b.ws.name}, so it cannot check main — open the workbench again (\`open_workbench\`), then answer again.`);

      expect(git(b.ws.path, "rev-parse", "main")).toBe(main);
      expect(b.takenIn()).toEqual([]);
    });

    it("基準の行が無い名前の作業台に取り込むものが無ければ、検査だけをして受理する(ADR 0373 決定7)", async () => {
      const b = await board("repair-no-baseline-nothing", { workspace: await makeWorkspace("repair-no-baseline-nothing"), pickup: false });
      b.stop();
      const id = b.question().id;

      await b.answer();

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(holdsBaseline(b.db, b.ws.name)).toBe(false);
    });
  });

  describe("(codex, B) の回答は記録を読む(ADR 0379 決定1・2・7、pin G1・G2・G5)", () => {
    /** 本物の検査を、cwd の disk に skill があるときだけ閉じきれないと答える app-server へ繋ぐ。`seen` は列挙された cwd と、そのとき git repo だったか。 */
    async function codexReadingTheDisk() {
      const seen: Array<{ cwd: string; repository: boolean }> = [];
      const appServer = fakeAppServerCall((args, cwds) => {
        seen.push(...cwds.map((cwd) => ({ cwd, repository: existsSync(join(cwd, ".git")) })));
        return answerSkillsFromDisk(args, cwds);
      });
      const check = createCodexWorkspaceCheck({ executable: "/opt/tidepool/bin/codex", codexHome: await tempDir("tidepool-codex-home-"), call: appServer.call });
      return { check, seen };
    }

    it("名前の場所の作業ツリーにだけある untracked な skill では落ちず、検査した checkout は git repo で、検査の後に消え、名前の場所は何も変わらない(pin G1・G2)", async () => {
      const codex = await codexReadingTheDisk();
      const b = await board("codex-record", { workspace: await makeWorkspace("codex-record"), codex: codex.check });
      b.stop("codex");
      await mkdir(join(b.ws.path, ".agents", "skills", "flat"), { recursive: true });
      await writeFile(join(b.ws.path, CODEX_DISK_SKILL), "only in the named place\n");
      const named = () => [git(b.ws.path, "for-each-ref"), git(b.ws.path, "status", "--porcelain"), git(b.ws.path, "count-objects", "-v")];
      const before = named();
      const id = b.question("codex").id;

      await b.answer("codex");

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(codex.seen.length).toBeGreaterThan(0);
      for (const { cwd, repository } of codex.seen) {
        expect(cwd).not.toBe(realpathSync(b.ws.path));
        expect(repository).toBe(true);
        expect(existsSync(cwd)).toBe(false);
      }
      expect(named()).toEqual(before);
    });

    /** `.agents/skills/flat/SKILL.md` を `dir` の今の branch に commit する。 */
    async function commitSkill(dir: string) {
      await mkdir(join(dir, ".agents", "skills", "flat"), { recursive: true });
      await writeFile(join(dir, CODEX_DISK_SKILL), "a tracked skill\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "track a skill");
    }

    /** `dir` の今の branch から skill を消して commit し、その tip を返す。 */
    function removeSkill(dir: string) {
      git(dir, "rm", "--quiet", "-r", ".agents");
      git(dir, "commit", "-m", "drop the skill");
      return git(dir, "rev-parse", "HEAD");
    }

    /** 保護ブランチに skill を持つ workspace の盤面で (codex, B) の組を止める。 */
    async function stoppedCodexPair(name: string, codex: CodexWorkspaceCheck) {
      const workspace = await makeWorkspace(name);
      await commitSkill(workspace.path);
      const b = await board(name, { workspace, codex });
      b.stop("codex");
      return b;
    }

    it("保護ブランチの tip に tracked な skill が残れば今の文に text G1 を足して拒み、検査した checkout は消える", async () => {
      const codex = await codexReadingTheDisk();
      const b = await stoppedCodexPair("codex-tracked", codex.check);
      const nothingWritten = b.unchanged("codex");

      const refusal = await b.answer("codex").catch((err: unknown) => err as Error);

      expect(refusal).toBeInstanceOf(DomainError);
      expect((refusal as Error).message).toMatch(/^codex containment in workspace codex-tracked is still not established: Under the board's closed skills\.config, /);
      expect((refusal as Error).message).toContain(`Codex still reports these skills enabled: flat (${CODEX_DISK_SKILL}).`);
      expect((refusal as Error).message).not.toContain("@containment-check");
      expect((refusal as Error).message).toMatch(new RegExp(`remove or disable them there\\. If the skill is tracked in the repository: The board opened the workbench at ${b.workbench()}: commit the fix there on main, then answer\\.$`));
      expect(codex.seen.every(({ cwd }) => !existsSync(cwd))).toBe(true);
      nothingWritten();
    });

    it("1手の道: 作業台の直しは、検査を通ってから保護ブランチへ取り込まれる(ADR 0371 決定6 / ADR 0379 決定6、pin G5)", async () => {
      const codex = await codexReadingTheDisk();
      const b = await stoppedCodexPair("codex-one-step", codex.check);
      const before = git(b.ws.path, "rev-parse", "main");
      const tip = removeSkill(b.workbench());
      const id = b.question("codex").id;

      const answered = await b.answer("codex");

      const main = git(b.ws.path, "rev-parse", "main");
      expect(getTask(b.db, id)?.status).toBe("done");
      expect(git(b.ws.path, "rev-list", "--parents", "-n", "1", "main").split(" ")).toEqual([main, before, tip]);
      expect(b.takenIn().map((event) => event.payload)).toEqual([
        { kind: "workbench_taken_in", workspace: b.ws.name, target: "refs/heads/main", tip, commit: main, entry: "containment_quarantine" },
      ]);
      expect(answered.notice).toBe(`took ${tip} in as ${main} on main. In a clone, fetch the workbench and fast-forward to \`board/main\` before you write on.`);
      expect(codex.seen.every(({ cwd, repository }) => repository && !existsSync(cwd))).toBe(true);
    });

    it("取り込む tip の検査も git repo の使い捨ての checkout で走り、検査の間に名前の場所は何も変わらず、検査の後に checkout は消える(pin G2)", async () => {
      const held = heldCodexCheck();
      const b = await stoppedCodexPair("codex-tip-record", held.check);
      removeSkill(b.workbench());
      const named = () => [git(b.ws.path, "for-each-ref"), git(b.ws.path, "status", "--porcelain"), git(b.ws.path, "count-objects", "-v")];
      const before = named();

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());
      const { path } = vi.mocked(held.check).mock.calls[0]![0];
      expect(existsSync(join(path, ".git"))).toBe(true);
      expect(existsSync(join(path, CODEX_DISK_SKILL))).toBe(false);
      expect(named()).toEqual(before);
      held.release();
      await answering;

      expect(existsSync(path)).toBe(false);
    });

    it("取り込みの記録の時刻は検査を待った後の時刻(ADR 0371 決定6)", async () => {
      const held = heldCodexCheck();
      const b = await stoppedCodexPair("codex-intake-time", held.check);
      removeSkill(b.workbench());

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());
      await b.clock.advance(60_000);
      const afterTheCheck = b.clock.now().toISOString();
      held.release();
      await answering;

      expect(b.takenIn().map((event) => event.created_at)).toEqual([afterTheCheck]);
    });

    it("取り込むものが無い検査の間に workspace が公開されても、偽の workspace の Quarantine を立てず、拒否は origin の道を言う(ADR 0378 決定7)", async () => {
      let release = () => {};
      const b = await stoppedCodexPair("codex-race-published-nothing", () =>
        new Promise((resolve) => {
          release = () => resolve({ available: false, reason: "the skill stays enabled" });
        }));
      const id = b.question("codex").id;

      const answering = b.answer("codex").catch((err: unknown) => err as Error);
      await vi.waitFor(() => expect(existsSync(join(b.base, "@containment-check"))).toBe(true));
      await becomeRemoteBacked(b);
      release();
      const refusal = await answering;

      expect((refusal as Error).message).toMatch(/^codex containment in workspace codex-race-published-nothing is still not established: the skill stays enabled\. If the skill is tracked in the repository: Push the fix to origin's main from your own clone, then answer\./);
      expect(quarantineQuestion(b.db, "workspace", b.ws.name)).toBeUndefined();
      expect(getTask(b.db, id)?.status).toBe("todo");
    });

    it("作業台の tip にまだ skill があれば、何も書かずに text G1 で拒む(ADR 0371 決定6)", async () => {
      const codex = await codexReadingTheDisk();
      const b = await stoppedCodexPair("codex-tip-still-open", codex.check);
      commitWork(b.workbench(), "notes.txt", "not the fix\n");
      const nothingWritten = b.unchanged("codex");

      await expect(b.answer("codex")).rejects.toThrow(`If the skill is tracked in the repository: The board opened the workbench at ${b.workbench()}: commit the fix there on main, then answer.`);

      nothingWritten();
      expect(codex.seen.every(({ cwd }) => !existsSync(cwd))).toBe(true);
    });

    it("2手の道: `open_workbench` → `take in` の後の回答は、保護ブランチの tip を検査して受理する(pin G5)", async () => {
      const codex = await codexReadingTheDisk();
      const b = await stoppedCodexPair("codex-two-steps", codex.check);
      const caller = { actorId: "human", origin: "webui" } as const;
      await openHumanContentWorkbench(b.db, b.ws, b.base, caller, b.clock.now(), { resolveRegistered: undefined });
      const tip = removeSkill(b.workbench());
      takeInHumanContentWorkbench(b.db, b.ws, { workbenchBase: b.base, answerer: caller, now: b.clock.now() });
      const id = b.question("codex").id;

      await b.answer("codex");

      expect(getTask(b.db, id)?.status).toBe("done");
      expect(b.takenIn().map((event) => event.payload)).toMatchObject([{ tip, entry: "intake_question" }]);
    });

    it.each([
      ["別の commit へ動いた", "codex-race-moved", (workbench: string) => commitWork(workbench, "later.txt", "after the check\n")],
      ["保護ブランチの値へ戻された", "codex-race-reset", (workbench: string) => git(workbench, "reset", "--quiet", "--hard", "board/main")],
    ])("検査の間に作業台の tip が%sら、検査していない tree を書かずに拒む(ADR 0371 決定6)", async (_case, name, move) => {
      const held = heldCodexCheck();
      const b = await stoppedCodexPair(name, held.check);
      const tip = removeSkill(b.workbench());
      const nothingWritten = b.unchanged("codex");

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());
      move(b.workbench());
      held.release();

      await expect(answering).rejects.toThrow(new DomainError(`main in the workbench at ${b.workbench()} is no longer ${tip}, the tip the board checked, so nothing was taken in. Answer again to check the tip it has now.`));
      nothingWritten();
    });

    it("検査の間に作業台が消えたら、検査した tip を取り込んだことにせず拒む(ADR 0371 決定6)", async () => {
      const held = heldCodexCheck();
      const b = await stoppedCodexPair("codex-race-removed", held.check);
      const tip = removeSkill(b.workbench());
      const workbench = b.workbench();
      const nothingWritten = b.unchanged("codex");

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());
      await rm(workbench, { recursive: true });
      held.release();

      await expect(answering).rejects.toThrow(`is no longer ${tip}, the tip the board checked`);
      nothingWritten();
    });

    it("検査の間に workspace が公開されたら、保護ブランチへ書かず origin の道と text A8e で拒む(ADR 0371 決定6)", async () => {
      const held = heldCodexCheck();
      const b = await stoppedCodexPair("codex-race-published", held.check);
      removeSkill(b.workbench());
      const nothingWritten = b.unchanged("codex");

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());
      await becomeRemoteBacked(b);
      held.release();

      await expect(answering).rejects.toThrow(
        new DomainError(
          `workspace ${b.ws.name} became remote-backed while the board was checking the workbench tip. Push the fix to origin's main from your own clone, then answer. ` +
            `Commits you made in the workbench at ${b.workbench()} are not taken in: fetch them from the workbench into your own clone and carry them from there.`,
        ),
      );
      nothingWritten();
    });

    it("検査が投げても、書き込む tree の checkout は消え、何も書かない", async () => {
      const paths: string[] = [];
      const b = await stoppedCodexPair("codex-check-throws", async (place) => {
        paths.push(place.path);
        throw new Error("the check broke");
      });
      removeSkill(b.workbench());
      const nothingWritten = b.unchanged("codex");

      await expect(b.answer("codex")).rejects.toThrow(new DomainError("the check broke"));

      expect(paths).toHaveLength(1);
      expect(existsSync(paths[0]!)).toBe(false);
      nothingWritten();
    });

    it("使い捨ての checkout を作れなければ、理由を言って拒み検査を撃たない(fail-closed)", async () => {
      const check = vi.fn<CodexWorkspaceCheck>(async () => ({ available: true }));
      const b = await stoppedCodexPair("codex-no-checkout", check);
      await writeFile(join(b.base, "@containment-check"), "not a directory\n");

      await expect(b.answer("codex")).rejects.toThrow(/^the throwaway checkout of main cannot be created: /);

      expect(check).not.toHaveBeenCalled();
      expect(getTask(b.db, b.question("codex").id)?.status).toBe("todo");
    });

    it("workspace の Quarantine が開いている間、取り込むものがある回答は Board call を撃たずに text A8a で拒む(ADR 0371 決定6)", async () => {
      const check = vi.fn<CodexWorkspaceCheck>(async () => ({ available: true }));
      const b = await stoppedCodexPair("codex-workspace-quarantined", check);
      removeSkill(b.workbench());
      quarantineWorkspace(b.db, b.ws.name, new Error("a stop of the workspace"), b.clock.now());
      const nothingWritten = b.unchanged("codex");

      await expect(b.answer("codex")).rejects.toThrow(
        new DomainError(`workspace ${b.ws.name} is quarantined — answer question ${quarantineQuestion(b.db, "workspace", b.ws.name)!.id} first.`),
      );

      expect(check).not.toHaveBeenCalled();
      nothingWritten();
    });

    describe("remote-backed", () => {
      /** origin の保護ブランチに skill を持つ remote-backed の盤面と、origin へ push できる人間の clone。 */
      async function remoteWithTrackedSkill(name: string, codex: CodexWorkspaceCheck, githubAuth?: GitHubAuth) {
        const { workspace } = await makeRemoteBackedWorkspace(name);
        const human = await tempDir("tidepool-codex-remote-human-");
        git(human, "clone", "--quiet", workspace.repo!, ".");
        await commitSkill(human);
        git(human, "push", "--quiet", "origin", "main");
        git(workspace.path, "fetch", "--quiet", "origin");
        const b = await board(name, { workspace, codex, githubAuth });
        b.stop("codex");
        return { b, human, origin: workspace.repo! };
      }

      it("origin の直しを引いてから tip を検査する —— 直す前は origin の道を言って拒み、push の後は受理する(ADR 0379 決定1、pin G5)", async () => {
        const codex = await codexReadingTheDisk();
        const { b, human } = await remoteWithTrackedSkill("codex-remote-fix", codex.check);

        await expect(b.answer("codex")).rejects.toThrow(/remove or disable them there\. If the skill is tracked in the repository: Push the fix to origin's main from your own clone, then answer\.$/);

        removeSkill(human);
        git(human, "push", "--quiet", "origin", "main");
        const id = b.question("codex").id;
        await b.answer("codex");

        expect(getTask(b.db, id)?.status).toBe("done");
        expect(b.takenIn()).toEqual([]);
      });

      it("fetch の失敗は理由を返す回答の拒否で、検査を撃たない(ADR 0379 決定1、pin G5)", async () => {
        const check = vi.fn<CodexWorkspaceCheck>(async () => ({ available: true }));
        const { b, origin } = await remoteWithTrackedSkill("codex-remote-fetch-fails", check);
        await rm(origin, { recursive: true });

        const refusal = await b.answer("codex").catch((err: unknown) => err as Error);

        expect(refusal).toBeInstanceOf(DomainError);
        expect((refusal as Error).message).toContain("origin");
        expect(check).not.toHaveBeenCalled();
        expect(getTask(b.db, b.question("codex").id)?.status).toBe("todo");
      });

      it("fetch の間に動いた ref を fetch の後の比較で捕まえる(ADR 0373 決定10 が Codex の組にも当たる、pin B15)", async () => {
        const check = vi.fn<CodexWorkspaceCheck>(async () => ({ available: true }));
        let during = () => {};
        const githubAuth = { ensureToken: async () => during(), env: () => process.env } as unknown as GitHubAuth;
        const { b } = await remoteWithTrackedSkill("codex-remote-moved", check, githubAuth);
        during = () => git(b.ws.path, "branch", "moved-during-the-fetch");

        await expect(b.answer("codex")).rejects.toThrow(/refs\/heads\/moved-during-the-fetch\. Answer the workspace Quarantine \(question [^)]+\) first\.$/);

        expect(check).not.toHaveBeenCalled();
      });

      it("回答の時点で remote-backed になっていれば何も取り込まず、拒否は origin の道と text A8e を1度だけ言う", async () => {
        const codex = await codexReadingTheDisk();
        const b = await stoppedCodexPair("codex-became-remote", codex.check);
        removeSkill(b.workbench());
        await becomeRemoteBacked(b);
        const nothingWritten = b.unchanged("codex");

        await expect(b.answer("codex")).rejects.toThrow(
          new RegExp(`remove or disable them there\\. If the skill is tracked in the repository: Push the fix to origin's main from your own clone, then answer\\. Commits you made in the workbench at ${b.workbench()} are not taken in: fetch them from the workbench into your own clone and carry them from there\\.$`),
        );

        nothingWritten();
      });
    });
  });

  describe("in-flight の鍵", () => {
    it("検査中の組の回答の間、同じ workspace の別の組の回答と workspace の Quarantine の回答は text B5 で拒まれる(pin B12)", async () => {
      const held = heldCodexCheck();
      const b = await board("in-flight-containment", { codex: held.check });
      b.stop("codex");
      b.stop("claude-code");
      quarantineWorkspace(b.db, b.ws.name, new Error("a stop of the workspace"), b.clock.now());

      const answering = b.answer("codex");
      await vi.waitFor(() => expect(held.check).toHaveBeenCalled());

      await expect(b.answer("claude-code")).rejects.toThrow(new DomainError(anotherAnswerInFlight(b.ws.name)));
      await expect(b.answerWorkspace()).rejects.toThrow(new DomainError(anotherAnswerInFlight(b.ws.name)));
      held.release();
      await answering;
    });

    it("workspace の Quarantine の回答を検査している間、組の回答は text B5 で拒まれる(pin B12)", async () => {
      const b = await board("in-flight-workspace");
      b.stop();
      quarantineWorkspace(b.db, b.ws.name, new Error("a stop of the workspace"), b.clock.now());
      const workspaceQuestion = quarantineQuestion(b.db, "workspace", b.ws.name)!;
      const nothingWritten = b.unchanged();

      const first = b.answerWorkspace();
      await expect(b.answer()).rejects.toThrow(new DomainError(anotherAnswerInFlight(b.ws.name)));
      nothingWritten();
      await first;
      expect(getTask(b.db, workspaceQuestion.id)?.status).toBe("done");
    });
  });
});
