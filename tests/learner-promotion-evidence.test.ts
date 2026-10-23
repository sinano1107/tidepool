import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, type EventPayload, getEvent, latestEventOfTask } from "../src/events.js";
import { applyExecutionSettingsChange } from "../src/execution-setting.js";
import { recordShadow, type TrackRecord } from "../src/learner.js";
import { registerMetaReview } from "../src/meta-review.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { getTask, listBoard, listChildren, registerTask } from "../src/tasks.js";
import { divergedSession, executionSetting, HUMAN_WEBUI, NO_RECORD, routingJudgmentRepairTask, WORKER_SPAWNED } from "./harness.js";

/** 学習器の昇格 / 降格の提案の根拠(ADR 0181 追記 #2438)のドメイン層: 根拠の検査と、盤面が根拠の shadow 行から組む detail。MCP の
 *  inputSchema が evidence を通すことはサーバ境界の tests/routing-proposal-question.test.ts、flag の直接の変更での決着は tests/execution-settings-endpoints.test.ts が言う。 */
const at = new Date("2026-10-22T00:00:00.000Z");

const record = (board: [number, number], workspace: [number, number], seed: TrackRecord["seed"] = null): TrackRecord => ({
  board: { accepted: board[0], rejected: board[1] },
  workspace: { accepted: workspace[0], rejected: workspace[1] },
  seed,
});

function board() {
  const db = openDb(":memory:");
  registerMetaReview(db, "routing", at);
  const review = listBoard(db).find((task) => task.meta_review_subject === "routing")!.id;
  // 昇格は承認の適用だけが書き、公開の扉は降格しか受けない(executionSettingsChangeSchema の learner_promoted)
  const promote = () => db.prepare("UPDATE execution_defaults SET learner_promoted = 1").run();
  const propose = (op: "promote" | "demote", evidence?: number[]) => proposeRoutingChange(db, review, { op, evidence, rationale: "r" }, "auditor", at);
  return { db, review, promote, propose };
}

it("昇格 / 降格の提案は根拠が無いと拒まれる", () => {
  const { promote, propose } = board();
  expect(() => propose("promote")).toThrow(/op promote names at least one evidence/);
  expect(() => propose("promote", [])).toThrow(DomainError);
  promote();
  expect(() => propose("demote")).toThrow(/op demote names at least one evidence/);
});

it("根拠は乖離した shadow 行の session の worker_spawned に限る —— 他の種類の event、shadow 行の無い spawn、乖離していない行の session は理由を名指して拒まれ、question は立たない", () => {
  const { db, review, propose } = board();
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const registered = latestEventOfTask(db, work, "task_registered")!.id;
  // review の session: pickup に shadow 行を書かない
  const reviewSession = appendEvent(db, { taskId: review, workerId: "auditor", origin: "board", at, payload: WORKER_SPAWNED });
  const run = executionSetting("anthropic", "claude-opus-5-5");
  recordShadow(db, work, { recommended: run, actual: run, basis: "data", recommended_record: NO_RECORD, actual_record: NO_RECORD, candidates: 2 }, at);
  const matched = appendEvent(db, { taskId: work, workerId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });

  expect(() => propose("promote", [registered])).toThrow(`evidence ${registered} is not a worker_spawned event`);
  expect(() => propose("promote", [reviewSession])).toThrow(`evidence ${reviewSession} is not the session of any shadow row`);
  expect(() => propose("promote", [matched])).toThrow(`evidence ${matched} is the session of a shadow row where the learner recommended the cell that ran`);
  expect(listChildren(db, review)).toEqual([]);
});

it("昇格の根拠は出所が学習器でない行(昇格前)、降格の根拠は出所が学習器の行(昇格後)に限る", () => {
  const { db, promote, propose } = board();
  const before = divergedSession(db, at);
  const after = divergedSession(db, at, { learner: true });

  expect(() => propose("promote", [after])).toThrow(`evidence ${after} ran on the promoted learner's choice: op promote rests on rows from before promotion`);
  promote();
  expect(() => propose("demote", [before])).toThrow(`evidence ${before} ran on the table's choice: op demote rests on rows where the promoted learner's choice ran`);
});

const taskOf = (db: Db, spawned: number) => getEvent(db, spawned)!.task_id!;
const detailOf = (db: Db, questionId: string) => getTask(db, questionId)!.question_items![0]!.detail!;
const SONNET = "anthropic / claude-sonnet-5-5 at effort high";
const OPUS = "anthropic / claude-opus-5-5 at effort high";

it("昇格前の昇格の提案は、根拠を (段, workspace, 学習器のセル, 表のセル) ごとに1行にまとめ、件数・task id・直近の引用した pickup 時点の両セルの実績を出し、outcome は出さない。question_proposal は evidence を持ち pin は { promoted } のまま", () => {
  const { db, propose } = board();
  const first = divergedSession(db, at, { learnerRecord: record([1, 0], [1, 0]), tableRecord: record([100, 1], [40, 0]) });
  const latest = divergedSession(db, at, { learnerRecord: record([2, 0], [2, 0]), tableRecord: record([101, 1], [41, 0], { kind: "interview", event_id: 7 }) });
  const elsewhere = divergedSession(db, at, { workspace: "lagoon", learnerRecord: record([2, 0], [0, 0]), tableRecord: record([101, 1], [3, 1]) });
  const frontier = divergedSession(db, at, { tier: "frontier" });

  const { question_id } = propose("promote", [first, latest, elsewhere, frontier]);

  expect(getTask(db, question_id)!.question_proposal).toEqual({ kind: "routing", op: "promote", evidence: [first, latest, elsewhere, frontier], pin: { promoted: false } });
  const detail = detailOf(db, question_id);
  for (const line of [
    `- tier standard, workspace reef, learner ${SONNET}, table ${OPUS}: 2 pickup(s) (tasks ${taskOf(db, first)}, ${taskOf(db, latest)}); learner board 2/0, workspace 2/0; table board 101/1, workspace 41/0, seeded by interview`,
    `- tier standard, workspace lagoon, learner ${SONNET}, table ${OPUS}: 1 pickup(s) (tasks ${taskOf(db, elsewhere)}); learner board 2/0, workspace 0/0; table board 101/1, workspace 3/1`,
    `- tier frontier, workspace reef, learner ${SONNET}, table ${OPUS}: 1 pickup(s) (tasks ${taskOf(db, frontier)}); learner board 0/0, workspace 0/0; table board 0/0, workspace 0/0`,
  ]) {
    expect(detail.split("\n")).toContain(line);
  }
  expect(detail).not.toMatch(/outcome/i);
  // フラグが一度も変わっていなければ全期間
  expect(detail.split("\n")).toContain(
    "All diverged pickups where the table's choice ran, over all time (the learner flag never changed): 4 in 3 line(s), 4 cited; lines not cited: none. Pickups with two or more candidates in that span: 4.",
  );
});

it("引用の外の乖離も盤面が1行で見せる —— フラグの最後の変更以降の同じ向きの乖離行の総数・組の数・うち引用した数・引用されなかった組ごとの件数と、候補が2行以上の pickup の数。変更より前の行と逆の向きの行は数えない。候補が2行以上の pickup は向きを問わず同じ範囲で数える", () => {
  const { db, propose } = board();
  divergedSession(db, at);
  // 昇格の承認の適用と同じ書き方(扉の schema を通さない)—— フラグの変更が2回あり、数えるのは最後の変更以降
  applyExecutionSettingsChange(db, { setting: "learner_promoted", value: true }, "webui", at);
  divergedSession(db, at);
  divergedSession(db, at, { learner: true });
  const change = applyExecutionSettingsChange(db, { setting: "learner_promoted", value: false }, "webui", at)!;
  // 学習器のフラグでない設定の変更は範囲を切らない
  applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at);
  const cited = divergedSession(db, at);
  divergedSession(db, at);
  divergedSession(db, at, { learnerModel: "claude-haiku-5-5" });
  divergedSession(db, at, { learner: true });
  const run = executionSetting("anthropic", "claude-opus-5-5");
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  for (const candidates of [2, 1]) recordShadow(db, work, { recommended: run, actual: run, basis: "data", recommended_record: NO_RECORD, actual_record: NO_RECORD, candidates }, at);

  const { question_id } = propose("promote", [cited]);

  expect(detailOf(db, question_id).split("\n")).toContain(
    `All diverged pickups where the table's choice ran, since the learner flag last changed (event ${change}): 3 in 2 line(s), 1 cited; lines not cited: tier standard, workspace reef, learner anthropic / claude-haiku-5-5 at effort high, table ${OPUS}: 1. Pickups with two or more candidates in that span: 5.`,
  );
});

it("フラグの最後の変更より前の乖離行の session は、変更の event を名指して拒まれる —— 引用できる範囲は引用の外と同じ", () => {
  const { db, propose } = board();
  const earlier = divergedSession(db, at);
  applyExecutionSettingsChange(db, { setting: "learner_promoted", value: true }, "webui", at);
  const change = applyExecutionSettingsChange(db, { setting: "learner_promoted", value: false }, "webui", at)!;

  expect(() => propose("promote", [earlier])).toThrow(`evidence ${earlier} is the session of a shadow row from before the learner flag last changed (event ${change})`);
});

it("値の変わらない降格(未昇格のまま)はフラグの変更ではないので、引用の外の範囲を切らない", () => {
  const { db, propose } = board();
  applyExecutionSettingsChange(db, { setting: "learner_promoted", value: false }, "webui", at);
  const cited = divergedSession(db, at);

  const { question_id } = propose("promote", [cited]);

  expect(detailOf(db, question_id).split("\n")).toContain(
    "All diverged pickups where the table's choice ran, over all time (the learner flag never changed): 1 in 1 line(s), 1 cited; lines not cited: none. Pickups with two or more candidates in that span: 1.",
  );
});

it("昇格後の降格の提案は、走った学習器のセルと推薦に回った表のセルを出所で呼び分け(列の反転)、組ごとに session の outcome の内訳を出す", () => {
  const { db, promote, propose } = board();
  promote();
  const excluded = divergedSession(db, at, { learner: true, learnerRecord: record([3, 0], [1, 0]), tableRecord: record([90, 2], [9, 1]) });
  const rejected = divergedSession(db, at, { learner: true, learnerRecord: record([3, 1], [1, 1]), tableRecord: record([90, 2], [9, 1]) });
  const payload = { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: rejected, judge: { provider: "anthropic", model: "fable", effort: "high" }, allocation: "underpowered", cause: "capability", evidence: "e" };
  appendEvent(db, { taskId: taskOf(db, rejected), workerId: "tidepool", origin: "board", at, payload: payload as Extract<EventPayload, { kind: "allocation_reviewed" }> });

  const { question_id } = propose("demote", [excluded, rejected]);

  expect(getTask(db, question_id)!.question_proposal).toEqual({ kind: "routing", op: "demote", evidence: [excluded, rejected], pin: { promoted: true } });
  expect(detailOf(db, question_id).split("\n")).toContain(
    `- tier standard, workspace reef, learner ${SONNET}, table ${OPUS}: 2 pickup(s) (tasks ${taskOf(db, excluded)}, ${taskOf(db, rejected)}); learner board 3/1, workspace 1/1; table board 90/2, workspace 9/1; outcomes 0 accepted, 1 rejected, 1 excluded`,
  );
  expect(detailOf(db, question_id).split("\n")).toContain(
    "All diverged pickups where the learner's choice ran, over all time (the learner flag never changed): 2 in 1 line(s), 2 cited; lines not cited: none. Pickups with two or more candidates in that span: 2.",
  );
});

it("routing repair の昇格の提案も同じ根拠の検査を通り、detail を同じく組む", () => {
  const db = openDb(":memory:");
  const repair = routingJudgmentRepairTask(db, at);
  const propose = (evidence?: number[]) => proposeRoutingChange(db, repair.id, { op: "promote", evidence, rationale: "r" }, "auditor", at);
  const afterPromotion = divergedSession(db, at, { learner: true });

  expect(() => propose()).toThrow(/op promote names at least one evidence/);
  expect(() => propose([afterPromotion])).toThrow(`evidence ${afterPromotion} ran on the promoted learner's choice`);
  const { question_id } = propose([divergedSession(db, at)]);
  expect(detailOf(db, question_id)).toContain("Evidence: 1 worker session(s) of diverged shadow rows");
});
