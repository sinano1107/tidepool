import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { setPaceOffsets, setProviderPaceOffset } from "../src/pace-offsets.js";
import { setSpendDown } from "../src/spend-down.js";
import {
  evaluateAndReportProviderUsage,
  reportProviderUsage,
  reportThrottle,
} from "../src/throttle.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool | undefined;
let dir: string | undefined;

afterEach(async () => {
  await t?.stopServer();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("Provider/window の観測値・offset・freshness・CLI version を pause と queue に永続表示する", async () => {
  dir = await mkdtemp(join(tmpdir(), "tidepool-provider-usage-"));
  const db = openDb(join(dir, "board.sqlite"));
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
  db.close();

  t = await bootTidepool({ dir });
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

it("openDb は既存の account-wide throttle と offsets を anthropic の Provider/window 状態へ移す", async () => {
  dir = await mkdtemp(join(tmpdir(), "tidepool-provider-migration-"));
  const path = join(dir, "board.sqlite");
  const db = openDb(path);
  const observedAt = new Date("2026-08-28T08:00:00.000Z");
  reportThrottle(
    db,
    {
      throttled: true,
      resetsAt: new Date("2026-08-28T09:00:00.000Z"),
      windows: {
        session: { throttled: true, resumeAt: new Date("2026-08-28T08:30:00.000Z") },
        week: { throttled: false, resumeAt: null },
        fable: null,
      },
    },
    observedAt,
  );
  setPaceOffsets(db, { session: 25, week: 15, fable: 5 });
  db.close();

  // Reopening is the migration seam; HTTP is the only assertion surface.
  openDb(path).close();
  t = await bootTidepool({ dir });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage).toEqual([
    {
      provider: "anthropic",
      status: "observed",
      plan: null,
      cliVersion: null,
      observedAt: observedAt.toISOString(),
      windows: [
        {
          window: "session",
          model: null,
          usedPercent: null,
          durationMs: null,
          resetsAt: null,
          offset: 25,
          throttled: true,
          resumesAt: "2026-08-28T08:30:00.000Z",
        },
        {
          window: "week",
          model: null,
          usedPercent: null,
          durationMs: null,
          resetsAt: null,
          offset: 15,
          throttled: false,
          resumesAt: null,
        },
      ],
    },
  ]);
});

it("legacy の未観測 window は migration 後も Anthropic unobservable のまま", async () => {
  dir = await mkdtemp(join(tmpdir(), "tidepool-provider-unobservable-migration-"));
  const path = join(dir, "board.sqlite");
  const db = openDb(path);
  reportThrottle(
    db,
    {
      throttled: true,
      resetsAt: null,
      windows: {
        session: null,
        week: { throttled: false, resumeAt: null },
        fable: null,
      },
    },
    new Date("2026-08-28T08:00:00.000Z"),
  );
  db.close();
  openDb(path).close();
  t = await bootTidepool({ dir });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage[0]).toMatchObject({
    provider: "anthropic",
    status: "unobservable",
  });
});

it("OpenAI Provider window は active Spend-down で pace line を外し 100% cap だけを残す", () => {
  const db = openDb(":memory:");
  const now = new Date("2026-08-28T08:00:00.000Z");
  setSpendDown(db, "session", now);

  const observed = evaluateAndReportProviderUsage(
    db,
    {
      provider: "openai",
      status: "observed",
      plan: "plus",
      cliVersion: "codex-cli 0.147.0",
      windows: [
        {
          window: "primary",
          model: null,
          usedPercent: 50,
          durationMs: 5 * 60 * 60 * 1000,
          resetsAt: new Date("2026-08-28T12:00:00.000Z"),
        },
      ],
    },
    now,
  );

  expect(observed.windows[0]).toMatchObject({ throttled: false, resumesAt: null });
  db.close();
});
