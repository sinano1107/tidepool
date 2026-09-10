import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { resolveExecutionSetting, SEED_EXECUTION_SETTINGS } from "../src/execution-setting.js";

/** 表を読む口は production の呼び手(`resolveExecutionSetting`)しかない
 *  (ADR 0107 決定5)。schema 層のテストは行を SQL で直に言い、読めていることは
 *  その呼び手を通して確かめる。 */
const deckhand = { provider: "anthropic", tier: undefined, advisor: false };

async function boardPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), `tidepool-${name}-`)), "board.sqlite");
}

it("実行設定の表は種の既定から DB へ初期化される(ADR 0110 決定3)", async () => {
  const db = openDb(await boardPath("execution-settings-seed"));
  expect(
    db.prepare("SELECT provider, tier, model, effort FROM execution_settings ORDER BY provider, tier").all(),
  ).toEqual(
    [...SEED_EXECUTION_SETTINGS].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.tier.localeCompare(b.tier),
    ),
  );
  expect(resolveExecutionSetting(db, deckhand)).toMatchObject({ model: "sonnet", effort: "high" });
  db.close();
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
  const withAdvisor = { provider: "anthropic", tier: "economy", advisor: true };
  expect(resolveExecutionSetting(db, withAdvisor).advisor).toBe("sonnet");
  db.prepare("INSERT INTO execution_defaults (id, frontier_advisor) VALUES (1, 1)").run();
  expect(resolveExecutionSetting(db, withAdvisor).advisor).toBe("fable");
  db.close();
});
