import { spawn as nodeSpawn } from "node:child_process";
import {
  type ContainerRuntime,
  isSpawnFailure,
  type WorkerContainer,
} from "../../src/worker-container.js";

/** **採用されていない候補**(issue #465)。macOS には cgroup v2 が無いので、
 *  `containerRuntimeFor` が darwin に返す fail-closed の unmeasured runtime の
 *  代わりに置ける唯一の POSIX 機構 — process group — をここに書いて contract
 *  suite に測らせる。`src` には入れない: 通ったときにだけ移す(ADR 0099 決定5 の
 *  「証明は contract suite が担う」の順序)。
 *
 *  機構: `detached: true` で spawn した子は新しい process group の leader になり
 *  (pgid = 子の PID)、強制回収は `kill(-pgid, SIGKILL)`、回収済み観測は
 *  「その group に process が1つも居ない」= `kill(-pgid, 0)` が ESRCH を返すこと。
 *  cgroup の `cgroup.events` にあたる kernel からの edge signal は無いので、
 *  観測は poll になる。 */

/** この run で作られた全 group。残骸の検証側読み(canary 4)がここを見る —
 *  cgroup と違って機構は file system に何も残さないので、この機構が数えられる
 *  残骸は「まだ member が居る group」だけである。setsid で group を離脱した
 *  子孫はここからは見えない — canary 3 が落ちた run では `sleep 300` の孫が
 *  host に残るので、suite の後に手で始末すること(#465 の実測記録)。 */
const createdGroups: number[] = [];

/** ESRCH だけが「空」である。EPERM(居るが signal を送れない)や他の errno は
 *  **観測できなかった**であって空ではない(ADR 0099 決定3 の fail-closed 側)。 */
function groupIsEmpty(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return false; // 届いた = まだ member が居る
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** まだ member が居る group。canary 4 の残骸 snapshot 用。 */
export function liveGroups(): number[] {
  return createdGroups.filter((pgid) => !groupIsEmpty(pgid, 0));
}

export const processGroupContainerRuntime: ContainerRuntime = {
  // 前提検査で見られるものが無い: process group は POSIX が常に持っている。
  // cgroup 版が持っていた再起動境界の掃き直し(#463)にあたるものも作れない —
  // 前回の run の pgid はどこにも残らないので、populated な残骸は原理的に
  // 見つけられない。この不在そのものが #465 の測定結果の一部である。
  preflight: () => ({ available: true }),
  create: createProcessGroup,
};

function createProcessGroup(): WorkerContainer {
  const groups: number[] = [];
  let forced = false;
  let live = 0;

  let markEmpty!: () => void;
  const reclaimed = new Promise<void>((resolve) => {
    markEmpty = resolve;
  });

  /** 全 group が空か。force 済みなら同じ syscall で SIGKILL を撃ち直す —
   *  `kill(-pgid)` は呼んだ瞬間の member にしか届かないので、kill の最中に
   *  fork された process はこの撃ち直しでしか捕まらない(force を強めている
   *  のであって、canary の敵対性を弱めてはいない)。 */
  const sweep = (): boolean => {
    const signal = forced ? "SIGKILL" : 0;
    // 早期 return しない: 空でない group が1つあっても、他の group へ SIGKILL は撃つ
    return groups.map((pgid) => groupIsEmpty(pgid, signal)).every(Boolean);
  };

  let armed = false;
  const armEmptyWatch = (): void => {
    if (armed) return;
    armed = true;
    const tick = (): void => {
      if (sweep()) {
        markEmpty();
        return;
      }
      // cgroup 側は inotify なので間隔を持たない。ここは poll しか無い
      setTimeout(tick, 25).unref();
    };
    tick();
  };

  return {
    spawn: (command, args, opts) => {
      // src の `defaultSpawn`(stdio の形と stderr の tee の正本)は `detached` を
      // 受け取らないので、採用されていない候補のためにその口を広げず、ここに写す
      const child = nodeSpawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        // 子自身を新しい process group(かつ新しい session)の leader にする。
        // cgroup 版の wrapper と同じ順序の性質を持つ: 子が作る子孫は最初から
        // 全部この group の中に生まれる(fork は pgid を継ぐ)。
        detached: true,
      });
      child.stderr.pipe(process.stderr);
      if (child.pid !== undefined) {
        groups.push(child.pid); // detached な子は自分が group leader = pgid は自分の PID
        createdGroups.push(child.pid);
      }
      live++;
      let counted = false;
      // cgroup 版と同じ arm の条件: 直の子が終わってから空を観測しにいく。
      const finish = (): void => {
        if (counted) return;
        counted = true;
        if (--live === 0) armEmptyWatch();
      };
      child.on("exit", finish);
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (isSpawnFailure(err)) finish();
      });
      return child;
    },
    forceReclaim: () => {
      forced = true;
      sweep();
      // 空の容器(spawn 前 / 既に全員 exit 済み)への force は、その場が空である
      if (live === 0) armEmptyWatch();
    },
    reclaimed,
  };
}
