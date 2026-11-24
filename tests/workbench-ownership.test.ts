import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type WorkbenchCarried, type WorkbenchOwner, workbenchOwner } from "../src/workbench.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, makeWorkspace } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 作業台の持ち主の判定と「人間の作業が残っていない」の述語(ADR 0382 決定2・3・5、#3352 の追記 1・2)を表で固定する。入口ごとの
// テストは、入口がこの判定を呼ぶことと入口に固有の挙動だけを見る。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const TARGET = "task/parent";
const CARRIED = "task/child";

/** 名前の場所(書く先 `task/parent` と運ばれる側 `task/child` が別のファイルを持つ)と、書く先を checkout した作業台。作業台の
 *  `board/*` は名前の場所の branch の引き直し —— 運ばれる側の `board/task/child` は書く先に無い commit を持つ。 */
async function board() {
  const named = await makeWorkspace("ownership");
  git(named.path, "branch", TARGET);
  git(named.path, "checkout", "--quiet", "-b", CARRIED);
  commitWork(named.path, "child.txt", "from the child\n");
  git(named.path, "checkout", "--quiet", TARGET);
  commitWork(named.path, "parent.txt", "from the parent\n");
  const at = join(await tempDir("tidepool-workbench-"), "workbench");
  git(named.path, "clone", "--quiet", "--branch", TARGET, named.path, at);
  git(at, "fetch", "--quiet", named.path, "+refs/heads/*:refs/heads/board/*");
  return { named: named.path, at };
}

type Board = Awaited<ReturnType<typeof board>>;

/** 作業台で書く先へ運ばれる側を merge して commit する(人間の手)。 */
const mergeCarried = ({ at }: Board) => git(at, "merge", "--quiet", "--no-edit", `board/${CARRIED}`);

const keyed = { inKey: true } as const;
const keyless = { inKey: false } as const;

/** 判定の種類。この入口のもので tip が入口の運ばれる側を欠けば、そう言う。 */
const outcome = (owner: WorkbenchOwner) => (owner.kind === "mine" && owner.lacksCarried ? "mine, lacking carried" : owner.kind);

it.each<[string, (b: Board) => void, "keyed" | "keyless" | "none", ReturnType<typeof outcome>, string[]]>([
  ["tip が書く先の今の値で何も残っていない", () => {}, "keyed", "nothing", []],
  ["tip が書く先の祖先(古い値)", ({ at }) => git(at, "reset", "--quiet", "--hard", "HEAD~1"), "keyed", "nothing", []],
  ["書く先に含まれる commit を指す人間の branch は数えない", ({ at }) => git(at, "branch", "kept", "HEAD~1"), "keyed", "nothing", []],
  ["鍵に運ばれる側があり、tip が書く先に含まれない", mergeCarried, "keyed", "mine", []],
  ["鍵に運ばれる側があり、tip が運ばれる側を含まなくてもその入口のもの", ({ at }) => commitWork(at, "notes.txt", "mine\n"), "keyed", "mine, lacking carried", []],
  ["鍵に運ばれる側が無く、tip が入口の運ばれる側を含む", mergeCarried, "keyless", "mine", []],
  ["鍵に運ばれる側が無く、tip が入口の運ばれる側を含まない", ({ at }) => commitWork(at, "notes.txt", "the human's own\n"), "keyless", "board", []],
  ["運ばれる側の無い入口はいつも自分のもの", ({ at }) => commitWork(at, "notes.txt", "the human's own\n"), "none", "mine", []],
  ["鍵に運ばれる側が無くても、tip が書く先に含まれれば取り込むものは無い", () => {}, "keyless", "nothing", []],
  [
    "作業ツリーが tip と違う(commit を忘れた)",
    ({ at }) => writeFileSync(join(at, "parent.txt"), "not committed\n"),
    "keyed",
    "refuse",
    ["it has uncommitted changes — commit them on task/parent or discard them"],
  ],
  ["untracked のファイルがある", ({ at }) => writeFileSync(join(at, "draft.txt"), "half done\n"), "keyed", "refuse", ["it has uncommitted changes"]],
  [
    "HEAD が書く先の branch に居ない",
    ({ at }) => git(at, "checkout", "--quiet", "--detach"),
    "keyed",
    "refuse",
    ["its HEAD is not on task/parent — check out task/parent there"],
  ],
  [
    "`board/*` 以外の branch に書く先に無い commit がある",
    ({ at }) => {
      git(at, "checkout", "--quiet", "-b", "fix");
      commitWork(at, "fix.txt", "on a side branch\n");
      git(at, "checkout", "--quiet", TARGET);
    },
    "keyed",
    "refuse",
    ["fix holds commits that task/parent does not have — merge them into task/parent, or delete them"],
  ],
  [
    "stash に書く先に無い commit がある",
    ({ at }) => {
      writeFileSync(join(at, "parent.txt"), "stashed\n");
      git(at, "stash", "--quiet");
    },
    "keyless",
    "refuse",
    ["the stash holds commits that task/parent does not have"],
  ],
  [
    "書く先の branch の無い作りかけ(init の直後で HEAD は `main`)",
    ({ at }) => {
      rmSync(at, { recursive: true, force: true });
      git(".", "init", "--quiet", "--initial-branch=main", at);
    },
    "keyed",
    "nothing",
    [],
  ],
  [
    "merge の途中で作業ツリーは tip と同じ(`-s ours --no-commit`)",
    ({ at }) => git(at, "merge", "--quiet", "-s", "ours", "--no-commit", `board/${CARRIED}`),
    "keyed",
    "refuse",
    ["a merge is in progress — commit it on task/parent or run `git merge --abort`"],
  ],
  [
    "stash の一番上が書く先に入っていても、下の段に書く先に無い commit がある",
    ({ at }) => {
      writeFileSync(join(at, "parent.txt"), "stashed\n");
      git(at, "stash", "--quiet");
      git(at, "update-ref", "--create-reflog", "-m", "on top", "refs/stash", TARGET);
    },
    "keyed",
    "refuse",
    ["the stash holds commits that task/parent does not have"],
  ],
  [
    // #3752: `reflog show` は開けない段を exit 0 のまま落とし、残る段がどれも書く先に入っていれば `nothing` と判定していた
    "stash の途中の段の object が作業台に無くても、その段を残っている作業に数える",
    ({ at }) => {
      git(at, "update-ref", "--create-reflog", "-m", "at the bottom", "refs/stash", TARGET);
      writeFileSync(join(at, "parent.txt"), "stashed\n");
      git(at, "stash", "--quiet");
      const middle = git(at, "rev-parse", "refs/stash");
      git(at, "update-ref", "-m", "on top", "refs/stash", TARGET);
      rmSync(join(at, ".git", "objects", middle.slice(0, 2), middle.slice(2)));
    },
    "keyed",
    "refuse",
    ["the stash holds commits that task/parent does not have"],
  ],
  [
    "stash のどの段も書く先に入っていれば数えない",
    ({ at }) => {
      git(at, "update-ref", "--create-reflog", "-m", "at the bottom", "refs/stash", `${TARGET}~1`);
      git(at, "update-ref", "-m", "on top", "refs/stash", TARGET);
    },
    "keyed",
    "nothing",
    [],
  ],
  [
    "reflog の無い refs/stash(update-ref で作った)はその値を判定する",
    ({ at }) => git(at, "update-ref", "refs/stash", `board/${CARRIED}`),
    "keyed",
    "refuse",
    ["the stash holds commits that task/parent does not have"],
  ],
  [
    "書く先の branch が無く、別の名前の branch に人間の commit がある",
    ({ at }) => {
      commitWork(at, "notes.txt", "renamed away\n");
      git(at, "branch", "--quiet", "-m", TARGET, "renamed");
    },
    "keyed",
    "refuse",
    ["renamed holds commits that task/parent does not have"],
  ],
])("%s", async (_case, write, key, kind, says) => {
  const b = await board();
  write(b);
  const carried: WorkbenchCarried | undefined =
    key === "none" ? undefined : { ...(key === "keyed" ? keyed : keyless), sha: git(b.named, "rev-parse", CARRIED) };
  let tip: string | undefined;
  try {
    tip = git(b.at, "rev-parse", "--verify", "--quiet", `refs/heads/${TARGET}`);
  } catch {
    tip = undefined;
  }

  const owner = workbenchOwner({ at: b.at, target: TARGET, targetSha: git(b.named, "rev-parse", TARGET), tip, verified: b.at }, carried, { boardMove: true });

  expect(outcome(owner)).toBe(kind);
  for (const element of says) expect(owner.kind === "refuse" && owner.reason).toContain(element);
  if (owner.kind === "refuse") expect(owner.reason).toMatch(new RegExp(`^the workbench at ${b.at} has nothing new on task/parent, but .*\\. Then answer again\\.$`));
});

// ADR 0382 決定6: 書く先の branch の無い作りかけは、盤面の手の無い入口(`take in` など)では「無い」にせず拒む —— 開き直して答え直す
it("書く先の branch の無い作りかけは、盤面の手の無い入口では拒む", async () => {
  const b = await board();
  rmSync(b.at, { recursive: true, force: true });
  git(".", "init", "--quiet", "--initial-branch=main", b.at);

  const owner = workbenchOwner({ at: b.at, target: TARGET, targetSha: git(b.named, "rev-parse", TARGET), tip: undefined, verified: b.named }, undefined, { boardMove: false });

  expect(owner).toEqual({
    kind: "refuse",
    reason: `the workbench at ${b.at} has no task/parent branch, so the board cannot tell what to take in. Open it again, then answer again.`,
  });
});
