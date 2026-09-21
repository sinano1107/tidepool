import { expect, it } from "vitest";
import type { ExecutionSetting } from "../src/execution-setting.js";
import type { Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { CanonicalWorkerRouter } from "../src/worker.js";

function fakeWorker(id: string, usage: string): WorkerAdapter & {
  started: string[];
  settings: ExecutionSetting[];
  stopped: string[];
} {
  const running = new Set<string>();
  const started: string[] = [];
  const settings: ExecutionSetting[] = [];
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

const task = (id: string): Task => ({ id }) as Task;

// 温存中の anthropic を避けて openai が選ばれた、の形
const openai: ExecutionSetting = {
  provider: "openai",
  model: "gpt-6-astra",
  effort: "high",
  advisor: undefined,
  source: { tier: "task", provider: "rank" },
};

function router() {
  const claude = fakeWorker("claude", "claude usage");
  const codex = fakeWorker("codex", "codex usage");
  const worker = new CanonicalWorkerRouter({ id: "deckhand", adapters: { "claude-code": claude, codex } });
  return { worker, claude, codex };
}

it("盤面が選んだ実行設定の Provider の正準 Harness へ出し、設定をそのまま adapter へ渡す(ADR 0098 / ADR 0110 決定3)", () => {
  const { worker, claude, codex } = router();

  worker.start(task("multi-entry-task"), openai);

  expect({ claude: claude.started, codex: codex.started, carried: codex.settings }).toEqual({
    claude: [],
    codex: ["multi-entry-task"],
    carried: [openai],
  });
});

it("watchdog の畳み込み停止は実際に spawn した Harness の root process へ届く", () => {
  const { worker, claude, codex } = router();

  worker.start(task("openai-task"), openai);
  worker.gracefulStop("openai-task");

  expect(codex.stopped).toEqual(["openai-task"]);
  expect(claude.stopped).toEqual([]);
});
