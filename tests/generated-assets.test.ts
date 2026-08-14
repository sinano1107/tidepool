import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("生成済みアセット", () => {
  it.each([
    ["WebUI", "public/app.js", "scripts/build-webui-bundle.mjs"],
    ["Design System", "_ds_bundle.js", "scripts/build-ds-bundle.mjs"],
    ["ADR Index", "docs/adr/README.md", "scripts/build-adr-index.mjs"],
  ])("%s の --check は fresh / stale を判定して書き換えない", (_name, output, script) => {
    const outputPath = join(ROOT, output);
    const original = readFileSync(outputPath, "utf8");
    const stale = `${original}\n// stale`;

    expect(spawnSync(process.execPath, [script, "--check"], { cwd: ROOT }).status).toBe(0);
    writeFileSync(outputPath, stale);

    try {
      const result = spawnSync(process.execPath, [script, "--check"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(readFileSync(outputPath, "utf8")).toBe(stale);
    } finally {
      writeFileSync(outputPath, original);
    }
  });
});

describe("ADR 索引の生成内容", () => {
  // 上の it.each が実行中に docs/adr/README.md を stale 化 → finally で復元するため、
  // ここは collection 時(it の外)で読む必要がある — it の中に移すとレースする。
  const lines = readFileSync(join(ROOT, "docs/adr/README.md"), "utf8").split("\n");
  const line = (num: string) => lines.find((l) => l.startsWith(`- [${num}]`));

  it("行数は docs/adr/ の ADR ファイル数と一致する", () => {
    const adrCount = readdirSync(join(ROOT, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f)).length;
    expect(lines.filter((l) => l.startsWith("- ["))).toHaveLength(adrCount);
  });

  it.each([
    [
      "単一の Status 行は逐語転記される(0007)",
      "0007",
      "- [0007](0007-swell-throttle-bypasses-failure-retry.md) — Swell throttle は watchdog の失敗リトライ経路を経由しない — 使用量リミットのみ自動再開の例外とする **(superseded by ADR-0008)**",
    ],
    [
      "複数の Status 行は / で連結される(0008)",
      "0008",
      "- [0008](0008-usage-polling-throttle.md) — Throttle 検知は pickup 時の /usage ポーリングと自前閾値による — 実行中タスクは常に完走する **(取得機構は ADR-0028 で差し替え済み / 閾値判定と再開タイマーは ADR-0030 で置き換え済み)**",
    ],
    [
      "Status 内の Markdown リンクは逐語のまま転記される(0034)",
      "0034",
      "- [0034](0034-worker-network-containment-two-tier-invariant.md) — worker のネットワーク到達は「操作 = 完全閉鎖 / 読取 = 監査つき受容」の二段で封じる **(superseded by [ADR 0036](0036-human-surface-is-guarded-by-a-credential.md)(2026-07-29)。)**",
    ],
    [
      "太字でない Status 言及はマーカーにならない(0028)",
      "0028",
      "- [0028](0028-usage-throttle-scrapes-interactive-tui.md) — Throttle の使用率取得は対話 TUI の `/usage` パネルをスクレイプする — headless の `-p /usage` も非公式 API 直叩きも採らない",
    ],
  ])("%s", (_desc, num, expected) => {
    expect(line(num)).toBe(expected);
  });
});
