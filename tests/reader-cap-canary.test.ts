import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCanaryPayload, judgeReceived, readClaudeReceived, readCodexReceived } from "../src/reader-cap-canary.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

// 実 CLI の記録(2026-10-05 にこの canary の一時 MCP を通して採取、tool_use / tool_result の行だけに削った)
const CLAUDE_STREAM = fixture("reader-cap-claude-2.1.289.stream.jsonl");
const CLAUDE_MARKERS = { middle: "MIDDLE-10df15f3-df46-4d3e-b3c1-d145fae57cb4", tail: "TAIL-0d0a0668-97af-435c-b6c2-0782eafb133f" };
// Codex 0.147.0 / gpt-5.6-sol(code mode)の rollout。モデルへの出力は中央が切り詰められ、
// 切り詰め前の本文は mcp_tool_call_end の event にだけ残る
const CODEX_ROLLOUT = fixture("reader-cap-codex-0.147.0.rollout.jsonl");
const CODEX_MARKERS = { middle: "MIDDLE-8872f510-04b6-4b39-ba8f-cc34363ecb06", tail: "TAIL-9df07b5c-5e2a-4721-bdfe-ce20c79b9bb3" };

describe("canary の応答", () => {
  it("盤面の予算(40,000 バイト)ちょうどの1行の JSON で、中央と末尾に目印を持つ", () => {
    const { text, middle, tail } = buildCanaryPayload();
    expect(Buffer.byteLength(text)).toBe(40_000);
    expect(text).not.toContain("\n");
    expect(() => JSON.parse(text)).not.toThrow();
    const at = text.indexOf(middle) / text.length;
    expect(at).toBeGreaterThan(0.4);
    expect(at).toBeLessThan(0.6);
    expect(text.slice(-100)).toContain(tail);
  });

  it("目印は呼び出しごとに変わる", () => {
    const first = buildCanaryPayload();
    const second = buildCanaryPayload();
    expect(second.middle).not.toBe(first.middle);
    expect(second.tail).not.toBe(first.tail);
  });
});

describe("読み手が受け取った本文の判定", () => {
  const markers = { middle: "MIDDLE-1", tail: "TAIL-1" };

  it("中央と末尾の目印が逐語で揃えば合格", () => {
    expect(judgeReceived('{"canary":"xxMIDDLE-1xxTAIL-1"}', [markers])).toMatchObject({ pass: true, middle: true, tail: true });
  });

  it("中央が切り詰められて中央の目印が欠けたら、末尾が残っていても不合格", () => {
    const verdict = judgeReceived('{"canary":"xx…4000 tokens truncated…xxTAIL-1"}', [markers]);
    expect(verdict).toMatchObject({ pass: false, middle: false, tail: true });
    expect(verdict.detail).toContain("middle");
  });

  it("末尾の目印が欠けても不合格", () => {
    expect(judgeReceived('{"canary":"xxMIDDLE-1xx', [markers])).toMatchObject({ pass: false, middle: true, tail: false });
  });

  it("読み手の受け取りが見つからなければ不合格", () => {
    const verdict = judgeReceived(null, [markers]);
    expect(verdict).toMatchObject({ pass: false, middle: false, tail: false });
    expect(verdict.detail).toContain("no tool result");
  });

  it("読み手が canary を一度も呼ばなければ不合格", () => {
    expect(judgeReceived(null, [])).toMatchObject({ pass: false, detail: "the reader never called the canary tool" });
  });

  it("2回呼ばれたら、最後の受け取りを最後の目印と突き合わせる", () => {
    const verdict = judgeReceived('{"canary":"xxMIDDLE-2xxTAIL-2"}', [markers, { middle: "MIDDLE-2", tail: "TAIL-2" }]);
    expect(verdict).toMatchObject({ pass: true });
    expect(verdict.detail).toContain("called 2 times");
  });
});

describe("Claude Code の受け取り", () => {
  it("canary の tool_use に対応する tool_result の本文を読む(ToolSearch の tool_result は読まない)", () => {
    const received = readClaudeReceived(CLAUDE_STREAM);
    expect(received?.startsWith('{"canary":"x')).toBe(true);
    expect(judgeReceived(received, [CLAUDE_MARKERS])).toMatchObject({ pass: true });
  });

  it("canary を呼んでいない stdout からは何も読まない", () => {
    expect(readClaudeReceived('{"type":"result","subtype":"success"}\n')).toBeNull();
  });
});

describe("Codex の受け取り", () => {
  it("canary を呼んだ call の出力を読み、中央が切り詰められていれば中央の目印が欠けて不合格になる", () => {
    expect(CODEX_ROLLOUT).toContain(CODEX_MARKERS.middle); // 切り詰め前の本文は rollout の別の行にある
    const received = readCodexReceived(CODEX_ROLLOUT);
    expect(received).toContain("tokens truncated");
    expect(judgeReceived(received, [CODEX_MARKERS])).toMatchObject({ pass: false, middle: false, tail: true });
  });

  it("code mode でない直接の MCP 呼び出しなら function_call_output を読む", () => {
    const rollout = [
      { type: "response_item", payload: { type: "function_call", name: "mcp__canary__read_canary", arguments: "{}", call_id: "c1" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "xxMIDDLE-1xx…truncated…" } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    expect(readCodexReceived(rollout)).toBe("xxMIDDLE-1xx…truncated…");
  });

  it("canary を呼んでいない rollout からは何も読まない", () => {
    expect(readCodexReceived('{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n')).toBeNull();
  });
});
