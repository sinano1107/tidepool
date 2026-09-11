import { expect, it } from "vitest";
import type { ExecutionSetting } from "../src/execution-setting.js";
import type { Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { CanonicalWorkerRouter } from "../src/worker.js";

function fakeWorker(id: string, usage: string): WorkerAdapter & {
  started: string[];
  settings: (ExecutionSetting | undefined)[];
  stopped: string[];
} {
  const running = new Set<string>();
  const started: string[] = [];
  const settings: (ExecutionSetting | undefined)[] = [];
  const stopped: string[] = [];
  return {
    id,
    started,
    settings,
    stopped,
    start(task, setting) {
      started.push(task.id);
      settings.push(setting);
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

it("盤面が選んだ実行設定があれば、その Provider の正準 Harness へ出し、設定をそのまま adapter へ渡す(ADR 0110 決定3 / issue #544)", () => {
  const claude = fakeWorker("claude", "claude usage");
  const codex = fakeWorker("codex", "codex usage");
  const worker = new CanonicalWorkerRouter({
    id: "deckhand",
    // 温存中の anthropic を避けて openai が選ばれた、の形。task だけを見る
    // resolveHarness は claude-code を答えるので、選択と dispatch がずれれば落ちる
    resolveHarness: () => "claude-code",
    adapters: { "claude-code": claude, codex },
  });
  const setting: ExecutionSetting = {
    provider: "openai",
    model: "gpt-6-astra",
    effort: "high",
    advisor: undefined,
    source: { tier: "task", provider: "rank" },
  };

  worker.start(task("multi-entry-task", "deckhand"), setting);

  expect({ claude: claude.started, codex: codex.started, carried: codex.settings }).toEqual({
    claude: [],
    codex: ["multi-entry-task"],
    carried: [setting],
  });
});
