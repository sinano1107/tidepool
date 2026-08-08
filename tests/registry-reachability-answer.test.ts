import { afterEach, expect, it, vi } from "vitest";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("registry がまだ到達不能なら確認回答を拒否し、question を開いたまま保つ(ADR 0052)", async () => {
  t = await bootTidepool({
    registryReachability: async () => ({
      available: false,
      reason: "origin remains unreachable",
    }),
  });
  await registerWork(t, "work waiting for registry repair");
  await t.clock.advance(HOUR);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find(
    (task) => task.title === "registry remote is unreachable — pickup is stopped",
  );

  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;

  expect({ status: response.status, error: response.json.error, questionStatus: after.status }).toEqual({
    status: 409,
    error: "registry remote is still unreachable: origin remains unreachable",
    questionStatus: "todo",
  });
});

it("registry 到達性を直して回答すると確認が解除され、pickup が即時再開する(ADR 0052)", async () => {
  let available = false;
  t = await bootTidepool({
    registryReachability: async () =>
      available
        ? { available: true }
        : { available: false, reason: "origin remains unreachable" },
  });
  const task = await registerWork(t, "work resumed after registry repair");
  await t.clock.advance(HOUR);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find(
    (candidate) => candidate.title === "registry remote is unreachable — pickup is stopped",
  );

  available = true;
  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(t.worker.started.map((started) => started.id)).toEqual([task.id]));
});
