import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// worktree を並べて同時に `npm test` を走らせると、各 vitest が「コア数−1」本の worker を
// 立てて CPU を奪い合い、時間に敏感なテストが timeout する。全 worktree が共有する
// git common dir にロックを置いて、この Mac 上の実行を 1 本ずつに直列化する。
const [command, ...args] = process.argv.slice(2);
const commonDir = path.resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
const lockDir = path.join(commonDir, "tidepool-test.lock");
const ownerFile = path.join(lockDir, "owner");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function acquire() {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        console.warn(`Could not take the test lock at ${lockDir} (${error.code}); running without it.`);
        return false;
      }
    }
    let owner;
    try {
      owner = JSON.parse(readFileSync(ownerFile, "utf8"));
    } catch {
      // 相手が mkdir と owner の書き込みの間にいる
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

const locked = await acquire();
if (locked) process.on("exit", () => rmSync(lockDir, { recursive: true, force: true }));

const child = spawn(command, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
