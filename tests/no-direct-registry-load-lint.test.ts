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

function lintedMessages(path: string, source: string): string[] {
  workdir = mkdtempSync(join(tmpdir(), "no-direct-registry-load-"));
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

const direct = 'import { loadRegistry } from "./registry.js";\nexport const read = () => loadRegistry("/registry", "purely-local");\n';

it.each([
  ["名前のまま", direct],
  ["別名", 'import { loadRegistry as read } from "./registry.js";\nexport const board = () => read("/registry", "purely-local");\n'],
  ["namespace 越し", 'import * as registry from "./registry.js";\nexport const read = () => registry.loadRegistry("/registry", "purely-local");\n'],
])("読み込みの1点の外から loadRegistry を%sで読むと、plugin が落とす", (_how, source) => {
  expect(lintedMessages("src/probe.ts", source)).toEqual([expect.stringContaining("loadRegistryOrStop")]);
});

it("読み込みの1点(src/registry-unreadable.ts)の中の呼び出しは通す", () => {
  expect(lintedMessages("src/registry-unreadable.ts", direct)).toEqual([]);
});

it("読み込みの1点を通る読みは、別名でも落とさない", () => {
  expect(lintedMessages("src/probe.ts", 'import { loadRegistryOrStop as read } from "./registry-unreadable.js";\nexport const board = () => read(db, source);\n')).toEqual([]);
});
