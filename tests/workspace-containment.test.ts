import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import type { Provider } from "../src/provider.js";
import { registerQuarantine } from "../src/quarantine.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyOpenai, healthyUsageText, noRetrospectiveCalls, passthroughContainers, unusedLanding } from "./fakes.js";
import {
  api,
  bootTidepool,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  quarantineQuestion,
  servedQuarantineQuestion,
  type Tidepool,
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
      start: (task, setting) => started.push([task.id, setting.provider]),
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
      converge: async () => [],
      db,
      clock,
      slot: new Slot(),
      worker,
      containers: passthroughContainers(),
      onSpawnFailed: () => {},
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

it("組の question への回答は、組の検査がまだ不成立なら拒まれて開いたまま残り、成立すれば受理される(ADR 0259 決定5)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const path = await tempDir("tidepool-ws-");
  const settings = join(path, ".claude", "settings.local.json");
  await mkdir(join(path, ".claude"));
  await writeFile(settings, JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));
  registerQuarantine(db, "workspaceContainment", "claude-code/B", "unsafe settings", clock.now());
  const question = quarantineQuestion(db, "workspaceContainment", "claude-code/B")!;
  const deps = {
    db,
    pollNow() {},
    landing: unusedLanding,
    quarantineChecks: quarantineChecks({
      db,
      resolveWorkspace: (name) => ({ name: name!, path, branch: "main" }),
    }),
  };
  const answer = () => submitAnswer(deps, question, ["repaired by hand"], undefined, () => clock.now(), "webui");

  await expect(answer()).rejects.toThrow(".claude/settings.local.json");
  expect(getTask(db, question.id)?.status).toBe("todo");

  await rm(settings);
  await answer();
  expect(getTask(db, question.id)?.status).toBe("done");
  expect(listEvents(db, question.id).at(-1)?.payload).toMatchObject({
    kind: "quarantine_released",
    quarantine: "workspaceContainment",
    value: "claude-code/B",
  });
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
