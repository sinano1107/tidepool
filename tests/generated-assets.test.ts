import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("生成済みアセット", () => {
  it.each([
    ["WebUI", "public/app.js", "scripts/build-webui-bundle.mjs"],
    ["Design System", "_ds_bundle.js", "scripts/build-ds-bundle.mjs"],
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
