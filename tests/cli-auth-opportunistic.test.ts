import { afterEach, expect, it } from "vitest";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { defaultExec } from "../src/claude-worker.js";
import { CLI_AUTH_QUESTION_TITLE } from "../src/cli-auth.js";
import { api, bootTidepool, registerQuestion, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("実execFile境界は非ゼロ終了でも401 JSONのstdoutを分類側へ渡す(ADR 0070)", async () => {
  const failure = await defaultExec(
    process.execPath,
    ["-e", 'process.stdout.write(JSON.stringify({ api_error_status: 401 })); process.exit(1)'],
    process.env,
  ).catch((err: unknown) => err);

  expect(failure).toMatchObject({ stdout: JSON.stringify({ api_error_status: 401 }) });
});

it("AI draft が api_error_status: 401 を返したら、その場でcliAuth questionを立てる(ADR 0070)", async () => {
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
    questionTitles: [CLI_AUTH_QUESTION_TITLE],
  });
});

it("表示時翻訳が api_error_status: 401 を返したら、その場でcliAuth questionを立てる(ADR 0070)", async () => {
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
    (task) => task.title === CLI_AUTH_QUESTION_TITLE,
  );

  expect({ status: response.status, questionTitles: questions.map((task) => task.title) }).toEqual({
    status: 503,
    questionTitles: [CLI_AUTH_QUESTION_TITLE],
  });
});
