import type { Db } from "./db.js";
import { registerQuarantine } from "./quarantine.js";

/** failedTeardown / unclosedSession の reason の前置きと、投げた手の例外本文の境。書き手と読み手がこの1つを共有する。 */
const THROWN_TEXT_FOLLOWS = ":\n\n";

/** 落ちた後始末を Quarantine の failedTeardown 行で立てる(ADR 0112 決定2)。既存
 *  quarantine 族の**機構だけ**を借りた形である —— 鍵は後始末のタスク id で、1件に
 *  つき確認は最大1枚、解放は確認回答ただ1つ。資源ではない: 実行不能になったのは
 *  資源ではなく盤面自身のコードである。
 *
 *  門を行に持つのは、in-memory の門が再起動を越えないからである(決定4)—— 越えなければ
 *  起動のたびに同じ所で落ち、偽の Containment question を1枚ずつ刷る。
 *
 *  原因の所在(バグか環境か)とホストのプロセス状態は断言しない —— 知らないハンドラに
 *  文面を書かせると、人間は残っていないプロセスを探す。受理が後始末の再実行であることは
 *  予告する: 予告が無ければ、拒まれた人間は盤面が壊れたと読む。 */
export function quarantineFailedTeardown(db: Db, taskId: string, err: unknown, now: Date): void {
  const row = db.prepare("SELECT teardown_started_at FROM tasks WHERE id = ?").get(taskId) as
    | { teardown_started_at: string | null }
    | undefined;
  // どの経路も後始末に入る前に印を書く(回収 timeout に落ちた watchdog の session も。ADR 0254
  // 決定1)ので、行の時刻がそのまま「いつから未了か」である。印の無い行(行そのものが無い呼び手を
  // 含む)では catch 時刻で代える。
  const startedAt = row?.teardown_started_at ?? now.toISOString();
  registerQuarantine(
    db,
    "failedTeardown",
    taskId,
    `that teardown has been unfinished since ${startedAt}${THROWN_TEXT_FOLLOWS}` +
      (err instanceof Error ? err.message : String(err)),
    now,
  );
}

/** failedTeardown / unclosedSession の `quarantine_refired` の reason から、投げた手の例外本文を取り出す。 */
export function thrownTextOfHaltReason(reason: string): string {
  return reason.slice(reason.indexOf(THROWN_TEXT_FOLLOWS) + THROWN_TEXT_FOLLOWS.length);
}

/** 閉じ切らなかった session を Quarantine の unclosedSession 行で立てる(ADR 0344 決定1・3)。鍵は spawn event id —— 同じ task の
 *  2 session が衝突しない。「いつから」は最初の throw の時刻で、再発火は `registerQuarantine` の畳みに任せるので行の本文が持ち続ける。 */
export function quarantineUnclosedSession(db: Db, spawnId: number, taskId: string, err: unknown, now: Date): void {
  registerQuarantine(
    db,
    "unclosedSession",
    String(spawnId),
    `the session of task ${taskId} has been unclosed since ${now.toISOString()}${THROWN_TEXT_FOLLOWS}` +
      (err instanceof Error ? err.message : String(err)),
    now,
  );
}
