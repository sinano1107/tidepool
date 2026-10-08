import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { executionSettingsFor, SEED_EXECUTION_SETTINGS } from "../src/execution-setting.js";
import { tempDir } from "./temp-dir.js";

/** 表を読む口は production の呼び手(`executionSettingsFor`)しかない
 *  (ADR 0107 決定5)。schema 層のテストは行を SQL で直に言い、読めていることは
 *  その呼び手を通して確かめる。行は段を id で指すので(ADR 0200 決定2)、SQL は段の名前を tiers から引く。 */
const tierId = (name: string) => `(SELECT id FROM tiers WHERE name = '${name}')`;
const deckhand = { provider: [{ name: "anthropic", advisor: false }], tier: undefined };

async function boardPath(name: string): Promise<string> {
  return join(await tempDir(`tidepool-${name}-`), "board.sqlite");
}

it("実行設定の表は種の7行から DB へ初期化される —— 価格2列つきのモデル分類の行で、moonshot は economy の1行(ADR 0110 決定3 / ADR 0114 決定2)", async () => {
  const db = openDb(await boardPath("execution-settings-seed"));
  expect(
    db
      .prepare(
        "SELECT provider, t.name AS tier, model, effort, price_in, price_out FROM execution_settings JOIN tiers t ON t.id = tier_id ORDER BY provider, model",
      )
      .all(),
  ).toEqual(
    [...SEED_EXECUTION_SETTINGS].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
  );
  expect(db.prepare("SELECT t.name AS tier FROM execution_settings JOIN tiers t ON t.id = tier_id WHERE provider = 'moonshot'").all()).toEqual([
    { tier: "economy" },
  ]);
  expect(executionSettingsFor(db, deckhand, undefined)[0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
  db.close();
});

it("主キーは (provider, model) —— 同じ Provider × ティアに複数行を置ける。負の価格は拒む", async () => {
  const db = openDb(await boardPath("execution-settings-pk"));
  const insert = db.prepare(
    "INSERT INTO execution_settings (provider, tier_id, model, effort, price_in, price_out) VALUES (?, (SELECT id FROM tiers WHERE name = ?), ?, ?, ?, ?)",
  );
  insert.run("anthropic", "economy", "haiku", "high", 1, 5);
  expect(() => insert.run("anthropic", "standard", "haiku", "high", 1, 5)).toThrow(/UNIQUE|PRIMARY KEY/);
  expect(() => insert.run("anthropic", "economy", "free", "high", -1, 0)).toThrow(/CHECK/);
  db.close();
});

it("初期化の後は DB が正本 — 書き換えた行は再オープンで種へ戻らない", async () => {
  const path = await boardPath("execution-settings-authority");
  const first = openDb(path);
  first.prepare(`UPDATE execution_settings SET model = 'haiku' WHERE provider = 'anthropic' AND tier_id = ${tierId("economy")}`).run();
  first.prepare(`DELETE FROM execution_settings WHERE provider = 'openai' AND tier_id = ${tierId("frontier")}`).run();
  first.close();

  const second = openDb(path);
  expect(
    second.prepare(`SELECT model FROM execution_settings WHERE provider = 'anthropic' AND tier_id = ${tierId("economy")}`).get(),
  ).toEqual({ model: "haiku" });
  expect(
    second.prepare(`SELECT count(*) AS n FROM execution_settings WHERE provider = 'openai' AND tier_id = ${tierId("frontier")}`).get(),
  ).toEqual({ n: 0 });
  second.close();
});

it("全行を消した表も再オープンで種へ戻らない —— 種で初期化するのは表を作ったときだけ(issue #545)", async () => {
  const path = await boardPath("execution-settings-emptied");
  const first = openDb(path);
  first.prepare("DELETE FROM execution_settings").run();
  first.close();

  const second = openDb(path);
  expect(second.prepare("SELECT count(*) AS n FROM execution_settings").get()).toEqual({ n: 0 });
  second.close();
});

it("execution_defaults の priority 列は quality / cost 以外を拒む(ADR 0114 決定1 / issue #545)", async () => {
  const db = openDb(await boardPath("execution-defaults-columns"));
  expect(() => db.prepare("UPDATE execution_defaults SET priority = 'speed'").run()).toThrow(/CHECK/);
  db.close();
});

it("events.task_id は盤面スコープの操作イベントのために NULL を許す(issue #545)", async () => {
  const db = openDb(await boardPath("events-task-less"));
  db.prepare(
    "INSERT INTO events (task_id, worker_id, origin, kind, payload, created_at) VALUES (NULL, 'human', 'mcp', 'execution_settings_changed', '{}', '2026-09-14T00:00:00.000Z')",
  ).run();
  expect(db.prepare("SELECT task_id, origin FROM events").all()).toEqual([{ task_id: null, origin: "mcp" }]);
  db.close();
});

it("advisor の上限の既定は off(未設定の盤面では advisor を有効にした agent も advisor 無しで走る、ADR 0208 決定1)", async () => {
  const path = await boardPath("advisor-ceiling-default");
  const db = openDb(path);
  const withAdvisor = { provider: [{ name: "anthropic", advisor: true }], tier: "economy" };
  expect(executionSettingsFor(db, withAdvisor, undefined)[0]?.advisor).toBeUndefined();
  db.prepare("UPDATE execution_defaults SET advisor_ceiling = 'fable'").run();
  expect(executionSettingsFor(db, withAdvisor, undefined)[0]?.advisor).toBe("fable");
  db.close();
});
