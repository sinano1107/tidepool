import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ContainerRuntime,
  type ContainerRuntimeCapability,
  defaultSpawn,
  type WorkerContainer,
} from "./worker-container.js";

/** cgroupfs の読み書き先。既定は実カーネルの2つのパスで、テストは temp dir を
 *  渡して外部挙動だけを観測する(実カーネルの証明は #464 の Pi canary が担う —
 *  開発機は macOS なので、ここを実物に固定すると機構が一行も測れない)。 */
export interface CgroupPaths {
  /** cgroup v2 の mount point。 */
  mount: string;
  /** 自分がどの cgroup に居るかを答えるファイル(`/proc/self/cgroup` の形)。 */
  selfCgroup: string;
}

const DEFAULT_PATHS: CgroupPaths = { mount: "/sys/fs/cgroup", selfCgroup: "/proc/self/cgroup" };

/** このホストの worker をどの容器機構で封じるか(ADR 0099 決定2/5)。platform の
 *  判定は `checkSandboxCapability` と同じ層に立つ — 実測した機構を持たない
 *  platform は黙って弱い回収へ落ちず、preflight が不成立を返して pickup を止める。 */
export function containerRuntimeFor(
  platform: NodeJS.Platform,
  paths: CgroupPaths = DEFAULT_PATHS,
): ContainerRuntime {
  if (platform === "linux") return cgroupContainerRuntime(paths);
  return unmeasuredContainerRuntime(platform);
}

/** 実測した容器機構が無い platform の fail-closed な機構。preflight が pickup を
 *  止めるので `create` は呼ばれない — 呼ばれたなら配線が壊れている。 */
function unmeasuredContainerRuntime(platform: NodeJS.Platform): ContainerRuntime {
  const capability: ContainerRuntimeCapability = {
    available: false,
    reason:
      `no worker container mechanism has been measured on platform "${platform}" — ` +
      "worker pickup stays stopped here until one is (issue #465)",
  };
  return {
    preflight: () => capability,
    create: () => {
      throw new Error(`no worker container mechanism on platform "${platform}"`);
    },
  };
}

/** 容器の cgroup ディレクトリ名の頭。前提検査の残骸掃除がこの頭で自分の作った
 *  ものだけを見分けるので、盤面の cgroup を他と共有していても掃除は自分の分に
 *  留まる。 */
const CONTAINER_PREFIX = "worker-";

const unavailable = (reason: string): ContainerRuntimeCapability => ({ available: false, reason });

/** 盤面自身が居る cgroup のディレクトリ。cgroup v2 の統一階層は
 *  `/proc/self/cgroup` の `0::` 行1本で表される(v1 / hybrid にはこの行が無い)。 */
function ownCgroup(paths: CgroupPaths): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(paths.selfCgroup, "utf8");
  } catch {
    return undefined;
  }
  const line = raw.split("\n").find((l) => l.startsWith("0::"));
  return line === undefined ? undefined : join(paths.mount, line.slice(3).trim());
}

/** 容器が**空である**ことの観測。読めなければ「空ではない」— 観測できなかった
 *  ことを空と数えない(ADR 0099 決定3)。 */
function isEmpty(dir: string): boolean {
  try {
    return /^populated 0$/m.test(readFileSync(join(dir, "cgroup.events"), "utf8"));
  } catch {
    return false;
  }
}

/** Linux の容器機構: worker session ごとの cgroup v2。controller は1つも有効化
 *  しない — 要るのは core の `cgroup.kill` と `cgroup.events` だけで、有効化すると
 *  cgroup v2 の "no internal processes" 規則が盤面自身の process を締め出す。 */
function cgroupContainerRuntime(paths: CgroupPaths): ContainerRuntime {
  return {
    preflight(): ContainerRuntimeCapability {
      if (!existsSync(join(paths.mount, "cgroup.controllers"))) {
        return unavailable(
          `cgroup v2 is not mounted at ${paths.mount} (no cgroup.controllers there) — ` +
            "the worker container mechanism needs the unified cgroup v2 hierarchy",
        );
      }
      const own = ownCgroup(paths);
      if (own === undefined) {
        return unavailable(
          `the board's own cgroup could not be read from ${paths.selfCgroup} (no "0::" line) — ` +
            "the board must run under a cgroup v2 hierarchy, not a v1 or hybrid one",
        );
      }
      // 再起動境界(#463): 帳簿は in-memory なので、前回の run の容器が populated の
      // まま残っていたら「回収済み観測の不成立」が再起動をまたいで残っている。空の
      // 残骸は掃除して進み、populated な残骸は pickup を止める(fail-closed)。
      for (const dir of leftoverContainers(own)) {
        if (!isEmpty(dir)) {
          return unavailable(
            `a worker container from a previous run of the board is still populated: ${dir} — ` +
              "its processes were never reclaimed and would share this host with the next worker. " +
              `Kill what is left in it (echo 1 > ${dir}/cgroup.kill), then start the board again`,
          );
        }
        try {
          rmdirSync(dir);
        } catch {
          // 空の容器が消せないのは掃除の失敗であって封じ込めの失敗ではない
        }
      }
      const probe = join(own, `${CONTAINER_PREFIX}preflight`);
      try {
        mkdirSync(probe);
        rmdirSync(probe);
      } catch (err) {
        return unavailable(
          `the board cannot create worker containers under its own cgroup ${own} ` +
            `(${(err as Error).message}) — run the board under a systemd unit with ` +
            "Delegate=yes so that the cgroup subtree belongs to it",
        );
      }
      return { available: true };
    },
    create: (sessionId) => createCgroup(paths, sessionId),
  };
}

/** 容器へ入ってから exec する wrapper。`$0` が容器の `cgroup.procs`、`$@` が
 *  本来の command と引数である(`sh -c script name args...` の POSIX の形)。
 *
 *  **順序が要点**: spawn したあとに親が子の PID を移すのでは、子が移される前に
 *  fork した孫が容器の外に残る。自分自身を入れてから exec すれば、その process が
 *  作る子孫は最初から全部容器の中に生まれる。引数配列で渡すので shell を経由した
 *  文字列結合は無く、command も引数も引用の必要が無い。 */
const ENTER_AND_EXEC = 'echo $$ > "$0" && exec "$@"';

function createCgroup(paths: CgroupPaths, sessionId: string): WorkerContainer {
  const own = ownCgroup(paths);
  // preflight が成立していれば起こらない(不成立なら pickup が止まっている)
  if (own === undefined) throw new Error(`cannot read the board's own cgroup from ${paths.selfCgroup}`);
  const dir = join(own, CONTAINER_PREFIX + sessionId);
  mkdirSync(dir, { recursive: true });

  let markEmpty!: () => void;
  const reclaimed = new Promise<void>((resolve) => {
    markEmpty = () => {
      resolve();
      try {
        rmdirSync(dir); // 空の容器は残さない(populated 0 なら rmdir できる)
      } catch {
        // 消せなくても封じ込めは終わっている。次の boot の前提検査が掃き直す。
      }
    };
  });

  /** 空の観測を張る。`cgroup.events` の変更 signal(cgroupfs は populated が
   *  変わると inotify を撃つ)+ 張った直後の1回読みで、**一回限りの process scan を
   *  使わない**(ADR 0099 決定3)。監視を張れなければ空は観測できないまま —
   *  reclaimed は未解決で回収 timeout へ落ち、Containment quarantine が門になる。 */
  let armed = false;
  const armEmptyWatch = (): void => {
    if (armed) return;
    armed = true;
    try {
      const watcher = watch(join(dir, "cgroup.events"), () => {
        if (!isEmpty(dir)) return;
        watcher.close();
        markEmpty();
      });
      // 監視を張ってから読む — 張る前に空になっていた場合をこの初回読みが拾う
      if (isEmpty(dir)) {
        watcher.close();
        markEmpty();
      }
    } catch {
      // 監視が張れない = 空を観測できない(fail-closed の側)
    }
  };

  let live = 0;
  return {
    spawn: (command, args, opts) => {
      const child = defaultSpawn("/bin/sh", ["-c", ENTER_AND_EXEC, join(dir, "cgroup.procs"), command, ...args], opts);
      live++;
      let counted = false;
      // 直の子が終わるまで待ってから空を観測しにいく: wrapper は容器へ入ってから
      // exec するので、子の exit の時点で容器に残っているのは子孫だけであり、
      // そこで読んだ populated 0 は本当の空である(空の cgroup は自分を再び埋め
      // られない)。生まれたての容器を spawn 前に読むと、まだ誰も入っていない
      // ことを「回収済み」と読み違える。
      const finish = (): void => {
        if (counted) return;
        counted = true;
        if (--live === 0) armEmptyWatch();
      };
      child.on("exit", finish);
      // spawn そのものが失敗した process は生まれていない = 容器は空
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.syscall?.startsWith("spawn")) finish();
      });
      return child;
    },
    forceReclaim: () => {
      try {
        writeFileSync(join(dir, "cgroup.kill"), "1");
      } catch {
        // 既に消えた容器への force は no-op(空の観測が先に届いている)
      }
      // 空の容器(spawn 前 / 既に全員 exit 済み)への force は、その場が空である。
      // 生きている子が居るなら読みにいかない — wrapper が容器へ入る前の
      // populated 0 を空と読むのは、送達を回収と数えることそのものだからである。
      //
      // ponytail: その window に force が届いた process は kill をすり抜けるが、
      // すり抜けた側は exit しないので空も観測されず、回収 timeout → Containment
      // quarantine に落ちる(fail-closed)。塞ぐには入場の完了を待つ同期が要り、
      // force は pickup から数十分後なのでこの窓は実質空である。
      if (live === 0) armEmptyWatch();
    },
    reclaimed,
  };
}

function leftoverContainers(own: string): string[] {
  try {
    return readdirSync(own, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(CONTAINER_PREFIX))
      .map((e) => join(own, e.name));
  } catch {
    return []; // 自分の cgroup が読めないことは下の mkdir 検査が答える
  }
}
