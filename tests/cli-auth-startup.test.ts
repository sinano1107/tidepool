import { afterEach, expect, it } from "vitest";
import { CLI_AUTH_EXPIRY_WARNING_INTERVAL_MS } from "../src/cli-auth.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("起動時と30分ごとの期限警告タイマーは認証をprobeせず、question も立てない(ADR 0077)", async () => {
  let calls = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      calls += 1;
      return { status: "unauthorized", reason: "API returned 401" };
    },
  });

  await t.clock.advance(CLI_AUTH_EXPIRY_WARNING_INTERVAL_MS);
  await t.clock.advance(CLI_AUTH_EXPIRY_WARNING_INTERVAL_MS * 2);

  const tasks = await api(t.baseUrl, "GET", "/api/tasks");
  expect({ status: tasks.status, calls, tasks: tasks.json }).toEqual({ status: 200, calls: 0, tasks: [] });
});
