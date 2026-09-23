import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCLI, type TestProject } from "vitest/node";

// worktree を並べて同時に vitest を走らせると、各 vitest が「コア数−1」本の worker を
// 立てて CPU を奪い合い、時間に敏感なテストが timeout する。全 worktree が共有する
// git common dir にロックを置いて、この Mac 上の重い実行を 1 本ずつに直列化する。
// vitest.config.ts の globalSetup なので、入口(npm test / npx vitest run)を問わず
// main process で worker を立てる前に1度だけ走る。
// 待ち手は queue に到着時刻の札を置き、先頭の札の持ち主だけがロックを取りに行く(先着順)。

// 既存のテストファイルをちょうど1つ指定した run だけが軽い(約1コア)。
// args は `vitest` より後ろの argv。option の値(`-t name` など)の見分けは vitest の parser に任せる。
export function isLightRun(args: string[]): boolean {
  const { filter } = parseCLI(["vitest", ...args]);
  if (filter.length !== 1) return false;
  try {
    return statSync(String(filter[0])).isFile();
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export default async function setup(project: TestProject): Promise<void> {
  if (project.config.watch || isLightRun(process.argv.slice(2))) return;

  let commonDir: string;
  try {
    commonDir = path.resolve(
      execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    );
  } catch {
    console.warn("Could not find the git common dir; running without the test lock.");
    return;
  }
  const lockDir = path.join(commonDir, "tidepool-test.lock");
  const ownerFile = path.join(lockDir, "owner");
  const queueDir = path.join(commonDir, "tidepool-test.queue");
  const ticket = `${String(Date.now()).padStart(15, "0")}-${process.pid}`;

  function isMyTurn(): boolean {
    for (const name of readdirSync(queueDir).sort()) {
      if (name === ticket) return true;
      if (isAlive(Number(name.split("-")[1]))) return false;
      rmSync(path.join(queueDir, name), { force: true });
    }
    return false;
  }

  async function acquire(): Promise<boolean> {
    let announced = false;
    for (;;) {
      if (isMyTurn()) {
        try {
          mkdirSync(lockDir);
          writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
          return true;
        } catch (error) {
          const { code } = error as NodeJS.ErrnoException;
          if (code !== "EEXIST") {
            console.warn(`Could not take the test lock at ${lockDir} (${code}); running without it.`);
            return false;
          }
        }
      }
      let owner: { pid: number; cwd: string } | undefined;
      try {
        owner = JSON.parse(readFileSync(ownerFile, "utf8"));
      } catch {
        // ロックが空いている(先頭待ち)か、相手が mkdir と owner の書き込みの間にいる
      }
      if (owner && !isAlive(owner.pid)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (!announced && owner) {
        console.log(`Waiting for the test run in ${owner.cwd} (pid ${owner.pid}) to finish...`);
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  let locked = false;
  try {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, ticket), "");
    process.on("exit", () => rmSync(path.join(queueDir, ticket), { force: true }));
    locked = await acquire();
  } catch (error) {
    console.warn(`Could not join the test queue at ${queueDir} (${(error as NodeJS.ErrnoException).code}); running without the lock.`);
  }
  rmSync(path.join(queueDir, ticket), { force: true });
  // 解放は exit の1経路だけ。globalSetup の teardown でも消すと、teardown から exit までの間に
  // 次の run が取ったロックを exit 時に消してしまう。
  if (locked) process.on("exit", () => rmSync(lockDir, { recursive: true, force: true }));
}
