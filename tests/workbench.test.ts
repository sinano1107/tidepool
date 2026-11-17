import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { permissionConfig } from "../src/codex-worker.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEventsOfKinds } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { whyInvalidRegistryName } from "../src/registry-name.js";
import { buildSandboxSettings } from "../src/sandbox.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { markTeardown, runTeardown, teardownStep } from "../src/teardown.js";
import { recordTaskCheckoutTip, refValues, releaseWorkspace, runPlaceReadPaths, WORKBENCH_SEGMENT, type WorkspaceConfig, workbenchPath } from "../src/workspace.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, prepareAtPickup, quarantineQuestion, sessionId, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 作業台と取り込み(ADR 0371、spec #3273 group A): merge back の conflict は作業台を開き、人間がそこで merge を commit して答えると
// 盤面がその tip を取り込む。入口は workspace の Quarantine の回答(受理の 11)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

type Board = { db: Db; clock: FakeClock; ws: WorkspaceConfig; base: string; parent: Task };

/** 未決着の親の work と、その `task/<親>` に `work.txt` の内容を持つ purely-local の workspace。task の checkout の基点 `base` は
 *  解放と受理が同じものを読む —— 作業台はその下に開く。 */
async function boardWithParent(): Promise<Board> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("workbench");
  const base = await tempDir("tidepool-task-checkouts-");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${parent.id}`, "main");
  git(ws.path, "checkout", `task/${parent.id}`);
  commitWork(ws.path, "work.txt", "from the parent\n");
  git(ws.path, "checkout", "main");
  return { db, clock, ws, base, parent };
}

/** 親の子を main から切り(親の `work.txt` を持たない)、task の checkout で `work.txt` を書いて完了させる。`release` が後始末を撃つ ——
 *  既定は完了の後始末の runner で、merge back が conflict して workspace の Quarantine が立つ。 */
async function completedChild(b: Board, { body = "from the child\n", work, release }: { body?: string; work?: (checkout: string) => void; release?: (place: Awaited<ReturnType<typeof prepareAtPickup>>, task: Task) => void } = {}) {
  const { db, clock, ws, base, parent } = b;
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, clock.now(), ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${registered.id}`, "main");
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, ws, task, { now: clock.now(), workspacesBaseDir: base });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  commitWork(place.path, "work.txt", body);
  work?.(place.path);
  recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  if (release) {
    release(place, getTask(db, task.id)!);
  } else {
    markTeardown(db, task.id, clock.now());
    const slot = new Slot();
    slot.occupy(task.id, sessionId(db, task.id));
    slot.enterTeardown();
    await runTeardown({ db, clock, slot, resolve: () => ws, pollNow: () => {} }, task.id, teardownStep(db, task.id));
  }
  return getTask(db, task.id)!;
}

/** 子の merge back を解放が conflict させ、Quarantine を立てた盤面。 */
async function conflicted(options?: Parameters<typeof completedChild>[1]) {
  const b = await boardWithParent();
  const child = await completedChild(b, options);
  const target = `task/${b.parent.id}`;
  return { ...b, child, target, source: `task/${child.id}`, workbench: () => realpathSync(workbenchPath(b.base, target)) };
}

type Conflicted = Awaited<ReturnType<typeof conflicted>>;

/** 開いた workspace の Quarantine に人間が答える(回答の経路、作業台の基点は解放と同じ)。 */
function answer({ db, clock, ws, base }: Board) {
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  return submitAnswer(
    { db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspace: ws, workspacesDir: base }) },
    question,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

/** 作業台の書く先の branch の上で子を merge し、conflict を両方の行で解いて commit する(人間の手)。 */
function resolveInWorkbench(workbench: string, source: string): void {
  expect(() => git(workbench, "merge", `board/${source}`)).toThrow();
  writeFileSync(join(workbench, "work.txt"), "from the parent\nfrom the child\n");
  git(workbench, "add", "work.txt");
  git(workbench, "commit", "--no-edit");
}

/** 名前の場所の全 ref(HEAD を含む)。 */
const refsOf = (ws: WorkspaceConfig) => `${git(ws.path, "symbolic-ref", "HEAD")}\n${git(ws.path, "for-each-ref", "--format=%(objectname) %(refname)")}`;

const lastEventId = (db: Db) => db.prepare("SELECT COALESCE(MAX(id), 0) FROM events").pluck().get() as number;

const baseline = (db: Db, name: string) => refValues(db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(name) as string);

const takenIn = (db: Db) => listEventsOfKinds(db, ["workbench_taken_in"]);

it("作業台は空の template から作った git repo で hook を持たず `updateInstead` を置き、書く先の branch を全部展開して checkout する —— task の checkout は `updateInstead` を持たない(pin A1)", async () => {
  const c = await conflicted();
  const workbench = c.workbench();

  expect(git(workbench, "config", "receive.denyCurrentBranch")).toBe("updateInstead");
  expect(existsSync(join(workbench, ".git", "hooks"))).toBe(false);
  expect(git(workbench, "symbolic-ref", "HEAD")).toBe(`refs/heads/${c.target}`);
  expect(git(workbench, "rev-parse", "HEAD")).toBe(git(c.ws.path, "rev-parse", c.target));
  expect(git(workbench, "ls-files")).toBe("README.md\nwork.txt");
  expect(() => git(workbench, "config", "core.sparseCheckout")).toThrow();
  // 盤面は名前の場所の branch を `board/*` に引き直す
  expect(git(workbench, "rev-parse", `board/${c.source}`)).toBe(git(c.ws.path, "rev-parse", c.source));
  expect(git(workbench, "rev-parse", `board/${c.target}`)).toBe(git(c.ws.path, "rev-parse", c.target));
  const other = registerTask(c.db, { type: "work", title: "other", purpose: "why", completion_criteria: "done" }, c.clock.now(), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(c.db, c.ws, other, { workspacesBaseDir: c.base });
  expect(() => git(place.path, "config", "receive.denyCurrentBranch")).toThrow();
});

it("作業台の番地はどの worker の sandbox の読み書きの root にも入らず、workspace の名前・task の checkout・読み専用の checkout・面接室のどれの番地にもならない(pin A2)", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  const other = registerTask(c.db, { type: "work", title: "other", purpose: "why", completion_criteria: "done" }, c.clock.now(), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(c.db, c.ws, other, { workspacesBaseDir: c.base });
  const taskTemp = realpathSync(await tempDir("tidepool-task-temp-"));
  const configDir = realpathSync(await tempDir("tidepool-config-dir-"));
  const settings = buildSandboxSettings({ taskType: "work", workspacePath: place.path, taskTemp, configDir, lib64: true, readPaths: runPlaceReadPaths(place) });
  const codex = permissionConfig("work", place.path, taskTemp, "/usr/local/bin/codex", [], runPlaceReadPaths(place)).join("\n");
  const roots = [
    ...settings.sandbox.filesystem.allowRead,
    ...settings.sandbox.filesystem.allowWrite,
    ...(settings.permissions.allow ?? []).map((rule) => rule.replace(/^Read\(\/(.*)\/\*\*\)$/, "$1")),
    ...[...codex.matchAll(/"(\/[^"]*)"/g)].map(([, path]) => path!),
  ].filter((path) => isAbsolute(path));
  expect(roots).toContain(place.path);
  expect(codex).toContain(`"${place.path}"`);

  // 根がその番地そのものか祖先なら、worker はそこを読み書きできる
  const covering = roots.filter((root) => !relative(root, workbench).startsWith("..") && !isAbsolute(relative(root, workbench)));
  expect(covering).toEqual([]);
  const [segment, key] = relative(realpathSync(c.base), workbench).split("/");
  expect(segment).toBe(WORKBENCH_SEGMENT);
  expect(key).toBe(c.parent.id);
  // workspace の名前・面接室(root id)・task の checkout の鍵(`<id>`・`<id>.checkout`・`<id>.reads`)はどれも名前の規則に収まる
  expect(whyInvalidRegistryName(WORKBENCH_SEGMENT)).toBeDefined();
});

it("作業台への push は名前の場所の ref を1つも動かさず、作業ツリーをその tip に揃える(pin A3)", async () => {
  const c = await conflicted();
  const clone = join(await tempDir("tidepool-own-clone-"), "clone");
  git(c.base, "clone", "--quiet", "--branch", c.target, c.workbench(), clone);
  commitWork(clone, "notes.txt", "from my own clone\n");
  const before = refsOf(c.ws);

  git(clone, "push", "--quiet", "origin", c.target);

  expect(refsOf(c.ws)).toBe(before);
  expect(git(c.workbench(), "rev-parse", c.target)).toBe(git(clone, "rev-parse", "HEAD"));
  expect(git(c.workbench(), "status", "--porcelain")).toBe("");
});

it.each<[string, (c: Conflicted, workbench: string) => void, (c: Conflicted, workbench: string) => string[]]>([
  [
    "tip が書く先の今の値を持たない",
    (c, workbench) => {
      git(workbench, "reset", "--hard", `board/${c.source}`);
      commitWork(workbench, "notes.txt", "written on the child alone\n");
    },
    (c, workbench) => [`the workbench at ${workbench} is not ready: ${c.target} there does not contain ${c.target} (\`board/${c.target}\`)`, `Run \`git merge board/${c.target}\` there`],
  ],
  [
    "tip が運ばれる側の branch の tip を持たない",
    (_c, workbench) => commitWork(workbench, "notes.txt", "no merge yet\n"),
    (c, workbench) => [`the workbench at ${workbench} is not ready: ${c.target} there does not contain ${c.source} (\`board/${c.source}\`)`, `Run \`git merge board/${c.source}\` there`],
  ],
  [
    "作業ツリーが tip と違う",
    (c, workbench) => {
      resolveInWorkbench(workbench, c.source);
      writeFileSync(join(workbench, "work.txt"), "not committed\n");
    },
    (_c, workbench) => [`the workbench at ${workbench} has uncommitted changes — commit or discard them, then answer again.`],
  ],
  [
    "gitlink を足した",
    (c, workbench) => {
      resolveInWorkbench(workbench, c.source);
      // 中身を持たない submodule の dir —— 作業ツリーは tip と同じ
      mkdirSync(join(workbench, "vendored"));
      git(workbench, "update-index", "--add", "--cacheinfo", `160000,${git(workbench, "rev-parse", "HEAD")},vendored`);
      git(workbench, "commit", "-m", "add a gitlink");
    },
    (_c, workbench) => [`the tip of the workbench at ${workbench} changes vendored, which is a gitlink`],
  ],
  [
    "盤面が隠せない形を足した",
    (c, workbench) => {
      resolveInWorkbench(workbench, c.source);
      commitWork(workbench, ".claude", "a file where the settings directory belongs\n");
    },
    (_c, workbench) => [`the tip of the workbench at ${workbench} changes .claude, which is a shape the board cannot hide`],
  ],
  [
    "人間しか書けない path を変えた",
    (c, workbench) => {
      resolveInWorkbench(workbench, c.source);
      commitWork(workbench, ".mcp.json", "{}\n");
    },
    (_c, workbench) => [`the tip of the workbench at ${workbench} changes .mcp.json, which is written only by a human`],
  ],
])("取り込みの拒否は ref も event も書かず、作業台の在り処と直し方を言う —— %s(pin A4)", async (_case, write, says) => {
  const c = await conflicted();
  const workbench = c.workbench();
  write(c, workbench);
  const refs = refsOf(c.ws);
  const events = lastEventId(c.db);

  const refused = answer(c);

  await expect(refused).rejects.toThrow(DomainError);
  const message = await refused.catch((err: Error) => err.message);
  for (const element of says(c, workbench)) expect(message).toContain(element);
  expect(refsOf(c.ws)).toBe(refs);
  expect(lastEventId(c.db)).toBe(events);
  expect(quarantineQuestion(c.db, "workspace", c.ws.name)).toBeDefined();
});

it("解放が立てた Quarantine の理由は作業台を名指し、そこで merge を commit した後の1回の回答で取り込まれて受理され、作業台は消える(pin A5・A8)", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  const old = git(c.ws.path, "rev-parse", c.target);
  const question = quarantineQuestion(c.db, "workspace", c.ws.name)!;
  expect(question.purpose).toContain(`The board opened the workbench at ${workbench} for it. There, on ${c.target}, run \`git merge board/${c.source}\``);
  expect(question.purpose).toContain(`record that with \`git merge -s ours board/${c.source}\`. Then answer. `);
  resolveInWorkbench(workbench, c.source);
  const tip = git(workbench, "rev-parse", "HEAD");

  await answer(c);

  expect(getTask(c.db, question.id)!.status).toBe("done");
  const commit = git(c.ws.path, "rev-parse", c.target);
  expect(git(c.ws.path, "rev-parse", `${commit}^1`, `${commit}^2`)).toBe(`${old}\n${tip}`);
  expect(git(c.ws.path, "rev-parse", `${commit}^{tree}`)).toBe(git(c.ws.path, "rev-parse", `${tip}^{tree}`));
  expect(baseline(c.db, c.ws.name).get(`refs/heads/${c.target}`)).toBe(commit);
  expect(takenIn(c.db).map(({ actor_id, origin, payload }) => ({ actor_id, origin, payload }))).toEqual([
    {
      actor_id: HUMAN_ACTOR_ID,
      origin: "webui",
      payload: { kind: "workbench_taken_in", workspace: c.ws.name, target: `refs/heads/${c.target}`, tip, commit, entry: "workspace_quarantine" },
    },
  ]);
  expect(existsSync(workbench)).toBe(false);
});

it("別の理由で先に開いていた Quarantine では、最初の回答が merge back の conflict に当たって作業台を開いて拒まれ、merge を commit した2回目の回答が受理される(pin A8)", async () => {
  const b = await boardWithParent();
  // 解放は token の失敗で merge back の前に止まり、Quarantine はその理由で立つ
  const child = await completedChild(b, {
    release: (place, task) => releaseWorkspace(b.db, place, task, b.clock.now(), true, undefined, new Error("GitHub token acquisition failed"), true),
  });
  const target = `task/${b.parent.id}`;
  const source = `task/${child.id}`;
  expect(quarantineQuestion(b.db, "workspace", b.ws.name)!.purpose).not.toContain("the workbench at");

  const first = await answer(b).catch((err: unknown) => err);

  const workbench = realpathSync(workbenchPath(b.base, target));
  expect(first).toBeInstanceOf(DomainError);
  expect((first as Error).message).toContain(`The board opened the workbench at ${workbench} for it.`);
  expect((first as Error).message).toContain(`record that with \`git merge -s ours board/${source}\`. Then answer again.`);
  resolveInWorkbench(workbench, source);

  await answer(b);

  expect(quarantineQuestion(b.db, "workspace", b.ws.name)).toBeUndefined();
  expect(git(b.ws.path, "show", `${target}:work.txt`)).toBe("from the parent\nfrom the child");
  expect(takenIn(b.db)).toHaveLength(1);
});

it("片側の tree を捨てた `-s ours` の merge も取り込まれる(pin A6)", async () => {
  const c = await conflicted();
  const treeBefore = git(c.ws.path, "rev-parse", `${c.target}^{tree}`);
  git(c.workbench(), "merge", "-s", "ours", "--no-edit", `board/${c.source}`);
  const tip = git(c.workbench(), "rev-parse", "HEAD");

  await answer(c);

  expect(git(c.ws.path, "rev-parse", `${c.target}^{tree}`)).toBe(treeBefore);
  expect(git(c.ws.path, "rev-parse", `${c.target}^2`)).toBe(tip);
  expect(git(c.ws.path, "merge-base", "--is-ancestor", c.source, c.target)).toBe("");
});

it("内容の検査は入力の tip のどれとも違う entry にだけ当たる —— 運ばれる側の branch が持ってきた人間しか書けない path は通る(pin A7)", async () => {
  const c = await conflicted({ work: (checkout) => commitWork(checkout, ".mcp.json", "{}\n") });
  resolveInWorkbench(c.workbench(), c.source);

  await answer(c);

  expect(git(c.ws.path, "show", `${c.target}:.mcp.json`)).toBe("{}");
  expect(takenIn(c.db)).toHaveLength(1);
});

it("祖先のほかに履歴は制限しない —— 兄弟の task/<S> の merge と cherry-pick を一緒に commit した tip も取り込まれる", async () => {
  const b = await boardWithParent();
  const sibling = `task/${registerTask(b.db, { type: "work", title: "sibling", purpose: "why", completion_criteria: "done", parent_id: b.parent.id }, b.clock.now(), ...HUMAN_WEBUI).id}`;
  git(b.ws.path, "branch", sibling, "main");
  git(b.ws.path, "checkout", sibling);
  commitWork(b.ws.path, "sibling.txt", "from the sibling\n");
  commitWork(b.ws.path, "picked.txt", "cherry-picked\n");
  git(b.ws.path, "checkout", "main");
  const child = await completedChild(b);
  const workbench = realpathSync(workbenchPath(b.base, `task/${b.parent.id}`));
  resolveInWorkbench(workbench, `task/${child.id}`);
  git(workbench, "cherry-pick", `board/${sibling}`);
  git(workbench, "merge", "--no-edit", `board/${sibling}~1`);

  await answer(b);

  expect(git(b.ws.path, "ls-tree", "--name-only", `task/${b.parent.id}`)).toBe("README.md\npicked.txt\nsibling.txt\nwork.txt");
  expect(takenIn(b.db)).toHaveLength(1);
});

it("拒否は作業台の `board/*` を名前の場所の値に引き直し、人間が書いた `board/*` は消え、人間の branch と作業ツリーは動かない", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  commitWork(workbench, "notes.txt", "no merge yet\n");
  git(workbench, "update-ref", `refs/heads/board/${c.source}`, "HEAD");
  git(workbench, "branch", "board/stray", "HEAD");
  writeFileSync(join(workbench, "untracked.txt"), "mine\n");
  const head = git(workbench, "rev-parse", "HEAD");

  await expect(answer(c)).rejects.toThrow(DomainError);

  expect(git(workbench, "rev-parse", `board/${c.source}`)).toBe(git(c.ws.path, "rev-parse", c.source));
  expect(() => git(workbench, "rev-parse", "--verify", "--quiet", "refs/heads/board/stray")).toThrow();
  expect(git(workbench, "symbolic-ref", "HEAD")).toBe(`refs/heads/${c.target}`);
  expect(git(workbench, "rev-parse", "HEAD")).toBe(head);
  expect(git(workbench, "status", "--porcelain")).toBe("?? untracked.txt");
});

it("自前の clone から force push して書く先の今の値を失った tip は、祖先の検査が拒む(pin A16)", async () => {
  const c = await conflicted();
  const clone = join(await tempDir("tidepool-own-clone-"), "clone");
  git(c.base, "clone", "--quiet", "--branch", c.target, c.workbench(), clone);
  git(clone, "reset", "--hard", `origin/board/${c.source}`);
  commitWork(clone, "notes.txt", "dropped the parent's commit\n");
  git(clone, "push", "--quiet", "--force", "origin", `HEAD:${c.target}`);
  const refs = refsOf(c.ws);

  await expect(answer(c)).rejects.toThrow(`${c.target} there does not contain ${c.target} (\`board/${c.target}\`)`);

  expect(refsOf(c.ws)).toBe(refs);
  expect(takenIn(c.db)).toEqual([]);
});

it("作業台を開けなくても conflict の拒否は立ち、その理由を言い、答え直しが作業台を開く(pin A17)", async () => {
  const b = await boardWithParent();
  // 段の場所にファイルがあって作業台の dir を作れない
  writeFileSync(join(b.base, WORKBENCH_SEGMENT), "in the way\n");
  const child = await completedChild(b);
  const source = `task/${child.id}`;
  const purpose = quarantineQuestion(b.db, "workspace", b.ws.name)!.purpose;
  expect(purpose).toContain(`${source} does not merge cleanly into 'task/${b.parent.id}'. The board could not open the workbench (`);
  expect(purpose).toContain("answer again and it opens it again. ");
  expect(purpose).not.toContain("opened the workbench");
  rmSync(join(b.base, WORKBENCH_SEGMENT));

  const workbench = workbenchPath(b.base, `task/${b.parent.id}`);
  await expect(answer(b)).rejects.toThrow(`The board opened the workbench at ${realpathSync(b.base)}/${WORKBENCH_SEGMENT}/${b.parent.id} for it.`);

  expect(existsSync(workbench)).toBe(true);
});

it("何も指さない残骸の作業台は、同じ鍵が開くとき消されて書く先の ref から作り直される", async () => {
  const b = await boardWithParent();
  const target = `task/${b.parent.id}`;
  const leftover = workbenchPath(b.base, target);
  mkdirSync(leftover, { recursive: true });
  git(leftover, "init", "--quiet", "--initial-branch", target);
  commitWork(leftover, "stale.txt", "left behind\n");

  await completedChild(b);

  expect(git(leftover, "rev-parse", target)).toBe(git(b.ws.path, "rev-parse", target));
  expect(git(leftover, "config", "receive.denyCurrentBranch")).toBe("updateInstead");
  expect(existsSync(join(leftover, "stale.txt"))).toBe(false);
});

it("作業台に何も commit していない回答は何も取り込まず、merge back の conflict の文で拒み直す", async () => {
  const c = await conflicted();
  const refs = refsOf(c.ws);

  await expect(answer(c)).rejects.toThrow(`The board opened the workbench at ${c.workbench()} for it.`);

  expect(refsOf(c.ws)).toBe(refs);
  expect(takenIn(c.db)).toEqual([]);
});
