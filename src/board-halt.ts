import type { Db } from "./db.js";
import type { HaltKind } from "./halt-kind.js";
import { isPaused } from "./pause.js";
import { openQuarantineValues, QUARANTINES } from "./quarantine.js";
import { getThrottleState } from "./throttle.js";
import { activeTriageSession } from "./triage.js";

/** 用語集「盤面全体の停止」の列挙(ADR 0058 決定1)。fable 線と workspace /
 *  agent の quarantine は資源単位なのでここに入らず、spend-down は停止ではなく
 *  操舵なので入らない。
 *
 *  属性を持つのは throttle entry だけである(ADR 0068 決定2)。`observedAt` は
 *  throttle の答えが使用量の読み取りに由来して遅れるための鮮度であり、他の kind は
 *  「row / question が存在する」という盤面自身の事実なので偽の鮮度を持たない。
 *  `revalidating`(再観測中)は独立の kind ではなく throttle の状態、`failClosed`
 *  は「使用量そのものを読めなかった」(ADR 0028)で「線を超えた」とは別の答え。
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
export type BoardHalt =
  | { kind: Exclude<HaltKind, "throttle"> }
  | {
      kind: "throttle";
      revalidating: boolean;
      failClosed: boolean;
      resumesAt: string | null;
      observedAt: string | null;
    };

/** 綴りの正本は依存ゼロの leaf module にある(WebUI がインライン import 型で引くため、
 *  ADR 0133 決定3)。サーバ側から見た語彙の住所はこの module のままである。 */
export { HALT_KINDS, type HaltKind } from "./halt-kind.js";

/** 盤面全体の停止の**順序つき**列挙 — 読み口(`GET /pause`・`GET /api/queue`・
 *  `list_queue`)と scheduler の同期プレフィックスが共有する唯一の場所
 *  (ADR 0068 決定1)。順序は表示優先順位であり interface の一部である:
 *  読み手が並べ替える限り、殺したい「手組みの部分集合」が生き残る。
 *
 *  throttle は `getThrottleState` の生の最終観測値を読む(resets_at の経過で
 *  false に解決しない)— 表示は最後に報告された答えをそのまま見せ、その古さは
 *  `observedAt` が言う(issue #82)。scheduler はこの
 *  entry を消費せず常に再観測する(ADR 0008 の just-in-time / 決定5)。
 *
 *  `throttleRevalidating` を注入する呼び手はもう無い(ADR 0140 決定3、引数ごとの
 *  削除は #803)。 */
export function boardHalts(
  db: Db,
  throttleRevalidating: () => boolean = () => false,
): BoardHalt[] {
  const halts: BoardHalt[] = [];
  if (activeTriageSession(db)) halts.push({ kind: "triage" });
  if (isPaused(db)) halts.push({ kind: "pause" });
  // 表のうち盤面全体の行を表の並びで(ADR 0137 決定6)。1枚でも開いていれば停止 ——
  // failedTeardown は後始末のタスクごとに1枚立つ
  for (const row of QUARANTINES) {
    if (row.scope === "board" && openQuarantineValues(db, row.kind).length > 0) halts.push({ kind: row.kind });
  }
  const throttle = getThrottleState(db);
  const revalidating = throttleRevalidating();
  if (throttle.throttled || revalidating) {
    halts.push({
      kind: "throttle",
      revalidating,
      failClosed: throttle.throttled && !throttle.resetsAt,
      resumesAt: throttle.resetsAt,
      observedAt: throttle.observedAt,
    });
  }
  return halts;
}
