import { describe, expect, it } from "vitest";
import { spawnAllowedTools } from "../src/claude-worker.js";

/** ADR 0035(issue #144)/ ADR 0038(issue #151): worker の床は permission
 *  モードの**残余の既定**であり、review は `manual`、work は `acceptEdits` で
 *  走る。どちらも「非許可は全部拒否」ではなく「ルールが何も言っていない操作は
 *  承認要求 → headless では誰も承認できないので拒否」という形なので、盤面が
 *  明示的に開ける必要があるものだけをこの関数が組み立てる。
 *  `reviewToolDenials` と同じ「組み立ては純関数、配線は launch() 側」の分離。
 *  期待値はこのファイル側の独立した literal で書く(実装を import して
 *  組み立て直すとトートロジーになる)。 */
describe("spawnAllowedTools", () => {
  it("どの task type でも tidepool MCP サーバをサーバ単位で allow する", () => {
    // 盤面への唯一の channel。開けないと verb が全部承認待ちで詰まり、セッションは
    // 「モデルが何もせず終了した」ようにしか見えない(ADR 0035 事実2 が review で
    // 実測、ADR 0038 が work でも同じことを実測)。綴りは本番 mcp-config の server
    // キーと同名のサーバ単位 — verb 列挙ではない。
    expect(spawnAllowedTools("work", [])).toEqual(["mcp__tidepool"]);
    expect(spawnAllowedTools("review", [])).toEqual(["mcp__tidepool"]);
    expect(spawnAllowedTools("question", [])).toEqual(["mcp__tidepool"]);
  });

  it("review は review_allowed_commands を Bash の接頭辞パターンに機械変換して足す", () => {
    // registry が持つのはホスト非依存のコマンド接頭辞で、CLI の綴りは盤面が
    // 与える。2語の接頭辞も接頭辞のまま(実測で `npm test -- <file>` と
    // `npm test 2>&1 | tail -5` が通り、`npx vitest` は承認要求になる)。
    expect(spawnAllowedTools("review", ["npm test", "npm run lint"])).toEqual([
      "mcp__tidepool",
      "Bash(npm test*)",
      "Bash(npm run lint*)",
    ]);
  });

  it("review_allowed_commands は review 専用 — 他の task type には畳まれない", () => {
    // work は元から書けるのでこの allow を必要とせず、開ければ registry のデータが
    // work の Bash 面を広げる経路になる。registry に入っていても work には効かない。
    expect(spawnAllowedTools("work", ["npm test"])).toEqual(["mcp__tidepool"]);
    expect(spawnAllowedTools("question", ["npm test"])).toEqual(["mcp__tidepool"]);
  });
});
