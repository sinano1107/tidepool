import { describe, expect, it } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { quarantineContainment } from "../src/containment.js";
import { openDb } from "../src/db.js";
import { quarantineFailedTeardown } from "../src/failed-teardown.js";
import { setPaused } from "../src/pause.js";
import { quarantineRegistryReachability } from "../src/registry-reachability.js";
import { answerQuestion, getTask, listBoard } from "../src/tasks.js";
import { reportThrottle } from "../src/throttle.js";
import { startTriage } from "../src/triage.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");

describe("boardHalts は盤面全体の停止を1つの順序つき列挙で答える(ADR 0068)", () => {
  it("停止が無い盤面では空の列挙", () => {
    expect(boardHalts(openDb(":memory:"))).toEqual([]);
  });

  it("6つすべてが同時に立っていれば落ちた後始末は containment の直後・レジストリ到達性の前に並ぶ", () => {
    const db = openDb(":memory:");
    startTriage(db, NOW);
    setPaused(db, true);
    quarantineContainment(db, "no sandbox", NOW);
    // ADR 0112 決定1: 両方立ったときに先に直すべきはホスト全体の側である
    quarantineFailedTeardown(db, "task-1", new Error("resolve exploded"), NOW);
    quarantineRegistryReachability(db, "origin is unreachable", NOW);
    reportThrottle(
      db,
      {
        throttled: true,
        resetsAt: new Date(NOW.getTime() + 90 * 60_000),
        windows: { session: null, week: null, fable: null },
      },
      NOW,
    );

    expect(boardHalts(db).map((h: { kind: string }) => h.kind)).toEqual([
      "triage",
      "pause",
      "containment",
      "failedTeardown",
      "registryReachability",
      "throttle",
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

  it("throttle entry は throttled でなくても再観測中なら存在し、鮮度は throttle だけが運ぶ", () => {
    const db = openDb(":memory:");
    setPaused(db, true);

    expect(boardHalts(db, () => true)).toEqual([
      { kind: "pause" },
      {
        kind: "throttle",
        revalidating: true,
        failClosed: false,
        resumesAt: null,
        observedAt: null,
      },
    ]);
  });

  it("throttled なのに resets_at が無い観測は fail-closed として運ばれる", () => {
    const db = openDb(":memory:");
    reportThrottle(
      db,
      { throttled: true, resetsAt: null, windows: { session: null, week: null, fable: null } },
      NOW,
    );

    expect(boardHalts(db)).toEqual([
      {
        kind: "throttle",
        revalidating: false,
        failClosed: true,
        resumesAt: null,
        observedAt: NOW.toISOString(),
      },
    ]);
  });
});
