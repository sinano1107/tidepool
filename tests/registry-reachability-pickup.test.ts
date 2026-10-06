import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, registerWork } from "./harness.js";

let t: Awaited<ReturnType<typeof bootTidepool>>;
afterEach(() => t?.stop());

// ADR 0068 決定5 の帰結: registry の確認 question が開いている間、poll は候補選定の
// **手前**の同期プレフィックスで止まる。壊れている間の /usage 観測はもう走らない
// (pickup しないという結果は同一 — 消えるのは無駄な観測だけ)。
it("registry 質問が開いている間、poll は /usage を観測しない(ADR 0068 決定5)", async () => {
  t = await bootTidepool({
    registryReachability: async () => ({ available: false, reason: "origin is unreachable" }),
  });
  await registerWork(t, "waits for the registry");
  const observedAt = async () =>
    (await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage?.find((usage: any) => usage.provider === "anthropic")
      ?.observedAt;
  await t.clock.advance(HOUR); // 1回目の poll: 質問がまだ無いので観測は走り、質問が立つ
  const first = await observedAt();
  expect(first).toBeDefined();

  await t.clock.advance(HOUR); // 2回目の poll: 質問が開いているので手前で止まる
  expect(await observedAt()).toBe(first);
});
