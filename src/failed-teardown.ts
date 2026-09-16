import type { Db } from "./db.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export const FAILED_TEARDOWN_QUESTION_TITLE = "the board's own teardown failed — pickup is stopped";

/** 立っている「落ちた後始末」の確認 question(ADR 0112 決定2)。既存 quarantine 族の
 *  **機構だけ**を借りた形である —— 行に持つのは question の列1つ、1件につき確認は
 *  最大1枚、解放は確認回答ただ1つ。6つ目の資源ではない: 実行不能になったのは資源では
 *  なく盤面自身のコードである。
 *
 *  門を行に持つのは、in-memory の門が再起動を越えないからである(決定4)—— 越えなければ
 *  起動のたびに同じ所で落ち、偽の Containment question を1枚ずつ刷る。 */
export function openFailedTeardownQuestion(db: Db): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE question_quarantine_teardown IS NOT NULL AND status = 'todo'`,
    )
    .get() as { id: string } | undefined;
}

/** 断言するのは3つだけ(ADR 0112 決定5): どのタスクの後始末が・いつから未了で・盤面の
 *  コードが投げた例外の本文。原因の所在(バグか環境か)とホストのプロセス状態は断言
 *  しない —— 知らないハンドラに文面を書かせると、人間は残っていないプロセスを探す。
 *  受理が後始末の再実行であることは予告する: 予告が無ければ、拒まれた人間は盤面が
 *  壊れたと読む。 */
export function quarantineFailedTeardown(db: Db, taskId: string, err: unknown, now: Date): void {
  // 1件につき確認は最大1枚。登録の直前にもう一度読む(`quarantineContainment` と同じ posture)
  if (openFailedTeardownQuestion(db)) return;
  const row = db.prepare("SELECT teardown_started_at FROM tasks WHERE id = ?").get(taskId) as
    | { teardown_started_at: string | null }
    | undefined;
  // 行に時刻が無いのは、回収 timeout で梯子の底へ落ちた session の受理(`acceptReclaimed`)
  // だけである —— あの経路は後始末に入らないまま確認 question で止まっているので、後始末が
  // 始まったのはこの瞬間であり、catch 時刻がそのまま「いつから未了か」になる。
  const startedAt = row?.teardown_started_at ?? now.toISOString();
  registerTask(
    db,
    {
      type: "question",
      title: FAILED_TEARDOWN_QUESTION_TITLE,
      purpose:
        `the board's own teardown for task ${taskId} threw this exception, and that teardown has ` +
        `been unfinished since ${startedAt}:\n\n${err instanceof Error ? err.message : String(err)}\n\n` +
        "No task is picked up while this stands. Answering re-runs the same teardown: " +
        "if it throws again the answer is refused, " +
        "this question stays open, and the refusal carries that run's exception body.",
      completion_criteria: "the teardown for that task runs to completion",
      question: [
        {
          title: FAILED_TEARDOWN_QUESTION_TITLE,
          options: ["repaired by hand"],
          recommendation: "repaired by hand",
        },
      ],
      quarantine_teardown: taskId,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}
