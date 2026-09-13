import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload, getEvent, listEvents, taskDecisionLog } from "./events.js";
import { type ExecutionSettingRow, loadExecutionSettingTable, rowFor } from "./execution-setting.js";
import { BOARD_WORKER_ID, listChildren, type Task } from "./tasks.js";
import { isAnthropicBoardCallBlocked } from "./throttle.js";
import { type DecisionLogEntry, listObjectedEntries, objectedEntryText } from "./triage.js";

/** Board call に渡す入力(ADR 0115 決定2): 異議されたエントリ本文・その steering 列・
 *  当時の decision log(異議されたタスクの decision_logged と完了エントリ)。agent
 *  定義本文・model 名・価格は渡さない —— 判断に要らず、配分評価の線と同じ。
 *  `entry_id` は Fake が entry ごとに応答を引く鍵で、model に意味は無い。
 *  `rca_findings` は第2回(#575)だけが足す: RCA 子(self / auditor)の decision log と
 *  完了 result を並べたもの。 */
export interface AttributionInput {
  entry_id: number;
  entry: string;
  steering: string[];
  decision_log: string[];
  rca_findings?: string[];
}

/** 帰責の構造化出力 —— 保存する値は `cause` 1つ、evidence は散文(ADR 0115 決定1)。 */
export interface AttributionJudgment {
  cause: Cause;
  evidence: string;
}

/** The Board call seam for attribution (draft / translation / allocation client と
 *  同型): `setting` は盤面が表から解決した Board call 自身の model / effort。 */
export interface AttributionClient {
  judge(
    input: AttributionInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AttributionJudgment>;
}

const uncertain = (evidence: string): AttributionJudgment => ({ cause: "uncertain", evidence });

/** Board call を撃てるか。Provider / ティアは盤面設定の固定値(ADR 0111 決定4 と同じ枠)で、
 *  client 未設定・表の行の欠落・窓の閉鎖は「撃てなかった」として理由を返す。 */
function boardCallSetting(
  db: Db,
  client: AttributionClient | undefined,
):
  | { client: AttributionClient; setting: Pick<ExecutionSettingRow, "model" | "effort"> }
  | { unavailable: string } {
  if (!client) return { unavailable: "not attributed: no attribution client is configured" };
  let setting: Pick<ExecutionSettingRow, "model" | "effort">;
  try {
    setting = rowFor(loadExecutionSettingTable(db), "anthropic", "frontier");
  } catch (err) {
    return { unavailable: `Board call not made: ${message(err)}` };
  }
  if (isAnthropicBoardCallBlocked(db, setting.model)) {
    return { unavailable: "Board call not made: the Anthropic window is closed (throttled)" };
  }
  return { client, setting };
}

/** commit の前半(spec #563「commit の流れ」): open session の異議されたエントリを
 *  1度だけ集め、Board call を並列に問う。transaction の外で待ち、結果の map を持って
 *  従来の transaction に入る。撃てない・失敗した entry は `uncertain` + 理由の
 *  evidence に倒れ、ここからは投げない —— 帰責の障害は commit を止めない(決定2)。 */
export async function attributeObjections(
  db: Db,
  client: AttributionClient | undefined,
  sessionId: number,
): Promise<Map<number, AttributionJudgment>> {
  const objected = listObjectedEntries(db, sessionId);
  const judgments = new Map<number, AttributionJudgment>();
  if (objected.length === 0) return judgments;
  const call = boardCallSetting(db, client);
  if ("unavailable" in call) {
    for (const o of objected) judgments.set(o.entry.id, uncertain(call.unavailable));
    return judgments;
  }
  await Promise.all(
    objected.map(async (o) => {
      const input: AttributionInput = {
        entry_id: o.entry.id,
        entry: objectedEntryText(o.entry),
        steering: o.comments,
        decision_log: decisionLogText(db, o.entry.task_id),
      };
      try {
        judgments.set(o.entry.id, await call.client.judge(input, call.setting));
      } catch (err) {
        judgments.set(o.entry.id, uncertain(`Board call failed: ${message(err)}`));
      }
    }),
  );
  return judgments;
}

/** 帰責の第2回(ADR 0115 決定2 / issue #575): `settled` が異議されたタスクの RCA 子
 *  (self / auditor —— `registerRcaReview` が付ける `rca (` の題)で、それを最後にその
 *  タスクの RCA 子がすべて決着(完了 / 取り消し)したとき、初回が `uncertain` のままの
 *  entry ごとに1度だけ Board call を回し、RCA の findings を証拠にした cause を同じ entry
 *  への新しい event(round = after_rca)として追記する。
 *
 *  1度だけ、の門は2つ —— 決着したのが RCA 子自身で、それで全部が揃ったこと(後から同じ
 *  タスクの統合 review が決着しても撃たない)、そして entry の最新の注釈が `initial` で
 *  あること。撃てない・失敗した entry も初回と同じく `uncertain` + 理由の evidence で
 *  after_rca を追記するので、後日の新しい RCA 群の決着でも門は開かない(第3回は無い)。
 *  settlement の書き込みと同じ tick で呼ぶ: Board call の await より前はすべて同期なので、
 *  2つの扉が同時に「全部揃った」を見ることは無い。 */
export async function attributeAfterRca(
  db: Db,
  client: AttributionClient | undefined,
  settled: Task,
  now: Date,
): Promise<void> {
  if (settled.type !== "review" || settled.parent_id === null) return;
  const objectedId = settled.parent_id;
  // ponytail: RCA 子の目印は題の接頭辞だけ —— task_registered に構造化された印が無い
  const rca = listChildren(db, objectedId).filter((c) => c.type === "review" && c.title.startsWith("rca ("));
  if (!rca.some((r) => r.id === settled.id) || rca.some((r) => r.status !== "done" && r.status !== "cancelled")) {
    return;
  }
  // 最新の帰責が entry ごとに有効(spec #563): 初回の uncertain だけが第2回の対象
  const latest = new Map<number, { id: number } & Extract<EventPayload, { kind: "objection_attributed" }>>();
  for (const e of listEvents(db, objectedId)) {
    if (e.payload.kind === "objection_attributed") latest.set(e.payload.entry_id, { id: e.id, ...e.payload });
  }
  const pending = [...latest.values()].filter((e) => e.cause === "uncertain" && e.round === "initial");
  if (pending.length === 0) return;
  const record = (initial: (typeof pending)[number], judgment: AttributionJudgment) =>
    appendEvent(db, {
      taskId: objectedId,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: {
        kind: "objection_attributed",
        entry_id: initial.entry_id,
        objection_event_ids: initial.objection_event_ids,
        ...judgment,
        round: "after_rca",
      },
      at: now,
    });
  const call = boardCallSetting(db, client);
  if ("unavailable" in call) {
    for (const initial of pending) record(initial, uncertain(call.unavailable));
    return;
  }
  const rcaFindings = rca.flatMap((r) => decisionLogText(db, r.id));
  await Promise.all(
    pending.map(async (initial) => {
      let judgment: AttributionJudgment;
      try {
        const input: AttributionInput = {
          entry_id: initial.entry_id,
          entry: objectedEntryText(getEvent(db, initial.entry_id) as DecisionLogEntry),
          steering: initial.objection_event_ids.map((id) => {
            const p = getEvent(db, id)?.payload;
            return p?.kind === "objection_raised" ? p.comment : "";
          }),
          // 当時の decision log = 初回の注釈より前に書かれた entry
          decision_log: decisionLogText(db, objectedId, initial.id),
          rca_findings: rcaFindings,
        };
        judgment = await call.client.judge(input, call.setting);
      } catch (err) {
        judgment = uncertain(`Board call failed: ${message(err)}`);
      }
      record(initial, judgment);
    }),
  );
}

/** そのタスクの decision log を人間が読んだ本文の列に(`before` を渡せばその event id
 *  より前のものだけ = 当時の log)。 */
function decisionLogText(db: Db, taskId: string, before = Number.POSITIVE_INFINITY): string[] {
  return (taskDecisionLog(db, taskId) as DecisionLogEntry[])
    .filter((e) => e.id < before)
    .map(objectedEntryText);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
