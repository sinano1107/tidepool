import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { latestEventOfTask, listEvents, NEVER_RAN_KINDS, sessionWindow } from "./events.js";
import { quarantineFailedTeardown } from "./failed-teardown.js";
import type { GitHubAuth } from "./github-auth.js";
import { openQuarantineValues } from "./quarantine.js";
import type { Slot } from "./slot.js";
import { getTask, returnToQueue, type Task } from "./tasks.js";
import { isBoardDbRefusal } from "./unhandled-rejection-floor.js";
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

/** 後始末(GLOSSARY.md「後始末」/ ADR 0109)に要るもの。上限到達による中断の
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
   *  merge-back まで進む。解決できない名前は quarantine しない(`done` へ決着させる verb はどれも verb の前に workspace を解決する門を通り、門が既に撃った。ADR 0274 決定3)。 */
  completion?: boolean;
  /** process を1つも持たなかった session(ADR 0274 決定3): task ブランチに乗っていない checkout と解決できない名前には
   *  tree rule を当てない。 */
  neverRan?: boolean;
  /** 門が既に解決した workspace。「解決済み・該当なし」を `null` で、「まだ解決していない」を
   *  `undefined` で言い分ける。解決できない名前を quarantine しない側は `completion` と
   *  `neverRan` の2つで、どちらも記録(`settlementOf`)から導くので復旧はこの欄に依存しない。 */
  workspace?: WorkspaceConfig | null;
}

type Settlement = "completed" | "released" | "interrupted" | "never_ran";

/** 後始末中の status と、最後の pickup の後に盤面が刻んだ決着の event が経路を一意に定める(ADR 0113 決定3 /
 *  ADR 0274 決定3)。`in_progress` / `done` 以外(`todo` / `cancelled`)は status では分けられない —— process を1つも
 *  持たなかった session の `todo` はエスカレーション・分解・人間の停止(failure question)と同じ値で、停止承認付き cancel と
 *  後始末の途中の直接 cancel は `cancelled` になる —— ので、process を持たない pickup の event(資源の停止・記録の器・
 *  spawn の失敗、ADR 0118 決定1)の有無で `never_ran` / `released` を分ける。最後の pickup に spawn があれば session の窓の
 *  never-ran(`sessionWindow`、exit が勝つ —— ADR 0316 決定4)を読み、無ければ pickup の後の決着 kind を見る(`pickup_stopped` は
 *  spawn より前にしか書かれない)。spawn の無い人間の停止もここで never-ran になる —— spawn は窓の停止に譲る(#1973)ので、
 *  停止の event が spawn より前にあることが process の無い証拠である。`NEVER_RAN_KINDS` には足さない(`sessionWindow` が spawn の
 *  後の停止まで never-ran に読む)。復旧・確認回答・回収済み観測と、読み口の経路フィールドがこの1点を通る —— 経路を表す
 *  永続事実は持たないので、対応表がここ以外に増えたらそれは写しである。 */
function settlementOf(db: Db, task: Pick<Task, "id" | "status"> | undefined): Settlement {
  if (task?.status === "in_progress") return "interrupted";
  if (task?.status === "done") return "completed";
  if (task?.status !== "todo" && task?.status !== "cancelled") return "released";
  const pickup = latestEventOfTask(db, task.id, "task_picked_up");
  if (!pickup) return "released";
  const events = listEvents(db, task.id).filter((e) => e.id > pickup.id);
  const spawned = events.find((e) => e.kind === "worker_spawned");
  const neverRan = spawned
    ? sessionWindow(events, spawned).neverRan
    : events.some((e) => e.kind === "pickup_stopped" || e.kind === "session_stopped_by_human" || NEVER_RAN_KINDS.includes(e.kind));
  return neverRan ? "never_ran" : "released";
}

export function teardownStep(db: Db, taskId: string): TeardownStep {
  const settlement = settlementOf(db, getTask(db, taskId));
  if (settlement === "interrupted") {
    return {
      ready: (current) => current.status === "in_progress",
      transition: (current, now) => returnToQueue(db, current, { kind: "cap_interrupted" }, now),
    };
  }
  if (settlement === "never_ran") return { neverRan: true };
  return { completion: settlement === "completed" };
}

/** 後始末の一撃(ADR 0109 決定1): tree rule → 状態遷移 → slot 解放。
 *
 *  **門は `slot.currentTaskId` の再観測である。** 回収済み観測は非同期に届く
 *  ので、その間に次の session が枠に入っていることがありうる —— 他人の slot を
 *  解放しないために、ここで観測しなおす(上限到達による中断の経路が ADR 0104 の
 *  実装時に局所的に取った自衛と同じ形で、それが1つの session につきちょうど1回を
 *  保証する)。梯子の底で保留されている session(`heldForContainment`)も同じ点で
 *  弾く —— そこでの解放の門は確認 question ただ1つである(ADR 0099 決定3)。
 *
 *  呼び口は全部 fire-and-forget の `void` である(回収済み観測の `.then`、adapter の中断ハンドラ、
 *  起動時の復旧)。個々の失敗はすでにそれぞれの位置で quarantine に落ちている(`releaseWorkspace`)ので、
 *  ここへ届くのは想定外だけである。そこで止まった後始末は**盤面全体の停止**である(ADR 0112 決定1):
 *  枠がまだ空いていないのではなく空かないので、後始末の runner(`runTeardownSteps`)が確認 question を
 *  1枚立てて停止の列挙に載せ、解放の門を後始末の再実行そのものにする(`acceptTeardownQuarantine`)。
 *  投げるのは盤面 DB の拒否だけで、底が process を終える(ADR 0342 決定2)。 */
export async function runTeardown(
  deps: TeardownDeps,
  taskId: string,
  step: TeardownStep = {},
): Promise<void> {
  // ADR 0112 決定4 / ADR 0342 決定6: 落ちた後始末の残りを持つ session は、受理の撃ち直しのほかに後始末を走らせない ——
  // 遅れた回収済み観測や MCP の verb が枠を空けると、残りの手も question も宙に浮く。届いた後始末は残りの後ろに継ぐ ——
  // 捨てると受理の後に撃つ者が無く枠が空かない。受理は残りを取り出してから撃つ
  if (deps.slot.deferToFailedTeardownRest(taskId, () => teardown(deps, taskId, step))) return;
  await runTeardownSteps(deps, taskId, () => teardown(deps, taskId, step));
}

/** 後始末の1手: 同期か Promise を返す関数(経路ごとの差分の `TeardownStep` とは別物)。 */
export type TeardownAction = () => unknown;

/** 投げた手から先を外へ運ぶ throw。外の runner / 受理が自分の残りを後ろに継ぎ、1つの残りとして持つ(ADR 0342 決定6)。 */
class TeardownThrew {
  constructor(
    readonly cause: unknown,
    readonly rest: TeardownAction[],
  ) {}
}

/** 同期に撃っている手の深さ。0 でなければ runner は入れ子 —— 投げた手は外の runner / 受理へ渡し、自分では question も残りも
 *  持たない(持つと外は成功に見え、受理が黙って通る)。入れ子の runner が返す Promise は、撃った手が返して外へ繋ぐ ——
 *  `void` すると reject が底へ落ちる。 */
let driving = 0;

/** 後始末の step の runner(ADR 0342 決定6 / ADR 0112)。手を順に撃ち、投げた手から先を枠に残して落ちた
 *  後始末の question を同期に立てる —— 行が立ってから返るので、watchdog の tick の門(ADR 0112 決定4)がすぐ効く。
 *  受理(`acceptTeardownQuarantine`)は残した手から撃ち直す。盤面 DB の拒否は question も書けないので底へ投げる
 *  (ADR 0342 決定2・3)。
 *
 *  枠を握ったままの throw だけが落ちた後始末である。`slot.release()` より後 —— pickup の契機 ——
 *  で投げた例外は枠も行も既に空いており、盤面は次へ進める: question は立てない。枠の主が替わった後に投げた
 *  adapter の書く step(`worker_exited` など)は再実行すべきものが残るが、次の session の枠を止めないので log に残し、
 *  次の起動の復旧(ADR 0315)に任せる。 */
export function runTeardownSteps(
  deps: Pick<TeardownDeps, "db" | "clock" | "slot">,
  taskId: string,
  ...actions: TeardownAction[]
): Promise<void> | undefined {
  if (driving > 0) return drive(actions);
  const fail = (err: unknown) => {
    const { cause, rest } = err as TeardownThrew;
    if (isBoardDbRefusal(cause)) throw cause;
    console.error(`[teardown] task ${taskId}:`, cause);
    if (deps.slot.currentTaskId !== taskId) return;
    quarantineFailedTeardown(deps.db, taskId, cause, deps.clock.now());
    deps.slot.appendFailedTeardownRest(taskId, rest);
  };
  try {
    return drive(actions)?.catch(fail);
  } catch (err) {
    fail(err);
    return undefined;
  }
}

/** 手を順に撃つ。投げれば `TeardownThrew` に投げた手から先を載せる —— 入れ子の runner の残りの後ろに、自分の残りを継ぐ。 */
function drive(actions: readonly TeardownAction[], from = 0): Promise<void> | undefined {
  const threw = (err: unknown, at: number) =>
    err instanceof TeardownThrew
      ? new TeardownThrew(err.cause, [...err.rest, ...actions.slice(at + 1)])
      : new TeardownThrew(err, actions.slice(at));
  for (let at = from; at < actions.length; at++) {
    let result: unknown;
    driving++;
    try {
      result = actions[at]!();
    } catch (err) {
      throw threw(err, at);
    } finally {
      driving--;
    }
    if (result instanceof Promise) {
      return result.then(
        () => drive(actions, at + 1),
        (err) => {
          throw threw(err, at);
        },
      );
    }
  }
  return undefined;
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
  // ADR 0342 決定6: process が生きていれば投げた手から、再起動を跨げば後始末そのものを撃ち直す
  const rest = deps.slot.takeFailedTeardownRest(taskId);
  // 枠を取り直すのは再起動を跨いだ受理だけ —— 残りを持つ受理で枠が空いているのは先の受理の後始末が既に解放した後で、取り直すと解放する者が無い
  if (!rest && deps.slot.currentTaskId === null) {
    deps.slot.occupy(taskId);
    deps.slot.enterTeardown();
  }
  try {
    await drive(rest ?? [() => teardown(deps, taskId, teardownStep(deps.db, taskId))]);
  } catch (err) {
    const { cause, rest } = err as TeardownThrew;
    // ADR 0342 決定4: 盤面 DB の拒否は回答の拒否に飲まない
    if (isBoardDbRefusal(cause)) throw cause;
    deps.slot.appendFailedTeardownRest(taskId, rest);
    throw new DomainError(
      `the teardown for task ${taskId} threw again: ` +
        (cause instanceof Error ? cause.message : String(cause)),
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
  // 同じ await の間に別の手が落ちた後始末を立てたなら解放しない —— 解放すると残りの手が消え、受理が2度目の後始末を撃つ(ADR 0342 決定6)
  if (slot.deferToFailedTeardownRest(taskId, () => teardown(deps, taskId, step))) return;
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

/** 後始末が tree rule を当てる走る場所(無ければ当てない)。解決できない名前(drift)を quarantine しないのは2種類だけである
 *  (ADR 0274 決定3)—— 他の決着(エスカレーション・分解・中断)は後始末が最初の観測者なので `resolveOrQuarantine` を通す。
 *  - 完了(`completion`): `done` へ決着させる verb はどれも verb の前に workspace を解決する門を通る(`runReleasingVerb` が強制)ので、門が後始末より前に同じ名前を解決しており、解決できなければ門がそこで撃っている。再起動の
 *    復旧でも撃ち直さず当てない。解決できれば今日どおり走る場所へ当てる。
 *  - process を1つも持たなかった session(`neverRan`): worker が触った checkout を持たない —— drift は止めた Quarantine を
 *    撃ち直さず、task ブランチに乗っていない checkout は動いていないので、どちらも当てない。task ブランチに乗った
 *    checkout(準備の checkout の後で止まった)だけ今日どおり退避する。 */
function runPlaceToRelease(
  { db, clock }: TeardownDeps,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  task: Task,
  step: TeardownStep,
): WorkspaceConfig | undefined {
  if (!step.completion && !step.neverRan) {
    const resolved = resolveOrQuarantine(db, resolve, task.workspace, clock.now());
    return resolved && taskRunPlace(db, task, resolved);
  }
  let place: WorkspaceConfig;
  try {
    place = taskRunPlace(db, task, resolve(task.workspace));
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) return undefined;
    // 開いた event は repo 完成後に書く(ADR 0329)。event 前に途中まで作られた場所にも process・準備・task ブランチは無く、
    // 触る checkout が無い。記録はあって repo が消えた場所は下の `onTaskBranch` が外す
    if (step.neverRan && err instanceof PlaceNotOpenError) return undefined;
    throw err;
  }
  return !step.neverRan || onTaskBranch(place, task.id) ? place : undefined;
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

/** slot を取ってから `worker_spawned` を書くまでの継続の門(#1973 / ADR 0118 決定1 / ADR 0305): その継続が属する pickup が
 *  まだ生きた session か。継続の冒頭で呼んで pickup の記録(status・後始末の印・最後の `task_picked_up` の id)を取り、返った述語を
 *  各 await の後・次の副作用の前に読む —— 後始末の印が置かれた・status が動いた・別の pickup が来た(停止 → 解放 → 同じ task の
 *  retry)のどれでも閉じる。pickup は時刻でなく event id で見分ける(時刻を進めない retry で衝突する)。status は `in_progress` と
 *  比べず冒頭の値と比べる —— 盤面の継続の冒頭は必ず `in_progress` で、pickup を経ずに adapter を直接走らせる呼び手を閉じない。 */
export function liveSession(db: Db, taskId: string): () => boolean {
  const record = () => {
    const row = db.prepare("SELECT status, teardown_started_at FROM tasks WHERE id = ?").get(taskId) as
      | { status: Task["status"]; teardown_started_at: string | null }
      | undefined;
    return { ...row, pickup: latestEventOfTask(db, taskId, "task_picked_up")?.id };
  };
  const started = record();
  return () => {
    const now = record();
    return now.status === started.status && now.teardown_started_at === started.teardown_started_at && now.pickup === started.pickup;
  };
}

/** 後始末が未了の session(あれば)。concurrency = 1 なので高々1つである。
 *  起動時の復旧・後始末の時限・「今なぜ pickup が起きないか」の読み口が共有する。 */
export function sessionInTeardown(
  db: Db,
): { taskId: string; startedAt: string; settlement: Settlement; humanStop?: { reason: string | null } } | undefined {
  const row = db
    .prepare(
      "SELECT id, status, teardown_started_at FROM tasks WHERE teardown_started_at IS NOT NULL " +
        "ORDER BY teardown_started_at LIMIT 1",
    )
    .get() as { id: string; status: Task["status"]; teardown_started_at: string } | undefined;
  const stopped = row && latestEventOfTask(db, row.id, "session_stopped_by_human");
  const pickup = row && latestEventOfTask(db, row.id, "task_picked_up");
  return (
    row && {
      taskId: row.id,
      startedAt: row.teardown_started_at,
      // 読み手が行の status から経路を導き直さないように、ここで写像を1度だけ当てる
      settlement: settlementOf(db, row),
      ...(stopped && pickup && stopped.id > pickup.id ? { humanStop: { reason: stopped.payload.reason ?? null } } : {}),
    }
  );
}
