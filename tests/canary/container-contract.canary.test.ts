import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { containerRuntimeFor } from "../../src/cgroup-container.js";
import {
  type ContainedProcess,
  type ContainerRuntime,
  type WorkerContainer,
  WorkerContainers,
} from "../../src/worker-container.js";
import { liveGroups, processGroupContainerRuntime } from "./process-group-container.js";

/** Worker 容器の contract suite(ADR 0099 決定5 / issue #464)。実カーネルの
 *  容器機構の上で、**公開 seam だけ**を通して敵対的子孫を回収する:
 *  `WorkerContainers` の `open` / `spawn` / `forceReclaim` / `reclaimed` /
 *  `preflight`。内部関数は import しない。
 *
 *  `npm test` の対象外(ADR 0027 の線 — 実 process を起こし、delegated な cgroup
 *  を要る)。`npm run canary:container` が唯一の実行契機で、機構ごとに一度と
 *  CLI / OS の更新時に走らせる。
 *
 *  測る機構は `TIDEPOOL_CANARY_RUNTIME` が選ぶ(既定 `cgroup` = src の Linux 実装)。
 *  issue #465 の macOS 測定は `process-group` を差す — 候補は `src` ではなく
 *  `./process-group-container.ts` に居る。**canary の assert は機構によらず同じ**で、
 *  機構ごとに差し替わるのは検証側が読む kernel の面だけである(macOS には `/proc` が
 *  無いので `ps` を読む)。
 *
 *  **PID を数えるのは検証側だけである**。敵対的 process には自分の PID を
 *  `$CANARY_PIDS` へ書かせ、回収後に1つも残っていないことをここで assert する。
 *  容器機構の側は PID を1つも見ない(一回限りの process scan は回収済み観測に
 *  数えない — ADR 0099 決定3)。 */

/** 測る機構と、その機構を測るために検証側が読む面。 */
interface CanaryProbe {
  /** この機構を測れる platform。他の platform では `beforeAll` が fail する。 */
  platform: NodeJS.Platform;
  runtime: ContainerRuntime;
  alive(pid: number): boolean;
  /** その process が runner とは別の session に居ること(setsid が本当に効いたこと)。 */
  escapedSession(pid: number): boolean;
  /** session を分けた孫を1つ起こす shell 断片。 */
  daemonScript: string;
  /** 前の run / 前の canary が残した残骸。`beforeAll` の snapshot と比較する。 */
  residue(): string[];
}

/** 盤面自身が居る cgroup。検証側の読みであって、容器機構の内部を import して
 *  いるわけではない(`/proc/self/cgroup` の `0::` 行という kernel の面を読む)。 */
function boardCgroup(): string {
  const line = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((l) => l.startsWith("0::"));
  if (line === undefined) throw new Error("this host has no cgroup v2 unified hierarchy");
  return join("/sys/fs/cgroup", line.slice(3).trim());
}

/** `/proc/<pid>/stat` の session id(6番目のフィールド)。`comm` は括弧の中に
 *  空白を含みうるので、最後の `)` から後ろだけを割る。 */
function sessionOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3] ?? "";
}

/** macOS の `ps` から1列を読む。該当 PID が居なければ `ps` は 1 で終わるので、
 *  空文字が「もう居ない」の答えである。 */
function psField(pid: number, keyword: string): string {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", `${keyword}=`], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

const probes: Record<string, CanaryProbe> = {
  /** Linux: cgroup v2(`src/cgroup-container.ts`、#464 で Pi 実測済み)。 */
  cgroup: {
    platform: "linux",
    runtime: containerRuntimeFor(process.platform),
    alive: (pid) => existsSync(`/proc/${pid}`),
    escapedSession: (pid) => sessionOf(pid) !== sessionOf(process.pid),
    daemonScript: `setsid /bin/sh -c 'echo $$ >> "$CANARY_PIDS"; exec sleep 300' </dev/null >/dev/null 2>&1 &`,
    residue: () => readdirSync(boardCgroup()),
  },
  /** macOS: process group の候補(issue #465、採用されていない)。 */
  "process-group": {
    platform: "darwin",
    runtime: processGroupContainerRuntime(),
    alive: (pid) => psField(pid, "pid") !== "",
    // macOS の `ps` には session id の列が無い(`sess` は tty 以外では 0)。代わりに
    // STAT の flag を読む: 先頭1文字が状態、以降が flag で、`s` は session leader。
    // session leader は sid = 自分の PID なので、後から生まれた孫が leader である
    // ことは runner とは別 session であることの証明になる。
    escapedSession: (pid) => psField(pid, "stat").slice(1).includes("s"),
    // macOS に `setsid(1)` は無いので、同じ syscall を perl から呼ぶ。孫は
    // 自分の PID を記録してから `sleep 300` へ exec する(linux 側と同じ形)。
    daemonScript: `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; open(my $f, ">>", $ENV{CANARY_PIDS}) or die "open: $!"; print $f "$$\\n"; close $f; exec "sleep", "300"' </dev/null >/dev/null 2>&1 &`,
    // 機構は file system に何も残さないので、残骸は「まだ member が居る group」だけ。
    residue: () => liveGroups().map(String),
  },
};

const probeName = process.env.TIDEPOOL_CANARY_RUNTIME ?? "cgroup";
const probe = probes[probeName];
if (probe === undefined) {
  throw new Error(
    `unknown TIDEPOOL_CANARY_RUNTIME "${probeName}" — known mechanisms: ${Object.keys(probes).join(", ")}`,
  );
}

const containers = new WorkerContainers(probe.runtime);

let residueAtStart: string[] = [];

beforeAll(() => {
  // 前提が無いホストでは skip ではなく fail させる: 黙って緑になれば、この suite は
  // 「敵対的子孫を実カーネルで測った」という主張を空手形で出すことになる。
  if (process.platform !== probe.platform) {
    throw new Error(
      `the "${probeName}" worker container mechanism is measured on ${probe.platform} only ` +
        `(this host is "${process.platform}")`,
    );
  }
  const capability = containers.preflight();
  if (!capability.available) {
    throw new Error(
      `this host cannot hold worker containers, so nothing here would be measured: ${capability.reason}`,
    );
  }
  residueAtStart = probe.residue();
});

/** 敵対的 process の作業ディレクトリと PID の書き出し先。 */
let work: string;
let pidsFile: string;

/** afterEach で必ず force する — canary が途中で落ちても、稼働し続ける敵対的
 *  process をホストに残さない。 */
const opened: string[] = [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "tidepool-container-canary-"));
  pidsFile = join(work, "pids");
  writeFileSync(pidsFile, "");
});

afterEach(async () => {
  const ids = opened.splice(0);
  for (const id of ids) containers.forceReclaim(id);
  await Promise.all(ids.map((id) => containers.reclaimed(id)));
  rmSync(work, { recursive: true, force: true });
});

function open(sessionId: string): WorkerContainer {
  opened.push(sessionId);
  return containers.open(sessionId);
}

/** 敵対的 process を容器の中へ1つ起こす。script は `$CANARY_PIDS` に自分の PID を
 *  追記する(`>>` は O_APPEND なので、孫が同時に書いても行は混ざらない)。 */
function hostile(container: WorkerContainer, script: string): ContainedProcess {
  return container.spawn("/bin/sh", ["-c", script], {
    cwd: work,
    env: { ...process.env, CANARY_PIDS: pidsFile },
  });
}

const recordedPids = (): number[] =>
  readFileSync(pidsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number);

const alive = (pid: number): boolean => probe.alive(pid);

/** 回収済み観測が**今この瞬間に**立っているか。force の送達より先に空が
 *  観測されないこと(= 送達を回収と数えていないこと)を測るために要る。 */
function emptyObserved(container: WorkerContainer): () => boolean {
  let observed = false;
  void container.reclaimed.then(() => {
    observed = true;
  });
  return () => observed;
}

it("畳み込み停止を無視する子は、強制回収でだけ容器から居なくなる", async () => {
  const container = open("graceful-deaf");
  const child = hostile(
    container,
    `trap '' TERM INT
echo $$ >> "$CANARY_PIDS"
while :; do sleep 1; done`,
  );
  const empty = emptyObserved(container);
  await vi.waitFor(() => expect(recordedPids()).toHaveLength(1), { timeout: 15_000 });

  // 畳み込み停止の合図は adapter が撃つもので、届いても従われる保証は無い
  child.kill("SIGTERM");
  await delay(500);
  expect(recordedPids().filter(alive)).toEqual(recordedPids());
  expect(empty()).toBe(false);

  containers.forceReclaim("graceful-deaf");
  await containers.reclaimed("graceful-deaf");

  expect(recordedPids().filter(alive)).toEqual([]);
});

it("kill の最中も fork し続ける子は、その最中に生まれた子孫ごと回収される", async () => {
  const container = open("fork-storm");
  hostile(
    container,
    `echo $$ >> "$CANARY_PIDS"
while :; do
  /bin/sh -c 'echo $$ >> "$CANARY_PIDS"; exec sleep 300' &
  sleep 0.05
done`,
  );
  const empty = emptyObserved(container);
  await vi.waitFor(() => expect(recordedPids().length).toBeGreaterThanOrEqual(5), { timeout: 15_000 });
  expect(empty()).toBe(false); // fork し続けている間、容器は空ではない

  const recordedBeforeForce = recordedPids().length;
  containers.forceReclaim("fork-storm");
  await containers.reclaimed("fork-storm");

  // 証明しているのは「記録された全 PID(force 前に生まれたものと、force と競合して
  // 書き込みまで辿り着いたもの)が1つも生きていない」こと。`cgroup.kill` はほぼ
  // 原子的なので、kill の最中に生まれた PID が実際に存在したかまでは区別しない
  expect(recordedPids().length).toBeGreaterThanOrEqual(recordedBeforeForce);
  expect(recordedPids().filter(alive)).toEqual([]);
});

it("session を分けて daemon 化した孫は、直の子が終わっても容器を空にしない", async () => {
  const container = open("setsid-daemon");
  const child = hostile(
    container,
    `echo $$ >> "$CANARY_PIDS"
${probe.daemonScript}
exit 0`,
  );
  const empty = emptyObserved(container);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await vi.waitFor(() => expect(recordedPids()).toHaveLength(2), { timeout: 15_000 });

  const [parent, daemon] = recordedPids();
  if (parent === undefined || daemon === undefined) throw new Error("unreachable");
  expect(probe.escapedSession(daemon)).toBe(true); // setsid は本当に効いている
  expect(alive(parent)).toBe(false); // 直の子はもう居ない
  await delay(500);
  expect(empty()).toBe(false); // それでも容器は空ではない

  containers.forceReclaim("setsid-daemon");
  await containers.reclaimed("setsid-daemon");

  expect(alive(daemon)).toBe(false);
});

it("回収を終えた容器は残骸を残さない — 次の boot の前提検査が成立したままである", () => {
  // 残骸の有無を先に見る: `preflight` は空の残骸を rmdir して available を返すので、
  // 順序を逆にすると「空になった容器の rmdir が通らなかった」ことを隠してしまう。
  expect(probe.residue()).toEqual(residueAtStart);
  expect(containers.preflight()).toEqual({ available: true });
});
