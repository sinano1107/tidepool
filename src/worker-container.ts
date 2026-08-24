import { spawn as nodeSpawn } from "node:child_process";
import type { SandboxCapability } from "./sandbox.js";

/** 容器の中で走る1つの process の口。`ContainerSpawn` が返すもので、adapter が
 *  stream と exit を読むために要る全部である(それ以外は容器の側の話)。 */
export interface ContainedProcess {
  stdout: NodeJS.ReadableStream;
  /** issue #125: the CLI's own failure channel (spawn-time errors, auth
   *  errors, forced terminations print here, not to stream-json) — captured so
   *  a failure always leaves evidence, alongside the stdout transcript. */
  stderr: NodeJS.ReadableStream;
  /** 畳み込み停止の合図の送達先。合図の選択は adapter の実装詳細であり
   *  (ADR 0099 決定1)、容器はどの signal かを知らない。 */
  kill(signal: NodeJS.Signals): void;
  /** issue #32: the adapter's own exit observation point — usage/cost
   *  recording needs to happen at the process boundary, not buried in a fake. */
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** issue #127: the adapter's own spawn-failure observation point — a spawn()
   *  that never produces a process (ENOENT/EACCES/PATH misconfig) fires this
   *  instead of "exit". Node's ChildProcess satisfies this structurally. */
  on(event: "error", listener: (err: Error) => void): void;
}

/** The process boundary the adapter is tested at: everything vendor-specific
 *  (the claude CLI, its flags) flows through this one call. */
export type ContainerSpawn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => ContainedProcess;

/** 機構前提検査の答え。封じ込めの fs 半分と同じ形を使う(containment.ts が
 *  `ContainmentCapability` でそうしているのと同じ理由 — 「何が足りないか」は
 *  reason の文面が担うのであって、型ではない)。 */
export type ContainerRuntimeCapability = SandboxCapability;

/** 1つの worker session ぶんの容器(CONTEXT.md「Worker 容器」)。 */
export interface WorkerContainer {
  /** 容器の中への spawn。session に属する process は全部この中で生きる。 */
  spawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ContainedProcess;
  /** 強制回収(force reclaim): 容器ごと全 process を終了させる操作。**送達で
   *  あって回収の完了ではない** — 完了は `reclaimed` だけが言う。 */
  forceReclaim(): void;
  /** 回収済み観測(reclaimed): 容器が**空になった signal**。一回限りの process
   *  scan は観測に数えない(TOCTOU)ので、点の検査ではなくこの Promise が唯一の
   *  観測口である。容器は空になったら二度と populated に戻らない(盤面は回収済み
   *  の容器へ spawn しない)ので、単調な signal で表せる。 */
  readonly reclaimed: Promise<void>;
}

/** 容器機構(container runtime)— ADR 0099 決定2 が立てる唯一の新しい seam。
 *  platform ごとに実装が違ってよい(cgroup v2 / process group)が、force と
 *  reclaimed の意味はここで1度だけ書かれる。 */
export interface ContainerRuntime {
  /** boot 時の機構前提検査(ADR 0099 決定5)。毎 boot の live kill canary は
   *  行わない — ここで見るのは前提の存在だけである。 */
  preflight(): ContainerRuntimeCapability;
  /** worker session 1つぶんの容器を作る。 */
  create(sessionId: string): WorkerContainer;
}

/** 盤面側 supervisor(ADR 0099 決定2)。seam ではなく共通 module であり、
 *  「どの session の容器か」の帳簿と、force / reclaimed の唯一の呼び口を持つ。
 *  watchdog も tool-surface drift の kill もここを通るので、Harness が増えても
 *  回収は再実装されない。 */
export class WorkerContainers {
  private readonly live = new Map<string, { container: WorkerContainer; forced: boolean }>();

  constructor(private readonly runtime: ContainerRuntime) {}

  preflight(): ContainerRuntimeCapability {
    return this.runtime.preflight();
  }

  /** 盤面が worker session ごとに**先に**作る(pickup 時)。adapter はここで
   *  作られた容器の中へ spawn するだけである。2度目の open は同じ容器を返す —
   *  scheduler を通らずに直接 adapter を動かす経路でも器が1つに保たれる。 */
  open(sessionId: string): WorkerContainer {
    const existing = this.live.get(sessionId);
    if (existing) return existing.container;
    const container = this.runtime.create(sessionId);
    this.live.set(sessionId, { container, forced: false });
    // 空になった容器は帳簿から消える。通常終了の session もここを通るので、
    // 残るのは「まだ空になっていない容器」だけになる。
    void container.reclaimed.then(() => this.live.delete(sessionId));
    return container;
  }

  /** 強制回収の唯一の呼び口。知らない session への force は no-op(既に空)。 */
  forceReclaim(sessionId: string): void {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    entry.forced = true;
    entry.container.forceReclaim();
  }

  /** その session の容器が空になった signal。知らない session は既に空である。 */
  reclaimed(sessionId: string): Promise<void> {
    return this.live.get(sessionId)?.container.reclaimed ?? Promise.resolve();
  }

  /** force を送ったのに空をまだ観測できていない容器。**回収済み観測の不成立**
   *  そのものであり、Containment quarantine の解除がここを読み直す。 */
  pendingReclaims(): string[] {
    return [...this.live].filter(([, entry]) => entry.forced).map(([sessionId]) => sessionId);
  }
}

const defaultSpawn: ContainerSpawn = (command, args, opts) => {
  const child = nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stderr は捕捉のため pipe に変えた(issue #125)が、従来 "inherit" で
  // 運用者がリアルタイムに見ていた可視性はこの tee で維持する(pipe は
  // process.stderr を close しない — Node の readable.pipe の仕様)
  child.stderr.pipe(process.stderr);
  return child;
};

/** 今日の既定の容器機構: 容器 = CLI root process 1本。force は root への
 *  SIGKILL、空の観測は root の exit である。
 *
 *  ponytail: 子孫 process は封じ込めない(root だけ)。これは #195 が見つけた穴
 *  そのものだが、**送達を回収と数えない**という ADR 0099 決定3 の形はここで既に
 *  成立している — 実機構(Linux: cgroup v2、macOS: process group)への差し替えは
 *  #463 で、この seam の裏だけが変わる。 */
export function passthroughContainerRuntime(spawn: ContainerSpawn = defaultSpawn): ContainerRuntime {
  return {
    preflight: () => ({ available: true }),
    create: () => {
      let child: ContainedProcess | null = null;
      let markEmpty!: () => void;
      const reclaimed = new Promise<void>((resolve) => {
        markEmpty = resolve;
      });
      return {
        spawn: (command, args, opts) => {
          child = spawn(command, args, opts);
          child.on("exit", () => markEmpty());
          // spawn そのものが失敗した process は生まれていない = 容器は空
          child.on("error", (err: NodeJS.ErrnoException) => {
            if (err.syscall?.startsWith("spawn")) markEmpty();
          });
          return child;
        },
        forceReclaim: () => {
          // 空の容器(spawn 前 / 既に exit 済み)への force は、その場で空である
          if (!child) markEmpty();
          else child.kill("SIGKILL");
        },
        reclaimed,
      };
    },
  };
}
