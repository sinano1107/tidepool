import { expect, it } from "vitest";
import { FakeClock } from "./fakes.js";

/** `FakeClock` の一発の時限(`setTimeout`)。advance() が跨いだ瞬間に1度だけ発火し、
 *  それより先には二度と発火しない —— interval の再スケジュールと違う一点(issue #771)。 */

it("advance() が時限に到達すると1度発火する", async () => {
  const clock = new FakeClock();
  let fired = 0;
  clock.setTimeout(() => {
    fired++;
  }, 1000);

  await clock.advance(1000);

  expect(fired).toBe(1);
});

it("時限を過ぎてどれだけ advance() しても再発火しない", async () => {
  const clock = new FakeClock();
  let fired = 0;
  clock.setTimeout(() => {
    fired++;
  }, 1000);

  await clock.advance(1000);
  await clock.advance(10_000);

  expect(fired).toBe(1);
});

it("発火前に cancel すると発火しない", async () => {
  const clock = new FakeClock();
  let fired = 0;
  const cancel = clock.setTimeout(() => {
    fired++;
  }, 1000);
  cancel();

  await clock.advance(1000);

  expect(fired).toBe(0);
});

it("発火後の cancel は無害", async () => {
  const clock = new FakeClock();
  let fired = 0;
  const cancel = clock.setTimeout(() => {
    fired++;
  }, 1000);

  await clock.advance(1000);
  cancel();

  expect(fired).toBe(1);
});

it("interval と混ざっても、時限到達の順番どおりに発火する", async () => {
  const order: string[] = [];
  const clock = new FakeClock();
  const cancelInterval = clock.setInterval(() => {
    order.push("interval");
  }, 500);
  clock.setTimeout(() => {
    order.push("timeout");
  }, 700);

  await clock.advance(1000);
  cancelInterval();

  // interval: t=500, t=1000 の2回。timeout: t=700 の1回。到達順に並ぶ。
  expect(order).toEqual(["interval", "timeout", "interval"]);
});
