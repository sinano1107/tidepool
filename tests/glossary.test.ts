import { expect, it } from "vitest";
import { parseGlossary } from "../src/glossary.js";

it("CONTEXT.md の `## Term(日本語)` 見出しから対訳エントリを抽出する", () => {
  const md = [
    "# Tidepool — ubiquitous language",
    "",
    "## Task(タスク)",
    "",
    "ボード上の作業単位。",
    "",
    "## Settled(決着)",
    "",
    "タスクが終端に達した状態。",
  ].join("\n");

  expect(parseGlossary(md)).toEqual([
    { term: "Task", ja: "タスク" },
    { term: "Settled", ja: "決着" },
  ]);
});

it("括弧を持たない見出し(複合語・スラッシュ区切り)はエントリにならない", () => {
  const md = [
    "## Slot-release tree rule",
    "",
    "本文。",
    "",
    "## Swell / Condensation",
    "",
    "本文。",
    "",
    "## Held(保留)",
  ].join("\n");

  expect(parseGlossary(md)).toEqual([{ term: "Held", ja: "保留" }]);
});
