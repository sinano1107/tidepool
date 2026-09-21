import type { Db } from "./db.js";
import { registerQuarantine } from "./quarantine.js";

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
  // 行に時刻が無いのは、回収 timeout で梯子の底へ落ちた session の受理(`acceptReclaimed`)
  // だけである —— あの経路は後始末に入らないまま確認 question で止まっているので、後始末が
  // 始まったのはこの瞬間であり、catch 時刻がそのまま「いつから未了か」になる。
  const startedAt = row?.teardown_started_at ?? now.toISOString();
  registerQuarantine(
    db,
    "failedTeardown",
    taskId,
    `that teardown has been unfinished since ${startedAt}:\n\n` +
      (err instanceof Error ? err.message : String(err)),
    now,
  );
}
