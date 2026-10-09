import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import {
  openQuarantineQuestion,
  parseTableRowEffortValue,
  QUARANTINES,
  type QuarantineKind,
  quarantineStops,
  quarantineUnlessClear,
  registerQuarantine,
  tableRowEffortValue,
} from "../src/quarantine.js";
import { pickupExclusions } from "../src/scheduler.js";
import { cancelTaskDirectly, listBoard, listQueue, nextSlotTask, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

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
  tableRow: ["anthropic/claude-opus-5", "moonshot/kimi-k3[1m]"],
  tableRowEffort: ["openai/gpt-5.5/max", "openai/gpt-5.5/xhigh"],
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

/** 止まるタスクの写像(ADR 0137 決定6): 資源単位の行は、停止範囲の比べ方だけで直接 cancel の
 *  門に掛かる。assignee 群の値は resolver が agent 名へ写す(agent 名は自分自身)。 */
// 表の行(scope "row")はタスクを止めない —— selector が表から外す(ADR 0184 決定2、execution-setting の釘)
describe.each(QUARANTINES.filter((row) => row.scope === "workspace" || row.scope === "assignees"))("資源単位の種類 $kind", (row) => {
  /** 開いた確認の資源を使うタスクを1つ置き、表から導いた止める集合を返す。 */
  function openOverTask() {
    const db = openDb(":memory:");
    const value = SAMPLE[row.kind][0]!;
    const task = registerTask(
      db,
      {
        type: "work",
        title: "uses the quarantined resource",
        purpose: "p",
        completion_criteria: "c",
        ...(row.scope === "workspace" ? { workspace: value } : { assignee: "deckhand" }),
      },
      NOW,
      ...HUMAN_WEBUI,
    );
    registerQuarantine(db, row.kind, value, "cause", NOW);
    const stops = quarantineStops(db, {
      providerAuth: () => ["deckhand"],
      harnessContainment: () => ["deckhand"],
    });
    return { db, task, stops };
  }

  it("開いた確認が subtree のタスクの使う資源に立っている間、直接 cancel は拒まれる", () => {
    const { db, task, stops } = openOverTask();

    expect(() => cancelTaskDirectly(db, task, null, NOW, { quarantined: stops }, "webui")).toThrow(
      /open quarantine confirmation/,
    );
  });

  it("開いた確認が立っている間、その資源を使うタスクは pickup されずキューで skipped に見える", () => {
    const { db, task, stops } = openOverTask();

    expect(nextSlotTask(db, "default-workspace", "deckhand", "auditor", stops)).toBeUndefined();
    expect(listQueue(db, "default-workspace", "deckhand", "auditor", stops).find((t) => t.id === task.id)?.status).toBe(
      "skipped",
    );
  });
});

/** entry 経路の除外(ADR 0110 決定3 / issue #788): 資源単位の行のうち「その Provider では
 *  走れない」を意味する種類は、開いた値から外す Provider の集合を `pickupExclusions` へ出す。 */
describe("pickupExclusions の quarantine 由来の Provider", () => {
  it("providerAuth の開いた値は、その Provider だけを外す", () => {
    const db = openDb(":memory:");
    registerQuarantine(db, "providerAuth", "moonshot", "cause", NOW);

    expect(pickupExclusions(db)).toEqual({ providers: ["moonshot"], models: [] });
  });

  it("harnessContainment の開いた値は、その Harness を正準経路に持つ Provider だけを外す", () => {
    const db = openDb(":memory:");
    registerQuarantine(db, "harnessContainment", "claude-code", "cause", NOW);

    expect(pickupExclusions(db)).toEqual({ providers: ["anthropic", "moonshot"], models: [] });
  });

  it.each(QUARANTINES.filter((row) => "excludesProviders" in row))(
    "行が $kind の外す Provider を持てば、開いた値の Provider が除外に現れる",
    (row) => {
      const db = openDb(":memory:");
      const value = SAMPLE[row.kind][0]!;
      registerQuarantine(db, row.kind, value, "cause", NOW);

      const excluded = row.excludesProviders([value]);
      expect(excluded).not.toEqual([]);
      expect(pickupExclusions(db).providers).toEqual(expect.arrayContaining(excluded));
    },
  );

  it.each(QUARANTINES.filter((row) => !("excludesProviders" in row)).map((row) => row.kind))(
    "%s の開いた quarantine は除外を変えない",
    (kind) => {
      const db = openDb(":memory:");
      registerQuarantine(db, kind, SAMPLE[kind][0], "cause", NOW);

      expect(pickupExclusions(db)).toEqual({ providers: [], models: [] });
    },
  );
});

it("行の Quarantine の文面は原因を断言しない —— 退役とは言わない(ADR 0184 決定1)", () => {
  const row = QUARANTINES.find((r) => r.kind === "tableRow")!;
  expect(row.prose("anthropic/claude-opus-5", "cause").purpose).not.toMatch(/retire/i);
});

const TABLE_ROW = QUARANTINES.find((r) => r.kind === "tableRow")!;

it("404 の行の Quarantine の文面は、証拠の種類を渡しても渡さなくても変わらない(ADR 0184 決定1)", () => {
  const purpose =
    "R. The anthropic provider refused the model id `claude-opus-5` on this board — with this CLI version and this " +
    "account. The board does not know why. This row is out of pickup and Board calls while this stands; " +
    "other rows keep running.\n\nRepair one of two ways:\n\n" +
    "1. Fix the table: in the settings tab, change this row's model or delete the row. This question then closes on its own.\n" +
    "2. If the model id is right, update the CLI or restore the account, then answer — the board checks this model id " +
    "again before it accepts the answer.";
  expect(TABLE_ROW.prose("anthropic/claude-opus-5", "R").purpose).toBe(purpose);
  expect(TABLE_ROW.prose("anthropic/claude-opus-5", "R", "api_404").purpose).toBe(purpose);
});

it("CLI の版の古さの行の Quarantine は原因を名指し、行の差し替えを先に、tidepool の更新を2番目に促す(ADR 0187 決定3)", () => {
  const { purpose, ...rest } = TABLE_ROW.prose("anthropic/claude-opus-5", "R", "cli_version_too_old");
  // タイトル・選択肢・推奨・completion criteria は 404 と同じ
  const { purpose: _, ...rest404 } = TABLE_ROW.prose("anthropic/claude-opus-5", "R", "api_404");
  expect(rest).toEqual(rest404);
  expect(purpose).toContain("This board's Claude Code CLI is older than this model requires");
  expect(purpose).toContain("1. Fix the table: in the settings tab");
  expect(purpose).toContain("2. To keep this row, update tidepool to a version that supports this model, then answer");
  // 運用者は固定の版を変えられない(ADR 0186 決定5)—— CLI の手動更新にも版の番号にも触れない
  expect(purpose).not.toMatch(/update the CLI|claude update/i);
  expect(purpose).not.toMatch(/\d+\.\d+\.\d+/);
});

it("行の effort の Quarantine の値は、model id に `/` があっても (provider, model, effort) に一意に戻る(ADR 0218 決定2)", () => {
  const row = { provider: "openai", model: "org/team/gpt-5.5", effort: "max" } as const;
  expect(tableRowEffortValue(row.provider, row.model, row.effort)).toBe("openai/org/team/gpt-5.5/max");
  expect(parseTableRowEffortValue(tableRowEffortValue(row.provider, row.model, row.effort))).toEqual(row);
  // effort「無い」の行(ADR 0218 決定5)も組が一意に戻る
  const noEffort = { provider: "anthropic", model: "claude-haiku-4-5-20251001", effort: null } as const;
  expect(parseTableRowEffortValue(tableRowEffortValue(noEffort.provider, noEffort.model, noEffort.effort))).toEqual(noEffort);
});
