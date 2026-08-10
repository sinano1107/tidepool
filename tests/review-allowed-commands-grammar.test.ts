import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

/** ADR 0035(issue #144): `review_allowed_commands` は review セッションの
 *  permission を**広げる**唯一の registry データである。門は値を読む人間 ——
 *  agent が書いたなら registry PR で、人間が書いたなら人間面の確認ダイアログで
 *  ——であり(ADR 0061 が「門は保護 workspace の人間 merge」という記述を訂正
 *  した。人間発の registry 変更は保護ブランチへ直接コミットされ PR を通らない)、
 *  その人間が読んだつもりの範囲を綴りが越えてしまわないよう、文法だけは機械が
 *  確かめる。
 *
 *  検証は文法のみで、在庫確認ではない(ADR 0023 / skill allowlist と同じ線)——
 *  ホストに存在しないコマンドの接頭辞は不活性なだけで、エラーではない。 */
describe("workspaces.yaml の review_allowed_commands 文法検証", () => {
  it("ホスト非依存のコマンド接頭辞は通り、workspace エントリに載る", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - npm test
    - git log
`,
    });
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.workspaces.tidepool?.review_allowed_commands).toEqual(["npm test", "git log"]);
  });

  it("カンマを含むエントリは拒否する — --allowedTools はカンマ結合なので allow トークン注入になる", async () => {
    // 人間が「npm test を1つ開けた」と読んだ diff — あるいは確認ダイアログの
    // 列挙 — が、実際には
    // `Bash(npm test*)` と `Bash(rm*)` の2トークンを開けている、という形を塞ぐ。
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - "npm test,rm -rf /"
`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/review_allowed_commands/);
  });

  it("CLI のパターン綴り(* や括弧)を持ち込むエントリは拒否する", async () => {
    // registry が運ぶのはコマンド接頭辞で、`Bash(…*)` の綴りは盤面が与える
    // (ADR 0033 の「許可リストは名前を運びパスを運ばない」の commands 版)。
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - "Bash(npm test*)"
`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/review_allowed_commands/);
  });

  it("空文字のエントリは拒否する — Bash(*) になって全部開いてしまう", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - ""
`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/review_allowed_commands/);
  });

  it("改行を含むエントリは拒否する — diff で1行に見えて2行を運ぶ", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - "npm test\\nrm -rf /"
`,
    });
    expect(() => loadRegistry(dir, "purely-local")).toThrow(/review_allowed_commands/);
  });

  it("フィールドを持たない workspace は空として通る(既存 registry を壊さない)", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir, "purely-local");
    expect(registry.workspaces.tidepool?.review_allowed_commands).toBeUndefined();
  });
});
