import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("pause 中は scheduler の poll が新規 pickup をしない", async () => {
  t = await bootTidepool();
  await registerWork(t, "waits for resume");

  const res = await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ paused: true });

  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
});

it("pause 中も実行中タスクは完走し、resume で即時 pickup が発火して先頭から走る", async () => {
  t = await bootTidepool();
  const running = await registerWork(t, "already running");
  const next = await registerWork(t, "waits behind it");
  await t.clock.advance(HOUR); // "already running" picked up

  await api(t.baseUrl, "POST", "/api/pause", { paused: true });

  // the running task completes normally — pause never touches the slot
  const client = await mcpClient(t.mcpBaseUrl, running.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  await t.clock.advance(HOUR); // slot is free, but still paused
  expect(t.worker.started.map((x) => x.id)).toEqual([running.id]);

  const res = await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(res.json).toEqual({ paused: false });
  expect(t.worker.started.map((x) => x.id)).toEqual([running.id, next.id]);
});

it("pause 中に todo を先頭へ move しても pickup が発火せず、resume 時に先頭から走る", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  await registerWork(t, "a");
  const b = await registerWork(t, "b");

  await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: null });
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(t.worker.started.map((x) => x.id)).toEqual([b.id]);
});

it("pause 中もキューの行は todo のまま — 停止は envelope の halts が1回で答える(ADR 0068)", async () => {
  t = await bootTidepool();
  const running = await registerWork(t, "keeps the slot busy");
  const task = await registerWork(t, "waits for resume");
  await t.clock.advance(HOUR); // "keeps the slot busy" picked up, slot stays occupied throughout

  await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  const paused = (await api(t.baseUrl, "GET", "/api/queue")).json;
  // 盤面全体の停止は行の性質ではなく面の性質 — 行の skipped には現れない
  expect(paused.tasks.find((x: any) => x.id === task.id).status).toBe("todo");
  expect(paused.halts).toEqual([{ kind: "pause" }]);

  // the slot is still occupied by "running", so resume's immediate poll is a
  // no-op for "task" — the halt simply leaves the envelope
  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  const resumed = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(resumed.tasks.find((x: any) => x.id === task.id).status).toBe("todo");
  expect(resumed.halts).toEqual([]);
  expect(t.worker.started.map((x: any) => x.id)).toEqual([running.id]);
});

it("pause は人間の操舵チャネル: MCP には一切公開されない", async () => {
  t = await bootTidepool();
  const client = await mcpClient(t.mcpBaseUrl);
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  expect(names.filter((n) => /pause|resume/.test(n))).toEqual([]);
  await client.close();
});

it("pause 状態はサーバー再起動を跨いで維持される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "stays paused across a restart");
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });

  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json).toEqual({
    // 盤面全体の停止は列挙が1回で答える — 4つの boolean は列挙から導出できる
    // ので応答から消えた(ADR 0068 決定3)
    halts: [{ kind: "pause" }],
    throttle: {
      throttled: false,
      resumesAt: null,
      observedAt: null,
      revalidating: false,
      windows: { session: null, week: null, fable: null },
    },
    spendDown: { session: null, week: null },
  });
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(t.worker.started.map((x: any) => x.id)).toEqual([task.id]);
});

it("pause は triage session と直交する: pause 中のコミットは pickup を再開しない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "waits behind both gates");
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });

  await api(t.baseUrl, "POST", "/api/triage/start");
  const commitRes = await api(t.baseUrl, "POST", "/api/triage/close");
  expect(commitRes.status).toBe(200);

  // the commit fires its own immediate poll, but pause still gates it
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(t.worker.started.map((x: any) => x.id)).toEqual([task.id]);
});

it("GET /api/pause は開いている triage session を盤面全体の停止として返す(ADR 0058)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/triage/start");

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([{ kind: "triage" }]);
});

it("GET /api/pause は封じ込め能力の不成立を盤面全体の停止として返す(ADR 0058)", async () => {
  t = await bootTidepool({ sandboxCapability: () => ({ available: false, reason: "no sandbox" }) });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([{ kind: "containment" }]);
});

it("GET /api/pause は registry 到達性の不成立を盤面全体の停止として返す(ADR 0058)", async () => {
  t = await bootTidepool({
    registryReachability: async () => ({ available: false, reason: "origin is unreachable" }),
  });
  await registerWork(t, "waits for the registry");
  await t.clock.advance(HOUR);

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([
    { kind: "registryReachability" },
  ]);
});
