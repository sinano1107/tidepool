import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import {
  openQuarantineQuestion,
  QUARANTINES,
  type QuarantineKind,
  quarantineUnlessClear,
  registerQuarantine,
} from "../src/quarantine.js";
import { listBoard } from "../src/tasks.js";

/** Quarantine の種類の表(ADR 0137 決定1・2)。行を総なめにするので、1行足せば
 *  このテストも足した行について同じことを述べる —— 足すのは下の見本の値だけである。 */

const NOW = new Date("2026-09-21T00:00:00.000Z");

/** 値を持つ種類は別の値を2つ、持たない種類(盤面全体で資源の名が無い)は null だけ。 */
const SAMPLE: Record<QuarantineKind, readonly [string, string] | readonly [null]> = {
  workspace: ["sandbox", "other"],
  agent: ["deckhand", "bosun"],
  providerAuth: ["anthropic", "openai"],
  harnessContainment: ["claude-code", "codex"],
  containment: [null],
  failedTeardown: ["task-1", "task-2"],
  registryReachability: [null],
};

const questions = (db: ReturnType<typeof openDb>) =>
  listBoard(db).filter((t) => t.type === "question");

describe.each(QUARANTINES.map((row) => row.kind))("Quarantine の種類 %s", (kind) => {
  const [value, other] = SAMPLE[kind];

  it("同じ (kind, value) の確認型 question は1枚で、開いている間の再発火は既存の question に quarantine_refired を追記する", () => {
    const db = openDb(":memory:");
    registerQuarantine(db, kind, value, "first cause", NOW);
    registerQuarantine(db, kind, value, "second cause", NOW);

    const [question, ...rest] = questions(db);
    expect(rest).toEqual([]);
    expect(question!.question_quarantine_kind).toBe(kind);
    expect(question!.question_quarantine_value).toBe(value);
    expect(openQuarantineQuestion(db, kind, value)?.id).toBe(question!.id);
    expect(
      listEvents(db, question!.id)
        .map((e) => e.payload)
        .filter((p) => p.kind === "quarantine_refired"),
    ).toEqual([{ kind: "quarantine_refired", cause: "second cause" }]);
  });

  it.skipIf(other === undefined)("別の値は別の確認型 question になる", () => {
    const db = openDb(":memory:");
    registerQuarantine(db, kind, value, "cause", NOW);
    registerQuarantine(db, kind, other!, "cause", NOW);

    expect(questions(db).map((q) => q.question_quarantine_value)).toEqual([value, other]);
  });

  it("開いていれば検査を撃たずに止まったと答え、開いていなければ検査が不成立のときだけ立てる", async () => {
    const db = openDb(":memory:");
    let fired = 0;
    const passing = async () => (fired++, { available: true as const });
    const failing = async () => (fired++, { available: false as const, reason: "broken" });

    expect(await quarantineUnlessClear(db, kind, value, passing, NOW)).toBe(false);
    expect(questions(db)).toEqual([]);
    expect(await quarantineUnlessClear(db, kind, value, failing, NOW)).toBe(true);
    expect(questions(db)).toHaveLength(1);
    expect(await quarantineUnlessClear(db, kind, value, passing, NOW)).toBe(true);
    expect(fired).toBe(2);
  });
});
