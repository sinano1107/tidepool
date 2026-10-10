import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// ADR 0207 決定4 の lint(no-adr-in-board-text.grit)は `public/index.html` の inline `<script>` の文字列にも
// 当たる(issue #1558)。Biome は HTML の埋め込み script を JS として lint し、その際 `language js` の plugin も
// 走らせる。当たるかどうかは biome.json の override の `includes` に `public/**` があることに懸かっていて、
// public/ の inline script には今 ADR を引く文字列が無いので、`npm run lint` だけではこの範囲の穴が赤くならない。
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// worktree では node_modules が親ディレクトリにしか無いので、固定パスでなく Node の解決で bin を見つける
const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

let workdir: string | undefined;
afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

describe("no-adr-in-board-text lint", () => {
  it("flags an ADR citation in a string of public/'s inline <script>", () => {
    // 共有 checkout の public/ に書かないよう、設定と plugin を一時ディレクトリへ写して lint する
    workdir = mkdtempSync(join(tmpdir(), "no-adr-lint-"));
    copyFileSync(join(repoRoot, "biome.json"), join(workdir, "biome.json"));
    for (const name of readdirSync(repoRoot).filter((n) => n.endsWith(".grit"))) {
      copyFileSync(join(repoRoot, name), join(workdir, name));
    }
    mkdirSync(join(workdir, "public"));
    writeFileSync(
      join(workdir, "public", "probe.html"),
      '<!doctype html><html><body><script>window.probe = "probe (ADR 0009)";</script></body></html>\n',
    );

    const run = spawnSync(process.execPath, [biome, "lint", "--vcs-enabled=false", "--reporter=json", "public/probe.html"], {
      cwd: workdir,
      encoding: "utf8",
    });
    // 起動失敗(ENOENT 等)や空の stdout は、JSON.parse の SyntaxError でなくここで理由つきで落とす
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.stdout, `status ${run.status}, signal ${run.signal}: ${run.stderr}`).not.toBe("");
    const report = JSON.parse(run.stdout) as { diagnostics: { category: string; message: string }[] };

    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ category: "plugin", message: expect.stringContaining("no maintainer references") }),
    );
  });
});
