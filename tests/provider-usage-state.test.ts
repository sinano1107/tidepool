import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { getProviderPaceOffset, listProviderPaceOffsets, setProviderPaceOffset } from "../src/pace-offsets.js";
import { setSpendDown } from "../src/spend-down.js";
import {
  evaluateAndReportProviderUsage,
  reportProviderUsage,
} from "../src/throttle.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool | undefined;

const KNOWN_PAIR_DEFAULTS = [
  { provider: "anthropic", window: "fable", offset: 10 },
  { provider: "anthropic", window: "session", offset: 20 },
  { provider: "anthropic", window: "week", offset: 10 },
  { provider: "openai", window: "primary", offset: 20 },
  { provider: "openai", window: "secondary", offset: 10 },
];

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
});

it("既知の組(anthropic × session / week / fable、openai × primary / secondary)以外の pace offset は入口で弾き、行を作らない", async () => {
  t = await bootTidepool();

  for (const [provider, window] of [
    ["anthropic", "primary"],
    ["openai", "session"],
    ["openai", "fable"],
    ["moonshot", "week"],
  ]) {
    const res = await api(t.baseUrl, "POST", "/api/settings/provider-pace-offsets", { provider, window, offset: 30 });
    expect(res.status).toBe(400);
  }
  expect((await api(t.baseUrl, "GET", "/api/settings/provider-pace-offsets")).json.offsets).toEqual(KNOWN_PAIR_DEFAULTS);
});

it("既知の5つの組の pace offset は保存され、anthropic の session / week / fable は旧 pace-offsets へ写る", async () => {
  t = await bootTidepool();

  const pairs = [
    { provider: "anthropic", window: "fable", offset: 33 },
    { provider: "anthropic", window: "session", offset: 31 },
    { provider: "anthropic", window: "week", offset: 32 },
    { provider: "openai", window: "primary", offset: 34 },
    { provider: "openai", window: "secondary", offset: 35 },
  ];
  for (const body of pairs) {
    expect((await api(t.baseUrl, "POST", "/api/settings/provider-pace-offsets", body)).status).toBe(200);
  }
  expect((await api(t.baseUrl, "GET", "/api/settings/provider-pace-offsets")).json.offsets).toEqual(pairs);
  expect((await api(t.baseUrl, "GET", "/api/settings/pace-offsets")).json).toEqual({ session: 31, week: 32, fable: 33 });
});

it("行が無い pace offset の既定は Provider × 窓ごと: anthropic session 20 / week 10 / fable 10、openai primary 20 / secondary 10", () => {
  const db = openDb(":memory:");
  expect({
    anthropic: ["session", "week", "fable"].map((w) => getProviderPaceOffset(db, "anthropic", w)),
    openai: ["primary", "secondary"].map((w) => getProviderPaceOffset(db, "openai", w)),
  }).toEqual({ anthropic: [20, 10, 10], openai: [20, 10] });
  db.close();
});

it("空の盤面の pace offset 一覧は既知の5つの組を provider, window 順に既定値で返す", () => {
  const db = openDb(":memory:");
  expect(listProviderPaceOffsets(db)).toEqual(KNOWN_PAIR_DEFAULTS);
  db.close();
});

it("ある組を保存すると一覧ではその組だけが保存値になり、他の組は既定値のまま", () => {
  const db = openDb(":memory:");
  setProviderPaceOffset(db, { provider: "openai", window: "secondary", offset: 42 });
  expect(listProviderPaceOffsets(db)).toEqual(
    KNOWN_PAIR_DEFAULTS.map((p) => (p.window === "secondary" ? { ...p, offset: 42 } : p)),
  );
  db.close();
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
