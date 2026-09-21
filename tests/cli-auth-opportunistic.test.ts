import { afterEach, expect, it } from "vitest";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { execThrough } from "../src/claude-worker.js";
import { ProcessContainers } from "../src/process-container.js";
import { containerHarness, FakeContainerRuntime, passthroughContainers } from "./fakes.js";
import { api, bootTidepool, registerQuestion, type Tidepool } from "./harness.js";

const ANTHROPIC_AUTH_QUESTION_TITLE =
  "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped";

let t: Tidepool;
afterEach(() => t?.stop());

it("Board call の口を通る exec は非ゼロ終了でも401 JSONのstdoutを分類側へ渡す(ADR 0070)", async () => {
  const failure = await execThrough(containerHarness(passthroughContainers()).boardCall, "task draft")(
    process.execPath,
    ["-e", 'process.stdout.write(JSON.stringify({ api_error_status: 401 })); process.exit(1)'],
    process.env,
  ).catch((err: unknown) => err);

  expect(failure).toMatchObject({ stdout: JSON.stringify({ api_error_status: 401 }) });
});

it("口が答えを返さなかった exec は reject する — 今日の失敗と同じく呼び出し側は 503 に倒す", async () => {
  const runtime = new FakeContainerRuntime();
  runtime.scriptPreflight("cgroup v2 is not mounted at /sys/fs/cgroup");
  const exec = execThrough(containerHarness(new ProcessContainers(runtime)).boardCall, "task draft");

  await expect(exec("claude", ["-p", "draft"], process.env)).rejects.toThrow(/task draft/);
});

it("AI draft が api_error_status: 401 を返したら、その場で provider の Confirmation を立てる(ADR 0070)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "authenticated" }),
    draftClient: new ClaudeDraftClient({
      exec: async () => {
        throw Object.assign(new Error("claude exited with status 1"), {
          stdout: JSON.stringify({
            is_error: true,
            api_error_status: 401,
            result: "Failed to authenticate. API Error: 401 Invalid bearer token",
          }),
        });
      },
    }),
  });

  const response = await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "draft this" });
  const questions = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter(
    (task) => task.type === "question",
  );

  expect({ status: response.status, questionTitles: questions.map((task) => task.title) }).toEqual({
    status: 503,
    questionTitles: [ANTHROPIC_AUTH_QUESTION_TITLE],
  });
});

it("表示時翻訳が api_error_status: 401 を返したら、その場で provider の Confirmation を立てる(ADR 0070)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "authenticated" }),
    translationClient: new ClaudeTranslationClient({
      exec: async () => {
        throw Object.assign(new Error("claude exited with status 1"), {
          stdout: JSON.stringify({
            is_error: true,
            api_error_status: 401,
            result: "Failed to authenticate. API Error: 401 Invalid bearer token",
          }),
        });
      },
    }),
  });
  const source = registerQuestion(t, {
    title: "repair decision",
    purpose: "Can the repair proceed?",
    completion_criteria: "answered",
    question: [{ title: "Proceed?", options: ["yes", "no"], recommendation: "yes" }],
  });

  const response = await api(t.baseUrl, "POST", "/api/translate", {
    type: "question",
    task_id: source.id,
  });
  const questions = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter(
    (task) => task.title === ANTHROPIC_AUTH_QUESTION_TITLE,
  );

  expect({ status: response.status, questionTitles: questions.map((task) => task.title) }).toEqual({
    status: 503,
    questionTitles: [ANTHROPIC_AUTH_QUESTION_TITLE],
  });
});
