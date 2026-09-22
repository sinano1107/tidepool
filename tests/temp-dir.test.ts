import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { tempDir } from "./harness.js";

// 順序に依存する2本組: A が作ったパスを B が「もう無い」で確かめる
// (issue #703) — `tempDir` 自身の後始末が実際に走ったことの唯一の観測面。
let created: string;

it("tempDir はプレフィックス付きのディレクトリを作る", async () => {
  created = await tempDir("tidepool-tempdir-test-");
  expect(existsSync(created)).toBe(true);
});

it("直前のテストが作った tempDir は、そのテストの終了時に消えている", () => {
  expect(existsSync(created)).toBe(false);
});
