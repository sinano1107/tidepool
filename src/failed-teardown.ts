import type { Db } from "./db.js";
import { latestEventOfTask } from "./events.js";
import { openQuarantineQuestion, registerQuarantine } from "./quarantine.js";

/** failedTeardown / unclosedSession の reason(question 本文)の前置きと、投げた手の例外本文の境。2つの書き手がこの1つを共有する。 */
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

/** 閉じ切らなかった session を Quarantine の unclosedSession 行で立てる(ADR 0344 決定1・3)。鍵は spawn event id —— 同じ task の
 *  2 session が衝突しない。「いつから」は最初の throw の時刻で、開いている間の登録は何も足さない(ADR 0366 決定1)ので行の本文が持ち続ける。 */
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

/** その spawn が task の今の pickup のものか。後の pickup が来ていれば、その spawn の session はもう枠の主ではない。 */
function spawnedAfterLatestPickup(db: Db, taskId: string, spawnId: number): boolean {
  return spawnId > (latestEventOfTask(db, taskId, "task_picked_up")?.id ?? 0);
}

/** task の今の pickup の session の spawn event id(ADR 0344 決定1: 停止の鍵)。前の pickup の spawn は死んだ session で、今の pickup に
 *  spawn が無ければ process を持たなかった session —— 鍵は task id だけになる。 */
export function spawnOfCurrentPickup(db: Db, taskId: string): number | undefined {
  const spawned = latestEventOfTask(db, taskId, "worker_spawned");
  return spawned && spawnedAfterLatestPickup(db, taskId, spawned.id) ? spawned.id : undefined;
}

/** ADR 0112 決定4 の門(ADR 0344 決定4)の question: 枠の主の session の開いた行 —— `failedTeardown` は task id、`unclosedSession` は
 *  spawn event id で引く。死んだ session の行は読まない —— 走っている session の梯子を止めない。`answeredSpawn` は回答中の spawn で、行はまだ開いている。
 *  後始末の門と、帰り先の持ち主の後始末を待つ人間の扉の拒否文(ADR 0390 決定3)が読む。 */
export function sessionHaltQuestion(db: Db, taskId: string, answeredSpawn?: number): { id: string } | undefined {
  const failed = openQuarantineQuestion(db, "failedTeardown", taskId);
  if (failed) return failed;
  const spawnId = spawnOfCurrentPickup(db, taskId);
  return spawnId === undefined || spawnId === answeredSpawn ? undefined : openQuarantineQuestion(db, "unclosedSession", String(spawnId));
}
