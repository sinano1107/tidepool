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

/** 1つの単位(worker session、または Board call 1回)ぶんの容器(CONTEXT.md「容器」)。 */
export interface ProcessContainer {
  /** 容器の中への spawn。その単位に属する process は全部この中で生きる。 */
  spawn: ContainerSpawn;
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
  /** 機構前提検査(ADR 0099 決定5)。boot 時だけでなく pickup と quarantine 回答時
   *  にも読み直される(CONTEXT.md「Containment capability」)。毎回の live kill
   *  canary は行わない — ここで見るのは前提の存在だけである。`live` は supervisor
   *  が今持っている単位の id — 稼働中の容器を前回の run の残骸と読み違えないため。 */
  preflight(live?: ReadonlySet<string>): ContainerRuntimeCapability;
  /** 単位1つぶん(worker session 1つ、または Board call 1回)の容器を作る。 */
  create(id: string): ProcessContainer;
}

/** 盤面側 supervisor(ADR 0099 決定2)。seam ではなく共通 module であり、
 *  「どの単位の容器か」の帳簿と、force / reclaimed の唯一の呼び口を持つ。単位は
 *  worker session と Board call 1回の2つで(ADR 0136 決定10)、帳簿はどちらも同じ
 *  id 空間に並べる —— 機構前提検査へ渡る「今生きている容器」が片方だけになると、
 *  もう片方の稼働中の容器が前回の run の残骸に読み違えられる。
 *  watchdog も tool-surface drift の kill もここを通るので、Harness が増えても
 *  回収は再実装されない。 */
export class ProcessContainers {
  private readonly live = new Map<string, { container: ProcessContainer; forced: boolean }>();

  constructor(private readonly runtime: ContainerRuntime) {}

  preflight(): ContainerRuntimeCapability {
    return this.runtime.preflight(new Set(this.live.keys()));
  }

  /** 盤面が単位ごとに**先に**作る —— worker session なら pickup 時、Board call
   *  なら呼び出しの口が1回ごとに。adapter も口もここで作られた容器の中へ spawn
   *  するだけである。2度目の open は同じ容器を返す — scheduler を通らずに直接
   *  adapter を動かす経路でも器が1つに保たれる。**id は単位をまたいで衝突させない**:
   *  衝突すれば Board call が worker session の容器の中に入る(ADR 0136 決定3 が
   *  置かないと決めた例外そのもの)。 */
  open(id: string): ProcessContainer {
    const existing = this.live.get(id);
    if (existing) return existing.container;
    const container = this.runtime.create(id);
    this.live.set(id, { container, forced: false });
    // 空になった容器は帳簿から消える。通常終了の単位もここを通るので、
    // 残るのは「まだ空になっていない容器」だけになる。
    void container.reclaimed.then(() => this.live.delete(id));
    return container;
  }

  /** 強制回収の唯一の呼び口。知らない id への force は no-op(既に空)。 */
  forceReclaim(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.forced = true;
    entry.container.forceReclaim();
  }

  /** その単位の容器が空になった signal。知らない id は既に空である —
   *  帳簿は in-memory なので、再起動をまたいだ「空」は platform supervisor の
   *  保証(ADR 0099 決定6、Pi では systemd の control-group kill)である。保証が
   *  破れて容器が populated のまま残っていた場合は、boot 時の機構前提検査が
   *  それを見つけて pickup を止める(#463 — 帳簿ではなく容器機構が答える)。 */
  reclaimed(id: string): Promise<void> {
    return this.live.get(id)?.container.reclaimed ?? Promise.resolve();
  }

  /** 強制回収を送ったのに、まだ空を観測できていない容器か。ADR 0109 決定4 で force は
   *  **root process の exit ごとに常態化した**ので、これ単独では回収済み観測の不成立を
   *  意味しない —— 正常に終わった単位も、exit から容器が空になるまでの一瞬ここを
   *  通る。不成立と言えるのは、梯子の底(回収 timeout)まで落ちた id だけをここへ渡す
   *  読み —— worker session なら watchdog の `pending`、Board call なら口の
   *  `unreclaimed` —— であり、Containment quarantine の解除はその両方を読み直す。 */
  pendingReclaim(id: string): boolean {
    return this.live.get(id)?.forced ?? false;
  }
}

/** 実 process を1つ起こす口。容器機構はどれもこれを包むだけなので(cgroup なら
 *  容器へ入る wrapper を被せる)、stdio の形と stderr の tee はここ1箇所にある。 */
/** spawn そのものが失敗した(process が生まれていない)error か。Node は
 *  この場合 "exit" を撃たず "error" だけを撃つので、容器の側はこれを空と数える。 */
export function isSpawnFailure(err: NodeJS.ErrnoException): boolean {
  return err.syscall?.startsWith("spawn") ?? false;
}

export const defaultSpawn: ContainerSpawn = (command, args, opts) => {
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

