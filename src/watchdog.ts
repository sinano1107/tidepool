import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "./actor-id.js";
import { quarantineRefusedRow, ROW_REFUSAL_EVIDENCE } from "./cli-auth.js";
import type { Clock } from "./clock.js";
import { quarantineContainment } from "./containment.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventOrigin, getEvent, latestEventOfTask, type RowRefusal } from "./events.js";
import type { GitHubAuth } from "./github-auth.js";
import type { ProcessContainers } from "./process-container.js";
import { openQuarantineValues, questionRefusedTarget, registerQuarantine } from "./quarantine.js";
import type { Slot } from "./slot.js";
import { abandonConsequence, escalateTask, getTask, type QueueReturnPayload, registerTask, returnToQueue, type Task, type TaskType, unrowedTarget } from "./tasks.js";
import {
  markTeardown,
  resumeUnfinishedTeardown,
  runTeardown,
  runTeardownSteps,
  sessionInTeardown,
  type TeardownDeps,
  teardownStep,
} from "./teardown.js";
import type { RecordContainerError, TranscriptFailure } from "./transcript-store.js";
import type { WorkerAdapter, WorkerExit, WorkerExitClassification } from "./worker.js";
import { buildWorkspaceResolver, type WorkspaceConfig } from "./workspace.js";

export const WATCHDOG_TICK = 60 * 1000;

/** 強制回収を送ってから回収済み観測を諦めるまで(ADR 0099 決定3)。tick 1本より
 *  十分長く取る — 猶予と同じく「待つ時間」であって、機構の性質ではない。後始末の
 *  backstop(ADR 0109 決定5)も同じ尺度なので、待つ時間はこの1つである。 */
export const RECLAIM_TIMEOUT = 5 * 60 * 1000;

export interface WatchdogConfig {
  /** Absolute wall-clock limit per task type, measured from pickup. A type
   *  without an entry is never watched (v1 has no inactivity detection). */
  timeLimits: Partial<Record<TaskType, number>>;
  /** 畳み込み停止から強制回収までの猶予。 */
  grace: number;
  /** 強制回収から回収済み観測までの上限。ADR 0109 決定5 の後始末の backstop
   *  ——「最終 verb は着地したのに root が exit しない」だけを見る時限 —— も
   *  同じ尺度で、この1つを共有する。 */
  reclaimTimeout?: number;
}

/** 回収済み観測の不成立(GLOSSARY.md「容器」)で止まっている slot の門
 *  (ADR 0099 決定3)。Containment / Harness Containment quarantine の確認回答の
 *  受理側(human-verbs)だけがこれを読む。 */
export interface PendingReclaim {
  /** 空をまだ観測できていない容器を名乗る一句(例: "the container for task 42")、
   *  無ければ undefined。id ではなく一句なのは、単位が worker session と Board call の
   *  2つあり(ADR 0136)、読み手の文面が単位ごとに違うからである。 */
  pendingReclaim: () => string | undefined;
  /** 空を再観測できた回収を受理する: slot-release tree rule を走らせ、
   *  slot を解放する。まだ populated なら no-op。この run で待っている回収が無くても、
   *  再起動を越えて後始末の印が残り枠が空いていれば、その後始末を走らせる(ADR 0254 決定2)。 */
  acceptReclaimed: () => void;
  /** `acceptReclaimed` の再起動を越えた枝だけ: この run で待っている回収には触れない。
   *  Harness Containment question の確認回答の受理が撃つ —— 解放の門は Containment question
   *  だけなので(ADR 0099 決定3)、`pending` を解放してはならない。 */
  resumeTeardown: () => void;
}

/** Validate the live slot before recording; only after that transaction succeeds does stopping begin. */
export type StopSession = (taskId: string, recordStop: () => void) => "nothing running" | "already ending" | undefined;

export interface Watchdog extends PendingReclaim {
  stop: () => void;
  stopSession: StopSession;
  /** **この session が梯子の底で保留されているか**(ADR 0099 決定3)。回収 timeout で
   *  Containment quarantine に落ちた session の後始末は、確認回答だけが進める ——
   *  遅れて届いた回収済み観測はこの述語で弾かれる。`pendingReclaim` では代われない:
   *  あちらは容器の側も読むので、空が観測された瞬間に false になる。 */
  heldForContainment: (taskId: string) => boolean;
  /** exit は即時に保持し、事実の束が揃ってから盤面が1度だけ決める(ADR 0309 / ADR 0338)。 */
  onWorkerExited: (taskId: string, exit: WorkerExit, facts: WorkerExitClassification) => void;
}

/** watchdog が持つ、今 slot にいるタスクの今の pickup の記録。taskId か pickup が替われば
 *  丸ごと作り直す —— retry された run は前の run の踏み終えた梯子を引き継がず、決着した
 *  タスクの分は残らない。slot にいないタスクの記録で先へ進む入口は無い(どの入口も、
 *  question や slot の解放の前に slot の主を確かめる)。 */
interface WatchRecord {
  taskId: string;
  pickup: number;
  stopSentAt?: number;
  forceSentAt?: number;
  humanStop?: boolean;
  /** 後始末の梯子(`teardownTick`)を、底に落ちた1度で止める。立てるのは梯子の底の2つ
   *  (`onTeardownReclaimTimeout` と、後始末へ入る `onReclaimTimeout`)—— 立たなければ以後の tick ごとに containment の
   *  quarantine を撃ち直す(開いている間は `quarantine_refired` を積み、回答後は question を
   *  刷り直す)。 */
  settled: boolean;
  /** 観測した root の exit。読むのは梯子の底の question だけで、どの判定にも使わない(ADR 0191) */
  exit?: WorkerExit;
  /** worker_exited の記録より前に梯子の底が決着しないための門(ADR 0309 決定3)。 */
  classification?: Promise<void>;
}

/** The task's most recent pickup, not its first: a retried task is picked up
 *  again after its earlier kill, and the watchdog must time the new run, not
 *  the original one. */
function pickedUpAt(db: Db, taskId: string): number {
  const row = latestEventOfTask(db, taskId, "task_picked_up");
  return row ? new Date(row.created_at).getTime() : 0;
}

/** exit が持っていた逐語 —— worker の最後の発話、CLI が報告した失敗の文、stderr 末尾 ——
 *  を見出し付きでこの順に連結する。空の欄は節ごと出さない(ADR 0188 / 0189 / 0191)。
 *  使用量を読み直せなかった exit だけ、CLI の失敗の文の後ろに1行添える(ADR 0261 決定6)。 */
function exitSections(exit: WorkerExit | undefined): string {
  return (
    (exit?.last_message ? `\n\nlast message from the worker:\n${exit.last_message}` : "") +
    (exit?.reported_error ? `\n\nerror reported by the CLI:\n${exit.reported_error}` : "") +
    (exit?.usage_recheck?.result === "unreadable"
      ? `\n\nthe board could not check whether a usage cap ended this session: ${exit.usage_recheck.reason}`
      : "") +
    (exit?.stderr_tail ? `\n\nstderr tail:\n${exit.stderr_tail}` : "") +
    (exit?.model_swaps?.length
      ? `\n\nmodels swapped in by the CLI:\n${exit.model_swaps.map((s) => `${s.from} → ${s.to}`).join("\n")}`
      : "")
  );
}

/** The failure escalation: a question child in tidepool's own name (the agent
 *  could not self-report), with a standing "retry" option — answering it runs
 *  through the ordinary unblock-to-head path, same as any other escalation.
 *  記録だけを撃つ —— tree rule はどの呼び手でも後始末(`runTeardown`)が走らせる。 */
export function registerFailureQuestion(
  db: Db,
  task: Task,
  title: string,
  reason: string,
  now: Date,
): void {
  escalateTask(
    db,
    task,
    {
      // abandon's consequence is spelled out via abandonConsequence; it's
      // declared via the system-internal failure kind below, never exposed
      // to agents.
      context:
        `${reason}\n\n` +
        `"retry" picks this task up again at the queue head: a new worker session continues on its existing task branch, with the work in progress kept. ` +
        abandonConsequence(db, task),
      questions: [{ title, options: ["retry", "abandon"], recommendation: "retry" }],
      question_kind: { kind: "failure", cancel_option: "abandon" },
    },
    BOARD_ACTOR_ID,
    now,
    "board",
  );
}

/** failure question と後始末の印を同じ transaction で書く(issue #1935 / 起動時の再起動中断の掃き出しは #1936)—— 間で落ちると後始末の印の
 *  無い todo が残り、起動時の中断の掃き出しにも復旧にも拾われず、tree rule の走らない workspace へ
 *  次の pickup が入る。 */
export function registerFailureAndMarkTeardown(
  db: Db,
  task: Task,
  title: string,
  reason: string,
  now: Date,
): void {
  db.transaction(() => {
    registerFailureQuestion(db, task, title, reason, now);
    markTeardown(db, task.id, now);
  })();
}

/** 人間の停止の記録は要求時に一括で置く。容器の回収は transaction の外(ADR 0305)。 */
export function recordHumanStop(db: Db, taskId: string, reason: string | undefined, now: Date, origin: EventOrigin, cancel?: () => void): void {
  db.transaction(() => {
    if (sessionInTeardown(db)?.taskId === taskId) throw new DomainError(`task ${taskId} is already ending`);
    const task = getTask(db, taskId);
    if (task?.status !== "in_progress") throw new DomainError(`task ${taskId} is not in progress`);
    if (cancel) cancel();
    else registerFailureQuestion(db, task, `stopped by human: ${task.title}`, `The human stopped this session.${reason === undefined ? "" : `\n\nReason: ${reason}`}`, now);
    const reasonQuestion = reason === undefined ? registerTask(db, {
      type: "question",
      title: `why did you stop "${task.title}"?`,
      purpose: `Record why you stopped "${task.title}": write what you saw in free text.`,
      completion_criteria: "The human has recorded the stop reason",
      question: [{ title: `why did you stop "${task.title}"?`, options: [] }],
      question_kind: { kind: "stop_reason", task_id: taskId },
    }, now, BOARD_ACTOR_ID, "board") : undefined;
    appendEvent(db, { taskId, actorId: HUMAN_ACTOR_ID, origin, payload: { kind: "session_stopped_by_human", ...(reasonQuestion ? { reason_question_id: reasonQuestion.id } : { reason }) }, at: now });
    markTeardown(db, taskId, now);
  })();
}

/** 行の拒否(GLOSSARY.md / ADR 0184 決定4)を盤面が登録し、`todo` へ戻すときに刻む event を返す: 行の Quarantine(行が表に
 *  残っているときだけ)か、行でない Interview の対象なら対象の question(ADR 0199 決定4)。ターンが走ったかに関わらず登録する
 *  (ADR 0338 決定3・4)—— 呼び手が `todo` への復帰か failure question と同じ transaction に置く。 */
function registerRowRefusal(db: Db, task: Task, refusal: RowRefusal, now: Date): QueueReturnPayload {
  // pin の子には別の候補が無いので、行の Quarantine でなく対象の question を立てる
  const target = unrowedTarget(db, task);
  if (target) {
    questionRefusedTarget(db, task, { ...target, cause: refusal.cause }, `ended with ${ROW_REFUSAL_EVIDENCE[refusal.cause]}`, now);
    return { kind: "target_refused", ...refusal };
  }
  quarantineRefusedRow(db, refusal, `The worker session for task ${task.id}`, now);
  return { kind: "row_refused", ...refusal };
}

/** process を1つも持たないまま失敗にせず位置を変えずに `todo` へ戻す pickup の盤面側の一撃(ADR 0274 決定3・4 / ADR 0333 決定1)。入口は資源の停止で worker が
 *  1度も走らなかった pickup(`pickup_stopped`)と盤面の記録の器が書けない pickup(`record_container_unwritable`、ADR 0266 決定3・4)で、
 *  Quarantine の登録はどちらも呼び手が先に済ませている —— 資源はもうその question を持つので failure question は立てない。
 *  形は行の拒否(ADR 0184 決定4)と同じ: `todo` への復帰と後始末の印を1 transaction に置き、後始末中の status は `todo` なので
 *  経路は process を1つも持たなかった session の step に読まれる(ADR 0113 決定3 / ADR 0274 決定3)—— drift で解決できない
 *  workspace の Quarantine を撃ち直さず、動いていない checkout に触れないのは、記録から導く後始末の側である(再起動を跨ぐ)。
 *  process の無い容器へ強制回収を撃つのは `spawnFailureHandler` と同じ。process が起きた session の `todo` への復帰は exit の決定
 *  (`onWorkerExited`)が持つ(ADR 0338 決定2)。 */
export function queueReturnHandler(
  deps: TeardownDeps,
  containers: ProcessContainers,
): (taskId: string, payload: Extract<QueueReturnPayload, { kind: "pickup_stopped" | "record_container_unwritable" }>) => void {
  return (taskId, payload) => settleAndReclaim(deps, containers, taskId, (task, now) => returnToQueue(deps.db, task, payload, now));
}

/** 盤面の記録の器が書けない pickup(ADR 0266 決定3・4)。入口は transcript の open(ADR 0276 決定5)で、観測点は
 *  scheduler の catch と adapter の launch の catch。盤面全体の停止を登録してから `queueReturnHandler` で `todo` へ戻す —— 盤面が
 *  止まっているので、後始末の pickup の契機は `boardHalts` が止める。踏んだ task は解放後の pickup で自分のブランチへ戻って続ける。 */
export function recordContainerHaltHandler(
  deps: TeardownDeps,
  containers: ProcessContainers,
): (taskId: string, err: RecordContainerError) => void {
  return (taskId, err) =>
    settleAndReclaim(deps, containers, taskId, (task, now) => returnToQueue(deps.db, task, { kind: "record_container_unwritable", path: err.path, reason: err.reason }, now), () =>
      registerQuarantine(deps.db, "recordContainer", null, `while picking up task ${taskId}, ${err.message}. Task ${taskId} was returned to the queue in its current place, not failed`, deps.clock.now()),
    );
}

/** worker が1度も走らなかった pickup(ADR 0118)の盤面側の一撃。観測点は3つ ——
 *  scheduler が捕まえる `start` の同期 throw、adapter が捕まえる `spawn()` の非同期
 *  失敗と skill 列挙の失敗(issue #770)—— で、`spawn_failed` event の中身はそれぞれの観測点が持つ。
 *  adapter の観測点は書く行為を `record` で渡し、失敗の記録と同じ transaction で書く(ADR 0342 決定6 / ADR 0338 決定4)。
 *
 *  上限到達による中断と違い、記録(failure question)を回収済み観測の**前**に置く ——
 *  escalate verb と同じ順で、後始末中の status は `todo` になり、経路は `spawn_failed` の event から
 *  process を1つも持たなかった session の step に読まれる(ADR 0113 決定3 / ADR 0274 決定3)。process を1つも持たない session
 *  なので、容器は空のまま強制回収を撃つ。 */
export function spawnFailureHandler(
  deps: TeardownDeps,
  containers: ProcessContainers,
): (taskId: string, failure: { error_code: string | null; message: string }, record?: () => void) => void {
  return (taskId, failure, record) =>
    settleAndReclaim(
      deps,
      containers,
      taskId,
      registerFailure(deps, (task) => [
        `worker never started for task: ${task.title}`,
        `the worker for task "${task.title}" (${task.id}) never ran: the board observed this ` +
          `error while starting it${failure.error_code ? ` (${failure.error_code})` : ""}:\n\n` +
          failure.message,
      ]),
      record,
    );
}

/** 走ってから transcript が書けなくなった session(ADR 0149 決定4)の盤面側の一撃。
 *  event は常に書く。question と強制回収は、まだ後始末に入っていない session だけ ——
 *  決着後に届いた失敗には止めるものが無く、「盤面が止めた」が偽になる。後始末の印が
 *  先に置かれるので、続く exit で ADR 0145 の question は立たない。止めた session は、その failure question を
 *  残したまま盤面全体の記録の器の停止も立てる(ADR 0266 決定4)—— `queueReturnHandler` の `todo` への復帰は通らない。 */
export function transcriptFailureHandler(
  deps: TeardownDeps,
  containers: ProcessContainers,
): (failure: TranscriptFailure) => void {
  return ({ taskId, workerSpawnedEventId, file, error_code, message, path }) =>
    settleAndReclaim(
      deps,
      containers,
      taskId,
      registerFailure(
        deps,
        (task) => [
          `worker transcript could not be written: ${task.title}`,
          `the board force-reclaimed the worker for task "${task.title}" (${task.id}) because its ` +
            `transcript could not be written (${error_code ?? "no error code"}, ${file} file):\n\n${message}`,
        ],
        `while task ${taskId} was running, the board's record container could not be written at ${path}: ${message}. ` +
          "That session was force-reclaimed and has its own failure question",
      ),
      // ADR 0342 決定6: event は失敗の記録と同じ tx —— rollback で何も残らず、受理の撃ち直しが2行目を書かない
      () =>
        appendEvent(deps.db, {
          taskId,
          // worker_spawned は open より先に書かれている(ADR 0149 決定2)
          actorId: getEvent(deps.db, workerSpawnedEventId)!.actor_id,
          origin: "board",
          payload: { kind: "transcript_failed", error_code, message, file, worker_spawned_event_id: workerSpawnedEventId },
          at: deps.clock.now(),
        }),
    );
}

/** 記録の手 → 後始末に入ったなら続きの手、の2手を runner に通す(ADR 0342 決定6)。`record` は tx で、後始末に入ったかを返す。
 *  受理は投げた手から撃ち直す —— 続きの手は `record` の結果だけを読み、門を持たない。 */
function recordThen(deps: Pick<TeardownDeps, "db" | "clock" | "slot">, taskId: string, record: () => boolean, follow: () => unknown) {
  let entered = false;
  return runTeardownSteps(
    deps,
    taskId,
    () => {
      entered = record();
    },
    () => entered && follow(),
  );
}

/** process を持たない session を盤面が観測した瞬間に決着させて後始末へ入れる(ADR 0118 / ADR 0274 の型)。決着を回収済み観測の
 *  **前**に置くので、後始末中の status が経路を決める(ADR 0113 決定3)。`record` は門より前に同じ transaction で書く
 *  観測の記録 —— 決着の後に届いた失敗にも残す(ADR 0149 決定4)。 */
function settleAndReclaim(
  deps: TeardownDeps,
  containers: ProcessContainers,
  taskId: string,
  settle: (task: Task, now: Date) => void,
  record?: () => void,
) {
  return recordThen(
    deps,
    taskId,
    () =>
      deps.db.transaction(() => {
        record?.();
        if (deps.slot.currentTaskId !== taskId || deps.slot.inTeardown) return false;
        const task = getTask(deps.db, taskId);
        if (task?.status !== "in_progress") return false;
        const now = deps.clock.now();
        settle(task, now);
        markTeardown(deps.db, taskId, now);
        return true;
      })(),
    () => reclaimIntoTeardown(deps, containers, taskId),
  );
}

/** 失敗の記録(ADR 0118 の型)。`haltReason` があれば記録の器の停止も同じ transaction で登録する(ADR 0266 決定4)。 */
function registerFailure(deps: TeardownDeps, wording: (task: Task) => [title: string, reason: string], haltReason?: string) {
  return (task: Task, now: Date) => {
    registerFailureQuestion(deps.db, task, ...wording(task), now);
    if (haltReason) registerQuarantine(deps.db, "recordContainer", null, haltReason, now);
  };
}

/** 記録の tx の後の手: 後始末へ入り、process の無い容器へも強制回収を撃ち、回収済み観測に後始末を繋ぐ。門は持たない ——
 *  受理の撃ち直しが門で空振りすると、枠は後始末中のまま回収の鎖が付かない(ADR 0342 決定6)。 */
function reclaimIntoTeardown(deps: TeardownDeps, containers: ProcessContainers, taskId: string): void {
  deps.slot.enterTeardown();
  containers.forceReclaim(taskId);
  void containers.reclaimed(taskId).then(() => runTeardown(deps, taskId, teardownStep(deps.db, taskId)));
}

/** Process-internal watchdog (#9): an absolute per-type time limit on the
 *  slot task, checked against the injected clock so overruns are
 *  deterministic in tests. 畳み込み停止 at the limit, 強制回収 after grace —
 *  そして**回収済み観測を経てから**、他のエスカレーションと同じ tree rule +
 *  failure question の経路へ進み、slot を解放する(ADR 0099 決定3)。
 *
 *  slot を解放するのは force の送達ではなく容器が空になった観測である。観測
 *  できないまま timeout したときは、失敗の記録(failure question)は残すが
 *  slot は解放せず、Containment quarantine の確認 question が解放の唯一の門に
 *  なる — 残存 process はどの Harness の次の worker とも同じホスト・workspace で
 *  同居しうるので、止められるより狭い資源が存在しない(決定4)。 */
export function startWatchdog(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  worker: WorkerAdapter;
  /** 盤面側 supervisor(ADR 0099 決定2)。force と reclaimed はここだけを通る。 */
  containers: ProcessContainers;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task fails against the
   *  board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** ADR 0093: 完了済み session の後始末が確認回答で解放されるとき、merge-back の
   *  帰り先を決める fetch がここの token を要る。 */
  githubAuth?: GitHubAuth;
  pollNow: () => void;
  /** Absent → receive exits and classify them, without time-based watchdog ticks. */
  config?: WatchdogConfig;
  /** 前の盤面が閉じ切らなかった session を閉じる復旧(ADR 0315 決定1)。受理の門で後始末の復旧より先に走る。 */
  closeLeftOpenSessions?: () => void;
}): Watchdog {
  const { db, clock, slot, worker, containers, workspace, resolveWorkspace } = deps;
  const config: WatchdogConfig = deps.config ?? { timeLimits: {}, grace: 0 };
  const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
  const reclaimTimeout = config.reclaimTimeout ?? RECLAIM_TIMEOUT;
  let pending: string | null = null;
  const heldForContainment = (taskId: string) => pending === taskId;
  const teardown: TeardownDeps = {
    db,
    clock,
    slot,
    resolve,
    githubAuth: deps.githubAuth,
    // watchdog が撃つ後始末も、梯子の底で保留中の session を遅れた回収済み観測で解放しない(ADR 0099 決定3)
    heldForContainment,
    pollNow: deps.pollNow,
  };
  // 今 slot にいるタスクの記録1件(`syncPickup` が作り直す)
  let record: WatchRecord | null = null;
  // ADR 0112 決定4: 落ちた後始末は梯子に入らない。門は行に持つ —— runner が同期に立てる行も同じ門で読む(ADR 0342 決定6)
  const failedTeardownOpen = () => openQuarantineValues(db, "failedTeardown").length > 0;

  /** 容器が空になった観測。ここで初めて failure question と slot 解放へ進む ——
   *  通る型は通常完了・上限到達による中断と同じ後始末である(ADR 0109 決定1)。
   *
   *  記録は後始末の**前**に置く —— `spawnFailureHandler`(ADR 0118)・`onReclaimTimeout`・
   *  cap と同じ順であり、escalate verb の順でもある。後始末の中(ツリー規律の前に走る
   *  記録)に置くと、後始末がそこへ届く前に投げたとき failure question が立たないまま
   *  status が `in_progress` で残り、落ちた後始末の受理は `teardownStep`(ADR 0113 決定3)に
   *  cap 経路と読まれる —— watchdog が殺したタスクが retry / abandon の問いなしに todo
   *  へ戻り、`cap_interrupted` という起きていない event が書かれる(GLOSSARY.md「Watchdog」:
   *  自動リトライは存在しない)。記録を先に置けば status は決着し、決定3 はこの経路でも真になる。 */
  function onReclaimed(taskId: string, rec: WatchRecord, limit: number): void {
    if (rec.settled) return;
    if (rec.humanStop) {
      void runTeardown(teardown, taskId, teardownStep(db, taskId));
      return;
    }
    if (rec.classification) {
      void rec.classification.then(() => {
        if (!rec.humanStop) onReclaimed(taskId, rec, limit);
      });
      return;
    }
    if (failedTeardownOpen()) {
      // 観測は1度きり: 捨てると受理の後の梯子が回収 timeout へ落ち、空の容器に偽の Containment question を立てる(ADR 0112 決定4)
      if (slot.hasFailedTeardownRest(taskId)) slot.keepFailedTeardownRest(taskId, [() => recordReclaimed(taskId, rec, limit)]);
      return;
    }
    recordReclaimed(taskId, rec, limit);
  }

  function recordReclaimed(taskId: string, rec: WatchRecord, limit: number) {
    return recordThen(
      teardown,
      taskId,
      () => {
        // 強制回収の待ちの間に cap / 最終 verb が決着したなら、その後始末が観測を受ける。回収 timeout で
        // 後始末へ入った session に遅れて届いた空の観測もここで外れる —— 外れなければ quarantine へ
        // 倒れた slot を黙って解放する(解放の門は確認 question ただ1つ)。後始末の側に届く観測を
        // 弾くのは `heldForContainment`
        if (sessionInTeardown(db)?.taskId === taskId) return false;
        // 後始末が持っていた門を、記録が先へ出た分だけこちらで読む —— 枠の主が変わっていれば
        // 他人の session に failure question を立ててしまう
        if (slot.currentTaskId !== taskId || slot.inTeardown) return false;
        const task = getTask(db, taskId);
        // 決着済みのタスクに failure question を立てない
        if (task?.status !== "in_progress") return false;
        registerFailureAndMarkTeardown(
          db,
          task,
          `watchdog killed task: ${task.title}`,
          `the task hit its ${task.type} time limit (${limit}ms) and its container was ` +
            `reclaimed (graceful stop, then force reclaim after ${config.grace}ms grace). ` +
            "No self-report is possible." +
            // root の exit は必ずここより先に観測済み(容器が exit を adapter より先に登録、reclaimed は microtask)
            exitSections(rec.exit),
          clock.now(),
        );
        return true;
      },
      // 撃った手の中の後始末の throw も同じ runner へ返す(受理の撃ち直しが黙って通らない)
      () => {
        slot.enterTeardown();
        return runTeardown(teardown, taskId, teardownStep(db, taskId));
      },
    );
  }

  /** 空を観測できないまま timeout。失敗の記録を置いてから後始末へ入る(ADR 0254 決定1)が、
   *  slot は解放しない — tree rule も走らせない(まだ生きている process が書いている作業ツリーを
   *  退避しても、退避そのものが競合する)。tree rule は確認 question の受理まで待つ
   *  (ADR 0099 決定3 / GLOSSARY.md「Slot-release tree rule」)。後始末の印が待ちを再起動の先へ運ぶ。 */
  function onReclaimTimeout(task: Task, rec: WatchRecord, limit: number): void {
    if (rec.humanStop) return;
    if (rec.classification) {
      void rec.classification.then(() => onReclaimTimeout(task, rec, limit));
      return;
    }
    if (failedTeardownOpen()) return;
    recordThen(teardown, task.id, () => {
      if (slot.currentTaskId !== task.id || slot.inTeardown || sessionInTeardown(db)?.taskId === task.id) return false;
      if (getTask(db, task.id)?.status !== "in_progress") return false;
      raiseReclaimTimeout(task, rec, limit);
      return true;
    }, () => {
      // ADR 0342 決定5: 印は書き込みが返った後 —— 先に置くと rollback の後に行の無い回収を報せる
      pending = task.id;
      rec.settled = true;
      slot.enterTeardown();
    });
  }

  function raiseReclaimTimeout(task: Task, rec: WatchRecord, limit: number): void {
    const now = clock.now();
    // 同じ transaction に置く —— 間で落ちると、status は決着したのに印の無い session が残り、
    // 起動時の復旧も再起動後の受理も後始末を走らせない(#648 の形に戻る)
    db.transaction(() => {
      registerFailureQuestion(
        db,
        task,
        `watchdog killed task: ${task.title}`,
        `the task hit its ${task.type} time limit (${limit}ms) and its container was ` +
          `force-reclaimed, but the board could not observe the container going empty within ` +
          `${reclaimTimeout}ms. No self-report is possible.` +
          exitSections(rec.exit),
        now,
      );
      // 回収を観測できないときに slot を塞いだままにするのは ADR 0099
      quarantineContainment(
        db,
        `the container for task ${task.id} was force-reclaimed but never observed empty, ` +
          "so processes from that session may still be running against this host and its " +
          "workspaces. The execution slot stays occupied until this is answered",
        now,
      );
      markTeardown(db, task.id, now);
    })();
  }

  /** 後始末に入った時刻からの backstop。最終 verb 後は強制回収 → 回収 timeout の
   *  2段、cap は exit 時に強制回収が済んでいるので回収 timeout の1段(ADR 0113)。 */
  function teardownTick(task: Task, rec: WatchRecord): void {
    const taskId = task.id;
    const session = sessionInTeardown(db);
    if (session?.taskId !== taskId || rec.settled) return;
    const now = clock.now().getTime();
    if (task.status === "in_progress") {
      if (now - new Date(session.startedAt).getTime() >= reclaimTimeout) onTeardownReclaimTimeout(task, rec);
      return;
    }
    if (rec.forceSentAt !== undefined) {
      if (now - rec.forceSentAt >= reclaimTimeout) onTeardownReclaimTimeout(task, rec);
      return;
    }
    if (now - new Date(session.startedAt).getTime() >= reclaimTimeout) {
      rec.forceSentAt = now;
      containers.forceReclaim(taskId);
    }
  }

  /** 決着済みの session(完了・escalate / decompose・worker が1度も走らなかった pickup)が
   *  梯子の底まで落ちたとき。**failure question は立てない** —— タスクの決着は host 側の
   *  事情で覆らない(ADR 0109 決定4)。 */
  function onTeardownReclaimTimeout(task: Task, rec: WatchRecord): void {
    const taskId = task.id;
    runTeardownSteps(teardown, taskId, () => {
      quarantineContainment(
        db,
        (task.status === "in_progress"
          ? `the worker session for task ${taskId} was interrupted by the Provider usage cap and will go back to the queue in its current place after teardown, but its `
          : `the worker session for task ${taskId} is settled — teardown has already decided the task's status — but its `) +
          "processes may still be running on this host: the board force-reclaimed the container and " +
          `could not observe it going empty within ${reclaimTimeout}ms. The task itself stays ` +
          `${task.status} — what is still held is this host's workspaces and the execution slot, until ` +
          "this is answered",
        clock.now(),
      );
      // ADR 0342 決定5: 印は書き込みが返った後
      rec.settled = true;
      pending = taskId;
    });
  }

  /** 記録を今の pickup に合わせる。retry された task が次の tick より先に exit すると、
   *  前の run の記録を読んでしまうので、tick と exit の観測の両方がここを通る。 */
  function syncPickup(taskId: string): WatchRecord {
    const pickup = pickedUpAt(db, taskId);
    if (record?.taskId !== taskId || record.pickup !== pickup) record = { taskId, pickup, settled: false };
    return record;
  }

  function beginStop(taskId: string, rec: WatchRecord): void {
    if (rec.stopSentAt !== undefined) return;
    rec.stopSentAt = clock.now().getTime();
    worker.gracefulStop(taskId);
  }

  /** cap と人間の停止は同じ猶予・強制回収・観測の梯子を通る(ADR 0305)。 */
  function advanceStop(task: Task, rec: WatchRecord, limit: number): void {
    if (rec.settled) return;
    const now = clock.now().getTime();
    if (rec.forceSentAt !== undefined) {
      if (now - rec.forceSentAt >= reclaimTimeout) {
        if (rec.humanStop) onTeardownReclaimTimeout(task, rec);
        else onReclaimTimeout(task, rec, limit);
      }
      return;
    }
    if (now - rec.stopSentAt! >= config.grace) {
      rec.forceSentAt = now;
      containers.forceReclaim(task.id);
      void containers.reclaimed(task.id).then(() => onReclaimed(task.id, rec, limit));
    }
  }

  const stopSession: StopSession = (taskId, recordStop) => {
    if (slot.currentTaskId !== taskId) return "nothing running";
    if (slot.inTeardown || sessionInTeardown(db)?.taskId === taskId) return "already ending";
    const rec = syncPickup(taskId);
    recordStop();
    slot.enterTeardown();
    rec.humanStop = true;
    beginStop(taskId, rec);
    // 分類待ちに留めた空の観測も、人間の停止は分類を待たずに受け取る(ADR 0309)。
    if (rec.forceSentAt !== undefined && rec.classification) {
      void containers.reclaimed(taskId).then(() => onReclaimed(taskId, rec, 0));
    }
    return undefined;
  };

  /** exit の事実と束を分けて受け、束が揃った時点で slot・後始末・status を読み直して1度だけ決める(ADR 0309 / ADR 0338 決定2)。 */
  function onWorkerExited(taskId: string, exit: WorkerExit, facts: WorkerExitClassification): void {
    const { turnRan, stop, capInterrupted, writes } = facts;
    // ADR 0342 決定6: 決定しない exit(通常完了の後始末中・枠の主が替わった)も exit の記録は書く
    if (slot.currentTaskId !== taskId || slot.inTeardown) {
      void runTeardownSteps(teardown, taskId, ...(typeof capInterrupted === "boolean" ? [] : [() => capInterrupted]), ...writes);
      return;
    }
    const rec = syncPickup(taskId);
    rec.exit = exit;
    let cap = false;
    let failedOpen = false;
    // ADR 0112 決定4 の門は撃ち直される手の外で読む —— 受理の撃ち直しは question が開いたまま走るので、手の中で読むと決定が黙って飛ぶ
    const classified = (value: boolean) => {
      cap = value;
      failedOpen = failedTeardownOpen();
    };
    const decide = () =>
      failedOpen ||
      recordThen(teardown, taskId, () => {
        if (rec.humanStop) return false;
        if (slot.currentTaskId !== taskId || slot.inTeardown || sessionInTeardown(db)?.taskId === taskId) return false;
        const task = getTask(db, taskId);
        if (task?.status !== "in_progress") return false;
        return recordDecision(task, cap);
      }, () => {
        slot.enterTeardown();
        void containers.reclaimed(taskId).then(() => runTeardown(teardown, taskId, teardownStep(db, taskId)));
      });
    /** 決定の記録の tx。返り値は後始末へ入ったか。 */
    const recordDecision = (task: Task, cap: boolean): boolean => {
      const now = clock.now();
      // 登録・status の決着・後始末の印は1 transaction —— 間で落ちると後始末の印の無い todo が残る(issue #1935)
      return db.transaction(() => {
        // ADR 0338 決定3・4: 行の拒否はターンに関わらず盤面が登録する。資源の停止は adapter が登録済み
        const queueReturn = stop && ("refusal" in stop ? registerRowRefusal(db, task, stop.refusal, now) : stop.registered);
        // ADR 0338 決定2: 人間の停止 > 停止(ターンが走っていない)> 上限到達 > 時間制限の停止の梯子 > 報告なき exit の failure question
        if (queueReturn && !turnRan) {
          returnToQueue(db, task, queueReturn, now);
        } else {
          // 戻らない session でも対象の拒否は証拠に残す —— 子の拒否の種類はこの event から引かれる(ADR 0199 決定4)
          if (queueReturn?.kind === "target_refused") appendEvent(db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload: queueReturn, at: now });
          // 畳み込み停止の結果は梯子が受ける
          if (!cap && rec.stopSentAt !== undefined) return false;
          if (!cap) {
            const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.exit_code}`;
            registerFailureQuestion(
              db,
              task,
              `worker exited without reporting: ${task.title}`,
              `the worker for task "${task.title}" (${task.id}) exited (${how}) without a final report — ` +
                "it did not complete, decompose, or escalate. No self-report is possible." +
                exitSections(exit),
              now,
            );
          }
        }
        markTeardown(db, taskId, now);
        return true;
      })();
    };
    // ADR 0309 決定3 / ADR 0342 決定6: 分類 → exit の記録 → 決定の順で、投げた手から撃ち直す。`stop` の登録も `writes` の中なので決定は登録の後に読む
    if (typeof capInterrupted === "boolean") {
      classified(capInterrupted);
      runTeardownSteps(teardown, taskId, ...writes, decide);
    } else {
      // 門は書き込みまで覆う —— 待つ梯子が exit の記録を追い越さない。落ちた後始末は行の門で止まり、reject を受け取らない(ADR 0112 決定4)
      rec.classification = runTeardownSteps(teardown, taskId, () => capInterrupted.then(classified), ...writes, decide)!.finally(() => {
        delete rec.classification;
      });
    }
  }

  function tick(): void {
    const taskId = slot.currentTaskId;
    if (taskId === null) return;
    // ADR 0112 決定4: 落ちた後始末は梯子(強制回収 → 回収 timeout → Containment
    // quarantine)に入らない。原因を知らないハンドラに文面を書かせると偽の断言になる
    // —— 容器はもう空なので強制回収は no-op で、続く Containment question は
    // 「その session のプロセスがこのホストに残っている」と断言するが実際には残って
    // いない。門は**行**に持つ: in-memory の門は再起動を越えないので、越えなければ
    // 起動のたびに偽の question を1枚ずつ刷る。
    if (failedTeardownOpen()) return;
    const task = getTask(db, taskId);
    if (!task) return;
    const rec = syncPickup(taskId);
    if (rec.humanStop) {
      advanceStop(task, rec, 0);
      return;
    }
    // cap は in_progress のまま後始末に入る(ADR 0113)。タスク種別の梯子より先に読む。
    if (sessionInTeardown(db)?.taskId === taskId) {
      teardownTick(task, rec);
      return;
    }
    if (task.status !== "in_progress") return;
    const limit = config.timeLimits[task.type];
    if (limit === undefined) return;

    const now = clock.now().getTime();
    if (rec.stopSentAt === undefined) {
      if (now - rec.pickup >= limit) beginStop(taskId, rec);
      return;
    }
    advanceStop(task, rec, limit);
  }

  // 再起動を越えた梯子の底(ADR 0254 決定2): 前提検査が落ちた起動では、起動時の復旧は
  // 枠を握らず、後始末の印だけが行に残る。受理の検査は前提検査を読み直しているので、
  // 起動時の復旧と同じ門を通して走らせる。閉じ切らなかった session を閉じる復旧はその直前に(ADR 0315 決定1)
  const resumeTeardown = () => {
    deps.closeLeftOpenSessions?.();
    void resumeUnfinishedTeardown(teardown);
  };
  const cancel = deps.config ? clock.setInterval(tick, WATCHDOG_TICK) : () => {};
  return {
    stop: cancel,
    stopSession,
    heldForContainment,
    onWorkerExited,
    pendingReclaim: () =>
      pending !== null && containers.pendingReclaim(pending)
        ? `the container for task ${pending}`
        : undefined,
    resumeTeardown,
    acceptReclaimed: () => {
      if (pending === null) {
        resumeTeardown();
        return;
      }
      // 「検査を回答時にもう一度走らせる」— 呼び出し側も先に見ているが、受理の
      // 直前でもう一度読む(1資源1枚の quarantine と同じ posture)
      if (containers.pendingReclaim(pending)) return;
      deps.closeLeftOpenSessions?.();
      const taskId = pending;
      pending = null;
      // slot が解放される瞬間に tree rule が走る、の対を閉じる(GLOSSARY.md
      // 「Slot-release tree rule」)— 回収 timeout の時点では走らせていない。
      // 完了済み session の後始末なら、通る型は通常完了と同じである(退避ではなく
      // 検査 + merge-back / 休止位置。ADR 0109 決定3)
      void runTeardown(teardown, taskId, teardownStep(db, taskId));
    },
  };
}
