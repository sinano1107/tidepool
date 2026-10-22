import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BoardCallUsageError, listBoardCalls, listTranslationUsage, recordBoardCall, recordedAnswer } from "../src/board-call-usage.js";
import { CliAuthError, RowRefusalError } from "../src/cli-auth.js";
import { type Db, openDb } from "../src/db.js";
import { BOARD_CALL_USAGE as USAGE } from "./fakes.js";
import { tempDir } from "./temp-dir.js";

let db: Db | undefined;
afterEach(() => db?.close());

const SETTING = { provider: "anthropic", model: "haiku", effort: "low" } as const;

async function freshDb(): Promise<Db> {
  const dir = await tempDir("tidepool-board-call-usage-");
  db = openDb(join(dir, "board.sqlite"));
  return db;
}

it("書いた行は用途・Provider・token・費用の null のまま読み戻せ、翻訳以外の行は断片数を持たない(ADR 0299 決定2)", async () => {
  const db = await freshDb();
  const now = new Date("2026-10-22T00:00:00Z");
  recordBoardCall(db, "allocation_review", { provider: "openai", model: "gpt-5.5", effort: "high" }, { ...USAGE, estimated_cost_usd: null }, now);

  expect(listBoardCalls(db)).toEqual([
    {
      use: "allocation_review",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fragments: null,
      usage: { ...USAGE, estimated_cost_usd: null },
      createdAt: now.toISOString(),
    },
  ]);
});

it("同一の created_at を持つ呼び出しの記録は保存順で返る(issue #688)", async () => {
  const db = await freshDb();
  const now = new Date("2026-07-21T00:00:00Z");
  for (const input_tokens of [1, 2, 3]) recordBoardCall(db, "translation", SETTING, { ...USAGE, input_tokens }, now, 1);

  expect(listTranslationUsage(db).map((r) => r.usage.input_tokens)).toEqual([1, 2, 3]);
});

it("created_at が異なる呼び出しの記録は created_at の昇順で返る(先に新しい行を保存しても古い行が先頭)", async () => {
  const db = await freshDb();
  recordBoardCall(db, "translation", SETTING, { ...USAGE, input_tokens: 9 }, new Date("2026-07-21T00:00:01Z"), 1);
  recordBoardCall(db, "translation", SETTING, { ...USAGE, input_tokens: 1 }, new Date("2026-07-21T00:00:00Z"), 1);

  expect(listTranslationUsage(db).map((r) => r.usage.input_tokens)).toEqual([1, 9]);
});

it("翻訳の usage の読み口は用途 translation の行だけを返す(ADR 0299 帰結)", async () => {
  const db = await freshDb();
  const now = new Date("2026-10-22T00:00:00Z");
  recordBoardCall(db, "allocation_review", { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, USAGE, now);
  recordBoardCall(db, "translation", SETTING, USAGE, now, 2);

  expect(listTranslationUsage(db)).toEqual([
    { provider: "anthropic", model: "haiku", fragments: 2, usage: USAGE, createdAt: now.toISOString() },
  ]);
});

it("答えが返った Board call は行を書き、答えを返す(ADR 0299 決定1)", async () => {
  const db = await freshDb();
  const now = new Date("2026-10-22T00:00:00Z");

  const output = await recordedAnswer(db, "attribution", now, Promise.resolve({ output: { ok: true }, usage: USAGE, setting: SETTING }));

  expect(output).toEqual({ ok: true });
  expect(listBoardCalls(db)).toEqual([{ use: "attribution", ...SETTING, fragments: null, usage: USAGE, createdAt: now.toISOString() }]);
});

it("usage を報告して失敗した Board call は行を書き、失敗をそのまま投げる(ADR 0299 決定3)", async () => {
  const db = await freshDb();
  const now = new Date("2026-10-22T00:00:00Z");
  const failed = new BoardCallUsageError("answer did not match the schema", SETTING, USAGE);

  await expect(recordedAnswer(db, "attribution", now, Promise.reject(failed))).rejects.toBe(failed);

  expect(listBoardCalls(db)).toEqual([{ use: "attribution", ...SETTING, fragments: null, usage: USAGE, createdAt: now.toISOString() }]);
});

it.each([
  ["行の拒否", new RowRefusalError("anthropic", "haiku", "api_404")],
  ["401", new CliAuthError("Invalid API key")],
  ["usage の無い失敗", new Error("claude CLI timed out")],
])("%s で終わった Board call は行を書かず、失敗をそのまま投げる(ADR 0299 決定3)", async (_, refusal) => {
  const db = await freshDb();

  await expect(recordedAnswer(db, "attribution", new Date("2026-10-22T00:00:00Z"), Promise.reject(refusal))).rejects.toBe(refusal);

  expect(listBoardCalls(db)).toEqual([]);
});
