import { describe, expect, it } from "vitest";
import { isLightRun } from "../scripts/test-lock.js";

// 引数は `vitest` より後ろの argv(`process.argv.slice(2)` 相当)
describe("isLightRun: 既存テストファイルちょうど1つの指定だけが lock を取らない", () => {
  it("引数なしの run は重い", () => {
    expect(isLightRun(["run"])).toBe(false);
  });

  it("既存テストファイル1つの run は軽い", () => {
    expect(isLightRun(["run", "tests/abandon.test.ts"])).toBe(true);
  });

  it("既存テストファイル1つを -t で名前まで絞っても軽い", () => {
    expect(isLightRun(["run", "tests/abandon.test.ts", "-t", "some name"])).toBe(true);
  });

  it("ファイルが2つなら重い", () => {
    expect(isLightRun(["run", "tests/abandon.test.ts", "tests/abandon-regression.test.ts"])).toBe(false);
  });

  it("既存ファイルでない部分一致パターンは重い", () => {
    expect(isLightRun(["run", "abandon"])).toBe(false);
  });
});
