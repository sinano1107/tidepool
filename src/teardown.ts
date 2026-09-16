import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { quarantineFailedTeardown } from "./failed-teardown.js";
import type { GitHubAuth } from "./github-auth.js";
import type { Landing } from "./landing.js";
import type { Slot } from "./slot.js";
import { DomainError, getTask, returnForCapInterruption, type Task } from "./tasks.js";
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
  /** **この session が梯子の底で保留されているか**(ADR 0099 決定3)。回収 timeout で
   *  Containment quarantine に落ちた session は、確認 question ただ1つを解放の門とする ——
   *  遅れて届いた回収済み観測が、その門を跨いで workspace と slot を解放してはならない。
   *  盤面全体の quarantine ではなくこの述語を読むのは、無関係な理由(harness containment /
   *  前提検査)で開いた quarantine が完了の後始末を黙って no-op にすると、誰も再起動しない
   *  まま枠が刺さるからである。Absent → watchdog を持たない盤面(梯子そのものが無い)。 */
  heldForContainment?: (taskId: string) => boolean;
  /** pickup の契機(ADR 0119 決定3)。解放の後、landing まで終えてから1回撃つ ——
   *  解放の瞬間に撃てば次の pickup の fetch / checkout が前タスクの push と並走する。
   *  **必須**にしてあるのは、構築箇所の配線漏れを型に捕まえさせるためである(#536 の
   *  欠落は optional な配線の漏れそのものだった)。 */
  pollNow: () => void;
}

/** 経路ごとに違うのはここに挙げたものだけである。 */
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
  /** 門が既に解決した workspace。`resolveOrQuarantine` は解決できない名前を
   *  **quarantine する副作用を持って `undefined` を返す**ので、「解決済み・該当なし」を
   *  `null` で、「まだ解決していない」を `undefined` で言い分ける —— 区別しないと、
   *  門が既に撃った quarantine を後始末が同じ観測でもう一度撃つ(1つの verb 呼び出しで
   *  2度撃たない)。 */
  workspace?: WorkspaceConfig | null;
}

/** 後始末中の status が経路を一意に定める(ADR 0113 決定3)。復旧・確認回答・
 *  回収済み観測は同じ規則を通す。経路を表す別の永続事実は持たない。 */
export function teardownStep(db: Db, taskId: string): TeardownStep {
  const task = getTask(db, taskId);
  if (task?.status === "in_progress") {
    return {
      ready: (current) => current.status === "in_progress",
      transition: (current, now) => returnForCapInterruption(db, current, now),
    };
  }
  return { completion: task?.status === "done" };
}

/** 後始末の一撃(ADR 0109 決定1): tree rule → 状態遷移 → slot 解放。
 *
 *  **門は `slot.currentTaskId` の再観測である。** 回収済み観測は非同期に届く
 *  ので、その間に次の session が枠に入っていることがありうる —— 他人の slot を
 *  解放しないために、ここで観測しなおす(`capInterruptionHandler` が ADR 0104 の
 *  実装時に局所的に取った自衛と同じ形で、それが1つの session につきちょうど1回を
 *  保証する)。梯子の底で保留されている session(`heldForContainment`)も同じ点で
 *  弾く —— そこでの解放の門は確認 question ただ1つである(ADR 0099 決定3)。
 *
 *  **投げない。** 呼び口は全部 fire-and-forget の `void` である(回収済み観測の
 *  `.then`、adapter の中断ハンドラ、起動時の復旧)—— 解放が同期だった頃は例外が
 *  MCP 呼び出しの返り値になったが、今ここで投げれば unhandled rejection として盤面
 *  ごと落ち、しかも未了は行に残るので次の起動でも同じ所で落ちる。個々の失敗は
 *  すでにそれぞれの位置で quarantine に落ちている(`releaseWorkspace`)ので、ここへ
 *  届くのは想定外だけである。そこで止まった後始末は**盤面全体の停止**である
 *  (ADR 0112 決定1): 枠がまだ空いていないのではなく空かないので、確認 question を
 *  1枚立てて停止の列挙に載せ、解放の門を後始末の再実行そのものにする
 *  (`acceptTeardownQuarantine`)。
 *
 *  枠を握ったままの throw だけがその停止である。`slot.release()` より後 —— 着地 ——
 *  で投げた例外は枠も行も既に空いており、盤面は次へ進める: 再実行すべき後始末が
 *  無いので question は立てない。 */
export async function runTeardown(
  deps: TeardownDeps,
  taskId: string,
  step: TeardownStep = {},
): Promise<void> {
  try {
    await teardown(deps, taskId, step);
  } catch (err) {
    console.error(`[teardown] task ${taskId}:`, err);
    if (deps.slot.currentTaskId === taskId) {
      quarantineFailedTeardown(deps.db, taskId, err, deps.clock.now());
    }
  }
}

/** 落ちた後始末の受理の門(ADR 0112 決定3)。隣の門(`ContainmentCheck` /
 *  `RegistryReachabilityCheck`)と違い可否を返さない —— 検査が後始末の再実行そのもの
 *  なので、答えは「通った」か「投げた」しかない。 */
export type FailedTeardownCheck = (taskId: string) => Promise<void>;

/** 落ちた後始末の解放の門(ADR 0112 決定3)。他の quarantine 族が受理の直前に資源を
 *  検証するのと同じ位置で走るが、検証すべき資源が無いので検査は後始末の再実行そのもの
 *  に一致する —— 通れば受理へ進み、まだ投げるなら `DomainError` で回答を拒む。
 *
 *  再起動を跨いだ受理では枠が空いている(起動時復旧は落ちた後始末を撃ち直さず、枠も
 *  占めない)。その枠をここで取り直すのは、後始末の門である `slot.currentTaskId` の
 *  再観測を満たすためである —— 満たさなければ早期 return で静かに受理され、tree rule が
 *  走っていない workspace のまま question だけが閉じる(issue #382 の形)。 */
export async function acceptTeardownQuarantine(deps: TeardownDeps, taskId: string): Promise<void> {
  if (deps.slot.currentTaskId === null) {
    deps.slot.occupy(taskId);
    deps.slot.enterTeardown();
  }
  try {
    await teardown(deps, taskId, teardownStep(deps.db, taskId));
  } catch (err) {
    throw new DomainError(
      `the teardown for task ${taskId} threw again: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** 投げる後始末。捕まえる版が `runTeardown` で、受理の検査はこちらを走らせる
 *  (ADR 0112 決定3: フラグ引数で分岐を型に持ち込まない)。ファイル外に呼び手は
 *  無いので export しない(ADR 0107 決定5)—— 外から見えるのは捕まえる版と
 *  `acceptTeardownQuarantine` の2つである。 */
async function teardown(
  deps: TeardownDeps,
  taskId: string,
  step: TeardownStep,
): Promise<void> {
  const { db, clock, slot } = deps;
  // 解放してよいか。枠の主がまだこの session であること(回収済み観測は非同期に届く)と、
  // 梯子の底で保留されていないこと(ADR 0099 決定3)の2つを1点から読む。
  const releasable = () =>
    slot.currentTaskId === taskId && deps.heldForContainment?.(taskId) !== true;
  if (!releasable()) return;
  const task = getTask(db, taskId);
  if (!task) return;
  if (step.ready && !step.ready(task)) return;
  const workspace =
    step.workspace === undefined
      ? deps.resolve && resolveOrQuarantine(db, deps.resolve, task.workspace, clock.now())
      : step.workspace;
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
  // その await を跨ぐ間に枠の主が変わる / 梯子の底へ落ちることがありうるので、門をもう一度読む
  if (!releasable()) return;
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
  // 早期 return はすべてこの手前にある —— ここを越えた後始末だけが pickup の契機を撃つ
  try {
    // 着地は枠を空けた後に撃つ(従来 `complete_task` が解放の後に撃っていたのと同じ位置)
    if (step.completion && deps.landing && task.status === "done") {
      await deps.landing.land(task);
      // 完了したのが付帯子なら、待っていた祖先の着地がここで起きる(ADR 0092 決定3)
      await deps.landing.relandAncestors(task);
    }
  } finally {
    deps.pollNow();
  }
}

/** slot-release tree rule の一撃だけ(CONTEXT.md「Slot-release tree rule」)。
 *  slot を触らない呼び手 —— `failTask` —— が使う。resolve が無い盤面では no-op。 */
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

/** session が決着した = 後始末に入った(ADR 0113)。in-memory の callback は
 *  盤面の crash を越えないので、未了は行に持つ。 */
export function markTeardown(db: Db, taskId: string, now: Date): void {
  db.prepare("UPDATE tasks SET teardown_started_at = ? WHERE id = ?").run(
    now.toISOString(),
    taskId,
  );
}

function clearTeardown(db: Db, taskId: string): void {
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
