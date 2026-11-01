import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { latestEventOfTask, listEvents, NEVER_RAN_KINDS, sessionWindow } from "./events.js";

import { quarantineFailedTeardown, quarantineUnclosedSession, thrownTextOfHaltReason } from "./failed-teardown.js";
import type { GitHubAuth } from "./github-auth.js";
import { openQuarantineQuestion } from "./quarantine.js";

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
  // ADR 0112 決定4 / ADR 0342 決定6 / ADR 0344 決定4: 落ちた後始末・閉じ切らなかった session の残りを持つ session は、受理の撃ち直しのほかに後始末を走らせない ——
  // 遅れた回収済み観測や MCP の verb が枠を空けると、残りの手も question も宙に浮く。届いた後始末は残りの後ろに継ぐ ——
  // 捨てると受理の後に撃つ者が無く枠が空かない。受理は残りを取り出してから撃つ
  if (deferToSessionRest(deps, taskId, () => teardown(deps, taskId, step))) return;
  await runTeardownSteps(deps, taskId, () => teardown(deps, taskId, step));
}

/** 後始末の1手: 同期か Promise を返す関数(経路ごとの差分の `TeardownStep` とは別物)。`closesSpawn` は束の手の印で、値は spawn event id。 */
export type TeardownAction = (() => unknown) & { closesSpawn?: number };

/** session を閉じる手に印を付ける。runner は投げた手の印で停止の kind を選ぶ —— 枠の主かでは分けない(ADR 0344 決定1)。 */
export function sessionCloseSteps(spawnId: number, actions: TeardownAction[]): TeardownAction[] {
  return actions.map((action) => Object.assign(() => action(), { closesSpawn: spawnId }));
}

/** 閉じ切らなかった session の残り(ADR 0344 決定2): spawn event id → 投げた手から先。枠の解放で消えないので `Slot` の欄にしない。
 *  鍵に `Slot` を使うのは盤面の process に1つで寿命が同じだから —— memory なので再起動を越えず、越えた受理は記録から閉じ直す。 */
const unclosedRests = new WeakMap<Slot, Map<number, TeardownAction[]>>();

function unclosedRestsOf(slot: Slot): Map<number, TeardownAction[]> {
  let rests = unclosedRests.get(slot);
  if (!rests) unclosedRests.set(slot, (rests = new Map()));
  return rests;
}

function appendUnclosedRest(slot: Slot, spawnId: number, actions: TeardownAction[]): void {
  const rests = unclosedRestsOf(slot);
  rests.set(spawnId, [...(rests.get(spawnId) ?? []), ...actions]);
}

function takeUnclosedRest(slot: Slot, spawnId: number): TeardownAction[] | undefined {
  const rests = unclosedRestsOf(slot);
  const actions = rests.get(spawnId);
  rests.delete(spawnId);
  return actions;
}

/** その spawn が task の今の pickup のものか。後の pickup が来ていれば、その spawn の session はもう枠の主ではない。 */
export function spawnedAfterLatestPickup(db: Db, taskId: string, spawnId: number): boolean {
  return spawnId > (latestEventOfTask(db, taskId, "task_picked_up")?.id ?? 0);
}

/** task の今の pickup の session の spawn event id(ADR 0344 決定1: 停止の鍵)。前の pickup の spawn は死んだ session で、今の pickup に
 *  spawn が無ければ process を持たなかった session —— 鍵は task id だけになる。 */
function spawnOfCurrentPickup(db: Db, taskId: string): number | undefined {
  const spawned = latestEventOfTask(db, taskId, "worker_spawned");
  return spawned && spawnedAfterLatestPickup(db, taskId, spawned.id) ? spawned.id : undefined;
}

/** ADR 0112 決定4 の門(ADR 0344 決定4): 枠の主の session の行が開いているか —— `failedTeardown` は task id、`unclosedSession` は
 *  spawn event id で引く。死んだ session の行は読まない —— 走っている session の梯子を止めない。`answeredSpawn` は回答中の spawn で、行はまだ開いている。 */
export function sessionHaltOpen(db: Db, taskId: string, answeredSpawn?: number): boolean {
  if (openQuarantineQuestion(db, "failedTeardown", taskId)) return true;
  const spawnId = spawnOfCurrentPickup(db, taskId);
  return spawnId !== undefined && spawnId !== answeredSpawn && openQuarantineQuestion(db, "unclosedSession", String(spawnId)) !== undefined;
}

/** 枠の主の session の残りがあれば `action` をその後ろに継いで true —— 呼び手は自分では撃たず、受理に任せる(ADR 0112 決定4 / ADR 0344 決定4)。
 *  死んだ session の残りには継がない —— 走っている session の観測が、その session と関係ない回答まで止まる。 */
export function deferToSessionRest({ db, slot }: Pick<TeardownDeps, "db" | "slot">, taskId: string, action: TeardownAction): boolean {
  if (slot.deferToFailedTeardownRest(taskId, action)) return true;
  const spawnId = spawnOfCurrentPickup(db, taskId);
  if (spawnId === undefined || !unclosedRestsOf(slot).has(spawnId)) return false;
  appendUnclosedRest(slot, spawnId, [action]);
  return true;
}

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

/** 後始末の step の runner(ADR 0342 決定6 / ADR 0112 / ADR 0344)。手を順に撃ち、投げた手から先を残して question を同期に立てる ——
 *  行が立ってから返るので、watchdog の tick の門(ADR 0112 決定4)がすぐ効く。受理は残した手から撃ち直す。
 *  盤面 DB の拒否は question も書けないので底へ投げる(ADR 0342 決定2・3)。
 *
 *  投げた手が session の束の手なら閉じ切らなかった session で、枠の主かに依らず spawn ごとに持つ(ADR 0344 決定1・2)。残りの先頭は
 *  入れ子を越えても投げた手そのものである。それ以外の手は枠を握ったままの throw だけが落ちた後始末である: `slot.release()` より後 ——
 *  pickup の契機 —— で投げた例外は枠も行も既に空いており、盤面は次へ進める。 */
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
    const spawnId = rest[0]?.closesSpawn;
    if (spawnId !== undefined) {
      quarantineUnclosedSession(deps.db, spawnId, taskId, cause, deps.clock.now());
      appendUnclosedRest(deps.slot, spawnId, rest);
      return;
    }
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
 *  確認回答の受理(ADR 0254 決定2)、閉じ切らなかった session の受理(`answeredSpawn`)が通る1つの門。未了が無い / 枠がもう握られている /
 *  後始末中の session の行が開いている(撃てば同じ所で落ちて無言に戻る。ADR 0112 決定4 / ADR 0344 決定4)なら撃たない。
 *  枠を握っているのは task ではなく session である(ADR 0109 決定2)—— 走り切るまで pickup は進まない。 */
export function resumeUnfinishedTeardown(deps: TeardownDeps, answeredSpawn?: number): Promise<void> | undefined {
  const session = sessionInTeardown(deps.db);
  if (!session || deps.slot.currentTaskId !== null) return;
  if (sessionHaltOpen(deps.db, session.taskId, answeredSpawn)) return;
  deps.slot.occupy(session.taskId);
  deps.slot.enterTeardown();
  return runTeardown(deps, session.taskId, teardownStep(deps.db, session.taskId));
}

/** 落ちた後始末の受理の門(ADR 0112 決定3)。隣の門(`ContainmentCheck` /
 *  `RegistryReachabilityCheck`)と違い可否を返さない —— 検査が後始末の再実行そのもの
 *  なので、答えは「通った」か「投げた」しかない。通れば確認を返し、回答の書き込みと同じ
 *  同期区間で呼ばれる(ADR 0343 決定1)。 */
export type FailedTeardownCheck = (taskId: string) => Promise<() => void>;

/** 閉じ切らなかった session の受理の門(ADR 0344 決定3)。形は `FailedTeardownCheck` と同じで、鍵が spawn event id。 */
export type UnclosedSessionCheck = (spawnId: number) => Promise<() => void>;

/** 受理が kind ごとに違うもの。 */
interface Rerun {
  row: { kind: "failedTeardown" | "unclosedSession"; value: string };
  take: () => TeardownAction[] | undefined;
  giveBack: (rest: TeardownAction[]) => void;
  /** 残りが無いとき —— 再起動を跨いだ受理 —— に撃つ手。 */
  fallback: () => TeardownAction[];
  overlapRefusal: string;
  threwAgain: (thrown: string) => string;
}

/** 受理の共有の本体(ADR 0112 決定3 / ADR 0343 決定1・2 / ADR 0344 決定3): 残りが無くなるまで撃って通れば確認を返し、まだ投げるなら
 *  `DomainError` で回答を拒む。検査が返ってから回答を書くまでにも step は投げられるので、受理が証明するのは投げた step の再実行が
 *  回答を書く瞬間まで投げなかったことで、確認がそこで残りを読み直して拒む。重なりを拒む印も確認まで持つ。印は kind を跨いで1つ ——
 *  落ちた後始末の受理は後始末を同じ session の残りへ継ぐので、2つの受理が1つの残りを撃たない。 */
async function acceptRerun(deps: TeardownDeps, rerun: Rerun): Promise<() => void> {
  // 重なった回答は拒む: 残りは先の受理が取り出した後なので、2つ目は空の残りを見て question を閉じる。印は同期に取り、question は開いたまま
  const releaseAcceptance = deps.slot.takeTeardownAcceptanceMark();
  if (!releaseAcceptance) throw new DomainError(rerun.overlapRefusal);
  try {
    // ADR 0112 決定3 / ADR 0342 の Status 追記: 撃っている間に継がれた手も撃つ —— 残したまま通すと、枠を握ったまま question だけが閉じる
    for (let actions: TeardownAction[] | undefined = rerun.take() ?? rerun.fallback(); actions; actions = rerun.take()) await drive(actions);
  } catch (err) {
    releaseAcceptance();
    const { cause, rest } = err as TeardownThrew;
    // ADR 0342 決定4: 盤面 DB の拒否は回答の拒否に飲まない
    if (isBoardDbRefusal(cause)) throw cause;
    rerun.giveBack(rest);
    throw new DomainError(rerun.threwAgain(cause instanceof Error ? cause.message : String(cause)));
  }
  // ADR 0343 決定1: 通っても拒んでも印を放す —— 残すと、立った残りを撃ち直す次の回答まで拒む
  return () => {
    releaseAcceptance();
    const rest = rerun.take();
    if (!rest) return;
    rerun.giveBack(rest);
    // 残りは `fail` が開いている question に積んでから立てるので、この question の最後の撃ち直しが投げた step である
    const question = openQuarantineQuestion(deps.db, rerun.row.kind, rerun.row.value)!;
    const { reason } = latestEventOfTask(deps.db, question.id, "quarantine_refired")!.payload;
    throw new DomainError(rerun.threwAgain(thrownTextOfHaltReason(reason)));
  };
}

/** 落ちた後始末の解放の門(ADR 0112 決定3)。他の quarantine 族が受理の直前に資源を
 *  検証するのと同じ位置で走るが、検証すべき資源が無いので検査は後始末の再実行そのもの
 *  に一致する。
 *
 *  再起動を跨いだ受理では枠が空いている(起動時復旧は落ちた後始末を撃ち直さず、枠も
 *  占めない)。その枠をここで取り直すのは、後始末の門である `slot.currentTaskId` の
 *  再観測を満たすためである —— 満たさなければ早期 return で静かに受理され、tree rule が
 *  走っていない workspace のまま question だけが閉じる(issue #382 の形)。 */
export function acceptTeardownQuarantine(deps: TeardownDeps, taskId: string): Promise<() => void> {
  return acceptRerun(deps, {
    row: { kind: "failedTeardown", value: taskId },
    // ADR 0342 決定6: process が生きていれば投げた手から撃ち直す
    take: () => deps.slot.takeFailedTeardownRest(taskId),
    giveBack: (rest) => deps.slot.appendFailedTeardownRest(taskId, rest),
    // 再起動を跨げば残りは無く、後始末そのものを撃ち直す。枠を取り直すのは再起動を跨いだ受理だけ —— 残りを持つ受理で枠が空いているのは
    // 先の受理の後始末が既に解放した後で、取り直すと解放する者が無い
    fallback: () => {
      if (deps.slot.currentTaskId === null) {
        deps.slot.occupy(taskId);
        deps.slot.enterTeardown();
      }
      return [() => teardown(deps, taskId, teardownStep(deps.db, taskId))];
    },
    overlapRefusal: "a failed teardown is already being re-run by another answer — answer again if this question stays open",
    threwAgain: (thrown) => `the teardown for task ${taskId} threw again: ${thrown}`,
  });
}

/** 閉じ切らなかった session の解放の門(ADR 0344 決定3): その session を閉じ直す。process が生きていれば memory の残りを投げた手から
 *  撃ち切る。無ければ記録から閉じ直す —— 既に閉じていれば no-op で通り、行が起動時の再開を止めていた後始末はその後ろで走らせる。 */
export function acceptUnclosedSession(deps: TeardownDeps, spawnId: number, closeFromRecord: () => void): Promise<() => void> {
  return acceptRerun(deps, {
    row: { kind: "unclosedSession", value: String(spawnId) },
    take: () => takeUnclosedRest(deps.slot, spawnId),
    giveBack: (rest) => appendUnclosedRest(deps.slot, spawnId, rest),
    fallback: () => [closeFromRecord, () => resumeUnfinishedTeardown(deps, spawnId)],
    overlapRefusal: "a worker session close or teardown is already being re-run by another answer — answer again if this question stays open",
    // 残りには session に継がれた決定と後始末も並ぶので、投げた手を閉じる手とは言わない
    threwAgain: (thrown) => `the re-run for worker session ${spawnId} threw again: ${thrown}`,
  });
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
  if (deferToSessionRest(deps, taskId, () => teardown(deps, taskId, step))) return;
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
  // ADR 0112 決定3: 印を消す書き込みで投げて状態遷移だけ残ると、撃ち直しの `ready` が外れて解放せずに受理が通る
  db.transaction(() => {
    step.transition?.(task, now);
    clearTeardown(db, taskId);
  })();
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
