import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

// ADR 0403 決定5 の「読み込みを迂回する呼び出しは lint で禁止する」(no-direct-registry-load.grit)。外すファイルは biome.json の
// override の `includes` が決めるので、本物の設定と plugin を一時ディレクトリへ写して、その除外ごと測る
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// worktree では node_modules が親ディレクトリにしか無いので、固定パスでなく Node の解決で bin を見つける
const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

let workdir: string | undefined;
afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

function lintedMessages(path: string): string[] {
  workdir = mkdtempSync(join(tmpdir(), "no-direct-registry-load-"));
  copyFileSync(join(repoRoot, "biome.json"), join(workdir, "biome.json"));
  for (const name of readdirSync(repoRoot).filter((n) => n.endsWith(".grit"))) copyFileSync(join(repoRoot, name), join(workdir, name));
  mkdirSync(join(workdir, "src"));
  writeFileSync(join(workdir, path), 'import { loadRegistry } from "./registry.js";\nexport const read = () => loadRegistry("/registry", "purely-local");\n');

  const run = spawnSync(process.execPath, [biome, "lint", "--vcs-enabled=false", "--reporter=json", path], { cwd: workdir, encoding: "utf8" });
  // 起動失敗(ENOENT 等)や空の stdout は、JSON.parse の SyntaxError でなくここで理由つきで落とす
  expect(run.error, run.stderr).toBeUndefined();
  expect(run.stdout, `status ${run.status}, signal ${run.signal}: ${run.stderr}`).not.toBe("");
  const report = JSON.parse(run.stdout) as { diagnostics: { category: string; message: string }[] };
  return report.diagnostics.filter((d) => d.category === "plugin").map((d) => d.message);
}

it("読み込みの1点の外から loadRegistry を呼ぶと、plugin が落とす", () => {
  expect(lintedMessages("src/probe.ts")).toEqual([expect.stringContaining("loadRegistryOrStop")]);
});

it("読み込みの1点(src/registry-unreadable.ts)の中の呼び出しは通す", () => {
  expect(lintedMessages("src/registry-unreadable.ts")).toEqual([]);
});
