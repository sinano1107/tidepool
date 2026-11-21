import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { CheckoutUnreadableError } from "../src/git.js";
import { completeTask, finishTask, getTask, listChildren, pickupTask, registerTask, type Task, type TaskType } from "../src/tasks.js";
import {
  completionTreeGateApplies,
  completionTreePaths,
  NamedPlaceFetchError,
  quarantineWorkspace,
  type RunPlace,
  recordTaskCheckoutTip,
  releaseWorkspace,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import {
  breakCheckoutStaging,
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeWorkspace,
  newTreePointsAtDamagedNamedBlob,
  pickedInterviewRoot,
  prepareAtPickup,
  quarantineQuestion,
  STAGING_FAILURES,
  seedTaskBranch,
} from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0359 決定2・3: 門が記録した tip を完了の解放で運び、worker の checkout では報告後の書き込みを観測する。

const NOW = new Date("2026-09-10T00:00:00.000Z");
/** `seed` は pickup の前に名前の場所へ置く setup。 */
async function pickedUpSession(type: TaskType = "work", seed?: (ws: WorkspaceConfig) => void): Promise<{
  db: Db;
  task: Task;
  ws: WorkspaceConfig;
  place: RunPlace;
}> {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("sandbox");
  seed?.(ws);
  const registered = registerTask(
    db,
    { type, title: "one", purpose: "why", completion_criteria: "done" },
    NOW,
    ...HUMAN_WEBUI,
  );
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, ws, task);
  return { db, task, ws, place };
}

/** 完了の門の前半(`completionGatedPlace`): worker の tip を名前の場所のタスクブランチにする。 */
const gateFetch = (db: Db, place: RunPlace, task: Task) => recordTaskCheckoutTip(db, place, task.id);

/** 完了経路の後始末そのもの(`runTeardown` が組み立てる引数と同じ形)—— work タスクの
 *  完了だけが merge-back まで進む。 */
function releaseAfterCompletion(db: Db, place: RunPlace, task: Task): void {
  releaseWorkspace(db, place, task, NOW, task.type === "work", undefined, undefined, true);
}

const treeIsDirty = (db: Db, place: RunPlace, task: Task) => completionTreePaths(db, place, task.id).length > 0;

async function completedChild(legacy?: "stale" | "recorded") {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("completed-child");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const parentBranch = `task/${parent.id}`;
  seedTaskBranch(db, ws, parent.id, "main");
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, ws, task);
  if (legacy) {
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_opened", path: place.path }, at: NOW });
  }
  commitWork(place.path, "child.txt", "child work\n");
  const tip = git(place.path, "rev-parse", "HEAD");
  if (legacy !== "stale") gateFetch(db, place, task);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  return { db, ws, task: getTask(db, task.id)!, place, tip, parentBranch };
}

const writeObservations = (db: Db, task: Task) =>
  listEvents(db, task.id).map(({ payload }) => payload).filter(({ kind }) => kind === "task_checkout_written_after_completion");

it("完了報告後の commit は観測し、merge back は完了の門が記録した tip を運ぶ(ADR 0359 決定2・3)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    commitWork(place.path, "after-done.txt", "late commit\n");
    const workerTip = git(place.path, "rev-parse", "HEAD");

    releaseAfterCompletion(db, place, task);

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "after-done.txt")).toBe("");
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "committed", worker_tip: workerTip },
    ]);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了報告後に worker の .git が無くなっても記録の tip を運び、checkout を削除する(ADR 0359 決定2・3)", async () => {
  const { db, task, ws, place, parentBranch } = await completedChild();
  try {
    rmSync(join(place.path, ".git"), { recursive: true });

    releaseAfterCompletion(db, place, task);

    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    const observation = { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining("has no git repository") };
    expect(writeObservations(db, task)).toEqual([observation]);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(existsSync(place.path)).toBe(false);

    const events = listEvents(db, task.id);
    releaseAfterCompletion(db, place, task);
    expect(listEvents(db, task.id)).toEqual(events);
  } finally {
    db.close();
  }
});

it.each(["stale", "unreadable", "matching"])("旧版で完了した task は worker tip と照合してから解放する (worker=%s)", async (worker) => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild(worker === "matching" ? "recorded" : "stale");
  try {
    if (worker === "unreadable") rmSync(join(place.path, ".git"), { recursive: true });
    const branch = `task/${task.id}`;
    const before = git(ws.path, "rev-parse", branch);

    releaseAfterCompletion(db, place, task);

    expect(git(ws.path, "rev-parse", branch)).toBe(before);
    expect(writeObservations(db, task)).toEqual([]);
    if (worker === "matching") {
      expect(git(ws.path, "rev-parse", parentBranch)).toBe(tip);
      expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
      expect(existsSync(place.path)).toBe(false);
    } else {
      expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("earlier board version");
      expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "child.txt")).toBe("");
      expect(readFileSync(join(place.path, "child.txt"), "utf8")).toBe("child work\n");
    }
  } finally {
    db.close();
  }
});

it("基準比較の直後に人間がタスクブランチを動かしても、確認済みの tip だけを merge back する(ADR 0359 決定2・4)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    git(ws.path, "switch", "--detach", tip);
    commitWork(ws.path, "human.txt", "human work\n");
    const humanTip = git(ws.path, "rev-parse", "HEAD");
    git(ws.path, "switch", "main");

    // 基準比較の後、merge back の帰り先を読む Git の呼び出しに人間の書き込みを挟む。
    const bin = await tempDir("tidepool-completion-ref-move-");
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    writeFileSync(join(bin, "move-ref"), `${realGit}\nrefs/heads/task/${task.id}\n${humanTip}\nrefs/heads/${parentBranch}\n`);
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      '{ IFS= read -r git; IFS= read -r ref; IFS= read -r tip; IFS= read -r target; } < "${0%/*}/move-ref"',
      'if [ "$1" = rev-parse ] && [ "$2" = "$target" ]; then',
      '  "$git" update-ref "$ref" "$tip" || exit',
      "fi",
      'exec "$git" "$@"',
      "",
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);

    releaseAfterCompletion(db, place, task);
    vi.unstubAllEnvs();

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(humanTip);
    expect(git(ws.path, "rev-parse", parentBranch)).toBe(tip);
    const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
    await expect(prepareAtPickup(db, ws, next)).rejects.toThrow(/refs changed while the checkout rested/);
  } finally {
    vi.unstubAllEnvs();
    db.close();
  }
});

it("完了の門は worker の index や info/exclude で隠した変更を読み、.gitignore は尊重する(ADR 0356 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    commitWork(place.path, ".gitignore", "ignored.txt\n");
    gateFetch(db, place, task);
    writeFileSync(join(place.path, "ignored.txt"), "generated\n");
    expect(completionTreePaths(db, place, task.id)).toEqual([]);

    git(place.path, "update-index", "--assume-unchanged", "--", "README.md");
    writeFileSync(join(place.path, "README.md"), "hidden tracked change\n");
    expect(git(place.path, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(db, place, task.id)).toEqual(["README.md"]);

    mkdirSync(join(place.path, ".git", "info"), { recursive: true });
    writeFileSync(join(place.path, ".git/info/exclude"), "hidden.txt\n");
    writeFileSync(join(place.path, "hidden.txt"), "hidden untracked change\n");
    expect(git(place.path, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(db, place, task.id)).toEqual(["README.md", "hidden.txt"]);
  } finally {
    db.close();
  }
});

it("worker が設定した fsmonitor は完了の門・退避・次の pickup で実行しない(ADR 0356 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const script = join(place.path, ".git", "fsmonitor-probe");
    const marker = join(place.path, ".git", "fsmonitor-ran");
    writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/fsmonitor-ran"\nexit 1\n', { mode: 0o755 });
    git(place.path, "config", "core.fsmonitor", script);
    git(place.path, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(treeIsDirty(db, place, task)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(place.path, "work.txt"), "work in progress\n");
    releaseWorkspace(db, place, task, NOW);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "show", `task/${task.id}:work.txt`)).toBe("work in progress");

    const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
    await prepareAtPickup(db, ws, next);
    expect(existsSync(marker)).toBe(false);
  } finally {
    db.close();
  }
});

// 旧: 完了の門は作業ツリーを HEAD に戻した後も worker の index の staged な変更を読んだ(ADR 0084 決定1)。盤面は worker の index を
// 読まず、退避と同じ作業ツリーだけを読む —— staged だけの内容は WIP にも門にも現れない
it("完了の門は worker の index を読まず、作業ツリーを tip に戻した staged だけの変更を名指さない —— 退避が積むものと同じを読む(ADR 0356 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    const path = join(place.path, "README.md");
    const original = git(place.path, "show", "HEAD:README.md");
    writeFileSync(path, "a staged edit\n");
    git(place.path, "add", "README.md");
    writeFileSync(path, `${original}\n`);

    expect(completionTreePaths(db, place, task.id)).toEqual([]);
  } finally {
    db.close();
  }
});

// 旧: 門は populated な submodule の中の未 commit の内容も読んだ。盤面は worker の入れ子の repo で git を撃たず(ADR 0356 決定3)、submodule は gitlink だけで読む
it("the gate reads a submodule by its gitlink only, without running Git in the worker's nested repo or its filters (ADR 0356 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    const source = await makeWorkspace("nested-module-source");
    commitWork(source.path, ".gitattributes", "README.md filter=probe\n");
    git(place.path, "-c", "protocol.file.allow=always", "submodule", "add", source.path, "module with space");
    git(place.path, "commit", "-m", "add a submodule");
    gateFetch(db, place, task);
    const submodule = join(place.path, "module with space");
    const marker = join(place.path, ".git", "submodule-filter-ran");
    const script = join(place.path, ".git", "submodule-filter");
    writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/submodule-filter-ran"\ncat\n', { mode: 0o755 });
    git(submodule, "config", "filter.probe.clean", `"${script}"`);
    const readme = join(submodule, "README.md");
    const modified = readFileSync(readme);
    modified[0] = 0x78;
    writeFileSync(readme, modified);
    utimesSync(readme, new Date(0), new Date(0));
    git(submodule, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(completionTreePaths(db, place, task.id)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    git(submodule, "config", "--unset", "filter.probe.clean");
    git(submodule, "add", "README.md");
    git(submodule, "commit", "-m", "advance the submodule tip");
    expect(git(submodule, "status", "--porcelain")).toBe("");
    // ADR 0365 決定3: 進めた tip の値は worktree から読まない —— gitlink は記録の値のまま
    expect(completionTreePaths(db, place, task.id)).toEqual([]);
  } finally {
    db.close();
  }
});

it("無関係の repo を指す gitfile を持つ untracked の dir を、完了の門は名指さない(ADR 0365 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    const other = await makeWorkspace("gate-nested-gitfile-source");
    mkdirSync(join(place.path, "mod"));
    writeFileSync(join(place.path, "mod", ".git"), `gitdir: ${join(other.path, ".git")}\n`);

    expect(completionTreePaths(db, place, task.id)).toEqual([]);
  } finally {
    db.close();
  }
});

// 旧: commit の無い入れ子の repo では退避の add -A が落ち、未決着なら task の失敗、完了済み review なら名前の場所の quarantine だった
it.each(["undecided", "completed review"] as const)("commit の無い入れ子の repo は %s の解放を落とさず、記録にも入らない(ADR 0365 決定3)", async (form) => {
  const { db, task, ws, place } = await pickedUpSession(form === "undecided" ? "work" : "review");
  try {
    if (form === "completed review") completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    mkdirSync(join(place.path, "mod"));
    git(join(place.path, "mod"), "init", "--quiet");
    writeFileSync(join(place.path, "work.txt"), "work in progress\n");

    releaseWorkspace(db, place, getTask(db, task.id)!, NOW, false, undefined, undefined, form === "completed review");

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(git(ws.path, "show", `task/${task.id}:work.txt`)).toBe("work in progress");
    expect(git(ws.path, "ls-tree", `task/${task.id}`, "--", "mod")).toBe("");
  } finally {
    db.close();
  }
});

it("記録が持てない入れ子の repo で落ちた未決着の解放は、読めない理由を1度だけ書いて task の失敗にする(ADR 0365 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    commitWork(place.path, "mod", "a file\n");
    rmSync(join(place.path, "mod"));
    git(place.path, "clone", "--quiet", (await makeWorkspace("release-nested-over-file-source")).path, "mod");

    releaseWorkspace(db, place, task, NOW);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listEvents(db, task.id).find(({ kind }) => kind === "task_checkout_release_failed")?.payload).toMatchObject({
      reason: `the task checkout at ${place.path} cannot be read: the worktree has a nested repository the board does not carry: mod`,
    });
  } finally {
    db.close();
  }
});

it.each(STAGING_FAILURES)("未決着の解放で $shape があれば task の失敗として checkout を残す(ADR 0367 決定1・2)", async (failure) => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    breakCheckoutStaging(place.path, failure);

    releaseWorkspace(db, place, task, NOW);

    expect(listEvents(db, task.id).filter(({ kind }) => kind === "task_checkout_release_failed").map(({ payload }) => payload)).toEqual([
      { kind: "task_checkout_release_failed", path: place.path, reason: expect.stringContaining(failure.reason) },
    ]);
    expect(listChildren(db, task.id)).toHaveLength(1);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(existsSync(place.path)).toBe(true);
  } finally {
    db.close();
  }
});

it.each(STAGING_FAILURES)("完了した Interview root の解放で $shape があれば unreadable を1度観測して checkout を消す(ADR 0367 決定3)", async (failure) => {
  const db = openDb(":memory:");
  try {
    const { root, room, place } = await pickedInterviewRoot(db, "release-staging-failure", NOW);
    const completed = finishTask(db, root, FULL_HANDOFF, "worker", NOW, "worker");
    breakCheckoutStaging(place.path, failure);

    releaseAfterCompletion(db, place, completed);

    expect(writeObservations(db, root)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(failure.reason) },
    ]);
    expect(workspaceNeedsHuman(db, room.name)).toBe(false);
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("退避の基準に使う名前の場所の tip が読めなければ checkout を残して quarantine する(ADR 0367 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const workerTip = git(place.path, "rev-parse", "HEAD");
    commitWork(place.path, "recorded.txt", "already recorded\n");
    const recorded = gateFetch(db, place, task);
    git(place.path, "reset", "--hard", workerTip);
    const tree = git(ws.path, "rev-parse", `${recorded}^{tree}`);
    rmSync(join(ws.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    releaseWorkspace(db, place, task, NOW);

    expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("ls-tree");
    expect(listEvents(db, task.id).filter(({ kind }) => kind === "task_checkout_release_failed")).toEqual([]);
    expect(existsSync(place.path)).toBe(true);
  } finally {
    db.close();
  }
});

it("完了した Interview root の退避の基準にある nested tree が読めなければ面接室を quarantine して WIP を残す(ADR 0367 決定1)", async () => {
  const db = openDb(":memory:");
  try {
    const { root, room, place } = await pickedInterviewRoot(db, "release-corrupt-room-base", NOW);
    const workerTip = git(place.path, "rev-parse", "HEAD");
    mkdirSync(join(place.path, "nested"));
    commitWork(place.path, "nested/recorded.txt", "already recorded\n");
    const recorded = gateFetch(db, place, root);
    git(place.path, "reset", "--hard", workerTip);
    const completed = finishTask(db, root, FULL_HANDOFF, "worker", NOW, "worker");
    writeFileSync(join(place.path, "wip.txt"), "only worker copy\n");
    const tree = git(room.path, "rev-parse", `${recorded}:nested`);
    rmSync(join(room.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    releaseAfterCompletion(db, place, completed);

    expect(quarantineQuestion(db, "workspace", room.name)).toMatchObject({ purpose: expect.stringContaining("read-tree") });
    expect(writeObservations(db, root)).toEqual([]);
    expect(readFileSync(join(place.path, "wip.txt"), "utf8")).toBe("only worker copy\n");
  } finally {
    db.close();
  }
});

it("gitlink の祖先を symlink に置き換えた完了済み review の解放は、名前の場所を quarantine せず symlink を記録する(ADR 0365 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    const source = await makeWorkspace("release-nested-ancestor-source");
    git(place.path, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", source.path, "a/mod");
    git(place.path, "commit", "-m", "add the library as a nested submodule");
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    rmSync(join(place.path, "a"), { recursive: true, force: true });
    const elsewhere = await tempDir("tidepool-release-nested-ancestor-");
    mkdirSync(join(elsewhere, "mod"));
    symlinkSync(elsewhere, join(place.path, "a"));

    releaseWorkspace(db, place, getTask(db, task.id)!, NOW, false, undefined, undefined, true);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "ls-tree", `task/${task.id}`, "--", "a")).toMatch(/^120000 /);
  } finally {
    db.close();
  }
});

// 旧: 完了の merge back は ignored の生成物と入れ子 repo を消してから帰った(ADR 0352 決定1・2)
it("完了の merge back は ignored の生成物と入れ子 repo を名前の場所へ運ばず、それらは task の checkout ごと消え、次のタスクは新しい checkout で clean に始まる(ADR 0356 決定2)", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("ignored-completion");
  commitWork(ws.path, ".gitignore", "node_modules/\n");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  seedTaskBranch(db, ws, parent.id, "main");
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, ws, task);
  commitWork(place.path, ".gitignore", "node_modules/\nbuild/\n");
  mkdirSync(join(place.path, "build", "nested"), { recursive: true });
  git(join(place.path, "build", "nested"), "init", "-q");
  writeFileSync(join(place.path, "build", "nested", "out.txt"), "generated\n");
  mkdirSync(join(place.path, "node_modules"));
  writeFileSync(join(place.path, "node_modules", "cache"), "shared ignore rule\n");
  gateFetch(db, place, task);
  expect(treeIsDirty(db, place, task)).toBe(false);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");

  releaseAfterCompletion(db, place, getTask(db, task.id)!);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(ws.path, "status", "--porcelain", "--ignored")).toBe("");
  expect(git(ws.path, "show", `task/${parent.id}:.gitignore`)).toContain("build/");

  const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const pickedUpNext = pickupTask(db, next, "deckhand", NOW)!;
  const nextPlace = await prepareAtPickup(db, ws, pickedUpNext);

  expect(git(nextPlace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${next.id}`);
  expect(treeIsDirty(db, nextPlace, pickedUpNext)).toBe(false);
});

// 旧: pickup のタスクブランチへの checkout は、離れる main だけが無視する生成物を名前の場所から消した(ADR 0352 決定1)
it("pickup は名前の場所の ignored の生成物を消さず、task の checkout にも運ばない(ADR 0356 決定1・7)", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("ignored-pickup");
  commitWork(ws.path, ".gitignore", "build/\n");
  mkdirSync(join(ws.path, "build"));
  writeFileSync(join(ws.path, "build", "out.txt"), "generated at rest\n");
  const task = registerTask(db, { type: "work", title: "resume", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);

  const place = await prepareAtPickup(db, ws, task);

  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(readFileSync(join(ws.path, "build", "out.txt"), "utf8")).toBe("generated at rest\n");
  expect(existsSync(join(place.path, "build"))).toBe(false);
  expect(treeIsDirty(db, place, task)).toBe(false);
});

it("完了報告後の未コミットの書き込みは退避せず、記録の tip を merge back する(ADR 0359 決定3)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    writeFileSync(join(place.path, "after-the-report.txt"), "written after completion\n");

    releaseAfterCompletion(db, place, task);

    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "uncommitted", paths: ["after-the-report.txt"] },
    ]);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "after-the-report.txt")).toBe("");
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了と解放の間に別の理由で workspace が Quarantine になっても、観測を記録して merge back する(ADR 0350 決定1 / ADR 0359 決定3)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    writeFileSync(join(place.path, "late.txt"), "written after completion\n");
    quarantineWorkspace(db, ws.name, new Error("unrelated workspace failure"), NOW);
    const question = quarantineQuestion(db, "workspace", ws.name)!;

    releaseAfterCompletion(db, place, task);

    expect(quarantineQuestion(db, "workspace", ws.name)).toMatchObject({ id: question.id, purpose: question.purpose });
    expect(listEvents(db, question.id).map((e) => e.kind)).not.toContain("quarantine_refired");
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "uncommitted", paths: ["late.txt"] },
    ]);
    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "late.txt")).toBe("");
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("汚れが shadow 残骸の3条件だけを満たすなら、task の checkout ごと通常どおり完了する(ADR 0069 / ADR 0356 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, "deliverable.txt", "the real work\n");
  gateFetch(db, place, task);
  // ADR 0069 の3条件(既知パス・untracked・0バイト)—— サンドボックスの影であって
  // セッションの遺物ではない
  mkdirSync(join(place.path, ".claude"), { recursive: true });
  writeFileSync(join(place.path, ".claude", "agents"), "");

  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(place.path)).toBe(false);
});

it("名前の場所の記録の tree が壊れたら、完了の門で拒む (ADR 0359 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    mkdirSync(join(place.path, "nested"));
    commitWork(place.path, "nested/deliverable.txt", "the real work\n");
    gateFetch(db, place, task);
    const tree = git(ws.path, "rev-parse", `task/${task.id}^{tree}`);
    rmSync(join(ws.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    expect(() => completionTreePaths(db, place, task.id)).toThrow();
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了以外の解放では、着地後の書き込みが従来どおり WIP としてタスクブランチに退避され、再開の checkout はその WIP に立つ(ADR 0356 決定2)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, ".gitignore", "build/\nnode_modules/\n");
  for (const dir of ["build", "node_modules"]) {
    mkdirSync(join(place.path, dir));
    writeFileSync(join(place.path, dir, "cache"), "generated\n");
  }
  writeFileSync(join(place.path, "half-done.txt"), "work in flight\n");
  writeFileSync(join(place.path, "README.md"), "edited tracked file\n");

  // escalate / decompose は完了経路ではない —— 退避が生まれる従来の解放
  releaseWorkspace(db, place, task, NOW);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).toContain("WIP");
  expect(git(ws.path, "show", `task/${task.id}:half-done.txt`)).toBe("work in flight");
  expect(git(ws.path, "show", `task/${task.id}:README.md`)).toBe("edited tracked file");
  expect(git(ws.path, "ls-tree", "--name-only", `task/${task.id}`).split("\n")).toEqual([".gitignore", "README.md", "half-done.txt"]);
  const wip = git(ws.path, "rev-parse", `task/${task.id}`);

  const resumed = await prepareAtPickup(db, ws, task);

  expect(git(resumed.path, "rev-parse", "HEAD")).toBe(wip);
  expect(treeIsDirty(db, resumed, task)).toBe(false);
  expect(existsSync(join(resumed.path, "build"))).toBe(false);
  expect(existsSync(join(resumed.path, "node_modules"))).toBe(false);
});

// 旧: ignored の生成物を削除できなければ checkout を動かさず workspace Quarantine に落ちた(ADR 0352 / ADR 0069 決定4)
it("task の checkout を削除できなければ解放は quarantine に包まず投げ、後始末の再実行が消す(ADR 0356 決定2)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, ".gitignore", "build/\n");
  gateFetch(db, place, task);
  const build = join(place.path, "build");
  mkdirSync(build);
  writeFileSync(join(build, "out.txt"), "generated\n");
  chmodSync(build, 0o555);
  try {
    expect(() => releaseAfterCompletion(db, place, task)).toThrow();

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(join(build, "out.txt"))).toBe(true);
  } finally {
    chmodSync(build, 0o755);
  }

  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
});

it("review の完了でも退避する —— 完了の門を持たない解放の WIP はタスクブランチに留まる", async () => {
  const { db, task, ws, place } = await pickedUpSession("review");
  writeFileSync(join(place.path, "reviewer-leavings.txt"), "notes\n");

  // 門が verb の手前で clean を要求していない範囲では、後始末時の汚れを
  // 「報告後に書かれたもの」とは言えない
  expect(completionTreeGateApplies(task)).toBe(false);
  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:reviewer-leavings.txt`)).toBe("notes");
});

it.each(["repository", "task branch"])("review の完了後に %s が無ければ観測を記録して checkout を削除する(ADR 0359 決定5)", async (missing) => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    const branch = `task/${task.id}`;
    const tip = git(ws.path, "rev-parse", branch);
    writeFileSync(join(place.path, "reviewer-leavings.txt"), "notes\n");
    if (missing === "repository") {
      rmSync(join(place.path, ".git"), { recursive: true });
    } else {
      git(place.path, "switch", "-c", "elsewhere");
      git(place.path, "branch", "-D", branch);
    }

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(`has no ${missing === "repository" ? "git repository" : "branch"}`) },
    ]);
    expect(git(ws.path, "rev-parse", branch)).toBe(tip);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it.each(["transfer", "staging"])("review の完了で %s が落ちれば、名前の場所を quarantine して checkout を残す", async (stage) => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    if (stage === "transfer") {
      commitWork(place.path, "reviewer-leavings.txt", "only worker copy\n");
      git(ws.path, "config", "fetch.unpackLimit", "1");
      const packDir = join(ws.path, ".git", "objects", "pack");
      rmSync(packDir, { recursive: true });
      writeFileSync(packDir, "");
    } else {
      writeFileSync(join(place.path, "reviewer-leavings.txt"), "only worker copy\n");
      vi.stubEnv("TMPDIR", join(ws.path, "missing-temp-directory"));
    }

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
    expect(writeObservations(db, task)).toEqual([]);
    expect(listEvents(db, task.id).some(({ kind }) => kind === "task_checkout_released")).toBe(false);
    expect(readFileSync(join(place.path, "reviewer-leavings.txt"), "utf8")).toBe("only worker copy\n");
  } finally {
    vi.unstubAllEnvs();
    db.close();
  }
});

const looseObject = (repo: string, sha: string) => join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));

/** 名前の場所の objects の下の、入れ直しが移した壊れた loose の path。 */
const damagedLoose = (ws: WorkspaceConfig): string[] => {
  const objects = join(ws.path, ".git", "objects");
  return readdirSync(objects).filter((name) => name.startsWith("tidepool-damaged-")).flatMap((dir) => readdirSync(join(objects, dir)).map((file) => join(objects, dir, file)));
};

/** 名前の場所での blob の損傷: 消す・同じ id の loose を zlib でない byte にする・loose の body を切り詰める(header は読めるので
 *  `cat-file --batch-check` は在ると言い、中身を読む手だけが落ちる)。 */
const damages = {
  missing: () => undefined,
  corrupt: () => Buffer.from("not zlib"),
  truncated: (loose: Buffer) => loose.subarray(0, 15),
} as const;

/** 門で一度運んだ `sub/kept.txt` の blob を名前の場所で `damage` の形に外し、worker は自前の store に持ったまま root に1 commit 積む ——
 *  次の門の pack は除外(`--not --alternate-refs`)で blob も `sub` の tree も入れず、fetch も送らない。blob の id を返す。 */
function damagedHeldByWorker(db: Db, place: RunPlace, task: Task, ws: WorkspaceConfig, damage: keyof typeof damages = "missing"): string {
  mkdirSync(join(place.path, "sub"));
  commitWork(place.path, "sub/kept.txt", "kept by the worker\n");
  gateFetch(db, place, task);
  const blob = git(place.path, "rev-parse", "HEAD:sub/kept.txt");
  const loose = looseObject(ws.path, blob);
  const damaged = damages[damage](readFileSync(loose));
  rmSync(loose);
  if (damaged) writeFileSync(loose, damaged);
  commitWork(place.path, "more.txt", "more\n");
  return blob;
}

it.each(["missing", "corrupt", "truncated"] as const)("名前の場所で %s の blob を worker が自前の store に持てば、完了の門の確かめが捕まえて入れ直し、名前の場所で読める(ADR 0388 決定1・2)", async (damage) => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const blob = damagedHeldByWorker(db, place, task, ws, damage);

    const tip = gateFetch(db, place, task);

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "cat-file", "-p", blob)).toBe("kept by the worker");
    // loose を pack より先に開く読み手(git 2.56 の cat-file -p の stream)に、壊れた loose が入れ直した pack を覆わない —— 消さずに残す dir へ移す
    expect(existsSync(looseObject(ws.path, blob))).toBe(false);
    expect(damagedLoose(ws).map((path) => path.endsWith(`/${blob}`))).toEqual(damage === "missing" ? [] : [true]);
  } finally {
    db.close();
  }
});

it("入れ直しは、盤面が途中で落ちて名前の場所の objects に残した入れ直しの repo を消してから入れる(ADR 0388 決定2)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const blob = damagedHeldByWorker(db, place, task, ws);
    const stale = join(ws.path, ".git", "objects", "tidepool-reinsert-left");
    mkdirSync(join(stale, "objects"), { recursive: true });
    utimesSync(stale, new Date(0), new Date(0));
    // 移した壊れた loose は人間が調べるために残る —— 掃除は触らない
    const damaged = join(ws.path, ".git", "objects", "tidepool-damaged-kept");
    mkdirSync(damaged);
    writeFileSync(join(damaged, "0".repeat(40)), "kept for a human");
    utimesSync(damaged, new Date(0), new Date(0));

    gateFetch(db, place, task);

    expect(git(ws.path, "cat-file", "-p", blob)).toBe("kept by the worker");
    expect(readdirSync(join(ws.path, ".git", "objects")).filter((name) => name.startsWith("tidepool-reinsert-"))).toEqual([]);
    expect(readFileSync(join(damaged, "0".repeat(40)), "utf8")).toBe("kept for a human");
  } finally {
    db.close();
  }
});

/** 名前の場所の記録の失敗として拒まれ、読めない object を名指す。 */
const namedPlaceRefusal = (blob: string) => expect.objectContaining({ constructor: NamedPlaceFetchError, message: expect.stringContaining(blob) });

it.each(["missing", "truncated"] as const)("%s の blob の入れ直しが落ちれば完了の門は拒み、task/<id> を書かず done にもせず、理由が読めない object を名指す(ADR 0388 決定2 / ADR 0359 決定1)", async (damage) => {
  const { db, task, ws, place } = await pickedUpSession();
  const pack = join(ws.path, ".git", "objects", "pack");
  try {
    const blob = damagedHeldByWorker(db, place, task, ws, damage);
    const before = git(ws.path, "rev-parse", `task/${task.id}`);
    chmodSync(pack, 0o555);

    expect(() => gateFetch(db, place, task)).toThrow(namedPlaceRefusal(blob));

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(before);
    expect(getTask(db, task.id)?.status).toBe("in_progress");
  } finally {
    chmodSync(pack, 0o755);
    db.close();
  }
});

/** 名前の場所の main に `sub/kept.txt` を、mode を 0 で詰めた tree(読めるが `index-pack --strict` の fsck が落とす)で置く。blob の id を返す。 */
function seedZeroPaddedTree(ws: WorkspaceConfig): string {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: ws.path, input: "kept by the worker\n" }).toString().trim();
  const entry = Buffer.concat([Buffer.from("0100644 kept.txt\0"), Buffer.from(blob, "hex")]);
  const sub = execFileSync("git", ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], { cwd: ws.path, input: entry }).toString().trim();
  const root = execFileSync("git", ["mktree"], { cwd: ws.path, input: `${git(ws.path, "ls-tree", "HEAD")}\n040000 tree ${sub}\tsub\n` }).toString().trim();
  git(ws.path, "update-ref", "refs/heads/main", git(ws.path, "commit-tree", root, "-p", "HEAD", "-m", "zero-padded sub"));
  git(ws.path, "reset", "--hard", "--quiet");
  return blob;
}

it("入れ直しの pack を index-pack --strict が落とせば完了の門は名前の場所の側で拒み、task/<id> を書かず、理由が欠けた object を名指す(ADR 0388 決定2 / ADR 0359 決定1)", async () => {
  let blob = "";
  const { db, task, ws, place } = await pickedUpSession("work", (named) => {
    blob = seedZeroPaddedTree(named);
  });
  try {
    // `-l` の無い repack は借りている object を自前の pack に写す —— 名前の場所の tree も blob も worker の store に入る
    git(place.path, "repack", "-a", "-d", "--quiet");
    rmSync(looseObject(ws.path, blob));
    commitWork(place.path, "more.txt", "more\n");
    const before = git(ws.path, "rev-parse", `task/${task.id}`);

    expect(() => gateFetch(db, place, task)).toThrow(
      expect.objectContaining({ constructor: NamedPlaceFetchError, message: expect.stringMatching(new RegExp(`${blob}[\\s\\S]*zeroPaddedFilemode`)) }),
    );

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(before);
  } finally {
    db.close();
  }
});

/** worker の自前の store の blob を壊す: zlib でない byte にするか、別の object の中身をその名で置く。 */
const workerCopyDamages = {
  corrupt: () => Buffer.from("not zlib"),
  renamed: (checkout: string) => readFileSync(looseObject(checkout, execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: checkout, input: "another object\n" }).toString().trim())),
} as const;

it.each(["corrupt", "renamed"] as const)("入れ直しに要る blob の worker の写しが %s なら、完了の門は名前の場所でなく worker の repo の故障で拒む(ADR 0388 決定2 / ADR 0364 決定2)", async (damage) => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    // 入れ直しに要る object は門の pack が除外した —— ADR 0364 の index-pack を通っていない
    const blob = damagedHeldByWorker(db, place, task, ws);
    const bytes = workerCopyDamages[damage](place.path);
    rmSync(looseObject(place.path, blob));
    writeFileSync(looseObject(place.path, blob), bytes);
    const before = git(ws.path, "rev-parse", `task/${task.id}`);

    expect(() => gateFetch(db, place, task)).toThrow(expect.objectContaining({ constructor: CheckoutUnreadableError, message: expect.stringContaining(place.path) }));

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(before);
  } finally {
    db.close();
  }
});

// ADR 0398 決定1 / #3501: worker が持ち、新しい tree が直に指す形は入れ直しへ進む —— 実装されればこのテストは変わる
it("未決着の work の commit が名前の場所で欠けた blob を直に指せば、解放は名前の場所の quarantine で、task を失敗にせず checkout を残す(ADR 0364 決定2 / ADR 0367 決定4)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const { blob } = newTreePointsAtDamagedNamedBlob(ws.path, place.path);

    releaseWorkspace(db, place, task, NOW);

    expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain(blob);
    expect(listEvents(db, task.id).some(({ kind }) => kind === "task_checkout_release_failed")).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(readFileSync(join(place.path, "copy.txt"), "utf8")).toBe("workspace\n");
  } finally {
    db.close();
  }
});

// ADR 0398 決定1 / #3501: worker が持ち、新しい tree が直に指す形は入れ直しへ進む —— 実装されればこのテストは変わる
it("work の commit が名前の場所で欠けた blob を直に指せば、完了の門は名前の場所の側で拒み、task/<id> を書かない(ADR 0364 決定2 / ADR 0359 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const { blob } = newTreePointsAtDamagedNamedBlob(ws.path, place.path);
    const before = git(ws.path, "rev-parse", `task/${task.id}`);

    expect(() => gateFetch(db, place, task)).toThrow(namedPlaceRefusal(blob));

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(before);
  } finally {
    db.close();
  }
});

it("完了済み review の pack に入る blob の名前に worker が別の object の中身を置けば、--strict の文が名前の場所の欠けと同じでも worker の repo の故障で、名前の場所を quarantine しない(ADR 0364 決定2 / ADR 0367 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    commitWork(place.path, "only.txt", "only worker copy\n");
    const blob = git(place.path, "rev-parse", "HEAD:only.txt");
    const bytes = workerCopyDamages.renamed(place.path);
    rmSync(looseObject(place.path, blob));
    writeFileSync(looseObject(place.path, blob), bytes);

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(`did not receive expected object ${blob}`) },
    ]);
  } finally {
    db.close();
  }
});

const treeEntry = (mode: string, name: string, id: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);

/** worker が `hash-object --literally` で書いた root tree(`entries` は名前順)の commit を task branch に積む —— `git commit` の検査を通さない。 */
function commitLiteralRoot(checkout: string, entries: Buffer[]): void {
  const root = execFileSync("git", ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], { cwd: checkout, input: Buffer.concat(entries) }).toString().trim();
  git(checkout, "update-ref", "HEAD", git(checkout, "commit-tree", root, "-p", "HEAD", "-m", "literal root"));
}

it("完了済み review の新しい tree が blob の mode で worker の tree を指せば、名前の場所は全部読めるので worker の repo の故障で、名前の場所を quarantine しない(ADR 0364 決定2 / ADR 0367 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    const inner = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: place.path, input: "inner\n" }).toString().trim();
    const tree = execFileSync("git", ["mktree"], { cwd: place.path, input: `100644 blob ${inner}\ta.txt\n` }).toString().trim();
    commitLiteralRoot(place.path, [treeEntry("100644", "README.md", git(place.path, "rev-parse", "HEAD:README.md")), treeEntry("100644", "weird", tree)]);

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(tree) },
    ]);
  } finally {
    db.close();
  }
});

it("完了済み review の worker が作った tree の mode を 0 で詰めていれば、新しい tree が名前の場所で欠けた blob も指していても worker の repo の故障で、名前の場所を quarantine しない(ADR 0364 決定2 / ADR 0367 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    const { blob } = newTreePointsAtDamagedNamedBlob(ws.path, place.path);
    commitLiteralRoot(place.path, [treeEntry("100644", "README.md", blob), treeEntry("100644", "copy.txt", blob), treeEntry("0100644", "padded.txt", blob)]);

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.any(String) },
    ]);
  } finally {
    db.close();
  }
});

it("worker が借りている tree の id に壊れた loose を書けば、自前の object を数える手が落ち、完了の門は worker の repo の故障で拒む(ADR 0388 決定1 / ADR 0364 決定2)", async () => {
  const { db, task, ws, place } = await pickedUpSession("work", (named) => {
    mkdirSync(join(named.path, "sub"));
    commitWork(named.path, "sub/a.txt", "a\n");
    // 名前の場所は tree を pack に持つ —— 門の検証は pack を先に引いて worker の loose を読まない
    git(named.path, "repack", "-a", "-d", "--quiet");
  });
  try {
    const tree = git(ws.path, "rev-parse", "HEAD:sub");
    mkdirSync(join(place.path, ".git", "objects", tree.slice(0, 2)), { recursive: true });
    writeFileSync(looseObject(place.path, tree), "not zlib");
    commitWork(place.path, "more.txt", "more\n");

    expect(() => gateFetch(db, place, task)).toThrow(CheckoutUnreadableError);
  } finally {
    db.close();
  }
});

// ADR 0398 決定1 / #3501: worker が持ち、新しい tree が直に指す形は入れ直しへ進む —— 実装されればこのテストは変わる
it.each(["missing", "corrupt"] as const)("完了済み review の commit が名前の場所で %s の blob を直に指せば、worker が自前で持っていても検証の段は名前の場所の失敗で、名前の場所を quarantine して checkout と commit を残す(ADR 0364 決定2 / ADR 0367 決定3)", async (damage) => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    const { blob } = newTreePointsAtDamagedNamedBlob(ws.path, place.path, damage);
    const commit = git(place.path, "rev-parse", "HEAD");

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain(blob);
    expect(writeObservations(db, task)).toEqual([]);
    expect(listEvents(db, task.id).some(({ kind }) => kind === "task_checkout_released")).toBe(false);
    expect(git(place.path, "rev-parse", `task/${task.id}`)).toBe(commit);
  } finally {
    db.close();
  }
});

it("退避の WIP が名前の場所に欠けた blob を持てば、staging repo の確かめが捕まえて入れ直し、名前の場所で読める(ADR 0388 決定1・2 / ADR 0367 決定5)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const blob = git(ws.path, "rev-parse", "HEAD:README.md");
    rmSync(looseObject(ws.path, blob));
    // 同じ中身の untracked file —— staging repo は名前の場所に無い blob を自前の store に書き、fetch は名前の場所の ref から届く blob を送らない
    writeFileSync(join(place.path, "copy.txt"), "workspace\n");

    releaseWorkspace(db, place, task, NOW);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "show", `task/${task.id}:copy.txt`)).toBe("workspace");
    expect(git(ws.path, "cat-file", "-p", blob)).toBe("workspace");
  } finally {
    db.close();
  }
});

it("集合の blob の名前の場所の loose が別の blob の中身なら、完了の門の確かめが破損に数えて入れ直し、差し替えた loose を残す dir へ移す(ADR 0398 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const blob = damagedHeldByWorker(db, place, task, ws);
    // zlib として正しい別の object —— pack-objects は loose の中身を hash し直さない
    writeFileSync(looseObject(ws.path, blob), readFileSync(looseObject(ws.path, git(ws.path, "rev-parse", "HEAD:README.md"))));

    gateFetch(db, place, task);

    expect(git(ws.path, "cat-file", "-p", blob)).toBe("kept by the worker");
    expect(damagedLoose(ws).map((path) => path.endsWith(`/${blob}`))).toEqual([true]);
  } finally {
    db.close();
  }
});

/** worker が `sub/a.txt` と `sub/b.txt` を自前で持って門で一度運び、root に1 commit 積む。2つの blob の id を返す。 */
function twoHeldByWorker(db: Db, place: RunPlace, task: Task): [string, string] {
  mkdirSync(join(place.path, "sub"));
  commitWork(place.path, "sub/a.txt", "a by the worker\n");
  commitWork(place.path, "sub/b.txt", "b by the worker\n");
  gateFetch(db, place, task);
  commitWork(place.path, "more.txt", "more\n");
  return [git(place.path, "rev-parse", "HEAD:sub/a.txt"), git(place.path, "rev-parse", "HEAD:sub/b.txt")];
}

/** 名前の場所の objects の下の残す dir へ移された loose の id。 */
const damagedIds = (ws: WorkspaceConfig) => damagedLoose(ws).map((path) => path.slice(path.lastIndexOf("/") + 1)).sort();

it("集合の2つの blob の名前の場所の loose が互いの中身なら、完了の門の確かめが両方を破損に数えて入れ直し、両方の loose を残す dir へ移す(ADR 0398 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const [a, b] = twoHeldByWorker(db, place, task);
    const [bytesA, bytesB] = [readFileSync(looseObject(ws.path, a)), readFileSync(looseObject(ws.path, b))];
    // 名前の集合は揃ったまま —— object ごとに照合しないと素通しする
    rmSync(looseObject(ws.path, a));
    rmSync(looseObject(ws.path, b));
    writeFileSync(looseObject(ws.path, a), bytesB);
    writeFileSync(looseObject(ws.path, b), bytesA);

    gateFetch(db, place, task);

    expect(git(ws.path, "cat-file", "-p", a)).toBe("a by the worker");
    expect(git(ws.path, "cat-file", "-p", b)).toBe("b by the worker");
    expect(damagedIds(ws)).toEqual([a, b].sort());
  } finally {
    db.close();
  }
});

it("集合の blob の名前の場所の loose が集合の別の blob の中身なら、その loose だけを残す dir へ移し、別の blob の健全な loose は残す(ADR 0398 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const [a, b] = twoHeldByWorker(db, place, task);
    const bytesB = readFileSync(looseObject(ws.path, b));
    rmSync(looseObject(ws.path, a));
    writeFileSync(looseObject(ws.path, a), bytesB);

    gateFetch(db, place, task);

    expect(git(ws.path, "cat-file", "-p", a)).toBe("a by the worker");
    expect(damagedIds(ws)).toEqual([a]);
    expect(readFileSync(looseObject(ws.path, b))).toEqual(bytesB);
  } finally {
    db.close();
  }
});

// 受け入れた限界(ADR 0398 決定2・3): 借りている tree の下の object は守らない —— 集合の walk は借りている `sub` で止まり、staging repo が
// 自前の store に書いた blob を数えない。名前の場所で先に欠けた blob は、最後の写しごと checkout が消える
it("借りている tree の下の object は守らない: その blob が名前の場所で欠けていても、root に WIP を足した未決着の解放は今どおり運んで checkout を消す(ADR 0398 決定2・3)", async () => {
  const { db, task, ws, place } = await pickedUpSession("work", (named) => {
    mkdirSync(join(named.path, "sub"));
    commitWork(named.path, "sub/kept.txt", "kept by the named place\n");
  });
  try {
    const blob = git(ws.path, "rev-parse", "HEAD:sub/kept.txt");
    rmSync(looseObject(ws.path, blob));
    writeFileSync(join(place.path, "more.txt"), "more\n");

    releaseWorkspace(db, place, task, NOW);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "show", `task/${task.id}:more.txt`)).toBe("more");
    expect(existsSync(place.path)).toBe(false);
    expect(() => git(ws.path, "cat-file", "-e", blob)).toThrow();
  } finally {
    db.close();
  }
});

// 受け入れた限界(ADR 0398 決定3): 名前の場所で先に壊れた借りている object は守らない —— staging repo の `git add` は同じ id の壊れた loose を
// 在ると見て自前の store に書かず、確かめの集合に入らない
it("名前の場所で先に壊れた借りている object は守らない: 同じ中身の WIP を積んでも、未決着の解放は今どおり運んで checkout を消す(ADR 0398 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const blob = git(ws.path, "rev-parse", "HEAD:README.md");
    rmSync(looseObject(ws.path, blob));
    writeFileSync(looseObject(ws.path, blob), "not zlib");
    writeFileSync(join(place.path, "copy.txt"), "workspace\n");

    releaseWorkspace(db, place, task, NOW);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "rev-parse", `task/${task.id}:copy.txt`)).toBe(blob);
    expect(existsSync(place.path)).toBe(false);
    expect(() => git(ws.path, "cat-file", "-p", blob)).toThrow();
  } finally {
    db.close();
  }
});

// 受け入れた限界(ADR 0388 決定4): 運び終えた後に名前の場所に起きる外からの損傷は守らない —— 消す側は確かめず、blob の最後の写しごと checkout が消える
it("運び終えた後の外からの損傷は守らない: 門の後に名前の場所から持ち込んだ blob を消しても、完了の解放は今どおり checkout を消す(ADR 0388 決定4)", async () => {
  const { db, task, ws, place } = await completedChild();
  try {
    rmSync(looseObject(ws.path, git(ws.path, "rev-parse", `task/${task.id}:child.txt`)));

    releaseAfterCompletion(db, place, task);

    expect(listEvents(db, task.id).some(({ kind }) => kind === "task_checkout_released")).toBe(true);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});
