import { describe, expect, it } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { quarantineContainment } from "../src/containment.js";
import { openDb } from "../src/db.js";
import { quarantineFailedTeardown, quarantineUnclosedSession } from "../src/failed-teardown.js";
import { setPaused } from "../src/pause.js";
import { quarantineStops, registerQuarantine } from "../src/quarantine.js";
import { getTask, listBoard, nextSlotTask, registerTask } from "../src/tasks.js";
import { startTriage } from "../src/triage.js";
import { answerQuestionViaWebui, HUMAN_WEBUI } from "./harness.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");

describe("boardHalts は盤面全体の停止を1つの順序つき列挙で答える(ADR 0068)", () => {
  it("停止が無い盤面では空の列挙", () => {
    expect(boardHalts(openDb(":memory:"))).toEqual([]);
  });

  it("同時に立っていれば落ちた後始末は containment の直後・レジストリ到達性の前に、記録の器は末尾に並ぶ", () => {
    const db = openDb(":memory:");
    startTriage(db, NOW);
    setPaused(db, true);
    quarantineContainment(db, "no sandbox", NOW);
    // ADR 0112 決定1: 両方立ったときに先に直すべきはホスト全体の側である
    quarantineFailedTeardown(db, "task-1", new Error("resolve exploded"), NOW);
    registerQuarantine(db, "registryReachability", null, "origin is unreachable", NOW);
    registerQuarantine(db, "recordContainer", null, "worker-logs is gone", NOW);

    expect(boardHalts(db).map((h: { kind: string }) => h.kind)).toEqual([
      "triage",
      "pause",
      "containment",
      "failedTeardown",
      "registryReachability",
      "recordContainer",
    ]);
  });

  it("閉じ切らなかった session は落ちた後始末の直後に並ぶ —— 先に直すべきは枠が刺さっている側(ADR 0344 決定1)", () => {
    const db = openDb(":memory:");
    registerQuarantine(db, "registryReachability", null, "origin is unreachable", NOW);
    quarantineUnclosedSession(db, 7, "task-1", new Error("exit write failed"), NOW);
    quarantineFailedTeardown(db, "task-1", new Error("resolve exploded"), NOW);

    expect(boardHalts(db).map((h: { kind: string }) => h.kind)).toEqual(["failedTeardown", "unclosedSession", "registryReachability"]);
  });

  it("落ちた後始末が2件なら確認型 question は2枚立ち、片方に答えても残りが開いている間は停止のまま(ADR 0112 決定2)", () => {
    const db = openDb(":memory:");
    quarantineFailedTeardown(db, "task-1", new Error("resolve exploded"), NOW);
    quarantineFailedTeardown(db, "task-2", new Error("resolve exploded"), NOW);
    const [first, second, ...rest] = listBoard(db).filter((t) => t.type === "question");
    expect(rest).toEqual([]);

    answerQuestionViaWebui(db, getTask(db, first!.id)!, ["repaired by hand"], NOW);
    expect(boardHalts(db)).toEqual([{ kind: "failedTeardown" }]);

    answerQuestionViaWebui(db, getTask(db, second!.id)!, ["repaired by hand"], NOW);
    expect(boardHalts(db)).toEqual([]);
  });
});

// ADR 0294 決定2: pickup を止めているのは失敗そのもので、question に門の役は無い
it("続く poll の失敗の question は停止の列挙に現れず、資源の停止も足さず、他の todo は候補のまま", () => {
  const db = openDb(":memory:");
  const todo = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  registerQuarantine(db, "pollFailure", null, "the poll keeps throwing", NOW);

  expect(boardHalts(db)).toEqual([]);
  expect(quarantineStops(db)).toEqual({ workspaces: [], assignees: [] });
  expect(nextSlotTask(db, undefined, "deckhand", "auditor", quarantineStops(db))?.id).toBe(todo.id);
});
