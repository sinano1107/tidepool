import { describe, expect, it } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { quarantineContainment } from "../src/containment.js";
import { openDb } from "../src/db.js";
import { quarantineFailedTeardown } from "../src/failed-teardown.js";
import { setPaused } from "../src/pause.js";
import { registerQuarantine } from "../src/quarantine.js";
import { answerQuestion, getTask, listBoard } from "../src/tasks.js";
import { startTriage } from "../src/triage.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");

describe("boardHalts は盤面全体の停止を1つの順序つき列挙で答える(ADR 0068)", () => {
  it("停止が無い盤面では空の列挙", () => {
    expect(boardHalts(openDb(":memory:"))).toEqual([]);
  });

  it("5つすべてが同時に立っていれば落ちた後始末は containment の直後・レジストリ到達性の前に並ぶ", () => {
    const db = openDb(":memory:");
    startTriage(db, NOW);
    setPaused(db, true);
    quarantineContainment(db, "no sandbox", NOW);
    // ADR 0112 決定1: 両方立ったときに先に直すべきはホスト全体の側である
    quarantineFailedTeardown(db, "task-1", new Error("resolve exploded"), NOW);
    registerQuarantine(db, "registryReachability", null, "origin is unreachable", NOW);

    expect(boardHalts(db).map((h: { kind: string }) => h.kind)).toEqual([
      "triage",
      "pause",
      "containment",
      "failedTeardown",
      "registryReachability",
    ]);
  });

  it("落ちた後始末が2件なら確認型 question は2枚立ち、片方に答えても残りが開いている間は停止のまま(ADR 0112 決定2)", () => {
    const db = openDb(":memory:");
    quarantineFailedTeardown(db, "task-1", new Error("resolve exploded"), NOW);
    quarantineFailedTeardown(db, "task-2", new Error("resolve exploded"), NOW);
    const [first, second, ...rest] = listBoard(db).filter((t) => t.type === "question");
    expect(rest).toEqual([]);

    answerQuestion(db, getTask(db, first!.id)!, ["repaired by hand"], NOW);
    expect(boardHalts(db)).toEqual([{ kind: "failedTeardown" }]);

    answerQuestion(db, getTask(db, second!.id)!, ["repaired by hand"], NOW);
    expect(boardHalts(db)).toEqual([]);
  });
});
