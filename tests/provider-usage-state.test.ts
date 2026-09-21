import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { setProviderPaceOffset } from "../src/pace-offsets.js";
import { setSpendDown } from "../src/spend-down.js";
import {
  evaluateAndReportProviderUsage,
  reportProviderUsage,
} from "../src/throttle.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool | undefined;

afterEach(async () => {
  await t?.stop();
});

it("Provider/window の観測値・offset・freshness・CLI version を pause と queue に永続表示する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-provider-usage-"));
  t = await bootTidepool({ dir });
  const db = t.db;
  const observedAt = new Date("2026-08-28T08:00:00.000Z");
  reportProviderUsage(db, {
    provider: "openai",
    status: "observed",
    plan: "plus",
    cliVersion: "codex-cli 0.147.0",
    observedAt,
    windows: [
      {
        window: "primary",
        model: null,
        usedPercent: 48,
        durationMs: 5 * 60 * 60 * 1000,
        resetsAt: new Date("2026-08-28T12:00:00.000Z"),
        throttled: true,
        resumesAt: new Date("2026-08-28T09:30:00.000Z"),
      },
      {
        window: "secondary",
        model: "gpt-5.6-sol",
        usedPercent: 12,
        durationMs: 7 * 24 * 60 * 60 * 1000,
        resetsAt: new Date("2026-09-04T08:00:00.000Z"),
        throttled: false,
        resumesAt: null,
      },
    ],
  });
  setProviderPaceOffset(db, {
    provider: "openai",
    window: "primary",
    offset: 25,
  });
  const expected = [
    {
      provider: "openai",
      status: "observed",
      plan: "plus",
      cliVersion: "codex-cli 0.147.0",
      observedAt: observedAt.toISOString(),
      windows: [
        {
          window: "primary",
          model: null,
          usedPercent: 48,
          durationMs: 5 * 60 * 60 * 1000,
          resetsAt: "2026-08-28T12:00:00.000Z",
          offset: 25,
          throttled: true,
          resumesAt: "2026-08-28T09:30:00.000Z",
        },
        {
          window: "secondary",
          model: "gpt-5.6-sol",
          usedPercent: 12,
          durationMs: 7 * 24 * 60 * 60 * 1000,
          resetsAt: "2026-09-04T08:00:00.000Z",
          offset: 10,
          throttled: false,
          resumesAt: null,
        },
      ],
    },
  ];

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage).toEqual(expected);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.providerUsage).toEqual(expected);

  expect(
    await api(t.baseUrl, "POST", "/api/settings/provider-pace-offsets", {
      provider: "openai",
      window: "primary",
      offset: 35,
    }),
  ).toEqual({
    status: 200,
    json: { provider: "openai", window: "primary", offset: 35 },
  });
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage[0].windows[0].offset).toBe(35);
  await api(t.baseUrl, "POST", "/api/settings/provider-pace-offsets", {
    provider: "anthropic",
    window: "session",
    offset: 45,
  });
  expect((await api(t.baseUrl, "GET", "/api/settings/pace-offsets")).json.session).toBe(45);
});

// --- Spend-down は Provider × ウィンドウで当たり、Provider をまたがない(ADR 0143) ---

const SPEND_NOW = new Date("2026-08-28T08:00:00.000Z");
const H = 60 * 60 * 1000;

/** primary: 07:00 開始・経過20%・線 20−10=10、secondary: 1日前開始・経過14.3%・線 4.3。
 *  どちらも使用率 50% でペース線を超える観測。 */
function evaluateOpenAi(db: Db, secondaryPercent = 50) {
  for (const window of ["primary", "secondary"]) {
    setProviderPaceOffset(db, { provider: "openai", window, offset: 10 });
  }
  return evaluateAndReportProviderUsage(
    db,
    {
      provider: "openai",
      status: "observed",
      plan: "plus",
      cliVersion: "codex-cli 0.147.0",
      windows: [
        { window: "primary", model: null, usedPercent: 50, durationMs: 5 * H, resetsAt: new Date("2026-08-28T12:00:00.000Z") },
        {
          window: "secondary",
          model: null,
          usedPercent: secondaryPercent,
          durationMs: 7 * 24 * H,
          resetsAt: new Date("2026-09-03T08:00:00.000Z"),
        },
      ],
    },
    SPEND_NOW,
  );
}

it("anthropic の Spend-down は openai の窓のペース線を外さない — オフセット込みの線が生きる", () => {
  const db = openDb(":memory:");
  setSpendDown(db, "anthropic", "session", SPEND_NOW);
  setSpendDown(db, "anthropic", "week", SPEND_NOW);

  const observed = evaluateOpenAi(db);

  // catch-up は 07:00 + (50 + 10)% × 5h = 10:00
  expect(observed.windows[0]).toMatchObject({ throttled: true, resumesAt: new Date("2026-08-28T10:00:00.000Z") });
  expect(observed.windows[1]).toMatchObject({ throttled: true });
  db.close();
});

it("openai の primary の Spend-down は primary の線だけを外し、secondary の線は生きる", () => {
  const db = openDb(":memory:");
  setSpendDown(db, "openai", "primary", SPEND_NOW);

  const observed = evaluateOpenAi(db);

  expect(observed.windows[0]).toMatchObject({ throttled: false, resumesAt: null });
  expect(observed.windows[1]).toMatchObject({ throttled: true });
  db.close();
});

it("openai の secondary の Spend-down は 100% cap だけを残し(再開はリセット時刻)、primary の線は生きる", () => {
  const db = openDb(":memory:");
  setSpendDown(db, "openai", "secondary", SPEND_NOW);

  const observed = evaluateOpenAi(db, 100);

  expect(observed.windows[0]).toMatchObject({ throttled: true, resumesAt: new Date("2026-08-28T10:00:00.000Z") });
  expect(observed.windows[1]).toMatchObject({ throttled: true, resumesAt: new Date("2026-09-03T08:00:00.000Z") });
  db.close();
});

// --- ペース線の評価器は Provider を問わず1本(ADR 0030 / ADR 0144) ---
// now = 12:00、session(5h)は 13:00 リセット → 開始 08:00・経過80%。既定オフセット20で線は60。
// week(7d)は2日後リセット → 開始 Jul 17 12:00・経過 5/7 ≈ 71.4%。既定オフセット10で線は61.4。
const PACE_NOW = new Date("2026-07-22T12:00:00.000Z");
const SESSION_RESETS = new Date("2026-07-22T13:00:00.000Z");
const WEEK_RESETS = new Date("2026-07-24T12:00:00.000Z");

function evaluate(
  db: Db,
  windows: Array<{ window: string; model: string | null; usedPercent: number; resetsAt: Date }>,
) {
  return evaluateAndReportProviderUsage(
    db,
    {
      provider: "anthropic",
      status: "observed",
      plan: null,
      cliVersion: null,
      windows: windows.map((window) => ({
        ...window,
        durationMs: window.window === "session" ? 5 * H : 7 * 24 * H,
      })),
    },
    PACE_NOW,
  );
}

it("Provider 全体の窓の逆算が不整合(開始時刻が未来)なら観測不能、不整合な窓は落ち、整合する窓は内訳に残る", () => {
  const db = openDb(":memory:");

  // resets が6時間先 — session は5時間なので開始が未来になり矛盾
  const observed = evaluate(db, [
    { window: "session", model: null, usedPercent: 5, resetsAt: new Date("2026-07-22T18:00:00.000Z") },
    { window: "week", model: null, usedPercent: 30, resetsAt: WEEK_RESETS },
  ]);

  expect(observed.status).toBe("unobservable");
  expect(observed.reason).toEqual(expect.any(String));
  expect(observed.windows).toEqual([expect.objectContaining({ window: "week", throttled: false })]);
  db.close();
});

it("model 固有の窓の逆算が不整合ならその窓だけ観測から落ち、Provider は他の窓で判定を続ける", () => {
  const db = openDb(":memory:");

  const observed = evaluate(db, [
    { window: "week", model: null, usedPercent: 30, resetsAt: WEEK_RESETS },
    // resets が8日先 — 7日の窓の開始が未来になり矛盾
    { window: "fable", model: "fable", usedPercent: 5, resetsAt: new Date("2026-07-30T12:00:00.000Z") },
  ]);

  expect(observed.status).toBe("observed");
  expect(observed.windows.map((window) => window.window)).toEqual(["week"]);
  db.close();
});

it.each([
  ["以下", 55],
  ["ちょうど(strict 比較 — 線上は「ペースどおり」)", 60],
])("使用率がペース線(経過% − オフセット)%s なら絞らない", (_, usedPercent) => {
  const db = openDb(":memory:");

  const observed = evaluate(db, [{ window: "session", model: null, usedPercent, resetsAt: SESSION_RESETS }]);

  expect(observed.windows[0]).toMatchObject({ throttled: false, resumesAt: null });
  db.close();
});

it("使用率がペース線を超えたら絞り、再開はリセットではなく catch-up 時刻(経過% = 使用率 + オフセット になる瞬間)", () => {
  const db = openDb(":memory:");

  // 70 > 60 で超過。catch-up は経過90%の瞬間 = 開始 08:00 + 4.5h = 12:30
  const observed = evaluate(db, [{ window: "session", model: null, usedPercent: 70, resetsAt: SESSION_RESETS }]);

  expect(observed.windows[0]).toMatchObject({ throttled: true, resumesAt: new Date("2026-07-22T12:30:00.000Z") });
  db.close();
});

it("使用率 + オフセットが100%以上なら、ウィンドウ内に catch-up は来ない — 再開見込みはリセット時刻へクランプ", () => {
  const db = openDb(":memory:");

  // 85 + 20 = 105% — 経過がそこへ達する前にリセットが来る
  const observed = evaluate(db, [{ window: "session", model: null, usedPercent: 85, resetsAt: SESSION_RESETS }]);

  expect(observed.windows[0]).toMatchObject({ throttled: true, resumesAt: SESSION_RESETS });
  db.close();
});

it("model 固有の窓のペース超過は Provider を止めない — 超過と catch-up はその窓にだけ載る(ADR 0030: 資源単位の絞り)", () => {
  const db = openDb(":memory:");

  // fable 85 > 線 61.4 で超過。catch-up は経過95%の瞬間 = 開始 Jul 17 12:00 + 0.95 × 7d = Jul 24 03:36
  const observed = evaluate(db, [
    { window: "week", model: null, usedPercent: 30, resetsAt: WEEK_RESETS },
    { window: "fable", model: "fable", usedPercent: 85, resetsAt: WEEK_RESETS },
  ]);

  expect(observed.status).toBe("observed");
  expect(observed.windows).toEqual([
    expect.objectContaining({ window: "week", throttled: false }),
    expect.objectContaining({ window: "fable", throttled: true, resumesAt: new Date("2026-07-24T03:36:00.000Z") }),
  ]);
  db.close();
});
