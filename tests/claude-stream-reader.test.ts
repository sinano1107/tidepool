import { expect, it } from "vitest";
import { claudeStreamObservation, observeClaudeLine } from "../src/claude-stream-reader.js";

const INITIALIZATION_FAILURE = "Sandbox is required but failed to initialize: Failed to create bridge sockets after 5 attempts. Restart to retry.";
const toolUse = (name: string, id = "bash-1", parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input: {} }] } });
const toolResult = (content: unknown, id = "bash-1", error: unknown = true, parent: string | null = null) => ({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content }] } });

it.each([
  INITIALIZATION_FAILURE,
  "Linux sandbox HTTP bridge socket is missing (socat may have died): /tmp/claude-http.sock",
  "Linux sandbox SOCKS bridge socket is missing (socat may have died): /tmp/claude-socks.sock",
])("Claude の読み手は Bash の error tool_result にある封じ込めの故障を観測する: %s", (failure) => {
  const observed = claudeStreamObservation();
  observeClaudeLine(observed, { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: {} }] } });
  observeClaudeLine(observed, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", is_error: true, content: failure }] } });

  expect(observed.sandboxFailure).toBe(failure);
});

it("Claude の読み手は tool_result の text block にある sandbox 故障も観測する", () => {
  const observed = claudeStreamObservation();
  observeClaudeLine(observed, toolUse("Bash"));
  observeClaudeLine(observed, toolResult([{ type: "text", text: INITIALIZATION_FAILURE }]));

  expect(observed.sandboxFailure).toBe(INITIALIZATION_FAILURE);
});

it.each([
  ["Bash 以外の結果", [toolUse("Read"), toolResult(INITIALIZATION_FAILURE)]],
  ["別の tool_use_id の結果", [toolUse("Bash"), toolResult(INITIALIZATION_FAILURE, "read-1")]],
  ["並行する Read の結果", [toolUse("Bash"), toolUse("Read", "read-1"), toolResult(INITIALIZATION_FAILURE, "read-1")]],
  ["tool_use の無い結果", [toolResult(INITIALIZATION_FAILURE)]],
  ["is_error: false", [toolUse("Bash"), toolResult(INITIALIZATION_FAILURE, "bash-1", false)]],
  ["is_error の無い結果", [toolUse("Bash"), { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: INITIALIZATION_FAILURE }] } }]],
  ["is_error が文字列", [toolUse("Bash"), toolResult(INITIALIZATION_FAILURE, "bash-1", "true")]],
  ["別の parent_tool_use_id の結果", [toolUse("Bash"), toolResult(INITIALIZATION_FAILURE, "bash-1", true, "subagent-1")]],
  ["subagent の Bash と root の結果", [toolUse("Bash", "bash-1", "subagent-1"), toolResult(INITIALIZATION_FAILURE)]],
  ["assistant 本文の引用", [{ type: "assistant", message: { content: [{ type: "text", text: INITIALIZATION_FAILURE }] } }]],
  ["assistant の tool_result", [toolUse("Bash"), { ...toolResult(INITIALIZATION_FAILURE), type: "assistant" }]],
  ["途中に署名のある Bash 出力", [toolUse("Bash"), toolResult(`quoted error: ${INITIALIZATION_FAILURE}`)]],
  ["通常の Bash error", [toolUse("Bash"), toolResult("command exited with code 1")]],
  ["署名のない tool_result content", [toolUse("Bash"), toolResult([null, { type: "image", text: INITIALIZATION_FAILURE }])]],
  ["壊れた message/content", [null, { type: "assistant", message: null }, { type: "user", message: { content: [null] } }, toolUse("Bash"), toolResult(null)]],
] as const)("Claude の読み手は %s を sandbox 故障にしない", (_, lines) => {
  const observed = claudeStreamObservation();
  for (const line of lines) observeClaudeLine(observed, line);

  expect(observed.sandboxFailure).toBeNull();
});

it("Claude の読み手は別スレッドの同じ ID の結果で Bash の照合を失わず、対応する結果で故障を観測する", () => {
  const observed = claudeStreamObservation();
  observeClaudeLine(observed, toolUse("Bash", "bash-1", "subagent-1"));
  observeClaudeLine(observed, toolResult("read output", "bash-1"));
  expect(observed.sandboxFailure).toBeNull();

  observeClaudeLine(observed, toolResult(INITIALIZATION_FAILURE, "bash-1", true, "subagent-1"));

  expect(observed.sandboxFailure).toBe(INITIALIZATION_FAILURE);
});

it("Claude の読み手は完了済みの Bash の ID を再利用した孤立の結果に反応しない", () => {
  const observed = claudeStreamObservation();
  observeClaudeLine(observed, toolUse("Bash"));
  observeClaudeLine(observed, toolResult("ready", "bash-1", false));
  observeClaudeLine(observed, toolResult(INITIALIZATION_FAILURE));

  expect(observed.sandboxFailure).toBeNull();
});
