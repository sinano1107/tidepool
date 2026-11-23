import { expect, it, vi } from "vitest";
import type { Clock } from "../src/clock.js";
import type { Db } from "../src/db.js";
import { withGhVersionQuarantine } from "../src/gh-version-signal.js";
import { FakeGitHubClient } from "./fakes.js";

// ADR 0402 決定3: question は信号 —— 信号の書き込みが投げても、gh の呼び出しの結末(merge 済み)を失敗に差し替えない
it("信号の書き込みが投げても、通った merge は merge 済みのまま返る", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const github = new FakeGitHubClient();
  github.scriptHead(7, "abc123");
  const db = { prepare: () => { throw new Error("the board DB refused the write"); } } as unknown as Db;
  const clock = { now: () => new Date(0) } as Clock;
  const workspace = { name: "widget", path: "/fake/path" };

  await withGhVersionQuarantine(github, db, clock).mergePullRequest({ workspace, number: 7 }, "abc123");

  expect(github.merged).toEqual([{ path: "/fake/path", number: 7 }]);
});
