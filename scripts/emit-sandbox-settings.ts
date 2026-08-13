/** worker が実際に spawn される `--settings` JSON を、盤面のコードから**そのまま**
 *  吐く。deploy-pi のサンドボックス smoke と封じ込め canary(issue #154)が使う。
 *
 *  手書きの profile で測ると、測っているのは自分の想像であって盤面ではない。
 *  以前はこの emitter を検査のたびに `sudo tee` で /opt/tidepool に生やして消して
 *  いたが、Pi では root 所有のツリーに一時ファイルを作る手順になっていて、失敗すると
 *  中途半端に残る。デプロイに載る恒久的なスクリプトにしておく方が安い。
 *
 *  使い方: tsx scripts/emit-sandbox-settings.ts <work|review> <workspacePath>
 *          [skill...] [--allowed-domain domain] */
import { buildSandboxSettings, type WorkerSessionSettingsInput } from "../src/sandbox.js";

const USAGE =
  "usage: emit-sandbox-settings.ts <work|review> <workspacePath> [skill...] [--allowed-domain domain]";
const [taskType, workspacePath, ...rest] = process.argv.slice(2);

if ((taskType !== "work" && taskType !== "review") || !workspacePath) {
  console.error(USAGE);
  process.exit(2);
}

const permittedSkills: string[] = [];
const allowedDomains: string[] = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--allowed-domain") {
    const domain = rest[++i];
    if (!domain) {
      console.error(USAGE);
      process.exit(2);
    }
    allowedDomains.push(domain);
  } else {
    permittedSkills.push(rest[i]!);
  }
}

const input: WorkerSessionSettingsInput = {
  taskType,
  workspacePath,
  permittedSkills,
  ...(allowedDomains.length > 0 && { allowedDomains }),
};
console.log(JSON.stringify(buildSandboxSettings(input)));
