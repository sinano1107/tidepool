import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const MIN = 60 * 1000;

const NOT_THROTTLED =
  "Current session: 5% used · resets Jan 1 at 12:00am (UTC)\n" +
  "Current week (all models): 5% used · resets Jan 1 at 12:00am (UTC)\n";

function overThreshold(resetsAt: Date): string {
  // both lines present (real /usage output always has both) — only session
  // crosses the threshold, week stays a well-observed 5%
  return (
    `Current session: 85% used · resets ${formatUsageDate(resetsAt)} (UTC)\n` +
    `Current week (all models): 5% used · resets ${formatUsageDate(resetsAt)} (UTC)\n`
  );
}

/** Renders a Date the way `/usage` renders resets: no year, English month,
 *  12-hour clock, e.g. "Jul 9 at 5:59pm". */
function formatUsageDate(d: Date): string {
  const month = d.toLocaleString("en-US", { timeZone: "UTC", month: "short" });
  const day = d.toLocaleString("en-US", { timeZone: "UTC", day: "numeric" });
  let hour = Number(d.toLocaleString("en-US", { timeZone: "UTC", hour: "numeric", hour12: false }));
  const minute = d.toLocaleString("en-US", { timeZone: "UTC", minute: "2-digit" });
  const meridiem = hour >= 12 ? "pm" : "am";
  hour = hour % 12 === 0 ? 12 : hour % 12;
  return `${month} ${day} at ${hour}:${minute.padStart(2, "0")}${meridiem}`;
}

it("session が閾値以上だと新規 pickup が resets_at まで skip され、resets_at 到達で(hourly tick を待たず)再開する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long haul");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overThreshold(resetsAt));

  await t.clock.advance(HOUR); // still short of resets_at: skipped
  expect(t.worker.started).toEqual([]);

  // by the time the one-shot reset timer fires, /usage now reports a fresh
  // (post-reset) reading — this is what the real world looks like at resets_at
  t.worker.scriptUsage(NOT_THROTTLED);
  await t.clock.advance(40 * MIN); // crosses the 90-min resets_at mark
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("パース不能(観測不能)は fail-closed で pickup を skip し、次の hourly tick で再試行する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long haul");

  t.worker.scriptUsage(null); // simulates a checkUsage failure
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  t.worker.scriptUsage(NOT_THROTTLED);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("TIDEPOOL_USAGE_THRESHOLD に不正値(非数値)を渡してもデフォルト 80% にフォールバックし、fail-open しない", async () => {
  const previous = process.env.TIDEPOOL_USAGE_THRESHOLD;
  process.env.TIDEPOOL_USAGE_THRESHOLD = "not-a-number";
  try {
    t = await bootTidepool();
    await registerWork(t, "long haul");

    const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
    t.worker.scriptUsage(overThreshold(resetsAt)); // 85%, over the 80% default

    await t.clock.advance(HOUR);
    expect(t.worker.started).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.TIDEPOOL_USAGE_THRESHOLD;
    else process.env.TIDEPOOL_USAGE_THRESHOLD = previous;
  }
});

it("閾値超えの間も実行中タスクには決して触れない(常に完走する)", async () => {
  t = await bootTidepool();
  const first = await registerWork(t, "long haul");
  await t.clock.advance(HOUR); // first picked up while usage is still fine

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overThreshold(resetsAt));

  // the in-progress task completes normally — the threshold never touches it
  const client = await mcpClient(t.mcpBaseUrl, first.id);
  const done: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  expect(done.isError ?? false).toBe(false);
  await client.close();
  expect(t.worker.killed).toEqual([]);

  const second = await registerWork(t, "long haul");
  await t.clock.advance(HOUR); // slot free, but usage is still over threshold
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);

  t.worker.scriptUsage(NOT_THROTTLED);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id, second.id]);
});

it("throttled の間、todo タスクはキュービュー(/api/queue)では skipped、ボード(/api/tasks)では todo のまま", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long haul");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overThreshold(resetsAt));
  await t.clock.advance(HOUR); // drives one poll so the observation is persisted

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === task.id).status).toBe("todo");

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === task.id).status).toBe("skipped");

  // once resets_at passes and /usage reports a fresh reading, the queue view
  // goes back to plain todo
  t.worker.scriptUsage(NOT_THROTTLED);
  await t.clock.advance(2 * HOUR);
  const queueAfter = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queueAfter.find((x: any) => x.id === task.id)?.status ?? "in_progress").not.toBe(
    "skipped",
  );
});
