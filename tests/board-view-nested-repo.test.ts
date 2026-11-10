import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { boardViewStatus, boardWriteTree, TaskCheckoutUnreadableError } from "../src/git.js";
import { addSubmodule, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, makeWorkspace, submoduleSource } from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0365 決定3: 盤面は gitlink の値を記録からしか読まない —— worktree の入れ子の repo は view から除き、記録の gitlink は base の値だけ

/** `tree` の entry を `<mode> <path>` で。 */
const entries = (repo: string, tree: string) =>
  git(repo, "ls-tree", "-r", tree).split("\n").filter(Boolean).map((line) => `${line.split(" ")[0]} ${line.split("\t")[1]}`);

async function checkout(name: string) {
  const ws = await makeWorkspace(name);
  return { path: ws.path, head: git(ws.path, "rev-parse", "HEAD") };
}

/** commit を1つ持つ、checkout と無関係の repo。 */
async function otherRepo(name: string) {
  return await submoduleSource(name);
}

it.each([
  ["A: 無関係の repo を指す gitfile", async (mod: string) => writeFileSync(join(mod, ".git"), `gitdir: ${join(await otherRepo("nested-a-source"), ".git")}\n`)],
  ["B: 手書きの .git/HEAD の任意の sha", async (mod: string) => {
    for (const dir of ["objects", "refs"]) mkdirSync(join(mod, ".git", dir), { recursive: true });
    writeFileSync(join(mod, ".git", "HEAD"), `${"1".repeat(40)}\n`);
  }],
  ["C: git init だけの入れ子の repo", async (mod: string) => void git(mod, "init", "--quiet")],
  [".git が他の repo への symlink", async (mod: string) => symlinkSync(join(await otherRepo("nested-symlink-source"), ".git"), join(mod, ".git"))],
])("untracked の入れ子の repo(%s)は WIP の tree にも view の status にも入らない", async (_, arrange) => {
  const { path, head } = await checkout("nested-untracked");
  const mod = join(path, "mod");
  mkdirSync(mod);
  writeFileSync(join(mod, "inside.txt"), "the nested repo's file\n");
  await arrange(mod);
  writeFileSync(join(path, "work.txt"), "work\n");

  const tree = boardWriteTree(path, head, path);

  expect(entries(path, tree).filter((entry) => entry.endsWith(" work.txt") || entry.includes(" mod"))).toEqual(["100644 work.txt"]);
  expect(boardViewStatus(path, head, path)).toEqual([{ path: "work.txt", status: "??" }]);
});

async function withSubmodule(name: string) {
  const { path } = await checkout(name);
  addSubmodule(path, await submoduleSource(`${name}-source`));
  git(path, "commit", "-m", "add the library as a submodule");
  const head = git(path, "rev-parse", "HEAD");
  return { path, head, recorded: git(path, "rev-parse", `${head}:mod`) };
}

it("submodule の tip を入れ子の repo で進めて commit していなければ、WIP の gitlink は base の値のままで status にも出ない", async () => {
  const { path, head, recorded } = await withSubmodule("nested-advanced");
  commitWork(join(path, "mod"), "lib.txt", "v2\n");

  const tree = boardWriteTree(path, head, path);

  expect(git(path, "rev-parse", `${tree}:mod`)).toBe(recorded);
  expect(boardViewStatus(path, head, path)).toEqual([]);
});

it("submodule の dir を消せば、WIP の gitlink は消え status は D を出す", async () => {
  const { path, head } = await withSubmodule("nested-deleted");
  rmSync(join(path, "mod"), { recursive: true, force: true });

  const tree = boardWriteTree(path, head, path);

  expect(entries(path, tree).filter((entry) => entry.includes(" mod"))).toEqual([]);
  expect(boardViewStatus(path, head, path)).toEqual([{ path: "mod", status: " D" }]);
});

it("submodule の dir を regular file に置き換えれば、WIP は blob を入れる", async () => {
  const { path, head } = await withSubmodule("nested-to-file");
  rmSync(join(path, "mod"), { recursive: true, force: true });
  writeFileSync(join(path, "mod"), "now a file\n");

  const tree = boardWriteTree(path, head, path);

  expect(entries(path, tree).filter((entry) => entry.includes(" mod"))).toEqual(["100644 mod"]);
  expect(boardViewStatus(path, head, path)).toEqual([{ path: "mod", status: " T" }]);
});

it("head で regular file を持つ dir を入れ子の repo に変えても、worker の編集は普通の blob で入り gitlink は入らない", async () => {
  const { path } = await checkout("nested-over-tracked");
  mkdirSync(join(path, "mod"));
  commitWork(path, "mod/a.txt", "v1\n");
  const head = git(path, "rev-parse", "HEAD");
  git(join(path, "mod"), "init", "--quiet");
  writeFileSync(join(path, "mod", "a.txt"), "v2\n");

  const tree = boardWriteTree(path, head, path);

  expect(entries(path, tree).filter((entry) => entry.includes(" mod"))).toEqual(["100644 mod/a.txt"]);
  expect(git(path, "cat-file", "-p", `${tree}:mod/a.txt`)).toBe("v2");
});

it("ignore された dir の中の git init だけの repo では WIP が通り、記録に無い", async () => {
  const { path } = await checkout("nested-ignored");
  commitWork(path, ".gitignore", "ign/\n");
  const head = git(path, "rev-parse", "HEAD");
  mkdirSync(join(path, "ign", "repo"), { recursive: true });
  git(join(path, "ign", "repo"), "init", "--quiet");

  const tree = boardWriteTree(path, head, path);

  expect(entries(path, tree).filter((entry) => entry.includes(" ign"))).toEqual([]);
  expect(boardViewStatus(path, head, path)).toEqual([]);
});

it("無効な gitfile を持つ dir の中の file は blob で入り、.git は入らない", async () => {
  const { path, head } = await checkout("nested-invalid-gitfile");
  mkdirSync(join(path, "mod"));
  writeFileSync(join(path, "mod", ".git"), "gitdir: /nonexistent/repo\n");
  writeFileSync(join(path, "mod", "inside.txt"), "plain\n");

  const tree = boardWriteTree(path, head, path);

  expect(entries(path, tree).filter((entry) => entry.includes(" mod"))).toEqual(["100644 mod/inside.txt"]);
});

it("列挙と add -A の間に worker が入れ子の .git を作れば、WIP は書いた tree の gitlink を base と比べて worker の repo の故障として投げる", async () => {
  const { path, head } = await checkout("nested-window");
  const mod = join(path, "mod");
  mkdirSync(mod);
  const other = await otherRepo("nested-window-source");
  // add の直前に gitfile を置く git —— 盤面の列挙はもう済んでいる
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  const bin = await tempDir("tidepool-git-window-");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n[ "$1" = add ] && printf 'gitdir: %s\\n' '${join(other, ".git")}' > '${join(mod, ".git")}'\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const original = process.env.PATH;
  process.env.PATH = `${bin}:${original}`;
  try {
    expect(() => boardWriteTree(path, head, path)).toThrow(TaskCheckoutUnreadableError);
  } finally {
    process.env.PATH = original;
  }
});
