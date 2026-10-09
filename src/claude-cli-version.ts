import { readFileSync } from "node:fs";

/** 盤面が検証した Claude CLI の版(ADR 0186 決定5)。正本は repo 直下の1か所で、導入スクリプトも同じファイルを読む。
 *  葉に置くのは、adapter(claude-worker.ts)と Quarantine の文面(quarantine.ts)が循環なしに読むため。 */
export const CLAUDE_CLI_VERSION = readFileSync(new URL("../claude-cli-version", import.meta.url), "utf8").trim();
