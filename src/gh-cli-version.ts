import { readFileSync } from "node:fs";
import { DomainError } from "./domain-error.js";

/** 盤面が撃つ gh の固定の版(ADR 0402 決定1)。正本は repo 直下の `gh-cli-version` の1か所で、導入スクリプト
 *  (`scripts/install-gh.sh`)も同じファイルを読む。 */
export const GH_CLI_VERSION = /^version=(\S+)$/m.exec(readFileSync(new URL("../gh-cli-version", import.meta.url), "utf8"))![1]!;

/** gh を撃つ前の版の読みが宣言と一致しなかった(読めなかったことも含む)—— 「gh の版」の Quarantine の契機(ADR 0402 決定2・3)。 */
export class GhVersionError extends DomainError {}

/** `gh --version` の1行目 `gh version X (date)` の X を宣言と完全一致で比べ、違えば投げる。版の門と回答の受理が同じこれを撃つ。
 *  ADR 0402 決定2: 読めないこと(gh が無い・`--version` の失敗・時間切れ)も一致と読まない。 */
export async function assertGhVersion(read: () => Promise<string>, declared = GH_CLI_VERSION): Promise<void> {
  let found: string;
  try {
    const output = await read();
    const version = /^gh version (\S+)/.exec(output)?.[1];
    if (version === declared) return;
    found = version === undefined ? `unrecognised \`gh --version\` output: ${output.split("\n")[0]}` : `gh ${version}`;
  } catch (err) {
    found = `no readable \`gh --version\` (${err instanceof Error ? err.message.trim() : String(err)})`;
  }
  throw new GhVersionError(`gh version mismatch: the board runs only gh ${declared} (pinned in gh-cli-version) and found ${found}`);
}
