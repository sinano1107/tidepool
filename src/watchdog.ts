import type { Clock } from "./clock.js";
import { quarantineContainment } from "./containment.js";
import type { Db } from "./db.js";
import type { GitHubAuth } from "./github-auth.js";
import type { Landing } from "./landing.js";
import type { ProcessContainers } from "./process-container.js";
import { openQuarantineValues } from "./quarantine.js";
import type { Slot } from "./slot.js";
import { abandonConsequence, escalateTask, getTask, type Task, type TaskType } from "./tasks.js";
import {
  markTeardown,
  runTeardown,
  runTreeRule,
  sessionInTeardown,
  type TeardownDeps,
  teardownStep,
} from "./teardown.js";
import type { WorkerAdapter } from "./worker.js";
import { BOARD_WORKER_ID, buildWorkspaceResolver, type WorkspaceConfig } from "./workspace.js";

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

/** 回収済み観測の不成立(CONTEXT.md「容器」)で止まっている slot の門
 *  (ADR 0099 決定3)。Containment quarantine の確認回答の受理側(human-verbs)
 *  だけがこれを読む。 */
export interface PendingReclaim {
  /** 空をまだ観測できていない容器を名乗る一句(例: "the container for task 42")、
   *  無ければ undefined。id ではなく一句なのは、単位が worker session と Board call の
   *  2つあり(ADR 0136)、読み手の文面が単位ごとに違うからである。 */
  pendingReclaim: () => string | undefined;
  /** 空を再観測できた回収を受理する: slot-release tree rule を走らせ、
   *  slot を解放する。待っている回収が無い / まだ populated なら no-op。 */
  acceptReclaimed: () => void;
}

export interface Watchdog extends PendingReclaim {
  stop: () => void;
  /** **この session が梯子の底で保留されているか**(ADR 0099 決定3)。回収 timeout で
   *  Containment quarantine に落ちた session の後始末は、確認回答だけが進める ——
   *  遅れて届いた回収済み観測はこの述語で弾かれる。`pendingReclaim` では代われない:
   *  あちらは容器の側も読むので、空が観測された瞬間に false になる。 */
  heldForContainment: (taskId: string) => boolean;
}

/** The task's most recent pickup, not its first: a retried task is picked up
 *  again after its earlier kill, and the watchdog must time the new run, not
 *  the original one. */
function pickedUpAt(db: Db, taskId: string): number {
  const row = db
    .prepare(
      "SELECT created_at FROM events WHERE task_id = ? AND kind = 'task_picked_up' ORDER BY id DESC LIMIT 1",
    )
    .get(taskId) as { created_at: string } | undefined;
  return row ? new Date(row.created_at).getTime() : 0;
}

/** The failure escalation: a question child in tidepool's own name (the agent
 *  could not self-report), with a standing "retry" option — answering it runs
 *  through the ordinary unblock-to-head path, same as any other escalation. */
export function failTask(
  db: Db,
  task: Task,
  title: string,
  reason: string,
  /** Resolves the failed task's own execution workspace against the registry
   *  (issue #26 / ADR 0009). Build with `buildWorkspaceResolver` — absent
   *  means no workspace tracking at all (a workspaceless caller). */
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  now: Date,
): void {
  // the failure question registers first, mirroring an agent's own escalate
  // call; the tree rule runs after, same order as every releasing MCP verb —
  // a tree-rule failure adds its own quarantine question on top, it never
  // replaces the failure question
  registerFailureQuestion(db, task, title, reason, now);
  runTreeRule(db, resolve, task, now);
}

/** failure question そのもの。後始末の型を通る watchdog 経路は tree rule を
 *  `runTeardown` 側に任せるので、記録だけを撃つこちらを使う。 */
function registerFailureQuestion(
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
      // declared via the system-internal cancel_option below, never exposed
      // to agents.
      context:
        `${reason}\n\n` +
        `"retry" restarts this task from scratch at the queue head. ` +
        abandonConsequence(db, task),
      questions: [{ title, options: ["retry", "abandon"], recommendation: "retry" }],
      cancel_option: "abandon",
    },
    BOARD_WORKER_ID,
    now,
    "board",
  );
}

/** 上限到達による中断(CONTEXT.md / ADR 0104)の盤面側の一撃。adapter は
 *  「Provider が 429 で断った」ことと「容器が空になった」ことだけを観測し、
 *  ここへ task id を渡す —— slot も tree rule も盤面の側にある(ADR 0099 決定1)。
 *
 *  通る型は通常完了・watchdog の強制回収と同じ後始末(`runTeardown`)であり、違いは
 *  failure question を立てないことだけである: リトライ判断が存在しない以上、問いに
 *  判断価値が無い(ADR 0007 の理路)。同じ理由で `failTask` を通さず、失敗統計も汚さない。
 *
 *  slot と status の門は後始末モジュールが持つ: 回収済み観測は非同期に届くので、その間に
 *  session が自己申告して次のタスクが slot に入っていることがありうる —— 他人の slot を
 *  解放しないために、そこで観測しなおす(ADR 0104 の実装時にこの経路だけが取った自衛が、
 *  ADR 0109 で3経路の共有物になった)。 */
export function capInterruptionHandler(deps: TeardownDeps): (taskId: string, reclaimed: Promise<void>) => void {
  return (taskId, reclaimed) => {
    if (deps.slot.currentTaskId !== taskId || deps.slot.inTeardown) return;
    if (getTask(deps.db, taskId)?.status !== "in_progress") return;
    markTeardown(deps.db, taskId, deps.clock.now());
    deps.slot.enterTeardown();
    void reclaimed.then(() => runTeardown(deps, taskId, teardownStep(deps.db, taskId)));
  };
}

/** worker が1度も走らなかった pickup(ADR 0118)の盤面側の一撃。観測点は2つ ——
 *  scheduler が捕まえる `start` の同期 throw と、adapter が捕まえる `spawn()` の非同期
 *  失敗 —— で、`spawn_failed` event はそれぞれの観測点が書く。
 *
 *  上限到達による中断と違い、記録(failure question)を回収済み観測の**前**に置く ——
 *  escalate verb と同じ順で、後始末中の status が `todo` になるので経路は
 *  エスカレーションの step に読まれる(ADR 0113 決定3)。process を1つも持たない session
 *  なので、容器は空のまま強制回収を撃つ。 */
export function spawnFailureHandler(
  deps: TeardownDeps,
  containers: ProcessContainers,
): (taskId: string, failure: { error_code: string | null; message: string }) => void {
  return (taskId, failure) => {
    if (deps.slot.currentTaskId !== taskId || deps.slot.inTeardown) return;
    const task = getTask(deps.db, taskId);
    if (task?.status !== "in_progress") return;
    const now = deps.clock.now();
    registerFailureQuestion(
      deps.db,
      task,
      `worker never started for task: ${task.title}`,
      `the worker for task "${task.title}" (${task.id}) never ran: the board observed this ` +
        `error while starting it${failure.error_code ? ` (${failure.error_code})` : ""}:\n\n` +
        failure.message,
      now,
    );
    markTeardown(deps.db, taskId, now);
    deps.slot.enterTeardown();
    containers.forceReclaim(taskId);
    void containers.reclaimed(taskId).then(() => runTeardown(deps, taskId, teardownStep(deps.db, taskId)));
  };
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
  /** 完了済み session の後始末がここを通る(確認回答で解放される経路)—— 着地は
   *  後始末の中で走るので(ADR 0109 決定1)、これが無いと梯子の底へ落ちた完了は
   *  merge-back まで進んだきり PR 昇格 / 着地が永久に起きない。 */
  landing?: Landing;
  pollNow: () => void;
  config: WatchdogConfig;
}): Watchdog {
  const { db, clock, slot, worker, containers, workspace, resolveWorkspace, config } = deps;
  const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
  const reclaimTimeout = config.reclaimTimeout ?? RECLAIM_TIMEOUT;
  const teardown: TeardownDeps = {
    db,
    clock,
    slot,
    resolve,
    githubAuth: deps.githubAuth,
    landing: deps.landing,
    pollNow: deps.pollNow,
  };
  // keyed by task id; reset whenever a fresh pickup shows up for that id so a
  // retried run starts its own graceful-stop clock instead of inheriting
  // the previous run's already-tripped state
  const lastSeenPickup = new Map<string, number>();
  const stopSentAt = new Map<string, number>();
  const forceSentAt = new Map<string, number>();
  // 1回の force につき「回収済み観測」と「回収 timeout」のどちらか**一方だけ**が
  // 動く。遅れて届いた空の観測が、既に quarantine へ倒れた slot を黙って解放して
  // しまわないための門でもある(解放の門は確認 question ただ1つ)。
  const settled = new Set<string>();
  let pending: string | null = null;

  /** 容器が空になった観測。ここで初めて failure question と slot 解放へ進む ——
   *  通る型は通常完了・上限到達による中断と同じ後始末である(ADR 0109 決定1)。
   *
   *  記録は後始末の**前**に置く —— `spawnFailureHandler`(ADR 0118)・`onReclaimTimeout`・
   *  cap と同じ順であり、escalate verb の順でもある。後始末の中(ツリー規律の前に走る
   *  記録)に置くと、後始末がそこへ届く前に投げたとき failure question が立たないまま
   *  status が `in_progress` で残り、落ちた後始末の受理は `teardownStep`(ADR 0113 決定3)に
   *  cap 経路と読まれる —— watchdog が殺したタスクが retry / abandon の問いなしに queue head
   *  へ戻り、`cap_interrupted` という起きていない event が書かれる(CONTEXT.md「Watchdog」:
   *  自動リトライは存在しない)。記録を先に置けば status は決着し、決定3 はこの経路でも真になる。 */
  function onReclaimed(taskId: string, limit: number): void {
    if (settled.has(taskId)) return;
    // 強制回収の待ちの間に cap / 最終 verb が決着したなら、その後始末が観測を受ける。
    if (sessionInTeardown(db)?.taskId === taskId) return;
    // 後始末が持っていた門を、記録が先へ出た分だけこちらで読む —— 枠の主が変わっていれば
    // 他人の session に failure question を立ててしまう(梯子の底での保留は `settled` が兼ねる)
    if (slot.currentTaskId !== taskId || slot.inTeardown) return;
    const task = getTask(db, taskId);
    if (task?.status !== "in_progress") return;
    const now = clock.now();
    settled.add(taskId);
    registerFailureQuestion(
      db,
      task,
      `watchdog killed task: ${task.title}`,
      `the task hit its ${task.type} time limit (${limit}ms) and its container was ` +
        `reclaimed (graceful stop, then force reclaim after ${config.grace}ms grace). ` +
        "No self-report is possible.",
      now,
    );
    markTeardown(db, taskId, now);
    slot.enterTeardown();
    void runTeardown(teardown, taskId, teardownStep(db, taskId));
  }

  /** 空を観測できないまま timeout。失敗の記録は残すが slot は解放しない —
   *  tree rule も走らせない(まだ生きている process が書いている作業ツリーを
   *  退避しても、退避そのものが競合する)。 */
  function onReclaimTimeout(task: Task, limit: number): void {
    settled.add(task.id);
    pending = task.id;
    failTask(
      db,
      task,
      `watchdog killed task: ${task.title}`,
      `the task hit its ${task.type} time limit (${limit}ms) and its container was ` +
        `force-reclaimed, but the board could not observe the container going empty within ` +
        `${reclaimTimeout}ms. No self-report is possible.`,
      // tree rule はここでは走らない: slot が解放される瞬間 — 確認 question の
      // 受理 — まで待つ(ADR 0099 決定3 / CONTEXT.md「Slot-release tree rule」)
      undefined,
      clock.now(),
    );
    quarantineContainment(
      db,
      `the container for task ${task.id} was force-reclaimed but never observed empty, ` +
        "so processes from that session may still be running against this host and its " +
        "workspaces (ADR 0099). The execution slot stays occupied until this is answered",
      clock.now(),
    );
  }

  /** 後始末に入った時刻からの backstop。最終 verb 後は強制回収 → 回収 timeout の
   *  2段、cap は exit 時に強制回収が済んでいるので回収 timeout の1段(ADR 0113)。 */
  function teardownTick(task: Task): void {
    const taskId = task.id;
    const session = sessionInTeardown(db);
    if (session?.taskId !== taskId || settled.has(taskId)) return;
    const now = clock.now().getTime();
    if (task.status === "in_progress") {
      if (now - new Date(session.startedAt).getTime() >= reclaimTimeout) onTeardownReclaimTimeout(task);
      return;
    }
    const forcedAt = forceSentAt.get(taskId);
    if (forcedAt !== undefined) {
      if (now - forcedAt >= reclaimTimeout) onTeardownReclaimTimeout(task);
      return;
    }
    if (now - new Date(session.startedAt).getTime() >= reclaimTimeout) {
      forceSentAt.set(taskId, now);
      containers.forceReclaim(taskId);
    }
  }

  /** 決着済みの session(完了・escalate / decompose・worker が1度も走らなかった pickup)が
   *  梯子の底まで落ちたとき。**failure question は立てない** —— タスクの決着は host 側の
   *  事情で覆らない(ADR 0109 決定4)。 */
  function onTeardownReclaimTimeout(task: Task): void {
    const taskId = task.id;
    settled.add(taskId);
    pending = taskId;
    quarantineContainment(
      db,
      (task.status === "in_progress"
        ? `the worker session for task ${taskId} was interrupted by the Provider usage cap and will return to the queue head after teardown, but its `
        : `the worker session for task ${taskId} is settled — teardown has already decided the task's status — but its `) +
        "processes may still be running on this host: the board force-reclaimed the container and " +
        `could not observe it going empty within ${reclaimTimeout}ms. The task itself stays ` +
        `${task.status} — what is still held is this host's workspaces and the execution slot, until ` +
        "this is answered",
      clock.now(),
    );
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
    if (openQuarantineValues(db, "failedTeardown").length > 0) return;
    const task = getTask(db, taskId);
    if (!task) return;
    const pickup = pickedUpAt(db, taskId);
    if (lastSeenPickup.get(taskId) !== pickup) {
      lastSeenPickup.set(taskId, pickup);
      stopSentAt.delete(taskId);
      forceSentAt.delete(taskId);
      settled.delete(taskId);
    }
    // cap は in_progress のまま後始末に入る(ADR 0113)。タスク種別の梯子より先に読む。
    if (sessionInTeardown(db)?.taskId === taskId) {
      teardownTick(task);
      return;
    }
    if (task.status !== "in_progress") return;
    const limit = config.timeLimits[task.type];
    if (limit === undefined) return;
    if (settled.has(taskId)) return;

    const now = clock.now().getTime();
    const forcedAt = forceSentAt.get(taskId);
    if (forcedAt !== undefined) {
      // 送達は済んでいる。ここから先を進めるのは観測だけで、tick は timeout を
      // 数えるためだけに回る。
      if (now - forcedAt >= reclaimTimeout) onReclaimTimeout(task, limit);
      return;
    }
    const stoppedAt = stopSentAt.get(taskId);
    if (stoppedAt === undefined) {
      if (now - pickup >= limit) {
        worker.gracefulStop(taskId);
        stopSentAt.set(taskId, now);
      }
      return;
    }
    if (now - stoppedAt >= config.grace) {
      forceSentAt.set(taskId, now);
      containers.forceReclaim(taskId);
      void containers.reclaimed(taskId).then(() => onReclaimed(taskId, limit));
    }
  }

  const cancel = clock.setInterval(tick, WATCHDOG_TICK);
  return {
    stop: cancel,
    heldForContainment: (taskId) => pending === taskId,
    pendingReclaim: () =>
      pending !== null && containers.pendingReclaim(pending)
        ? `the container for task ${pending}`
        : undefined,
    acceptReclaimed: () => {
      if (pending === null) return;
      // 「検査を回答時にもう一度走らせる」— 呼び出し側も先に見ているが、受理の
      // 直前でもう一度読む(1資源1枚の quarantine と同じ posture)
      if (containers.pendingReclaim(pending)) return;
      const taskId = pending;
      pending = null;
      // slot が解放される瞬間に tree rule が走る、の対を閉じる(CONTEXT.md
      // 「Slot-release tree rule」)— 回収 timeout の時点では走らせていない。
      // 完了済み session の後始末なら、通る型は通常完了と同じである(退避ではなく
      // 検査 + merge-back / 休止位置。ADR 0109 決定3)
      void runTeardown(teardown, taskId, teardownStep(db, taskId));
    },
  };
}
