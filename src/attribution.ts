import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { taskDecisionLog } from "./events.js";
import { type ExecutionSettingRow, loadExecutionSettingTable, rowFor } from "./execution-setting.js";
import { isAnthropicBoardCallBlocked } from "./throttle.js";
import { type DecisionLogEntry, listObjectedEntries, objectedEntryText } from "./triage.js";

/** Board call に渡す入力(ADR 0115 決定2): 異議されたエントリ本文・その steering 列・
 *  当時の decision log(異議されたタスクの decision_logged と完了エントリ)。agent
 *  定義本文・model 名・価格は渡さない —— 判断に要らず、配分評価の線と同じ。
 *  `entry_id` は Fake が entry ごとに応答を引く鍵で、model に意味は無い。 */
export interface AttributionInput {
  entry_id: number;
  entry: string;
  steering: string[];
  decision_log: string[];
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
  const allUncertain = (evidence: string) => {
    for (const o of objected) judgments.set(o.entry.id, uncertain(evidence));
    return judgments;
  };
  if (objected.length === 0) return judgments;
  if (!client) return allUncertain("not attributed: no attribution client is configured");
  // Board call の Provider / ティアは盤面設定の固定値(ADR 0111 決定4 と同じ枠)。
  // 表の行が欠けた盤面も「撃てなかった」として uncertain に畳む
  let setting: Pick<ExecutionSettingRow, "model" | "effort">;
  try {
    setting = rowFor(loadExecutionSettingTable(db), "anthropic", "frontier");
  } catch (err) {
    return allUncertain(`Board call not made: ${message(err)}`);
  }
  if (isAnthropicBoardCallBlocked(db, setting.model)) {
    return allUncertain("Board call not made: the Anthropic window is closed (throttled)");
  }
  await Promise.all(
    objected.map(async (o) => {
      const input: AttributionInput = {
        entry_id: o.entry.id,
        entry: objectedEntryText(o.entry),
        steering: o.comments,
        decision_log: (taskDecisionLog(db, o.entry.task_id) as DecisionLogEntry[]).map(objectedEntryText),
      };
      try {
        judgments.set(o.entry.id, await client.judge(input, setting));
      } catch (err) {
        judgments.set(o.entry.id, uncertain(`Board call failed: ${message(err)}`));
      }
    }),
  );
  return judgments;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
