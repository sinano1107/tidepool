import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { TaskCheckoutUnreadableError } from "../src/git.js";
import { completeTask, getTask, interviewRoomPath, listChildren, pickupTask, registerTask, type Task, type TaskType } from "../src/tasks.js";
import { commitRoomCopy, recordTaskCheckoutTip, releaseWorkspace, type TaskCheckoutPlace, type WorkspaceConfig } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  callAsTask,
  checkoutOf,
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  pickedInterviewRoot,
  poseAccepted,
  prepareAtPickup,
  quarantineQuestion,
  questions,
  registerWork,
  servedQuarantineQuestion,
  type Tidepool,
  writeObservations,
} from "./harness.js";
import { tempDir } from "./temp-dir.js";

// ADR 0364: 盤面は worker の `.git` をリポジトリとして開かず、regular file だけを盤面所有の repo に写して tip を検証してから引く。
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// 途中の dir の lstat と open の間の差し替え(競走)を決定的に起こす口 —— 既定は素通し
const fsHook = vi.hoisted(() => ({ afterLstat: undefined as ((path: string) => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((path: string, options?: object) => {
    const stat = fs.lstatSync(path, options);
    fsHook.afterLstat?.(String(path));
    return stat;
  }) as typeof fs.lstatSync;
  return { ...fs, default: { ...fs, lstatSync }, lstatSync };
});

let t: Tidepool | undefined;
afterEach(async () => {
  fsHook.afterLstat = undefined;
  vi.unstubAllEnvs();
  await t?.stop();
  t = undefined;
});

const NOW = new Date("2026-11-10T00:00:00.000Z");

async function pickedUp(type: TaskType = "work"): Promise<{ db: Db; named: WorkspaceConfig; task: Task; place: TaskCheckoutPlace }> {
  const db = openDb(":memory:");
  onTestFinished(() => void db.close());
  const named = await makeWorkspace("tip-copy");
  const registered = registerTask(db, { type, title: type, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  return { db, named, task, place: (await prepareAtPickup(db, named, task)) as TaskCheckoutPlace };
}

/** 盤面ユーザーには読めて worker には読めない object store の代わり(他 workspace の名前の場所・registry clone)。 */
async function outsideRepo() {
  const outside = await makeWorkspace("outside");
  commitWork(outside.path, "secret.txt", "only outside\n");
  return { path: outside.path, commit: git(outside.path, "rev-parse", "HEAD"), blob: git(outside.path, "rev-parse", "HEAD:secret.txt") };
}

/** worker が書ける `.git` に仕込むポインタの3形(#3097 の triage で、旧い fetch が外部 object を名前の場所に入れた形)。 */
const pointers = {
  async alternates(checkout: string, branch: string) {
    const outside = await outsideRepo();
    appendFileSync(join(checkout, ".git", "objects", "info", "alternates"), `${join(outside.path, ".git", "objects")}\n`);
    const merge = git(checkout, "commit-tree", git(checkout, "rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-p", outside.commit, "-m", "merge outside");
    git(checkout, "update-ref", `refs/heads/${branch}`, merge);
    return outside.blob;
  },
  async gitdir(checkout: string, branch: string) {
    const outside = await outsideRepo();
    git(outside.path, "branch", branch);
    renameSync(join(checkout, ".git"), join(checkout, "moved-git"));
    writeFileSync(join(checkout, ".git"), `gitdir: ${join(outside.path, ".git")}\n`);
    return outside.blob;
  },
  async "ref symlink"(checkout: string, branch: string) {
    const outside = await outsideRepo();
    git(outside.path, "branch", branch);
    const ref = join(checkout, ".git", "refs", "heads", branch);
    rmSync(ref);
    symlinkSync(join(outside.path, ".git", "refs", "heads", branch), ref);
    return outside.blob;
  },
} as const;

const inNamed = (named: WorkspaceConfig, sha: string) => {
  try {
    git(named.path, "cat-file", "-e", sha);
    return true;
  } catch {
    return false;
  }
};

const releaseFailure = (db: Db, task: Task) => listEvents(db, task.id).find(({ kind }) => kind === "task_checkout_release_failed")?.payload;

it.each(Object.keys(pointers) as (keyof typeof pointers)[])("%s の checkout の tip は完了の門で worker の repo の故障として拒まれ、外部の object は名前の場所に入らない(ADR 0364 決定1・2)", async (form) => {
  const { db, named, task, place } = await pickedUp();
  commitWork(place.path, "work.txt", "work\n");
  const blob = await pointers[form](place.path, `task/${task.id}`);

  expect(() => recordTaskCheckoutTip(db, place, task.id)).toThrow(TaskCheckoutUnreadableError);
  expect(inNamed(named, blob)).toBe(false);
});

it.each(Object.keys(pointers) as (keyof typeof pointers)[])("%s の checkout の未決着の解放は task の失敗で、名前の場所を quarantine せず外部の object も入れない(ADR 0364 決定2)", async (form) => {
  const { db, named, task, place } = await pickedUp();
  const blob = await pointers[form](place.path, `task/${task.id}`);

  releaseWorkspace(db, place, task, NOW);

  expect(releaseFailure(db, task)).toMatchObject({ path: place.path });
  expect(listChildren(db, task.id)).toMatchObject([{ type: "question", question_cancel_option: "abandon" }]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(inNamed(named, blob)).toBe(false);
});

it.each(Object.keys(pointers) as (keyof typeof pointers)[])("%s の checkout の完了済み review の解放は「読めない」観測で、外部の object は名前の場所に入らない(ADR 0364 決定2 / ADR 0359 決定5)", async (form) => {
  const { db, named, task, place } = await pickedUp("review");
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  const blob = await pointers[form](place.path, `task/${task.id}`);

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW, false, undefined, undefined, true);

  expect(writeObservations(db, task.id)).toEqual([
    { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(place.path) },
  ]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(inNamed(named, blob)).toBe(false);
});

it.each(["commit", "gc"])("正当な worker の tip は今日どおり記録に着く(%s、ADR 0364 決定1)", async (shape) => {
  const { db, named, task, place } = await pickedUp();
  commitWork(place.path, "work.txt", "work\n");
  commitWork(place.path, "more.txt", "more\n");
  const tip = git(place.path, "rev-parse", "HEAD");
  if (shape === "gc") {
    git(place.path, "gc", "--quiet", "--prune=now");
    expect(git(place.path, "count-objects", "-v")).toContain("count: 0");
    expect(existsSync(join(place.path, ".git", "refs", "heads", "task", task.id))).toBe(false);
  }

  expect(recordTaskCheckoutTip(db, place, task.id)).toBe(tip);
  expect(git(named.path, "rev-parse", `task/${task.id}`)).toBe(tip);
  expect(git(named.path, "show", `task/${task.id}:more.txt`)).toBe("more");
});

const looseObject = (checkout: string, sha: string) => join(checkout, ".git", "objects", sha.slice(0, 2), sha.slice(2));

/** worker が自分の objects を壊した形。閉包の到達可能性と内容は fetch の前に写しの中で確かめる —— fetch の段で露見すると名前の場所の
 *  quarantine に誤帰属する(#3061 の逆転)。 */
const corruptions = {
  deleted: (checkout: string, blob: string) => rmSync(looseObject(checkout, blob)),
  zlib: (checkout: string, blob: string) => {
    rmSync(looseObject(checkout, blob));
    writeFileSync(looseObject(checkout, blob), "not zlib");
  },
  "hash mismatch": (checkout: string, blob: string, other: string) => {
    const bytes = readFileSync(looseObject(checkout, other));
    rmSync(looseObject(checkout, blob));
    writeFileSync(looseObject(checkout, blob), bytes);
  },
  "broken pack": (checkout: string) => {
    git(checkout, "repack", "-a", "-d", "-l", "-q");
    const dir = join(checkout, ".git", "objects", "pack");
    const pack = join(dir, readdirSync(dir).find((name) => name.endsWith(".pack"))!);
    const bytes = readFileSync(pack);
    for (let i = 20; i < 40; i++) bytes[i]! ^= 0xff;
    rmSync(pack);
    writeFileSync(pack, bytes);
  },
} as const;

it.each(
  (Object.keys(corruptions) as (keyof typeof corruptions)[]).flatMap((corruption) => [
    [corruption, "work"],
    [corruption, "review"],
  ] as const),
)("worker の objects の %s は、%s の解放で worker の repo の故障になり名前の場所を quarantine しない(ADR 0364 決定1・2)", async (corruption, type) => {
  const { db, named, task, place } = await pickedUp(type);
  commitWork(place.path, "work.txt", "work\n");
  commitWork(place.path, "more.txt", "more\n");
  if (type === "review") completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  const tip = git(place.path, "rev-parse", "HEAD");
  corruptions[corruption](place.path, git(place.path, "rev-parse", "HEAD:work.txt"), git(place.path, "rev-parse", "HEAD:more.txt"));

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW, false, undefined, undefined, type === "review");

  if (type === "work") {
    expect(releaseFailure(db, task)).toMatchObject({ path: place.path, reason: expect.stringContaining("cannot be read") });
  } else {
    expect(writeObservations(db, task.id)).toMatchObject([{ observation: "unreadable", reason: expect.stringContaining("cannot be read") }]);
  }
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(inNamed(named, tip)).toBe(false);
});

it.each([
  ["objects/<xx>", (checkout: string, blob: string) => join(checkout, ".git", "objects", blob.slice(0, 2))],
  ["refs/heads/task", (checkout: string) => join(checkout, ".git", "refs", "heads", "task")],
  [".git", (checkout: string) => join(checkout, ".git")],
] as const)("%s を外の dir への symlink に差し替えた checkout は完了の門で worker の repo の故障(ADR 0364 決定1)", async (_, target) => {
  const { db, named, task, place } = await pickedUp();
  commitWork(place.path, "work.txt", "work\n");
  const tip = git(place.path, "rev-parse", "HEAD");
  const moved = join(await tempDir("tidepool-moved-"), "dir");
  const dir = target(place.path, git(place.path, "rev-parse", "HEAD:work.txt"));
  renameSync(dir, moved);
  symlinkSync(moved, dir);

  expect(() => recordTaskCheckoutTip(db, place, task.id)).toThrow(TaskCheckoutUnreadableError);
  expect(inNamed(named, tip)).toBe(false);
});

/** checkout の中で `blob` を指す tree の commit を tip にする —— worker は blob を持たなくても sha だけで tree を書ける。 */
function tipNaming(checkout: string, branch: string, blob: string): void {
  const tree = execFileSync("git", ["mktree", "--missing"], { cwd: checkout, input: `100644 blob ${blob}\tsecret.txt\n` }).toString().trim();
  git(checkout, "update-ref", `refs/heads/${branch}`, git(checkout, "commit-tree", tree, "-p", "HEAD", "-m", "name the blob"));
}

// darwin では worker が走らないので検査を飛ばす(ADR 0100 決定6)—— 釘は Linux の CI
it.skipIf(process.platform !== "linux")("Linux では途中の dir が lstat の後に外への symlink へ差し替えられても、開いた実体が checkout の外なら worker の repo の故障(ADR 0364 決定1)", async () => {
  const { db, named, task, place } = await pickedUp();
  const outside = await outsideRepo();
  tipNaming(place.path, `task/${task.id}`, outside.blob);
  const dir = join(place.path, ".git", "objects", outside.blob.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  fsHook.afterLstat = (path) => {
    if (path !== dir) return;
    fsHook.afterLstat = undefined;
    rmSync(dir, { recursive: true });
    symlinkSync(join(outside.path, ".git", "objects", outside.blob.slice(0, 2)), dir);
  };

  expect(() => recordTaskCheckoutTip(db, place, task.id)).toThrow(/resolves outside the task checkout/);
  expect(inNamed(named, outside.blob)).toBe(false);
});

/** 盤面の git を通さずに commit object を書く —— 親が手元に無くても worker は sha だけで書ける。 */
function forgedCommit(checkout: string, parent: string): string {
  const tree = git(checkout, "rev-parse", "HEAD^{tree}");
  const body = `tree ${tree}\nparent ${parent}\nauthor a <a@example.com> 0 +0000\ncommitter a <a@example.com> 0 +0000\n\nguess\n`;
  return execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: checkout, input: body }).toString().trim();
}

it("Interview の受験者が面接室にだけある兄弟の commit を親にした tip は写しで閉包が解けず、worker の repo の故障(ADR 0364 決定1)", async () => {
  const db = openDb(":memory:");
  onTestFinished(() => void db.close());
  const { root, room, place } = await pickedInterviewRoot(db, "tip-copy-room", NOW);
  const [examinee] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, place, root.id));
  releaseWorkspace(db, place, root, NOW);
  const examineePlace = await prepareAtPickup(db, room, examinee!);
  const checkout = examineePlace.path;
  const sibling = git(room.path, "commit-tree", "-p", git(checkout, "rev-parse", "HEAD"), "-m", "a sibling's answer", git(checkout, "rev-parse", "HEAD^{tree}"));
  git(room.path, "update-ref", "refs/heads/task/sibling", sibling);
  const before = git(room.path, "rev-parse", `task/${examinee!.id}`);
  git(checkout, "update-ref", `refs/heads/task/${examinee!.id}`, forgedCommit(checkout, sibling));

  releaseWorkspace(db, examineePlace, getTask(db, examinee!.id)!, NOW);

  expect(releaseFailure(db, examinee!)).toMatchObject({ path: checkout, reason: expect.stringContaining("cannot be read") });
  expect(git(room.path, "rev-parse", `task/${examinee!.id}`)).toBe(before);
  expect(quarantineQuestion(db, "workspace", root.id)).toBeUndefined();
});

it("work の tip は名前の場所にある commit を親にしてよい —— 名前の場所の objects を借りる役(ADR 0364 決定1)", async () => {
  const { db, named, task, place } = await pickedUp();
  const elsewhere = git(named.path, "commit-tree", "-p", "HEAD", "-m", "elsewhere", "HEAD^{tree}");
  git(named.path, "update-ref", "refs/heads/elsewhere", elsewhere);
  const tip = forgedCommit(place.path, elsewhere);
  git(place.path, "update-ref", `refs/heads/task/${task.id}`, tip);

  expect(recordTaskCheckoutTip(db, place, task.id)).toBe(tip);
  expect(git(named.path, "rev-parse", `task/${task.id}^`)).toBe(elsewhere);
});

it("写しの tmp が作れない未決着の解放は task の失敗で checkout を残し、名前の場所を quarantine しない(ADR 0364 決定2)", async () => {
  const { db, named, task, place } = await pickedUp();
  writeFileSync(join(place.path, "unfinished.txt"), "work in flight\n");
  vi.stubEnv("TMPDIR", join(named.path, "missing-temp-directory"));

  releaseWorkspace(db, place, task, NOW);
  vi.unstubAllEnvs();

  expect(releaseFailure(db, task)).toMatchObject({ path: place.path, reason: expect.stringContaining("cannot make its copy of the task checkout's git files") });
  expect(listChildren(db, task.id)).toMatchObject([{ type: "question", question_cancel_option: "abandon" }]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(readFileSync(join(place.path, "unfinished.txt"), "utf8")).toBe("work in flight\n");
});

it("checkout の root を読めなくした未決着の解放は worker の repo の故障で、名前の場所を quarantine しない(ADR 0364 決定2)", async () => {
  const { db, named, task, place } = await pickedUp();
  chmodSync(place.path, 0o000);
  try {
    releaseWorkspace(db, place, task, NOW);
  } finally {
    chmodSync(place.path, 0o755);
  }

  expect(releaseFailure(db, task)).toMatchObject({ path: place.path, reason: expect.stringContaining("cannot be read") });
  expect(listChildren(db, task.id)).toMatchObject([{ type: "question", question_cancel_option: "abandon" }]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
});

it("写しの中の git が tmp の容量切れで落ちれば host の失敗で、完了済み review の解放は「読めない」観測にせず quarantine する(ADR 0364 決定2)", async () => {
  const { db, named, task, place } = await pickedUp("review");
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  const shim = await tempDir("tidepool-enospc-git-");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\nif [ "$1" = index-pack ] && [ "$2" = --strict ]; then\n  echo 'fatal: unable to write file: No space left on device' >&2\n  exit 128\nfi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${shim}:${process.env.PATH}`);

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW, false, undefined, undefined, true);
  vi.unstubAllEnvs();

  expect(quarantineQuestion(db, "workspace", named.name)).toBeDefined();
  expect(writeObservations(db, task.id)).toEqual([]);
  expect(existsSync(join(place.path, ".git"))).toBe(true);
});

it("pack の 0 の連なりは写しで穴にしても byte が保たれ、tip は記録に着く(core.compression=0、ADR 0364 決定3)", async () => {
  const { db, named, task, place } = await pickedUp();
  writeFileSync(join(place.path, "zeros.bin"), Buffer.alloc(4 << 20));
  git(place.path, "add", "zeros.bin");
  git(place.path, "commit", "-q", "-m", "zeros");
  git(place.path, "-c", "pack.compression=0", "repack", "-a", "-d", "-l", "-q");
  const tip = git(place.path, "rev-parse", "HEAD");

  expect(recordTaskCheckoutTip(db, place, task.id)).toBe(tip);
  expect(git(named.path, "cat-file", "-s", `${tip}:zeros.bin`)).toBe(String(4 << 20));
});

/** 名前の場所の object DB を書けなくする(#3061 の再現)。戻す手を返す。 */
function freezeObjects(repo: string): () => void {
  const chmodDirs = (mode: string) => execFileSync("find", [join(repo, ".git", "objects"), "-type", "d", "-exec", "chmod", mode, "{}", "+"]);
  chmodDirs("0555");
  return () => chmodDirs("0755");
}

it("名前の場所の objects に書けない未決着の解放は名前の場所の側の失敗で quarantine し、task の失敗にしない(#3061 / ADR 0364 決定2)", async () => {
  const { db, named, task, place } = await pickedUp();
  commitWork(place.path, "work.txt", "work\n");
  const thaw = freezeObjects(named.path);
  try {
    releaseWorkspace(db, place, task, NOW);
  } finally {
    thaw();
  }

  expect(quarantineQuestion(db, "workspace", named.name)).toBeDefined();
  expect(releaseFailure(db, task)).toBeUndefined();
  expect(listChildren(db, task.id)).toEqual([]);
});

it("WIP の objects を名前の場所に書けなければ quarantine し、task の失敗にせず checkout を残す(ADR 0367 決定4)", async () => {
  const { db, named, task, place } = await pickedUp();
  writeFileSync(join(place.path, "wip.txt"), "only in the working tree\n");
  const thaw = freezeObjects(named.path);
  try {
    releaseWorkspace(db, place, task, NOW);
  } finally {
    thaw();
  }

  expect(quarantineQuestion(db, "workspace", named.name)?.purpose).toContain("WIP commit");
  expect(releaseFailure(db, task)).toBeUndefined();
  expect(listChildren(db, task.id)).toEqual([]);
  expect(existsSync(place.path)).toBe(true);
});

/** verb の時点で名前の場所の側か写しの host で tip を記録できない形。戻す手を返す。 */
const recordFailures = {
  "named place": (named: string) => freezeObjects(named),
  host: (named: string) => {
    vi.stubEnv("TMPDIR", join(named, "missing-temp-directory"));
    return () => vi.unstubAllEnvs();
  },
} as const;

it.each(["named place", "host"] as const)("complete_task は %s の側で tip を記録できなければ拒むだけで、資源を止めず task を失敗にしない(ADR 0364 決定2 / ADR 0359 決定4)", async (side) => {
  const ws = await makeWorkspace("tip-copy-gate");
  const board = (t = await bootTidepool({ workspace: ws }));
  const task = await registerWork(board, "record the tip");
  await board.clock.advance(HOUR);
  commitWork(checkoutOf(board.db, task.id), "work.txt", "work\n");

  const restore = recordFailures[side](ws.path);
  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF }).finally(restore);

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("Retry complete_task or escalate");
  expect((await api(board.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
  expect(board.containers.forceReclaims).toEqual([]);
  expect((await questions(board)).filter((question) => question.parent_id === task.id)).toEqual([]);
  expect(await servedQuarantineQuestion(board, "workspace", ws.name)).toBeUndefined();
});

it.each(["named place", "host"] as const)("pose_probe は %s の側で出題の写しを面接室に記録できなければ拒むだけで、資源を止めない(ADR 0367 決定1 / ADR 0359 決定4)", async (side) => {
  const ws = await makeWorkspace("tip-copy-pose");
  const board = (t = await bootTidepool({ workspace: ws }));
  const root = (await api(board.baseUrl, "POST", "/api/tasks", { type: "interview", title: "interview", hypothesis: "h", tier: "frontier", interview_targets: [{ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }] })).json;
  await board.clock.advance(HOUR);
  writeFileSync(join(checkoutOf(board.db, root.id), "env.txt"), "the probe's environment\n");

  const restore = recordFailures[side](interviewRoomPath(board.db, root.id)!);
  const res = await callAsTask(board, root.id, "pose_probe", { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }).finally(restore);

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("Retry pose_probe or escalate");
  expect((await api(board.baseUrl, "GET", `/api/tasks/${root.id}`)).json.status).toBe("in_progress");
  expect(board.containers.forceReclaims).toEqual([]);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json.filter((event: { kind: string }) => event.kind === "decision_logged")).toEqual([]);
  expect(await servedQuarantineQuestion(board, "workspace", root.id)).toBeUndefined();
});
