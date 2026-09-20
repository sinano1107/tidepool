import type { Clock } from "./clock.js";
import type { ContainedProcess, ProcessContainers } from "./process-container.js";
import type { PendingReclaim } from "./watchdog.js";

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
   *  撃つ契機を持たず、容器に入れても populated のまま残りうる。 */
  limitMs: number;
  /** 結果を回収済み観測のあとに返すか。既定は root の exit で返す —— 答えの
   *  正しさは残存の有無で変わらない。true にするのは workspace を cwd にする
   *  呼び出しだけで、その workspace で次に起きる worker と残存を同居させない
   *  ために門を1つ手前に置く(ADR 0136 決定5)。 */
  awaitReclaimed?: boolean;
}

/** 呼び出し1回。`read` は spawn 直後に呼ばれ、「今までに観測した答え」を返す
 *  関数を渡す —— 口はそれを root の exit のあとに1度だけ呼ぶ。答えの形(stream か
 *  1つの文字列か)は呼び出し側の話なので口は知らない。
 *
 *  null は fail-closed の結果である: 機構前提の不成立・上限到達・spawn 失敗・
 *  回収済み観測を待つ呼び出しでの回収 timeout のどれでも、呼び出し側は今日と
 *  同じ「観測できなかった / 失敗」を受け取る(ADR 0136 決定7)。 */
export type BoardCall = <T>(
  spec: BoardCallSpec,
  read: (proc: ContainedProcess) => () => T | null,
) => Promise<T | null>;

/** 口そのもの。`PendingReclaim` は Containment quarantine の回答受理側(human-verbs)
 *  が読む門で、watchdog のものと同じ形で並ぶ —— 未回収の容器は worker session の
 *  ものだけとは限らない。 */
export interface BoardCalls extends PendingReclaim {
  call: BoardCall;
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

  const subject = (kind: string): string => `the container for the ${kind} board call`;

  /** 強制回収を撃ったあと、空の観測を回収 timeout まで待つ。true = 空を観測した。 */
  async function awaitEmpty(id: string, kind: string): Promise<boolean> {
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
    if (!observed) {
      unreclaimed.set(id, kind);
      deps.onReclaimTimeout(
        `${subject(kind)} was force-reclaimed but never observed empty, so processes from ` +
          "that call may still be running against this host and its workspaces (ADR 0136)",
      );
    }
    return observed;
  }

  const call: BoardCall = async <T>(
    spec: BoardCallSpec,
    read: (proc: ContainedProcess) => () => T | null,
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
      let proc: ContainedProcess;
      try {
        proc = container.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
      } catch {
        // process が1つも生まれていない(ENOENT / PATH の誤り)= 容器は空
        settle(() => null);
        return;
      }
      const observed = read(proc);
      // ADR 0109 決定4 の形: root の exit は容器が空になった証拠ではないが、
      // 残っているものが孤児である証拠ではある。行儀のよい exit は待たない。
      proc.on("exit", () => settle(observed));
      proc.on("error", () => settle(() => null));
      // 時間上限。`Clock` は `setTimeout` を持たないので、1度撃って自分で止める
      // interval で数える(注入された時計で数えることが要点 —— 実時間で数えると
      // FakeClock の前進で上限が発火しない)。
      cancelLimit = deps.clock.setInterval(() => settle(() => null), spec.limitMs);
    });

    // 2つ目の force の契機(上限到達)も1つ目(root の exit)も、ここ1箇所を通る。
    deps.containers.forceReclaim(id);
    const empty = awaitEmpty(id, spec.kind);
    if (!spec.awaitReclaimed) return finish();
    return (await empty) ? finish() : null;
  };

  return {
    call,
    // 容器の側を毎回読み直す(watchdog と同じ posture): 遅れて空になった容器は
    // もう保留ではない。
    pendingReclaim: () => {
      for (const [id, kind] of unreclaimed) {
        if (deps.containers.pendingReclaim(id)) return subject(kind);
      }
      return undefined;
    },
    acceptReclaimed: () => {
      for (const id of [...unreclaimed.keys()]) {
        if (!deps.containers.pendingReclaim(id)) unreclaimed.delete(id);
      }
    },
  };
}
