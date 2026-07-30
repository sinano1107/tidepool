/** worker が実際に spawn される `--settings` JSON を、盤面のコードから**そのまま**
 *  吐く。deploy-pi のサンドボックス smoke と封じ込め canary(issue #154)が使う。
 *
 *  手書きの profile で測ると、測っているのは自分の想像であって盤面ではない。
 *  以前はこの emitter を検査のたびに `sudo tee` で /opt/tidepool に生やして消して
 *  いたが、Pi では root 所有のツリーに一時ファイルを作る手順になっていて、失敗すると
 *  中途半端に残る。デプロイに載る恒久的なスクリプトにしておく方が安い。
 *
 *  使い方: tsx scripts/emit-sandbox-settings.ts <work|review> <workspacePath> [skill...] */
import { buildSandboxSettings, type SandboxSettingsInput } from "../src/sandbox.js";

const [taskType, workspacePath, ...permittedSkills] = process.argv.slice(2);

if (taskType !== "work" && taskType !== "review") {
  console.error("usage: emit-sandbox-settings.ts <work|review> <workspacePath> [skill...]");
  process.exit(2);
}
if (!workspacePath) {
  console.error("usage: emit-sandbox-settings.ts <work|review> <workspacePath> [skill...]");
  process.exit(2);
}

const input: SandboxSettingsInput = { taskType, workspacePath, permittedSkills };
console.log(JSON.stringify(buildSandboxSettings(input)));
