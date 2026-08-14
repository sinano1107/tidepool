import { afterEach, expect, it } from "vitest";
import {
  CLI_AUTH_EXPIRY_WARNING_INTERVAL_MS,
  quarantineCliAuth,
} from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("起動時と30分ごとの期限警告タイマーは認証をprobeせず、cliAuth questionも立てない(ADR 0077)", async () => {
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

it("cliAuth question が開いている間は盤面全体のpickupを止める(ADR 0070)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "unauthorized", reason: "API returned 401" }),
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  quarantineCliAuth(db, t.clock.now());
  db.close();
  await registerWork(t, "waits for authentication repair");

  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
});
