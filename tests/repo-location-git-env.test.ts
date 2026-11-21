import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GIT_FIXTURE_TEST_TIMEOUT, git, tempDirSync } from "./harness.js";

const FIXTURE_DIR = "tests/fixtures/repo-location-git-env";
// 子の fixture の上限に vitest の起動の余裕を足す —— 子が自分の時限で落ちる前に kill しない
const CHILD_TIMEOUT_MS = GIT_FIXTURE_TEST_TIMEOUT + 15_000;

// #3334: a linked worktree's `git bisect run` / `rebase --exec` / hook exports GIT_DIR. A test run under it must not write
// into that repo. The child is a light run (exactly one file) —— otherwise its test lock waits on this run's lock.
// 時限は子の上限に、この test 自身の git(呼び手の repo と worktree を組む)の余裕を足す
it("a test run under an inherited GIT_DIR leaves that repo alone", { timeout: CHILD_TIMEOUT_MS + 10_000 }, () => {
  const caller = tempDirSync("tidepool-caller-");
  git(caller, "init", "--quiet");
  // 空の tree —— fixture の commit(README.md)が呼び手の tree と同じだと no-op になり、HEAD が動かず assert が効かない
  git(caller, "commit", "--quiet", "--allow-empty", "-m", "caller");
  const worktree = join(tempDirSync("tidepool-caller-wt-"), "wt");
  git(caller, "worktree", "add", "--quiet", "--detach", worktree);
  const gitDir = git(worktree, "rev-parse", "--absolute-git-dir");
  const head = git(worktree, "rev-parse", "HEAD");
  const config = readFileSync(join(caller, ".git", "config"), "utf8");

  // spawnSync blocks the event loop, so the test timeout cannot fire while the child hangs —— the child gets its own
  const child = spawnSync(
    "npx",
    ["vitest", "run", "--config", `${FIXTURE_DIR}/vitest.config.ts`, `${FIXTURE_DIR}/writes-a-repo.fixture.ts`],
    { cwd: process.cwd(), env: { ...process.env, GIT_DIR: gitDir }, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );

  // 呼び手の repo の状態を先に見る —— 子の失敗は、壊れた repo に書いた結果としても起きる
  expect(readFileSync(join(caller, ".git", "config"), "utf8")).toBe(config);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
  expect(child.status, child.stdout + child.stderr).toBe(0);
});
