import type { Db } from "./db.js";
import type { HaltKind } from "./halt-kind.js";
import { isPaused } from "./pause.js";
import { openQuarantineValues, QUARANTINES } from "./quarantine.js";
import { activeTriageSession } from "./triage.js";

/** 用語集「盤面全体の停止」の列挙(ADR 0058 決定1)。throttle と workspace /
 *  agent の quarantine は資源単位なのでここに入らず(ADR 0140 決定1)、spend-down は
 *  停止ではなく操舵なので入らない。entry は kind だけを持つ —— どれも「row /
 *  question が存在する」という盤面自身の事実なので、鮮度を持たない。
 *
 *  `containment` は**回収済み観測の不成立も含む**(ADR 0099 決定4): 残存 process の
 *  停止範囲は盤面全体で、機構は既存の Containment quarantine を再利用する — 新しい
 *  quarantine 族は立てないので、列挙も1行のままである。どちらで止まっているかは
 *  question の本文が言う。
 *
 *  `failedTeardown` は**盤面自身のコードが投げた**後始末である(ADR 0112 決定1)。
 *  想定どおり走る後始末は停止ではない(枠がまだ空いていないだけ)が、落ちた後始末は
 *  人間が来るまで終わらないので「枠が空かない」であり、停止そのものである。並ぶのは
 *  containment の直後 —— 両方立ったときに先に直すべきはホスト全体の側である。 */
export type BoardHalt = { kind: HaltKind };

/** 綴りの正本は依存ゼロの leaf module にある(WebUI がインライン import 型で引くため、
 *  ADR 0133 決定3)。サーバ側から見た語彙の住所はこの module のままである。 */
export { HALT_KINDS, type HaltKind } from "./halt-kind.js";

/** 盤面全体の停止の**順序つき**列挙 — 読み口(`GET /pause`・`GET /api/queue`・
 *  `list_queue`)と scheduler の同期プレフィックスが共有する唯一の場所
 *  (ADR 0068 決定1)。順序は表示優先順位であり interface の一部である:
 *  読み手が並べ替える限り、殺したい「手組みの部分集合」が生き残る。 */
export function boardHalts(db: Db): BoardHalt[] {
  const halts: BoardHalt[] = [];
  if (activeTriageSession(db)) halts.push({ kind: "triage" });
  if (isPaused(db)) halts.push({ kind: "pause" });
  // 表のうち盤面全体の行を表の並びで(ADR 0137 決定6)。1枚でも開いていれば停止 ——
  // failedTeardown は後始末のタスクごとに1枚立つ
  for (const row of QUARANTINES) {
    if (row.scope === "board" && openQuarantineValues(db, row.kind).length > 0) halts.push({ kind: row.kind });
  }
  return halts;
}
