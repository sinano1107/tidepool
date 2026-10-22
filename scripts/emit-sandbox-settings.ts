/** worker が実際に spawn される `--settings` JSON を、盤面のコードから**そのまま**
 *  吐く。deploy-pi のサンドボックス smoke と封じ込め canary(issue #154)が使う。
 *
 *  手書きの profile で測ると、測っているのは自分の想像であって盤面ではない。
 *  以前はこの emitter を検査のたびに `sudo tee` で /opt/tidepool に生やして消して
 *  いたが、Pi では root 所有のツリーに一時ファイルを作る手順になっていて、失敗すると
 *  中途半端に残る。デプロイに載る恒久的なスクリプトにしておく方が安い。
 *
 *  使い方: tsx scripts/emit-sandbox-settings.ts <work|review|interview> <workspacePath>
 *          --task-temp dir [skill...] [--allowed-domain domain] [--read path]
 *
 *  `interview` は Interview の root の床(ADR 0273 決定2): workspacePath は cwd の面接室、`--read` は読みだけ開く実環境
 *  (と開ける面接室)。面接室 canary が手で足していた1行の代わり。
 *
 *  `--task-temp` は必須(ADR 0257 決定2)。吐いた settings で走らせる `claude -p` には、同じ dir を
 *  `TMPDIR` と `CLAUDE_CODE_TMPDIR` に載せて渡す —— 載せないと許可ドメインに届かない。
 *
 *  `--codex` を付けると、Codex の worker が spawn で渡す permission の `-c` 値(`permissionConfig()`)と proxy の1行
 *  (`NETWORK_PROXY_CONFIG`)を1行1つで吐く(issue #2197 の面接室 canary)。executable は盤面と同じく PATH 上の `codex` の実体。skill は取らない。 */
import { existsSync } from "node:fs";
import { NETWORK_PROXY_CONFIG, permissionConfig, resolveCodexExecutable } from "../src/codex-worker.js";
import { buildSandboxSettings, type WorkerSessionSettingsInput } from "../src/sandbox.js";

const USAGE =
  "usage: emit-sandbox-settings.ts <work|review|interview> <workspacePath> --task-temp dir [skill...] [--allowed-domain domain] [--read path] [--codex]";
const [taskType, workspacePath, ...rest] = process.argv.slice(2);

if ((taskType !== "work" && taskType !== "review" && taskType !== "interview") || !workspacePath) {
  console.error(USAGE);
  process.exit(2);
}

const permittedSkills: string[] = [];
const allowedDomains: string[] = [];
const readPaths: string[] = [];
let taskTemp: string | undefined;
let codex = false;
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--task-temp") {
    // a missing value falls through to the required check below
    taskTemp = rest[++i];
  } else if (rest[i] === "--allowed-domain") {
    const domain = rest[++i];
    if (!domain) {
      console.error(USAGE);
      process.exit(2);
    }
    allowedDomains.push(domain);
  } else if (rest[i] === "--read") {
    const path = rest[++i];
    if (!path) {
      console.error(USAGE);
      process.exit(2);
    }
    readPaths.push(path);
  } else if (rest[i] === "--codex") {
    codex = true;
  } else {
    permittedSkills.push(rest[i]!);
  }
}

if (!taskTemp) {
  console.error(USAGE);
  process.exit(2);
}

if (codex) {
  const { executable } = resolveCodexExecutable();
  const config = permissionConfig(taskType, workspacePath, taskTemp, executable, allowedDomains, readPaths);
  console.log([...config, NETWORK_PROXY_CONFIG].join("\n"));
  process.exit(0);
}

const input: WorkerSessionSettingsInput = {
  taskType,
  workspacePath,
  permittedSkills,
  ...(allowedDomains.length > 0 && { allowedDomains }),
  taskTemp,
  lib64: existsSync("/lib64"),
  readPaths,
};
console.log(JSON.stringify(buildSandboxSettings(input)));
