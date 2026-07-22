import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getThrottleState, reportThrottle } from "../src/throttle.js";

async function freshDb() {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-throttle-windows-"));
  return openDb(join(dir, "board.sqlite"));
}

it("ウィンドウ別の判定内訳(どの線か・catch-up 時刻)が persist され、getThrottleState で読み出せる(ADR 0030)", async () => {
  const db = await freshDb();

  reportThrottle(db, {
    throttled: true,
    resetsAt: new Date("2026-07-22T12:30:00.000Z"),
    windows: {
      session: { throttled: true, resumeAt: new Date("2026-07-22T12:30:00.000Z") },
      week: { throttled: false, resumeAt: null },
    },
  });

  expect(getThrottleState(db)).toEqual({
    throttled: true,
    resetsAt: "2026-07-22T12:30:00.000Z",
    windows: {
      session: { throttled: true, resumeAt: "2026-07-22T12:30:00.000Z" },
      week: { throttled: false, resumeAt: null },
    },
  });
});

it("fail-closed(観測不能)のウィンドウは null のまま往復する — UI が「観測できていない」を区別できる", async () => {
  const db = await freshDb();

  reportThrottle(db, {
    throttled: true,
    resetsAt: null,
    windows: {
      session: { throttled: false, resumeAt: null },
      week: null,
    },
  });

  expect(getThrottleState(db)).toEqual({
    throttled: true,
    resetsAt: null,
    windows: {
      session: { throttled: false, resumeAt: null },
      week: null,
    },
  });
});

it("一度も /usage 観測が走っていない board は unthrottled かつ内訳なし", async () => {
  const db = await freshDb();

  expect(getThrottleState(db)).toEqual({
    throttled: false,
    resetsAt: null,
    windows: { session: null, week: null },
  });
});
