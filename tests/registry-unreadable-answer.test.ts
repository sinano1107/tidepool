import { afterEach, expect, it, vi } from "vitest";
import type { ServerOptions } from "../src/server.js";
import { buildServerOptions } from "../src/server-options.js";
import { composition } from "./board-composition.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";
import { breakRegistry, makeRegistry } from "./registry-fixture.js";

const STOP_TITLE = "registry is unavailable — pickup and landing are stopped";

let t: Tidepool;
afterEach(() => t?.stop());

it("registry がまだ到達不能なら確認回答を拒否し、question を開いたまま保つ(ADR 0052)", async () => {
  t = await bootTidepool({
    registryAvailability: async () => ({
      available: false,
      reason: "origin remains unreachable",
    }),
  });
  await registerWork(t, "work waiting for registry repair");
  await t.clock.advance(HOUR);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find(
    (task) => task.title === "registry is unavailable — pickup and landing are stopped",
  );

  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;

  expect({ status: response.status, error: response.json.error, questionStatus: after.status }).toEqual({
    status: 409,
    error: "registry is still unavailable: origin remains unreachable",
    questionStatus: "todo",
  });
});

it("registry 到達性を直して回答すると確認が解除され、pickup が即時再開する(ADR 0052)", async () => {
  let available = false;
  t = await bootTidepool({
    registryAvailability: async () =>
      available
        ? { available: true }
        : { available: false, reason: "origin remains unreachable" },
  });
  const task = await registerWork(t, "work resumed after registry repair");
  await t.clock.advance(HOUR);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const question = tasks.find(
    (candidate) => candidate.title === "registry is unavailable — pickup and landing are stopped",
  );

  available = true;
  const response = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(t.worker.started.map((started) => started.id)).toEqual([task.id]));
});

/** 合成 root が組んだ読み口(担当の確認と判定)で起動し、registry を壊した purely-local の盤面。返すのは registry を直す手。 */
async function bootOnBrokenRegistry(): Promise<() => void> {
  const registryDir = await makeRegistry();
  let composed: ServerOptions | undefined;
  t = await bootTidepool({
    agentRegistered: (name) => composed!.agentRegistered!(name),
    registryAvailability: () => composed!.registryAvailability!(),
  });
  composed = await buildServerOptions({ ...composition(), clock: t.clock, registryDir, workspaceName: "tidepool", defaultAgentName: "deckhand" }, t.db);
  return breakRegistry(registryDir);
}

// ADR 0403 決定5: 人間の要求も読み込みの1点を通る —— 要求はその場で理由を受け取り、止まりは盤面に立つ
it("registry が読めない盤面への人間の登録の要求は理由つきで失敗し、registry の止まりが1枚立つ", async () => {
  await bootOnBrokenRegistry();

  const response = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work", title: "assigned while the registry is broken", purpose: "p", completion_criteria: "c", assignee: "deckhand",
  });
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];

  expect({
    status: response.status,
    error: response.json.error,
    questions: tasks.filter((task) => task.type === "question").map((task) => task.title),
  }).toEqual({
    status: 503,
    error: expect.stringMatching(/^the board could not read the registry: .*; pickup and landing are stopped until the registry question is answered$/s),
    questions: [STOP_TITLE],
  });
});

it("registry が読めないまま答えると拒否され、registry を直してから答えると受理される", async () => {
  const repair = await bootOnBrokenRegistry();
  await registerWork(t, "work waiting for the registry");
  await t.clock.advance(HOUR);
  const question = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.title === STOP_TITLE);

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
  repair();
  const accepted = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });

  expect({ refused: [refused.status, refused.json.error], accepted: accepted.status }).toEqual({
    refused: [409, expect.stringMatching(/^registry is still unavailable: the board could not read the registry: /)],
    accepted: 200,
  });
});
