import { describe, expect, it } from "vitest";
import { reviewAllowedTools } from "../src/claude-worker.js";

/** ADR 0035(issue #144): review の書き込み床は `--permission-mode manual` が
 *  担う。manual は「非許可は全部拒否」ではなく「読み取り系は素通し・副作用の
 *  あるものは承認要求 → headless では誰も承認できないので拒否」という形なので、
 *  盤面が明示的に開ける必要があるものだけをこの関数が組み立てる。
 *  `reviewToolDenials` と同じ「組み立ては純関数、配線は launch() 側」の分離。
 *  期待値はこのファイル側の独立した literal で書く(実装を import して
 *  組み立て直すとトートロジーになる)。 */
describe("reviewAllowedTools", () => {
  it("review タスクは tidepool MCP サーバをサーバ単位で allow する", () => {
    // 素の manual では MCP verb が全部承認待ちで詰まり、盤面への唯一の channel
    // が死ぬ(ADR 0035 事実2)。綴りは本番 mcp-config の server キーと同名の
    // サーバ単位 — verb 列挙ではない。
    expect(reviewAllowedTools("review", [])).toEqual(["mcp__tidepool"]);
  });

  it("review_allowed_commands を Bash の接頭辞パターンに機械変換して足す", () => {
    // registry が持つのはホスト非依存のコマンド接頭辞で、CLI の綴りは盤面が
    // 与える。2語の接頭辞も接頭辞のまま(実測で `npm test -- <file>` と
    // `npm test 2>&1 | tail -5` が通り、`npx vitest` は承認要求になる)。
    expect(reviewAllowedTools("review", ["npm test", "npm run lint"])).toEqual([
      "mcp__tidepool",
      "Bash(npm test*)",
      "Bash(npm run lint*)",
    ]);
  });

  it("review 以外は何も allow しない — work の spawn は auto のままで allowlist を持たない", () => {
    // work は書けなければならないので manual にも allowlist にも巻き込まない。
    // registry に review_allowed_commands が入っていても work には効かない。
    expect(reviewAllowedTools("work", ["npm test"])).toEqual([]);
    expect(reviewAllowedTools("question", ["npm test"])).toEqual([]);
  });
});
