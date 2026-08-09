import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("生成済みアセット", () => {
  it("WebUI の --check は stale な生成物を検出して書き換えない", () => {
    const outputPath = join(ROOT, "public", "app.js");
    const original = readFileSync(outputPath, "utf8");
    const stale = `${original}\n// stale`;
    writeFileSync(outputPath, stale);

    try {
      const result = spawnSync(process.execPath, ["scripts/build-webui-bundle.mjs", "--check"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(readFileSync(outputPath, "utf8")).toBe(stale);
    } finally {
      writeFileSync(outputPath, original);
    }
  });

  it("Design System の --check は stale な生成物を検出して書き換えない", () => {
    const outputPath = join(ROOT, "_ds_bundle.js");
    const original = readFileSync(outputPath, "utf8");
    const stale = `${original}\n// stale`;
    writeFileSync(outputPath, stale);

    try {
      const result = spawnSync(process.execPath, ["scripts/build-ds-bundle.mjs", "--check"], {
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
