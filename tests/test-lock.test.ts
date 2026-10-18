import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { isLightRun, killChildren } from "../scripts/test-lock.js";

// 壁時計の上限が切れた run は、イベントループに戻らない worker も落とせなければ lock を手放したことにならない
it("killChildren は親の直下の子を SIGKILL で落とす —— 子を wait している親はそれで終われる", async () => {
  const parent = spawn("sh", ["-c", "sleep 60 & sleep 60 & wait"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const exited = once(parent, "exit");

  killChildren(parent.pid!);

  await exited;
  expect(parent.exitCode ?? parent.signalCode).not.toBeNull();
});

// 引数は `vitest` より後ろの argv(`process.argv.slice(2)` 相当)
describe("isLightRun: 既存テストファイルちょうど1つの指定だけが lock を取らない", () => {
  it("引数なしの run は重い", () => {
    expect(isLightRun(["run"])).toBe(false);
  });

  it("既存テストファイル1つの run は軽い", () => {
    expect(isLightRun(["run", "tests/test-lock.test.ts"])).toBe(true);
  });

  it("既存テストファイル1つを -t で名前まで絞っても軽い", () => {
    expect(isLightRun(["run", "tests/test-lock.test.ts", "-t", "some name"])).toBe(true);
  });

  it("ファイルが2つなら重い", () => {
    expect(isLightRun(["run", "tests/test-lock.test.ts", "vitest.config.ts"])).toBe(false);
  });

  it("既存ファイルでない部分一致パターンは重い", () => {
    expect(isLightRun(["run", "test-lock"])).toBe(false);
  });
});
