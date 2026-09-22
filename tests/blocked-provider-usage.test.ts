import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  blockedProviderUsageResources,
  isAnthropicBoardCallBlocked,
  reportProviderUsage,
} from "../src/throttle.js";
import { tempDir } from "./harness.js";

let db: Db | undefined;
afterEach(() => db?.close());

async function freshDb(): Promise<Db> {
  const dir = await tempDir("tidepool-blocked-provider-usage-");
  db = openDb(join(dir, "board.sqlite"));
  return db;
}

const NOW = new Date("2026-07-21T00:00:00Z");
const HOUR = 60 * 60 * 1000;

it("status が observed でない Provider は全体(model: null)が除外される", async () => {
  const db = await freshDb();

  reportProviderUsage(db, {
    provider: "anthropic",
    status: "unauthorized",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [],
  });

  expect(blockedProviderUsageResources(db)).toEqual([{ provider: "anthropic", model: null }]);
});

it("throttled な Provider 全体の窓(model なし)は Provider 全体が除外される", async () => {
  const db = await freshDb();

  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "session",
        model: null,
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(NOW.getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + HOUR),
      },
    ],
  });

  expect(blockedProviderUsageResources(db)).toEqual([{ provider: "anthropic", model: null }]);
});

it("throttled な model 固有の窓(fable)は、その model だけが除外され Provider 全体は除外されない", async () => {
  const db = await freshDb();

  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "fable",
        model: "fable",
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(NOW.getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + HOUR),
      },
    ],
  });

  expect(blockedProviderUsageResources(db)).toEqual([{ provider: "anthropic", model: "fable" }]);
});

it("別 Provider の除外は影響しない(openai の throttle で isAnthropicBoardCallBlocked は false)", async () => {
  const db = await freshDb();
  reportProviderUsage(db, {
    provider: "openai",
    status: "observed",
    plan: "plus",
    cliVersion: "codex-cli 0.147.0",
    observedAt: NOW,
    windows: [
      {
        window: "primary",
        model: null,
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(NOW.getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + HOUR),
      },
    ],
  });

  expect(isAnthropicBoardCallBlocked(db)).toBe(false);
});

it("isAnthropicBoardCallBlocked: Provider 全体の除外は model 引数の有無に関わらず true", async () => {
  const db = await freshDb();
  reportProviderUsage(db, {
    provider: "anthropic",
    status: "unobservable",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [],
  });

  expect(isAnthropicBoardCallBlocked(db)).toBe(true);
  expect(isAnthropicBoardCallBlocked(db, "fable")).toBe(true);
});

it("isAnthropicBoardCallBlocked: model 窓の除外は渡した model が一致するときだけ true、model を渡さなければ false", async () => {
  const db = await freshDb();
  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "fable",
        model: "fable",
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(NOW.getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + HOUR),
      },
    ],
  });

  expect(isAnthropicBoardCallBlocked(db, "fable")).toBe(true);
  expect(isAnthropicBoardCallBlocked(db, "claude-haiku-4-5")).toBe(false);
  expect(isAnthropicBoardCallBlocked(db)).toBe(false);
});

it("Anthropic の使用量観測がまだ無ければ blocked ではない", async () => {
  const db = await freshDb();

  expect(blockedProviderUsageResources(db)).toEqual([]);
  expect(isAnthropicBoardCallBlocked(db)).toBe(false);
});

it("新しい成功した観測が前の除外を置き換える", async () => {
  const db = await freshDb();
  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "session",
        model: null,
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(NOW.getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + HOUR),
      },
    ],
  });
  expect(blockedProviderUsageResources(db)).toEqual([{ provider: "anthropic", model: null }]);

  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "session",
        model: null,
        usedPercent: 50,
        durationMs: HOUR,
        resetsAt: new Date(NOW.getTime() + HOUR),
        throttled: false,
        resumesAt: null,
      },
    ],
  });

  expect(blockedProviderUsageResources(db)).toEqual([]);

  reportProviderUsage(db, {
    provider: "anthropic",
    status: "unauthorized",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [],
  });
  expect(blockedProviderUsageResources(db)).toEqual([{ provider: "anthropic", model: null }]);

  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [],
  });

  expect(blockedProviderUsageResources(db)).toEqual([]);
});
