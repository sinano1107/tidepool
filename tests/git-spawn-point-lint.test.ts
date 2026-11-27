import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

// ADR 0441 決定3 の lint(no-git-child-outside-git-module.grit / no-network-git-outside-github-auth.grit)。外すファイルは biome.json の
// override の `includes` が決めるので、本物の設定と plugin を一時ディレクトリへ写して、その除外ごと測る
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// worktree では node_modules が親ディレクトリにしか無いので、固定パスでなく Node の解決で bin を見つける
const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

let workdir: string | undefined;
afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

function lintedMessages(path: string, source: string): string[] {
  workdir = mkdtempSync(join(tmpdir(), "git-spawn-point-lint-"));
  copyFileSync(join(repoRoot, "biome.json"), join(workdir, "biome.json"));
  for (const name of readdirSync(repoRoot).filter((n) => n.endsWith(".grit"))) copyFileSync(join(repoRoot, name), join(workdir, name));
  mkdirSync(join(workdir, "src"));
  writeFileSync(join(workdir, path), source);

  const run = spawnSync(process.execPath, [biome, "lint", "--vcs-enabled=false", "--reporter=json", path], { cwd: workdir, encoding: "utf8" });
  // 起動失敗(ENOENT 等)や空の stdout は、JSON.parse の SyntaxError でなくここで理由つきで落とす
  expect(run.error, run.stderr).toBeUndefined();
  expect(run.stdout, `status ${run.status}, signal ${run.signal}: ${run.stderr}`).not.toBe("");
  const report = JSON.parse(run.stdout) as { diagnostics: { category: string; message: string }[] };
  return report.diagnostics.filter((d) => d.category === "plugin").map((d) => d.message);
}

const direct = 'import { execFileSync } from "node:child_process";\nexport const status = () => execFileSync("git", ["status"], { cwd: "/repo" });\n';

it.each([
  ["execFileSync", direct],
  ["spawnSync", 'import { spawnSync } from "node:child_process";\nexport const status = () => spawnSync("git", ["status"]);\n'],
  ["execFile", 'import { execFile } from "node:child_process";\nexport const status = () => execFile("git", ["status"], () => {});\n'],
  ["spawn", 'import { spawn } from "node:child_process";\nexport const status = () => spawn("git", ["status"]);\n'],
  ["namespace 越しの spawnSync", 'import * as cp from "node:child_process";\nexport const status = () => cp.spawnSync("git", ["--version"]);\n'],
])("git の module の外で git の子を %s で作ると、plugin が落とす", (_how, source) => {
  expect(lintedMessages("src/probe.ts", source)).toEqual([expect.stringContaining("git module's runners")]);
});

it("git の module(src/git.ts)の中で git の子を作っても落とさない", () => {
  expect(lintedMessages("src/git.ts", direct)).toEqual([]);
});

it("git でない command の子は落とさない", () => {
  expect(lintedMessages("src/probe.ts", 'import { execFileSync } from "node:child_process";\nexport const status = () => execFileSync("gh", ["status"]);\n')).toEqual([]);
});

const bringsEnv = 'import { networkGit } from "./git.js";\nexport const fetch = () => networkGit("/repo", ["fetch"], {});\n';

it.each([
  ["名前のまま", bringsEnv],
  ["別名", 'import { networkGit as run } from "./git.js";\nexport const fetch = () => run("/repo", ["fetch"], {});\n'],
  ["namespace 越し", 'import * as gitModule from "./git.js";\nexport const fetch = () => gitModule.networkGit("/repo", ["fetch"], {});\n'],
])("env を持ち込む起動口を github-auth の外から%sで呼ぶと、plugin が落とす", (_how, source) => {
  expect(lintedMessages("src/probe.ts", source)).toContainEqual(expect.stringContaining("Only github-auth brings its own env"));
});

it("github-auth(src/github-auth.ts)が env を持ち込む起動口を呼んでも落とさない", () => {
  expect(lintedMessages("src/github-auth.ts", bringsEnv)).toEqual([]);
});
