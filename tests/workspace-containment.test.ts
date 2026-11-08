import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexWorkspaceCheck } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import type { Provider } from "../src/provider.js";
import { registerQuarantine } from "../src/quarantine.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import type { WorkerAdapter } from "../src/worker.js";
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
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  quarantineQuestion,
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
    const onPickupStopped = queueReturnHandler({ db, clock, slot, resolve: undefined, pollNow: () => scheduler.pollNow() }, containers);
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

/** `.claude` を `shared` への symlink として保護ブランチ(main)に commit した workspace —— 盤面が隠せない形(ADR 0360 決定1)。 */
async function workspaceWithSymlinkedClaude(name: string) {
  const workspace = await makeWorkspace(name);
  await mkdir(join(workspace.path, "shared"));
  await writeFile(join(workspace.path, "shared", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } }));
  await symlink("shared", join(workspace.path, ".claude"));
  git(workspace.path, "add", "-A");
  git(workspace.path, "commit", "-m", "share settings through a symlink");
  return workspace;
}

it("task branch の記録の .claude が symlink なら spawn せず、(claude-code, workspace) の組が path と型を名指して止まり、同じ workspace の Codex の行は候補に残る(ADR 0360 決定1・ADR 0259 決定1)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-symlink");
  const booted = await bootClaudeOn(workspace, {
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t!.db, { provider: [{ name: task.assignee === "codex-agent" ? "openai" : "anthropic", advisor: false }], tier: undefined }, task),
  });
  t = booted.t;
  const claude = queueWork(t, "Claude work", workspace.name);

  await t.clock.advance(HOUR);
  const stop = await vi.waitFor(async () => {
    const question = await servedQuarantineQuestion(t!, "workspaceContainment", `claude-code/${workspace.name}`);
    expect(question).toBeDefined();
    return question;
  });
  expect(stop.purpose).toContain(`task/${claude.id}`);
  expect(stop.purpose).toContain("has .claude as a symlink");
  expect(claudeSpawnOf(booted.proc, claude.id)).toBeUndefined();
  expect(await servedQuarantineQuestion(t, "workspace", workspace.name)).toBeUndefined();

  const codex = queueWork(t, "Codex work", workspace.name, "codex-agent");
  const queued = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  const status = (id: string) => queued.find((x) => x.id === id)?.status;
  expect(status(claude.id)).toBe("skipped");
  expect(status(codex.id)).not.toBe("skipped");
});

it("組の question への回答は、名前の場所の作業ツリーに何があっても保護ブランチの tree にまだ隠せない形があれば拒まれ、保護ブランチを書き直せば受理される(ADR 0360 決定3・ADR 0259 決定5)", async () => {
  const workspace = await workspaceWithSymlinkedClaude("pair-answer");
  t = await bootTidepool({ workspace });
  registerQuarantine(t.db, "workspaceContainment", `claude-code/${workspace.name}`, "unhideable .claude", t.clock.now());
  const question = await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`);
  const answer = () => api(t!.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });

  // 作業ツリーでは .claude は実ディレクトリだが、保護ブランチの記録は symlink のまま
  await rm(join(workspace.path, ".claude"));
  await mkdir(join(workspace.path, ".claude"));
  await writeFile(join(workspace.path, ".claude", "settings.json"), "{}");
  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("has .claude as a symlink");
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeDefined();

  git(workspace.path, "add", "-A");
  git(workspace.path, "commit", "-m", "make .claude a directory");
  expect((await answer()).status).toBe(200);
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeUndefined();
});
