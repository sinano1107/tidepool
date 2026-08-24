import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type CgroupPaths, containerRuntimeFor } from "../src/cgroup-container.js";
import type { ContainerRuntimeCapability } from "../src/worker-container.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** kernel の代わりに cgroupfs の形だけを temp dir に作る: mount の
 *  `cgroup.controllers` と、盤面自身が居る cgroup(`/proc/self/cgroup` の
 *  `0::` 行が指す先)。実カーネルでの証明は #464 の contract suite が担う。 */
async function fakeCgroupfs(): Promise<CgroupPaths & { own: string }> {
  const mount = await mkdtemp(join(tmpdir(), "tidepool-cgroupfs-"));
  dirs.push(mount);
  writeFileSync(join(mount, "cgroup.controllers"), "cpuset cpu memory pids\n");
  const own = join(mount, "board.slice");
  mkdirSync(own);
  const selfCgroup = join(mount, "proc-self-cgroup");
  writeFileSync(selfCgroup, "0::/board.slice\n");
  return { mount, selfCgroup, own };
}

const linux = (paths: CgroupPaths) => containerRuntimeFor("linux", paths);

/** 不成立の理由。成立していたら空文字なので、どの `toContain` も落ちる —
 *  「不成立であること」と「理由が何を名指しするか」を1行で測る。 */
const reason = (capability: ContainerRuntimeCapability): string =>
  capability.available ? "" : capability.reason;

it("容器機構を実測していない platform は fail-closed — 黙って弱い回収へ落ちない", () => {
  const capability = containerRuntimeFor("darwin").preflight();

  expect(reason(capability)).toContain("darwin");
  expect(reason(capability)).toContain("has been measured");
});

it("cgroup v2 が mount され自分の cgroup 配下に mkdir できれば前提は成立する", async () => {
  const paths = await fakeCgroupfs();

  expect(linux(paths).preflight()).toEqual({ available: true });
});

it("cgroup v2 の mount が無ければ不成立 — 理由は何が足りないかを名指しする", async () => {
  const paths = await fakeCgroupfs();
  rmSync(join(paths.mount, "cgroup.controllers"));

  const capability = linux(paths).preflight();

  expect(reason(capability)).toContain("cgroup v2");
  expect(reason(capability)).toContain(paths.mount);
});

it("自分がどの cgroup に居るか読めなければ不成立", async () => {
  const paths = await fakeCgroupfs();
  writeFileSync(paths.selfCgroup, "1:name=systemd:/board.slice\n"); // v1 だけの hybrid

  const capability = linux(paths).preflight();

  expect(reason(capability)).toContain(paths.selfCgroup);
});

it("自分の cgroup 配下に容器を作れなければ不成立 — 理由は Delegate=yes を名指しする", async () => {
  const paths = await fakeCgroupfs();
  writeFileSync(paths.selfCgroup, "0::/not-delegated.slice\n");

  const capability = linux(paths).preflight();

  expect(reason(capability)).toContain("Delegate=yes");
});

/** kernel の代わりに `cgroup.events` を書く(容器は create 済みであること)。 */
function events(paths: CgroupPaths & { own: string }, sessionId: string, populated: 0 | 1): string {
  const file = join(paths.own, `worker-${sessionId}`, "cgroup.events");
  writeFileSync(file, `populated ${populated}\nfrozen 0\n`);
  return file;
}

/** 前回の run が残した容器。 */
function leftover(paths: CgroupPaths & { own: string }, sessionId: string, populated: 0 | 1): string {
  const dir = join(paths.own, `worker-${sessionId}`);
  mkdirSync(dir);
  events(paths, sessionId, populated);
  return dir;
}

it("再起動をまたいで populated な容器が残っていたら不成立 — 回収済み観測の不成立は再起動で消えない", async () => {
  const paths = await fakeCgroupfs();
  const dir = leftover(paths, "task-42", 1);

  const capability = linux(paths).preflight();

  expect(reason(capability)).toContain(dir);
  expect(reason(capability)).toContain("populated");
  expect(existsSync(dir)).toBe(true); // 掃除はしない — 中で process が生きている
});

// 掃除(rmdir)そのものは temp dir では観測できない: cgroupfs の rmdir は control
// ファイルを抱えたディレクトリを消せる(kernfs のファイルは unlink できないので
// それが唯一の消し方)が、temp dir の rmdir は ENOTEMPTY で落ちる。ここで測るのは
// 「空の残骸は pickup を止めない」— 掃除は best-effort で、消し損ねても次の boot が
// もう一度掃く。
it("空になっていた残骸は pickup を止めない", async () => {
  const paths = await fakeCgroupfs();
  leftover(paths, "task-42", 0);

  expect(linux(paths).preflight()).toEqual({ available: true });
});

it("稼働中の session の容器は残骸ではない — pickup と回答時の読み直しが健全な盤面を止めない", async () => {
  const paths = await fakeCgroupfs();
  leftover(paths, "task-42", 1); // 今まさに走っている session

  expect(linux(paths).preflight(new Set(["task-42"]))).toEqual({ available: true });
});

const collect = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    let out = "";
    stream.on("data", (c) => {
      out += c;
    });
    stream.on("end", () => resolve(out));
  });

it("容器の中への spawn は exec の前に自分自身を容器へ入れる — spawn 後に PID を移すのでは fork と競合する", async () => {
  const paths = await fakeCgroupfs();
  const container = linux(paths).create("task-7");

  const child = container.spawn("/bin/echo", ["hi"], { cwd: paths.mount, env: process.env });

  expect((await collect(child.stdout)).trim()).toBe("hi");
  const procs = join(paths.own, "worker-task-7", "cgroup.procs");
  expect(readFileSync(procs, "utf8").trim()).toMatch(/^\d+$/);
});

it("容器へ入れなければ CLI は走らない — 入場の失敗が spawn の成功に見えない", async () => {
  const paths = await fakeCgroupfs();
  const container = linux(paths).create("task-12");
  const procs = join(paths.own, "worker-task-12", "cgroup.procs");
  writeFileSync(procs, "");
  chmodSync(procs, 0o444); // kernel が入場を拒む形(EBUSY / EACCES)の代わり

  const child = container.spawn("/bin/echo", ["hi"], { cwd: paths.mount, env: process.env });
  const out = collect(child.stdout);
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));

  expect(code).not.toBe(0);
  expect((await out).trim()).toBe("");
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

it("回収済み観測は cgroup.events の populated 0 — 子の exit だけでは容器が空とは言えない", async () => {
  const paths = await fakeCgroupfs();
  const container = linux(paths).create("task-8");
  const file = events(paths, "task-8", 1); // 子孫がまだ居る
  let observed = false;
  void container.reclaimed.then(() => {
    observed = true;
  });

  const child = container.spawn("/bin/echo", ["hi"], { cwd: paths.mount, env: process.env });
  await new Promise((resolve) => child.on("exit", resolve));
  await settle();
  expect(observed).toBe(false); // CLI root は死んだが容器は空ではない

  writeFileSync(file, "populated 0\nfrozen 0\n"); // kernel の signal
  await container.reclaimed;
});

it("張る前に空になっていた容器も観測できる — signal の取りこぼしを一回限りの scan で埋めない", async () => {
  const paths = await fakeCgroupfs();
  const container = linux(paths).create("task-9");
  events(paths, "task-9", 0);

  container.spawn("/bin/echo", ["hi"], { cwd: paths.mount, env: process.env });

  await container.reclaimed;
});

it("強制回収は cgroup.kill への 1 の書き込み — 容器ごと落とす", async () => {
  const paths = await fakeCgroupfs();
  const container = linux(paths).create("task-10");
  events(paths, "task-10", 1);

  container.forceReclaim();

  expect(readFileSync(join(paths.own, "worker-task-10", "cgroup.kill"), "utf8")).toBe("1");
});

it("force の送達は空の観測ではない — 生きている子が居る間は populated 0 を読みにいかない", async () => {
  const paths = await fakeCgroupfs();
  const container = linux(paths).create("task-11");
  // wrapper が容器へ入る前の姿。ここを読んで「空」と答えるのが、送達を回収と
  // 数える TOCTOU そのものである(ADR 0099 決定3)。
  events(paths, "task-11", 0);
  const child = container.spawn("/bin/sleep", ["5"], { cwd: paths.mount, env: process.env });
  let observed = false;
  void container.reclaimed.then(() => {
    observed = true;
  });

  container.forceReclaim();
  await settle();

  expect(observed).toBe(false);
  child.kill("SIGKILL");
});
