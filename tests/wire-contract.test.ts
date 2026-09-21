import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// サーバ側の照らし忘れを機械で落とす(ADR 0138 決定5)。`res.json` の戻り値は any なので
// tsc は satisfies の欠落に気づけない —— 契約表の各キーが API ルータに現れることを文字列で見る。
const ROOT = join(import.meta.dirname, "..");
const contract = readFileSync(join(ROOT, "src/wire-contract.ts"), "utf8");
const router = readFileSync(join(ROOT, "src/api.ts"), "utf8");
const keys = [...contract.matchAll(/^\s*"([A-Z]+ \/[^"]*)":/gm)].map((m) => m[1]);

describe("wire の契約", () => {
  it("表からキーを読み取れる", () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(keys)("%s はサーバの API ルータで satisfies に照らされる", (key) => {
    const needle = `satisfies WireContract["${key}"]`;
    expect(router.includes(needle), needle).toBe(true);
  });
});
