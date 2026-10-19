import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import type { EventKind } from "./events.js";
import { quarantineFailedTeardown } from "./failed-teardown.js";
import type { GitHubAuth } from "./github-auth.js";
import { openQuarantineValues } from "./quarantine.js";
import type { Slot } from "./slot.js";
import { getTask, returnToQueueHead, type Task } from "./tasks.js";
import {
  ensureWorkspaceToken,
  onTaskBranch,
  PlaceNotOpenError,
  releaseWorkspace,
  resolveOrQuarantine,
  taskRunPlace,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "./workspace.js";

/** 後始末(CONTEXT.md「後始末」/ ADR 0109)に要るもの。上限到達による中断の
 *  ハンドラが既に持っていた引数と**同じ**であり、後始末へ入るすべての経路がこの1つの型を
 *  共有する(ADR 0109 決定1)。 */
export interface TeardownDeps {
  db: Db;
  clock: Clock;
  slot: Slot;
  /** watchdog / MCP と同じ resolver(`buildWorkspaceResolver` 製)。無ければ
   *  workspace 追跡の無い盤面なので tree rule は走らない。 */
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined;
  githubAuth?: GitHubAuth;
  /** **この session が梯子の底で保留されているか**(ADR 0099 決定3)。回収 timeout で
   *  Containment quarantine に落ちた session は、確認 question ただ1つを解放の門とする ——
   *  遅れて届いた回収済み観測が、その門を跨いで workspace と slot を解放してはならない。
   *  盤面全体の quarantine ではなくこの述語を読むのは、無関係な理由(harness containment /
   *  前提検査)で開いた quarantine が完了の後始末を黙って no-op にすると、誰も再起動しない
   *  まま枠が刺さるからである。Absent → watchdog を持たない盤面(梯子そのものが無い)。 */
  heldForContainment?: (taskId: string) => boolean;
  /** pickup の契機(ADR 0119 決定3)。解放の後に1回撃つ —— 着地はこの契機が突く収束が撃つ(ADR 0241 決定5)。
   *  **必須**にしてあるのは、構築箇所の配線漏れを型に捕まえさせるためである(#536 の
   *  欠落は optional な配線の漏れそのものだった)。 */
  pollNow: () => void;
}

/** 経路ごとに違うのはここに挙げたものだけである。 */
export interface TeardownStep {
  /** ツリー規律の**後**の状態遷移 —— 上限到達による中断の todo 復帰がこれ。完了経路は
   *  タスクが既に決着しているので持たない。 */
  transition?: (task: Task, now: Date) => void;
  /** slot の再観測に加わる、経路ごとの状態の門(cap / watchdog は `in_progress` の
   *  ときだけ)。 */
  ready?: (task: Task) => boolean;
  /** 完了経路(ADR 0109 決定1・3): 退避ではなく検査を走らせ、work タスクなら
   *  merge-back まで進む。 */
  completion?: boolean;
  /** process を1つも持たなかった session(ADR 0274 決定3): task ブランチに乗っていない checkout と解決できない名前には
   *  tree rule を当てない。 */
  neverRan?: boolean;
  /** 門が既に解決した workspace。`resolveOrQuarantine` は解決できない名前を
   *  **quarantine する副作用を持って `undefined` を返す**ので、「解決済み・該当なし」を
   *  `null` で、「まだ解決していない」を `undefined` で言い分ける —— 区別しないと、
   *  門が既に撃った quarantine を後始末が同じ観測でもう一度撃つ(1つの verb 呼び出しで
   *  2度撃たない)。 */
  workspace?: WorkspaceConfig | null;
}

type Settlement = "completed" | "released" | "interrupted" | "never_ran";

/** 盤面が process を持たないまま決着させた pickup の event(ADR 0274 決定3 / ADR 0266 / ADR 0118 決定5)。 */
const NO_PROCESS_STOP_KINDS = ["pickup_stopped", "record_container_unwritable", "spawn_failed"] as const satisfies readonly EventKind[];

/** 後始末中の status と、最後の pickup の後に盤面が刻んだ決着の event が経路を一意に定める(ADR 0113 決定3 /
 *  ADR 0274 決定3)。`in_progress` / `done` 以外(`todo` / `cancelled`)は status では分けられない —— process を1つも
 *  持たなかった session の `todo` はエスカレーション・分解と同じ値で、後始末の途中で人間が直接 cancel すれば
 *  `cancelled` になる —— ので、process を持たない pickup の event(資源の停止・記録の器・spawn の失敗、ADR 0118
 *  決定1)の有無で `never_ran` / `released` を分ける。復旧・確認回答・回収済み観測と、読み口の経路フィールドが
 *  この1点を通る —— 経路を表す永続事実は持たないので、対応表がここ以外に増えたらそれは写しである。 */
function settlementOf(db: Db, task: Pick<Task, "id" | "status"> | undefined): Settlement {
  if (task?.status === "in_progress") return "interrupted";
  if (task?.status === "done") return "completed";
  const neverRan =
    (task?.status === "todo" || task?.status === "cancelled") &&
    db
      .prepare(
        `SELECT 1 FROM events WHERE task_id = ? AND kind IN (${NO_PROCESS_STOP_KINDS.map(() => "?").join(", ")})
           AND id > (SELECT MAX(id) FROM events WHERE task_id = ? AND kind = 'task_picked_up')`,
      )
      .get(task.id, ...NO_PROCESS_STOP_KINDS, task.id) !== undefined;
  return neverRan ? "never_ran" : "released";
}

export function teardownStep(db: Db, taskId: string): TeardownStep {
  const settlement = settlementOf(db, getTask(db, taskId));
  if (settlement === "interrupted") {
    return {
      ready: (current) => current.status === "in_progress",
      transition: (current, now) => returnToQueueHead(db, current, { kind: "cap_interrupted" }, now),
    };
  }
  if (settlement === "never_ran") return { neverRan: true };
  return { completion: settlement === "completed" };
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
 *  枠を握ったままの throw だけがその停止である。`slot.release()` より後 —— pickup の契機 ——
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

/** 行に残った後始末の未了を、枠を握ってから走らせる —— 起動時の復旧と、再起動を越えた梯子の底の
 *  確認回答の受理(ADR 0254 決定2)が通る1つの門。未了が無い / 枠がもう握られている / 落ちた後始末の
 *  question が開いている(撃てば同じ所で落ちて無言に戻る。ADR 0112 決定4)なら撃たない。
 *  枠を握っているのは task ではなく session である(ADR 0109 決定2)—— 走り切るまで pickup は進まない。 */
export function resumeUnfinishedTeardown(deps: TeardownDeps): Promise<void> | undefined {
  const session = sessionInTeardown(deps.db);
  if (!session || deps.slot.currentTaskId !== null) return;
  if (openQuarantineValues(deps.db, "failedTeardown").length > 0) return;
  deps.slot.occupy(session.taskId);
  deps.slot.enterTeardown();
  return runTeardown(deps, session.taskId, teardownStep(deps.db, session.taskId));
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
 *  無いので export しない(ADR 0107 決定5)。 */
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
  // 後始末は走る場所に効く —— interview の root は面接室、受験者は自分の checkout(ADR 0273 決定1・8 / ADR 0276 決定1)。門が渡した workspace は解決済みの走る場所
  let workspace = step.workspace;
  if (workspace === undefined) workspace = deps.resolve && runPlaceToRelease(deps, deps.resolve, task, step);
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
  // 早期 return はすべてこの手前にある —— ここを越えた後始末だけが pickup の契機を撃つ。着地を直接は呼ばない ——
  // この契機が収束を突き、印を消した後に盤面が落ちても、起動の収束が同じ根を導く(ADR 0241 決定5 / ADR 0240)
  deps.pollNow();
}

/** 後始末が tree rule を当てる走る場所(無ければ当てない)。process を1つも持たなかった session(ADR 0274 決定3)は worker が
 *  触った checkout を持たない —— 解決できない名前(drift)は止めた Quarantine を撃ち直さず、task ブランチに乗っていない checkout
 *  は動いていないので、どちらも当てない。task ブランチに乗った checkout(準備の checkout の後で止まった)だけ今日どおり退避する。 */
function runPlaceToRelease(
  { db, clock }: TeardownDeps,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  task: Task,
  step: TeardownStep,
): WorkspaceConfig | undefined {
  if (!step.neverRan) {
    const resolved = resolveOrQuarantine(db, resolve, task.workspace, clock.now());
    return resolved && taskRunPlace(db, task, resolved);
  }
  let place: WorkspaceConfig;
  try {
    place = taskRunPlace(db, task, resolve(task.workspace));
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) return undefined;
    // 開いた event は在り処の mkdir の直後、git の手順より前に書く —— event が無ければ盤面はこの task の場所を作れておらず、
    // 触る checkout が無い。記録はあって repo がまだ無い場所は下の `onTaskBranch` が外す
    if (err instanceof PlaceNotOpenError) return undefined;
    throw err;
  }
  return onTaskBranch(place, task.id) ? place : undefined;
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
export function sessionInTeardown(
  db: Db,
): { taskId: string; startedAt: string; settlement: Settlement } | undefined {
  const row = db
    .prepare(
      "SELECT id, status, teardown_started_at FROM tasks WHERE teardown_started_at IS NOT NULL " +
        "ORDER BY teardown_started_at LIMIT 1",
    )
    .get() as { id: string; status: Task["status"]; teardown_started_at: string } | undefined;
  return (
    row && {
      taskId: row.id,
      startedAt: row.teardown_started_at,
      // 読み手が行の status から経路を導き直さないように、ここで写像を1度だけ当てる
      settlement: settlementOf(db, row),
    }
  );
}
