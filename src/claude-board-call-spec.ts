import type { BoardCallSpec, ClaudeBoardCallBrand, ClaudeBoardCallPosture } from "./board-call.js";

/** 姿勢 → フラグの唯一の写像(ADR 0341 決定2)。runner の module に置かないのは、runner が claude-worker.ts から原語を
 *  import していて、claude-worker.ts がここを引くと import の循環になるから(原語の移設は #2472)。 */
export const POSTURE_FLAGS: Record<ClaudeBoardCallPosture, readonly string[]> = {
  // the board's own cwd, not a task workspace: --safe-mode keeps the board repo's CLAUDE.md/skills/MCP config,
  // hooks and plugins out of what must stay a bare answer, without --bare's API-key-only auth. It does **not**
  // keep an advisor out (measured, issue #174) — that is the env's job. --safe-mode still reads `language`
  // from the user and project tiers (measured on 2.1.286 / 2.1.308, #2454): no settings tier at all (ADR 0303 決定1)
  answer: ["--safe-mode", "--setting-sources", ""],
  // worker と同じ設定の層と MCP の宣言 —— probe が見る集合が worker の見る集合に等しく、workspace の `.mcp.json` の
  // server もホストの user 層の server も立たない(ADR 0341 決定3・4、#2809 の D 行)
  "worker-shaped": ["--setting-sources", "project", "--strict-mcp-config"],
  // ホストの CLI 自身の状態(認証・使用量)を観測する: 盤面の repo の CLAUDE.md / skills / MCP だけを外す(ADR 0341 決定1)
  ambient: ["--safe-mode"],
};

type ClaudeBoardCallSpec = Extract<BoardCallSpec, { harness: "claude-code" }>;

/** Claude の Board call の注文を組む唯一の入口(ADR 0341 決定2): 姿勢のフラグを呼び出し側の `args` の前に置く。
 *  `args` は呼び出しが測るもの(`--settings` / `--permission-mode` / `--mcp-config` / `--tools` を含む)だけを運ぶ。 */
export const claudeBoardCallSpec = <S extends Omit<ClaudeBoardCallSpec, "harness" | keyof ClaudeBoardCallBrand>>(
  spec: S,
): S & { harness: "claude-code" } & ClaudeBoardCallBrand =>
  // 印は型だけにある(board-call.ts)—— 付けられるのはこの cast だけ
  ({ ...spec, harness: "claude-code", args: [...POSTURE_FLAGS[spec.posture], ...spec.args] }) as S & { harness: "claude-code" } & ClaudeBoardCallBrand;
