import { afterEach, expect, it, vi } from "vitest";
import type { SandboxCapability } from "../src/sandbox.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const UNAVAILABLE: SandboxCapability = {
  available: false,
  reason: "bubblewrap (bwrap) could not create a sandbox",
};

/** A capability seam a test can flip mid-run, standing in for a host whose
 *  sandbox breaks (bwrap removed) and is later repaired (ADR 0027: the OS
 *  check itself is 実機スモークの担当, its consequences are testable here). */
function flippableCapability(initial: SandboxCapability) {
  let current = initial;
  return {
    capability: () => current,
    set: (next: SandboxCapability) => {
      current = next;
    },
  };
}

const CLAUDE_ROUTE = {
  resolveHarness: () => "claude-code" as const,
  agentsUsingHarnesses: (harnesses: readonly string[]) =>
    harnesses.includes("claude-code") ? ["fake-worker"] : [],
};

const harnessCheck = (check: () => SandboxCapability) => async (harness: string) =>
  harness === "claude-code" ? check() : ({ available: true } as const);

const questions = async (t: Tidepool) =>
  ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((x) => x.type === "question");

it("Claude Harness の能力検査が不成立ならその pickup が止まり、確認型 question が立つ", async () => {
  t = await bootTidepool({
    ...CLAUDE_ROUTE,
    harnessContainment: harnessCheck(() => UNAVAILABLE),
  });
  await registerWork(t, "work that must not run unsandboxed");

  await t.clock.advance(HOUR);
  // 裸で走らせない: 子プロセスは1つも起動しない
  expect(t.worker.started).toEqual([]);

  const open = await questions(t);
  expect(open).toHaveLength(1);
  expect(open[0].question_quarantine_harness).toBe("claude-code");
  // 1択の確認型 — quarantine と同じ形(選択ではなく完了確認)
  expect(open[0].question_items[0].options).toEqual(["repaired by hand"]);
  // なぜ止まっているかが question 本文に残る
  expect(open[0].purpose).toContain("bubblewrap");
});

it("止まっている間に何度 poll しても question は増えない(1つだけ立つ)", async () => {
  t = await bootTidepool({
    ...CLAUDE_ROUTE,
    harnessContainment: harnessCheck(() => UNAVAILABLE),
  });
  await registerWork(t, "work that must not run unsandboxed");

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await questions(t)).toHaveLength(1);
  expect(t.worker.started).toEqual([]);
});

it("回答は検証つき解除: 検査が依然不成立なら受理せず、question は open のまま残る", async () => {
  const gate = flippableCapability(UNAVAILABLE);
  t = await bootTidepool({
    ...CLAUDE_ROUTE,
    harnessContainment: harnessCheck(gate.capability),
  });
  await registerWork(t, "work that must not run unsandboxed");
  await t.clock.advance(HOUR);

  const [question] = await questions(t);
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  // workspace quarantine の tree 検証拒否と同じ 409(DomainError)
  expect(res.status).toBe(409);
  // 封じ込め能力という1つの答えの、どちらの半分で落ちたのかが読める形で返る
  expect(res.json.error).toContain("claude-code Harness containment is still not established");
  expect(res.json.error).toContain("bubblewrap");
  expect((await questions(t))[0].status).toBe("todo");
});

it("検査が通るようになれば回答が受理され、pickup が再開する", async () => {
  const gate = flippableCapability(UNAVAILABLE);
  t = await bootTidepool({
    ...CLAUDE_ROUTE,
    harnessContainment: harnessCheck(gate.capability),
  });
  const task = await registerWork(t, "work that waited for a repaired sandbox");
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  const [question] = await questions(t);
  gate.set({ available: true });
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(200);
  // 回答は即時 poll を焚く(quarantine 解除と同じ)。焚かれた poll は封じ込め能力を
  // measure し直す — 人間面の自己検査が実 HTTP を1往復するので、応答より後に着く。
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
});

it("修理されただけでは再開しない — 人間の確認回答が解除の唯一の門(quarantine と同じ)", async () => {
  const gate = flippableCapability(UNAVAILABLE);
  t = await bootTidepool({
    ...CLAUDE_ROUTE,
    harnessContainment: harnessCheck(gate.capability),
  });
  await registerWork(t, "work that waited for a repaired sandbox");
  await t.clock.advance(HOUR);

  gate.set({ available: true });
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect((await questions(t))[0].status).toBe("todo");
});

it("止まっている間、キューは対象 Harness の行だけ skipped にして盤面全体を止めない", async () => {
  t = await bootTidepool({
    ...CLAUDE_ROUTE,
    harnessContainment: harnessCheck(() => UNAVAILABLE),
  });
  const task = await registerWork(t, "work that must not run unsandboxed");
  await t.clock.advance(HOUR);

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.tasks.find((x: any) => x.id === task.id).status).toBe("skipped");
  expect(queue.halts).toEqual([]);
});
