import { existsSync, readdirSync, realpathSync } from "node:fs";
import { expect, it } from "vitest";
import type { BoardCallSpec } from "../src/board-call.js";
import { atBoardOwnedConfigDir, claudeBoardCallSpec } from "../src/claude-board-call-spec.js";

const order = { kind: "k", command: "claude", args: ["-p", "/usage"], cwd: "/w", env: {}, limitMs: 1 };

it.each([
  [{ posture: "answer" }, ["--safe-mode", "--setting-sources", ""]],
  [{ posture: "worker-shaped", configDir: "/c" }, ["--setting-sources", "project", "--strict-mcp-config"]],
  [{ posture: "ambient" }, ["--safe-mode"]],
] as const)("姿勢 %o は呼び出し側の args の前に決まったフラグ列を置く(ADR 0341 決定1・2)", (posture, flags) => {
  const spec = claudeBoardCallSpec({ ...order, ...posture });
  expect(spec.harness).toBe("claude-code");
  expect(spec.args).toEqual([...flags, "-p", "/usage"]);
});

it("claude-code の spec は姿勢を省けない(ADR 0341 決定1)", () => {
  // @ts-expect-error —— 姿勢の無い Claude の spec は型が通らない
  const missing: BoardCallSpec = { ...order, harness: "claude-code" };
  const codex: BoardCallSpec = { ...order, harness: "codex" };
  expect([missing.harness, codex.harness]).toEqual(["claude-code", "codex"]);
});

it("Claude の spec は入口を通らずには組めない —— 姿勢を書いた literal でも型が通らない(ADR 0341 決定2)", () => {
  // @ts-expect-error —— 姿勢のフラグを導くのは claudeBoardCallSpec だけ
  const literal: BoardCallSpec = { ...order, harness: "claude-code", posture: "answer" };
  expect(literal.args).toEqual(["-p", "/usage"]);
});

// ADR 0354 決定1 / ADR 0341 の Status 追記: worker-shaped の姿勢は env の半分を持つ —— 新しい呼び出し場所も dir を忘れられない
it("worker-shaped の注文は config dir を型で必須に取り、env の2鍵に写す。answer / ambient は取らず載せない", () => {
  // @ts-expect-error —— worker-shaped は config dir 無しでは組めない
  claudeBoardCallSpec({ ...order, posture: "worker-shaped" });
  // @ts-expect-error —— answer は人間の login 状態のまま走る
  claudeBoardCallSpec({ ...order, posture: "answer", configDir: "/c" });

  const worker = claudeBoardCallSpec({ ...order, env: { PATH: "/bin" }, posture: "worker-shaped", configDir: "/c" });
  expect(worker.env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/c", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
  expect(worker).not.toHaveProperty("configDir");
  for (const posture of ["answer", "ambient"] as const) {
    const env = claudeBoardCallSpec({ ...order, posture }).env;
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  }
});

it.each([["解決"], ["reject"]])("盤面所有の config dir は呼び出しの間だけ空で在り、%s の後には無い(ADR 0354 決定1)", async (settle) => {
  let seen = "";
  const run = atBoardOwnedConfigDir(async (dir) => {
    seen = dir;
    expect(readdirSync(dir)).toEqual([]);
    // settings の deny と env が同じ綴りになるよう実体の path で渡す(task temp と同じ)
    expect(realpathSync(dir)).toBe(dir);
    if (settle === "reject") throw new Error("口が落ちた");
    return "ok";
  });
  await (settle === "reject" ? expect(run).rejects.toThrow("口が落ちた") : expect(run).resolves.toBe("ok"));
  expect(existsSync(seen)).toBe(false);
});
