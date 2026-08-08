import { afterEach, expect, it, vi } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("起動時の registry refresh 失敗は起動を拒まず、警告と確認 question を残す(ADR 0052)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  t = await bootTidepool({
    registryReachability: async () => ({
      available: false,
      reason: "origin is unavailable during boot",
    }),
  });
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];

  expect({
    questions: tasks.filter((task) => task.type === "question").map((task) => task.title),
    warning: error.mock.calls.flat().join(" "),
  }).toEqual({
    questions: ["registry remote is unreachable — pickup is stopped"],
    warning:
      "[registry] startup refresh failed; pickup is stopped: origin is unavailable during boot",
  });
  error.mockRestore();
});
