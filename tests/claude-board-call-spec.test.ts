import { expect, it } from "vitest";
import type { BoardCallSpec } from "../src/board-call.js";
import { claudeBoardCallSpec } from "../src/claude-board-call-spec.js";

const order = { kind: "k", command: "claude", args: ["-p", "/usage"], cwd: "/w", env: {}, limitMs: 1 };

it.each([
  ["answer", ["--safe-mode", "--setting-sources", ""]],
  ["worker-shaped", ["--setting-sources", "project", "--strict-mcp-config"]],
  ["ambient", ["--safe-mode"]],
] as const)("姿勢 %s は呼び出し側の args の前に決まったフラグ列を置く(ADR 0341 決定1・2)", (posture, flags) => {
  const spec = claudeBoardCallSpec({ ...order, posture });
  expect(spec.harness).toBe("claude-code");
  expect(spec.args).toEqual([...flags, "-p", "/usage"]);
});

it("claude-code の spec は姿勢を省けない(ADR 0341 決定1)", () => {
  // @ts-expect-error —— 姿勢の無い Claude の spec は型が通らない
  const missing: BoardCallSpec = { ...order, harness: "claude-code" };
  const codex: BoardCallSpec = { ...order, harness: "codex" };
  expect([missing.harness, codex.harness]).toEqual(["claude-code", "codex"]);
});
