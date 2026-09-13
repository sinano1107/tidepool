import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { resolveExecutionSetting, SEED_EXECUTION_SETTINGS } from "../src/execution-setting.js";

/** 表を読む口は production の呼び手(`resolveExecutionSetting`)しかない
 *  (ADR 0107 決定5)。schema 層のテストは行を SQL で直に言い、読めていることは
 *  その呼び手を通して確かめる。 */
const deckhand = { provider: [{ name: "anthropic", advisor: false }], tier: undefined };

async function boardPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), `tidepool-${name}-`)), "board.sqlite");
}

it("実行設定の表は種の7行から DB へ初期化される —— 価格2列つきのモデル分類の行で、moonshot は economy の1行(ADR 0110 決定3 / ADR 0114 決定2)", async () => {
  const db = openDb(await boardPath("execution-settings-seed"));
  expect(
    db.prepare("SELECT provider, tier, model, effort, price_in, price_out FROM execution_settings ORDER BY provider, model").all(),
  ).toEqual(
    [...SEED_EXECUTION_SETTINGS].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
  );
  expect(db.prepare("SELECT tier FROM execution_settings WHERE provider = 'moonshot'").all()).toEqual([{ tier: "economy" }]);
  expect(resolveExecutionSetting(db, deckhand, undefined)).toMatchObject({ model: "sonnet", effort: "high" });
  db.close();
});

it("主キーは (provider, model) —— 同じ Provider × ティアに複数行を置ける。負の価格は拒む", async () => {
  const db = openDb(await boardPath("execution-settings-pk"));
  const insert = db.prepare(
    "INSERT INTO execution_settings (provider, tier, model, effort, price_in, price_out) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("anthropic", "economy", "haiku", "high", 1, 5);
  expect(() => insert.run("anthropic", "standard", "haiku", "high", 1, 5)).toThrow(/UNIQUE|PRIMARY KEY/);
  expect(() => insert.run("anthropic", "economy", "free", "high", -1, 0)).toThrow(/CHECK/);
  db.close();
});

it("旧形(価格列なし、主キー (provider, tier))の表を持つ盤面を開くと、表は新形で作り直され種から再 seed される(ADR 0114: 編集された表は無い)", async () => {
  const path = await boardPath("execution-settings-old-shape");
  const fresh = openDb(path);
  fresh.close();
  const old = new Database(path);
  old.exec(`
    DROP TABLE execution_settings;
    CREATE TABLE execution_settings (
      provider TEXT NOT NULL,
      tier     TEXT NOT NULL,
      model    TEXT NOT NULL,
      effort   TEXT NOT NULL,
      PRIMARY KEY (provider, tier)
    );
    INSERT INTO execution_settings VALUES ('moonshot', 'frontier', 'kimi-k3[1m]', 'high');
  `);
  old.close();

  const migrated = openDb(path);
  expect(migrated.prepare("SELECT count(*) AS n FROM execution_settings").get()).toEqual({ n: 7 });
  expect(migrated.prepare("SELECT tier FROM execution_settings WHERE provider = 'moonshot'").all()).toEqual([{ tier: "economy" }]);
  migrated.close();
});

it("初期化の後は DB が正本 — 書き換えた行は再オープンで種へ戻らない", async () => {
  const path = await boardPath("execution-settings-authority");
  const first = openDb(path);
  first.prepare("UPDATE execution_settings SET model = 'haiku' WHERE provider = 'anthropic' AND tier = 'economy'").run();
  first.prepare("DELETE FROM execution_settings WHERE provider = 'openai' AND tier = 'frontier'").run();
  first.close();

  const second = openDb(path);
  expect(
    second.prepare("SELECT model FROM execution_settings WHERE provider = 'anthropic' AND tier = 'economy'").get(),
  ).toEqual({ model: "haiku" });
  expect(
    second.prepare("SELECT count(*) AS n FROM execution_settings WHERE provider = 'openai' AND tier = 'frontier'").get(),
  ).toEqual({ n: 0 });
  second.close();
});

it("「上位ティアの行を advisor に使える」フラグの既定は false(未設定の盤面は advisor を main と同一に倒す)", async () => {
  const path = await boardPath("frontier-advisor-default");
  const db = openDb(path);
  const withAdvisor = { provider: [{ name: "anthropic", advisor: true }], tier: "economy" };
  expect(resolveExecutionSetting(db, withAdvisor, undefined)?.advisor).toBe("sonnet");
  db.prepare("INSERT INTO execution_defaults (id, frontier_advisor) VALUES (1, 1)").run();
  expect(resolveExecutionSetting(db, withAdvisor, undefined)?.advisor).toBe("fable");
  db.close();
});
