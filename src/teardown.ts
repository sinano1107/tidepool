import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { GitHubAuth } from "./github-auth.js";
import type { Landing } from "./landing.js";
import type { Slot } from "./slot.js";
import { getTask, type Task } from "./tasks.js";
import {
  ensureWorkspaceToken,
  releaseWorkspace,
  resolveOrQuarantine,
  type WorkspaceConfig,
} from "./workspace.js";

/** 後始末(CONTEXT.md「後始末」/ ADR 0109)に要るもの。上限到達による中断の
 *  ハンドラが既に持っていた引数と**同じ**であり、通常完了・上限到達による中断・
 *  watchdog の強制回収の3経路がこの1つの型を共有する(ADR 0109 決定1)。 */
export interface TeardownDeps {
  db: Db;
  clock: Clock;
  slot: Slot;
  /** watchdog / MCP と同じ resolver(`buildWorkspaceResolver` 製)。無ければ
   *  workspace 追跡の無い盤面なので tree rule は走らない。 */
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined;
  githubAuth?: GitHubAuth;
  /** 完了経路の着地(issue #19)。**merge-back の後**に走る —— 帰り先を決める fetch も
   *  退避もこの手前で済んでいなければ、昇格は古い remote-tracking ref を読み、tree rule の
   *  失敗より先に PR 昇格の失敗を人間へ届けてしまう。Absent → 着地口を持たない呼び手
   *  (起動時の復旧より前の段)。 */
  landing?: Landing;
}

/** 経路ごとに違うのはこの4つだけである。 */
export interface TeardownStep {
  /** ツリー規律の**前**に走る記録 —— watchdog の failure question がこれ(自分の
   *  escalate を真似て、記録を先に置く)。 */
  record?: (task: Task, now: Date) => void;
  /** ツリー規律の**後**の状態遷移 —— 上限到達による中断の todo 復帰がこれ。完了経路は
   *  タスクが既に決着しているので持たない。 */
  transition?: (task: Task, now: Date) => void;
  /** slot の再観測に加わる、経路ごとの状態の門(cap / watchdog は `in_progress` の
   *  ときだけ)。 */
  ready?: (task: Task) => boolean;
  /** 完了経路(ADR 0109 決定1・3): 退避ではなく検査を走らせ、work タスクなら
   *  merge-back まで進む。 */
  completion?: boolean;
  /** 既に解決済みの workspace。`resolveOrQuarantine` は quarantine の**副作用**を
   *  持つので、完了の門が先に解決している経路では1つの verb 呼び出しで2度撃たない。 */
  workspace?: WorkspaceConfig;
}

/** 後始末の一撃(ADR 0109 決定1): tree rule → 状態遷移 → slot 解放。
 *
 *  **門は `slot.currentTaskId` の再観測ひとつである。** 回収済み観測は非同期に届く
 *  ので、その間に次の session が枠に入っていることがありうる —— 他人の slot を
 *  解放しないために、ここで観測しなおす(`capInterruptionHandler` が ADR 0104 の
 *  実装時に局所的に取った自衛と同じ形で、それが1つの session につきちょうど1回を
 *  保証する)。
 *
 *  **投げない。** 呼び口は全部 fire-and-forget の `void` である(回収済み観測の
 *  `.then`、adapter の中断ハンドラ、起動時の復旧)—— 解放が同期だった頃は例外が
 *  MCP 呼び出しの返り値になったが、今ここで投げれば unhandled rejection として盤面
 *  ごと落ち、しかも未了は行に残るので次の起動でも同じ所で落ちる。個々の失敗は
 *  すでにそれぞれの位置で quarantine に落ちている(`releaseWorkspace`)ので、ここへ
 *  届くのは想定外だけである: 記録して流し、枠は握られたまま「後始末待ち」として
 *  読み口に残す(ADR 0083 追記2 と同じ姿勢)。 */
export async function runTeardown(
  deps: TeardownDeps,
  taskId: string,
  step: TeardownStep = {},
): Promise<void> {
  try {
    await teardown(deps, taskId, step);
  } catch (err) {
    console.error(`[teardown] task ${taskId}:`, err);
  }
}

async function teardown(deps: TeardownDeps, taskId: string, step: TeardownStep): Promise<void> {
  const { db, clock, slot } = deps;
  if (slot.currentTaskId !== taskId) return;
  const task = getTask(db, taskId);
  if (!task) return;
  if (step.ready && !step.ready(task)) return;
  const workspace =
    step.workspace ??
    (deps.resolve && resolveOrQuarantine(db, deps.resolve, task.workspace, clock.now()));
  const mergeBack = Boolean(step.completion) && task.type === "work";
  // ADR 0093: merge-back は帰り先を決めるために fetch する。その token の取得だけが
  // ネットワークなので、同期の `releaseWorkspace` の手前で撃つ。失敗は投げずに持ち越す
  // —— ここで投げると tree rule も slot の解放も走らない。
  let tokenFailure: unknown;
  if (workspace && mergeBack) {
    try {
      await ensureWorkspaceToken(workspace, deps.githubAuth);
    } catch (err) {
      tokenFailure = err ?? new Error("GitHub token acquisition failed");
    }
  }
  // その await を跨ぐ間に枠の主が変わっていることがありうるので、門をもう一度読む
  if (slot.currentTaskId !== taskId) return;
  const now = clock.now();
  step.record?.(task, now);
  if (workspace) {
    releaseWorkspace(
      db,
      workspace,
      task,
      now,
      mergeBack,
      deps.githubAuth,
      tokenFailure,
      step.completion,
    );
  }
  step.transition?.(task, now);
  clearTeardown(db, taskId);
  slot.release();
  // 着地は枠を空けた後に撃つ(従来 `complete_task` が解放の後に撃っていたのと同じ位置)
  if (step.completion && deps.landing && task.status === "done") {
    await deps.landing.land(task);
    // 完了したのが付帯子なら、待っていた祖先の着地がここで起きる(ADR 0092 決定3)
    await deps.landing.relandAncestors(task);
  }
}

/** slot-release tree rule の一撃だけ(CONTEXT.md「Slot-release tree rule」)。
 *  slot を持たない呼び手 —— 起動時の中断処理と、回収 timeout 後に確認回答で
 *  解放される経路 —— が使う。resolve が無い盤面では no-op。 */
export function runTreeRule(
  db: Db,
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  task: Task,
  now: Date,
): void {
  if (!resolve) return;
  const resolved = resolveOrQuarantine(db, resolve, task.workspace, now);
  if (resolved) releaseWorkspace(db, resolved, task, now);
}

/** 最終 verb が着地した = 後始末に入った(ADR 0109 決定5)。in-memory の callback は
 *  盤面の crash を越えないので、未了は行に持つ。 */
export function markTeardown(db: Db, taskId: string, now: Date): void {
  db.prepare("UPDATE tasks SET teardown_started_at = ? WHERE id = ?").run(
    now.toISOString(),
    taskId,
  );
}

export function clearTeardown(db: Db, taskId: string): void {
  db.prepare("UPDATE tasks SET teardown_started_at = NULL WHERE id = ?").run(taskId);
}

/** 後始末が未了の session(あれば)。concurrency = 1 なので高々1つである。
 *  起動時の復旧・後始末の時限・「今なぜ pickup が起きないか」の読み口が共有する。 */
export function sessionInTeardown(db: Db): { taskId: string; startedAt: string } | undefined {
  const row = db
    .prepare(
      "SELECT id, teardown_started_at FROM tasks WHERE teardown_started_at IS NOT NULL " +
        "ORDER BY teardown_started_at LIMIT 1",
    )
    .get() as { id: string; teardown_started_at: string } | undefined;
  return row && { taskId: row.id, startedAt: row.teardown_started_at };
}
