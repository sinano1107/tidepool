import { expect, it } from "vitest";
import type { Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { CanonicalWorkerRouter } from "../src/worker.js";

function fakeWorker(id: string, usage: string): WorkerAdapter & {
  started: string[];
  stopped: string[];
} {
  const running = new Set<string>();
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    id,
    started,
    stopped,
    start(task) {
      started.push(task.id);
      running.add(task.id);
    },
    gracefulStop(taskId) {
      if (running.has(taskId)) stopped.push(taskId);
    },
    async checkUsage() {
      return usage;
    },
  };
}

const task = (id: string, assignee: string): Task =>
  ({ id, assignee } as Task);

it("scheduler の WorkerAdapter は Provider の正準 Harness だけへ dispatch し、fallback しない(ADR 0098)", () => {
  const claude = fakeWorker("claude", "claude usage");
  const codex = fakeWorker("codex", "codex usage");
  const worker = new CanonicalWorkerRouter({
    id: "deckhand",
    resolveHarness: (picked) => {
      if (picked.assignee === "openai-agent") return "codex";
      if (picked.assignee === "anthropic-agent") return "claude-code";
      throw new Error("unsupported canonical route");
    },
    adapters: { "claude-code": claude, codex },
  });

  worker.start(task("openai-task", "openai-agent"));
  expect({ claude: claude.started, codex: codex.started }).toEqual({
    claude: [],
    codex: ["openai-task"],
  });
  expect(() => worker.start(task("unsupported-task", "unknown-agent"))).toThrow(
    "unsupported canonical route",
  );
  expect({ claude: claude.started, codex: codex.started }).toEqual({
    claude: [],
    codex: ["openai-task"],
  });
});

it("watchdog の畳み込み停止は実際に spawn した Harness の root process へ届く", () => {
  const claude = fakeWorker("claude", "claude usage");
  const codex = fakeWorker("codex", "codex usage");
  const worker = new CanonicalWorkerRouter({
    id: "deckhand",
    resolveHarness: () => "codex",
    adapters: { "claude-code": claude, codex },
  });

  worker.start(task("openai-task", "openai-agent"));
  worker.gracefulStop("openai-task");

  expect(codex.stopped).toEqual(["openai-task"]);
  expect(claude.stopped).toEqual([]);
});
