import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexWorkspaceCheck } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { claudeWorkspaceContainment } from "../src/harness-containment.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import type { Provider } from "../src/provider.js";
import { registerQuarantine } from "../src/quarantine.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import type { WorkerAdapter } from "../src/worker.js";
import { openInterviewRoom, type WorkspaceConfig } from "../src/workspace.js";
import {
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
  claudeSpawnOf,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  humanDecomposeTaskViaWebui,
  makeRemoteBackedWorkspace,
  makeWorkspace,
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

it("組を止める理由は記録の ref・名前の場所・隠せない形の path と型を名指し、直す先には保護ブランチを挙げる(ADR 0360 決定1・3)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-reason");
  git(workspace.path, "branch", "trunk");
  const contained = claudeWorkspaceContainment({ ...workspace, branch: "trunk" });

  expect(contained).toEqual({
    available: false,
    reason:
      `the recorded tree of refs/heads/trunk in the named place ${workspace.path} has .claude as a symlink, not a directory — ` +
      "the board cannot hide .claude/settings.json or .claude/settings.local.json behind it from the worker's CLI, " +
      "so commit .claude as a directory on trunk",
  });
});

it("(claude-code, B) の question への回答は、名前の場所の作業ツリーに何があっても保護ブランチの tree にまだ隠せない形があれば拒まれて開いたまま残り、保護ブランチを書き直せば受理される(ADR 0360 決定3・ADR 0259 決定5)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-answer");
  const { answer, status } = claudePairQuestion(workspace);

  await makeClaudeADirectory(workspace.path);
  await expect(answer()).rejects.toThrow("has .claude as a symlink");
  expect(status()).toBe("todo");

  git(workspace.path, "add", "-A");
  git(workspace.path, "commit", "-m", "make .claude a directory");
  await answer();
  expect(status()).toBe("done");
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

it("(codex, B) の question への回答は、その workspace の skill の列挙と観測をもう一度走らせ、閉じきれないうちは拒まれて開いたまま残り、閉じきれれば受理される(ADR 0259 決定5)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const path = await realpath(await tempDir("tidepool-ws-"));
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
      resolveWorkspace: (name) => ({ name: name!, path, branch: "main" }),
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
  expect(appServer.calls.map(({ requests }) => requests[0]!.params.cwds)).toEqual([[path], [path]]);

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
  expect(question.question_items[0]).toMatchObject({ options: ["retry", "abandon"], recommendation: "abandon" });
  expect(question.purpose).toContain(".claude as a symlink");
  expect(question.purpose).toMatch(/retry.*same tree.*branch changes/i);
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, failed.id)).toBeUndefined();
  await vi.waitFor(() => expect(claudeSpawnOf(booted.proc, clean.id)).toBeDefined());
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
  expect(question.question_items[0].recommendation).toBe("abandon");
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${root.id}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, root.id)).toBeUndefined();
});

it("隠せない .claude を継いだ同じ分解判断の兄弟は failure question 1枚で held になり、abandon で両方 cancel される(ADR 0360 決定3・ADR 0048)", async () => {
  const workspace = await makeWorkspace("decomposition-symlink");
  ({ t } = await bootClaudeOn(workspace));
  const parent = queueWork(t, "Parent with a symlink", workspace.name);
  git(workspace.path, "switch", "-c", `task/${parent.id}`);
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
