import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

/** ADR 0035(issue #144): `review_allowed_commands` は review セッションの
 *  permission を**広げる**唯一の registry データである。門は保護 workspace で
 *  ある registry の人間 merge だが、その人間が読んだつもりの範囲を綴りが越えて
 *  しまわないよう、文法だけは機械が確かめる。
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
    const registry = loadRegistry(dir);
    expect(registry.workspaces.tidepool?.review_allowed_commands).toEqual(["npm test", "git log"]);
  });

  it("カンマを含むエントリは拒否する — --allowedTools はカンマ結合なので allow トークン注入になる", async () => {
    // 人間が「npm test を1つ開けた」と読んだ merge が、実際には
    // `Bash(npm test*)` と `Bash(rm*)` の2トークンを開けている、という形を塞ぐ。
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - "npm test,rm -rf /"
`,
    });
    expect(() => loadRegistry(dir)).toThrow(/review_allowed_commands/);
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
    expect(() => loadRegistry(dir)).toThrow(/review_allowed_commands/);
  });

  it("空文字のエントリは拒否する — Bash(*) になって全部開いてしまう", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - ""
`,
    });
    expect(() => loadRegistry(dir)).toThrow(/review_allowed_commands/);
  });

  it("改行を含むエントリは拒否する — diff で1行に見えて2行を運ぶ", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - "npm test\\nrm -rf /"
`,
    });
    expect(() => loadRegistry(dir)).toThrow(/review_allowed_commands/);
  });

  it("フィールドを持たない workspace は空として通る(既存 registry を壊さない)", async () => {
    const dir = await makeRegistry();
    const registry = loadRegistry(dir);
    expect(registry.workspaces.tidepool?.review_allowed_commands).toBeUndefined();
  });
});
