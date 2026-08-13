import { afterEach, expect, it, vi } from "vitest";
import { CLI_AUTH_QUESTION_TITLE, quarantineCliAuth } from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("authentication がまだ失敗するなら確認回答を拒否し、question を開いたまま保つ(ADR 0070)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "unauthorized", reason: "API returned 401" }),
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  quarantineCliAuth(db, t.clock.now());
  db.close();
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((task) => task.title === CLI_AUTH_QUESTION_TITLE);

  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;

  expect({ status: response.status, error: response.json.error, questionStatus: after.status }).toEqual({
    status: 409,
    error: "Claude authentication is still unavailable: API returned 401",
    questionStatus: "todo",
  });
});

it("authentication を直して回答すると確認が解除され、pickup が即時再開する(ADR 0070)", async () => {
  let authenticated = false;
  t = await bootTidepool({
    cliAuth: async () =>
      authenticated
        ? { status: "authenticated" }
        : { status: "unauthorized", reason: "API returned 401" },
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  quarantineCliAuth(db, t.clock.now());
  db.close();
  const task = await registerWork(t, "work resumed after authentication repair");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find((candidate) => candidate.title === CLI_AUTH_QUESTION_TITLE);

  authenticated = true;
  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["authentication restored"],
  });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(t.worker.started.map((started) => started.id)).toEqual([task.id]));
});
