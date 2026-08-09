import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getThrottleState, reportThrottle } from "../src/throttle.js";

const OBSERVED_AT = new Date("2026-07-22T12:00:00.000Z");

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
      fable: null,
    },
  }, OBSERVED_AT);

  expect(getThrottleState(db)).toEqual({
    throttled: true,
    resetsAt: "2026-07-22T12:30:00.000Z",
    observedAt: OBSERVED_AT.toISOString(),
    windows: {
      session: { throttled: true, resumeAt: "2026-07-22T12:30:00.000Z" },
      week: { throttled: false, resumeAt: null },
      fable: null,
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
      fable: null,
    },
  }, OBSERVED_AT);

  expect(getThrottleState(db)).toEqual({
    throttled: true,
    resetsAt: null,
    observedAt: OBSERVED_AT.toISOString(),
    windows: {
      session: { throttled: false, resumeAt: null },
      week: null,
      fable: null,
    },
  });
});

it("fable 線の判定内訳(観測状態を含む)も persist され読み出せる — 盤面全体は unthrottled のまま(ADR 0030)", async () => {
  const db = await freshDb();

  reportThrottle(db, {
    throttled: false,
    resetsAt: null,
    windows: {
      session: { throttled: false, resumeAt: null },
      week: { throttled: false, resumeAt: null },
      fable: { throttled: true, resumeAt: new Date("2026-07-24T03:36:00.000Z") },
    },
  }, OBSERVED_AT);

  expect(getThrottleState(db)).toEqual({
    throttled: false,
    resetsAt: null,
    observedAt: OBSERVED_AT.toISOString(),
    windows: {
      session: { throttled: false, resumeAt: null },
      week: { throttled: false, resumeAt: null },
      fable: { throttled: true, resumeAt: "2026-07-24T03:36:00.000Z" },
    },
  });
});

it("一度も /usage 観測が走っていない board は unthrottled かつ内訳なし", async () => {
  const db = await freshDb();

  expect(getThrottleState(db)).toEqual({
    throttled: false,
    resetsAt: null,
    observedAt: null,
    windows: { session: null, week: null, fable: null },
  });
});
