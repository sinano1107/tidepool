import type { Clock } from "./clock.js";
import type { ContainedProcess, ProcessContainers, PtyFn, PtyProcess } from "./process-container.js";

/** 1回の Board call の注文(ADR 0136 決定4)。「何を・どの cwd で・どの env で
 *  起こすか」と「時間上限」「結果をいつ返すか」だけを言い、容器・force・観測の
 *  順序は口の中にある。 */
export interface BoardCallSpec {
  /** 呼び出しの種類。回収済み観測が不成立になったときの確認 question から
   *  「原因が worker なのか、どの probe なのか」が読める唯一の手掛かりなので、
   *  人間がその文面で読んで分かる綴りにする(例: "skill enumeration")。 */
  kind: string;
  command: string;
  args: string[];
  cwd: string;
  /** Board call の env(ADR 0044 決定3)。差分ではなく完全形。 */
  env: NodeJS.ProcessEnv;
  /** 時間上限。**省略できない**(ADR 0136 決定4): 上限の無い呼び出しは force を
   *  撃つ契機を持たず、容器に入れても populated のまま残りうる。役は詰まりの検知で
   *  あって通常の遅延を縛ることではない —— 切りすぎた上限は呼び出しを失敗側へ倒す
   *  ので、値は冷えた CLI の起動込みの遅い側に広く取る。 */
  limitMs: number;
  /** 結果を回収済み観測のあとに返すか。既定は root の exit で返す —— 答えの
   *  正しさは残存の有無で変わらない。true にするのは workspace を cwd にする
   *  呼び出しだけで、その workspace で次に起きる worker と残存を同居させない
   *  ために門を1つ手前に置く(ADR 0136 決定5)。 */
  awaitReclaimed?: boolean;
  /** stdin を開けたまま渡すか。既定は閉じる。応答が揃うまで EOF を送れない
   *  呼び出し(App Server、#706)だけが opt-in する。 */
  stdin?: "pipe";
}

/** pty で起こす呼び出し(usage TUI、ADR 0136 決定8)。pty を起こすのは `launch` で、
 *  容器はその command に入り方を被せる。`read` は `PtyProcess` を受け取る。 */
export interface PtyBoardCallSpec extends BoardCallSpec {
  pty: { launch: PtyFn; cols: number; rows: number };
}

/** 呼び出し1回。`read` は spawn 直後に呼ばれ、「今までに観測した答え」を返す
 *  関数を渡す —— 口はそれを root の exit のあとに1度だけ、その exit code を添えて
 *  呼ぶ。答えの形(stream か1つの文字列か)は呼び出し側の話なので口は知らない。
 *
 *  `read` の2つ目の引数 `done` は「呼び手はもう終わった —— 今 force を撃て」で、
 *  root の exit と同じく読み手の答えで決着する(exit code は null —— pty の exit も同じ)。root が合図に
 *  応じないときの teardown の底である(ADR 0136 決定8)。
 *
 *  null は fail-closed の結果である: 機構前提の不成立・上限到達・spawn 失敗・
 *  回収済み観測を待つ呼び出しでの回収 timeout のどれでも、呼び出し側は今日と
 *  同じ「観測できなかった / 失敗」を受け取る(ADR 0136 決定7)。 */
export interface BoardCall {
  // pty を先に置く: overload は上から選ばれ、PtyBoardCallSpec は BoardCallSpec にも当てはまる
  <T>(
    spec: PtyBoardCallSpec,
    read: (proc: PtyProcess, done: () => void) => (exitCode: number | null) => T | null,
  ): Promise<T | null>;
  <T>(
    spec: BoardCallSpec,
    read: (proc: ContainedProcess, done: () => void) => (exitCode: number | null) => T | null,
  ): Promise<T | null>;
}

/** 1回の呼び出しの出力。stdout / stderr を1つの文字列として読み切る呼び出し
 *  (答えを取りに行く呼び出しと、答えの JSON を読む probe)が共有する読み手の形。 */
export interface CallOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** `read` の実装の1つ: stdout / stderr を全部ためて、exit code と一緒に返す。
 *  utf8 で decode するのは chunk 境界で多バイト文字が割れないため(翻訳の答えは日本語)。 */
export function readOutput(proc: ContainedProcess): (exitCode: number | null) => CallOutput {
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return (exitCode) => ({ exitCode, stdout, stderr });
}

/** 口そのもの。`pendingReclaim` は Containment quarantine の回答受理側
 *  (human-verbs)が読む門で、watchdog のものと並べて合成される —— 未回収の容器は
 *  worker session のものだけとは限らない。受理側の `acceptReclaimed` は持たない:
 *  解放するものを持つのは slot を握る worker session だけである。 */
export interface BoardCalls {
  call: BoardCall;
  /** まだ空を観測できていない Board call の容器を名乗る一句、無ければ undefined。 */
  pendingReclaim: () => string | undefined;
}

/** 容器 id の頭。**task id と衝突させない**: `ProcessContainers.open` は既知の
 *  id に既存の容器を返すので、task id で開けば probe が worker の容器の中に入る
 *  —— ADR 0136 決定3 が置かないと決めた例外そのものになる。 */
const BOARD_CALL_PREFIX = "board-call-";

export function createBoardCalls(deps: {
  containers: ProcessContainers;
  clock: Clock;
  /** 強制回収から回収済み観測までの上限。watchdog と同じ既定を使う(ADR 0136)。 */
  reclaimTimeout: number;
  /** 回収済み観測の不成立を盤面へ返す口。配線先は Containment quarantine で、
   *  worker session の回収失敗と同じ経路である(新しい quarantine 族は立てない
   *  —— ADR 0136 決定6)。 */
  onReclaimTimeout: (reason: string) => void;
}): BoardCalls {
  let counter = 0;
  /** 回収 timeout まで空を観測できなかった容器 id → 呼び出しの種類。 */
  const unreclaimed = new Map<string, string>();

  const subject = (kind: string): string => `the container for the ${kind} Board call`;

  /** 強制回収を撃ったあと、空の観測を回収 timeout まで待つ。true = 空を観測した。
   *  **副作用を持たない**: 報告は下の `report` が別に撃つ —— 報告が投げたときに
   *  口の契約(null = fail-closed)まで一緒に壊れないためである。 */
  async function awaitEmpty(id: string): Promise<boolean> {
    let cancel!: () => void;
    const observed = await Promise.race([
      deps.containers.reclaimed(id).then(() => true),
      new Promise<boolean>((resolve) => {
        cancel = deps.clock.setInterval(() => {
          cancel();
          resolve(false);
        }, deps.reclaimTimeout);
      }),
    ]);
    cancel();
    return observed;
  }

  /** 空を観測できなかったことの報告。結果の promise とは別に撃つので、
   *  `onReclaimTimeout` が投げたときの上がり方は結果の待ち方(既定 / 回収済み観測)に
   *  依らず同じ —— watchdog の tick(`watchdog.ts` の `onReclaimTimeout`)と同じく
   *  盤面へ上がる。ここで握り潰すと Containment quarantine の失敗が黙って消える。 */
  function report(id: string, kind: string): void {
    unreclaimed.set(id, kind);
    deps.onReclaimTimeout(
      `${subject(kind)} was force-reclaimed but never observed empty, so processes from ` +
        "that call may still be running against this host and its workspaces (ADR 0136)",
    );
  }

  const call = async <T>(
    spec: BoardCallSpec & Partial<PtyBoardCallSpec>,
    read: (proc: ContainedProcess & PtyProcess, done: () => void) => (exitCode: number | null) => T | null,
  ): Promise<T | null> => {
    // ADR 0136 決定7: 機構前提が不成立の platform では Board call を起こさない。
    // 容器なしで起こすのは ADR 0099 決定5 が禁じた「黙って弱い回収へ落ちる」形である。
    if (!deps.containers.preflight().available) return null;
    const id = BOARD_CALL_PREFIX + ++counter;
    const container = deps.containers.open(id);

    const finish = await new Promise<() => T | null>((resolve) => {
      let settled = false;
      let cancelLimit: () => void = () => {};
      const settle = (value: () => T | null): void => {
        if (settled) return;
        settled = true;
        cancelLimit();
        resolve(value);
      };
      // 時間上限。`Clock` は `setTimeout` を持たないので、1度撃って自分で止める
      // interval で数える(注入された時計で数えることが要点 —— 実時間で数えると
      // FakeClock の前進で上限が発火しない)。spawn より先に張る —— あとで張ると、
      // 先に settle した呼び出しが止められない interval を残す。
      cancelLimit = deps.clock.setInterval(() => settle(() => null), spec.limitMs);
      let observed!: (exitCode: number | null) => T | null;
      const done = (): void => settle(() => observed(null));
      // spawn の throw だけを「何も生まれていない」と読む —— 読み手の throw まで null に畳まない
      // process が1つも生まれていない(ENOENT / PATH の誤り / pty が立たない)= 容器は空
      if (spec.pty) {
        const { launch, cols, rows } = spec.pty;
        let proc: PtyProcess;
        try {
          proc = container.spawnPty(launch, spec.command, spec.args, { cwd: spec.cwd, env: spec.env, cols, rows });
        } catch {
          settle(() => null);
          return;
        }
        observed = read(proc as ContainedProcess & PtyProcess, done);
        // pty の root の exit も stream と同じく force の契機(ADR 0109 決定4)
        proc.onExit(done);
        return;
      }
      let proc: ContainedProcess;
      try {
        proc = container.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdin: spec.stdin });
      } catch {
        settle(() => null);
        return;
      }
      observed = read(proc as ContainedProcess & PtyProcess, done);
      // ADR 0109 決定4 の形: root の exit は容器が空になった証拠ではないが、
      // 残っているものが孤児である証拠ではある。行儀のよい exit は待たない。
      proc.on("exit", (code) => settle(() => observed(code)));
      proc.on("error", () => settle(() => null));
    });

    // 2つ目の force の契機(上限到達)も1つ目(root の exit)も、ここ1箇所を通る。
    deps.containers.forceReclaim(id);
    const empty = awaitEmpty(id);
    void empty.then((observed) => {
      if (!observed) report(id, spec.kind);
    });
    if (!spec.awaitReclaimed) return finish();
    return (await empty) ? finish() : null;
  };

  return {
    // 実装は2つの overload の和で1本 —— process の型の出し分けは spec.pty の有無だけ
    call: call as BoardCall,
    // 容器の側を毎回読み直す(watchdog と同じ posture): 遅れて空になった容器は
    // もう保留ではないので、その場で帳簿から落とす。
    pendingReclaim: () => {
      for (const [id, kind] of unreclaimed) {
        if (deps.containers.pendingReclaim(id)) return subject(kind);
        unreclaimed.delete(id);
      }
      return undefined;
    },
  };
}
