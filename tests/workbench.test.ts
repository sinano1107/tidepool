import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { permissionConfig } from "../src/codex-worker.js";
import type { Db } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { latestEventId, listEventsOfKinds } from "../src/events.js";
import { whyInvalidRegistryName } from "../src/registry-name.js";
import { buildSandboxSettings } from "../src/sandbox.js";
import { getTask, registerTask, type Task } from "../src/tasks.js";
import { workbenchPath } from "../src/workbench.js";
import { refValues, releaseWorkspace, runPlaceReadPaths, type WorkspaceConfig } from "../src/workspace.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";
import { answer, type Board, boardWithParent, type Conflicted, childOf, completedChild, conflicted, resolveInWorkbench } from "./workbench-fixture.js";

// 作業台と取り込み(ADR 0371、spec #3273 group A): merge back の conflict は作業台を開き、人間がそこで merge を commit して答えると
// 盤面がその tip を取り込む。入口は workspace の Quarantine の回答(受理の 11)。

// 取り込みが event を書く瞬間に人間の手を差し込む口 —— 既定は素通し
const eventHook = vi.hoisted(() => ({ onTakenIn: undefined as (() => void) | undefined }));
vi.mock("../src/events.js", async (importOriginal) => {
  const events = await importOriginal<typeof import("../src/events.js")>();
  const appendEvent: typeof events.appendEvent = (db, event) => {
    if (event.payload.kind === "workbench_taken_in") eventHook.onTakenIn?.();
    return events.appendEvent(db, event);
  };
  return { ...events, appendEvent };
});

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const refsOf = (ws: WorkspaceConfig) => `${git(ws.path, "symbolic-ref", "HEAD")}\n${git(ws.path, "for-each-ref", "--format=%(objectname) %(refname)")}`;


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

  // 鍵は (書く先, 運ばれる側) —— 運ばれる側の `/` は葉の中に符号化され、段を増やさない(ADR 0382 決定1)
  expect(key).toBe(`${c.parent.id}@task+s${c.child.id}`);
  // workspace の名前・面接室(root id)・task の checkout の鍵(`<id>`・`<id>.checkout`・`<id>.reads`)はどれも名前の規則に収まる
  expect(whyInvalidRegistryName(segment!)).toBeDefined();
});

it("作業台への push は名前の場所の ref を1つも動かさず、作業ツリーをその tip に揃える(pin A3)", async () => {
  const c = await conflicted();
  const clone = join(await tempDir("tidepool-own-clone-"), "clone");
  // URL の形(`ssh://` と同じく git が `%` を解く)で remote にしても在り処は変わらない(ADR 0382 決定1)
  git(c.base, "clone", "--quiet", "--branch", c.target, `file://${c.workbench()}`, clone);
  commitWork(clone, "notes.txt", "from my own clone\n");
  const before = refsOf(c.ws);

  git(clone, "push", "--quiet", "origin", c.target);

  expect(refsOf(c.ws)).toBe(before);
  expect(git(c.workbench(), "rev-parse", c.target)).toBe(git(clone, "rev-parse", "HEAD"));
  expect(git(c.workbench(), "status", "--porcelain")).toBe("");
});

// ADR 0382 決定1・4: local 着地の作業台は (workspace, 保護ブランチ, `task/<id>`) ごと。保護ブランチの葉は `@<workspace>` で始まり、
// `@<workspace>` だけの葉は人間自身の内容の作業台に残す —— どの葉も同じ段に並び、互いに入れ子にならない
it("保護ブランチを書く先にする作業台の葉は workspace と運ばれる側で分かれ、task を書く先にする葉と重ならない", () => {
  const leaves = [
    workbenchPath("/base", "main", "task/abc", "ws"),
    workbenchPath("/base", "main", "task/def", "ws"),
    workbenchPath("/base", "main", "task/abc", "ws2"),
    workbenchPath("/base", "task/abc", "origin/main"),
  ];

  expect(leaves.map((leaf) => relative("/base", leaf))).toEqual(["@workbench/@ws@task+sabc", "@workbench/@ws@task+sdef", "@workbench/@ws2@task+sabc", "@workbench/abc@origin+smain"]);
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
  const events = latestEventId(c.db);

  const refused = answer(c);

  await expect(refused).rejects.toThrow(DomainError);
  const message = await refused.catch((err: Error) => err.message);
  for (const element of says(c, workbench)) expect(message).toContain(element);
  expect(refsOf(c.ws)).toBe(refs);
  expect(latestEventId(c.db)).toBe(events);
  expect(quarantineQuestion(c.db, "workspace", c.ws.name)).toBeDefined();
});

it("解放が立てた Quarantine の理由は作業台を名指し、そこで merge を commit した後の1回の回答で取り込まれて受理され、作業台は消える(pin A5・A8)", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  const old = git(c.ws.path, "rev-parse", c.target);
  const question = quarantineQuestion(c.db, "workspace", c.ws.name)!;
  expect(question.purpose).toContain(`The board opened the workbench at ${workbench} for it. There, on ${c.target}, run \`git merge board/${c.source}\``);
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

  const workbench = realpathSync(workbenchPath(b.base, target, source));
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
  const workbench = realpathSync(workbenchPath(b.base, `task/${b.parent.id}`, `task/${child.id}`));
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
  const segment = dirname(workbenchPath(b.base, `task/${b.parent.id}`, "any"));
  writeFileSync(segment, "in the way\n");
  const child = await completedChild(b);
  const source = `task/${child.id}`;
  const purpose = quarantineQuestion(b.db, "workspace", b.ws.name)!.purpose;
  expect(purpose).toContain(`${source} does not merge cleanly into 'task/${b.parent.id}'. The board could not open the workbench (`);
  expect(purpose).toContain("answer again and it opens it again. ");
  expect(purpose).not.toContain("opened the workbench");
  rmSync(segment);

  const workbench = workbenchPath(b.base, `task/${b.parent.id}`, source);
  const refused = await answer(b).catch((err: Error) => err.message);

  expect(refused).toContain(`The board opened the workbench at ${realpathSync(workbench)} for it.`);
});

// ADR 0382 決定5: 開く手は指し手を数えず中身で決める —— 人間の作業が残っていない作業台と作りかけは作り直し、人間の commit は消さない。
// 何が「残っている」かは workbench-ownership.test.ts の表が言う
const cloneTarget = (leftover: string, b: Board) => git(b.ws.path, "clone", "--quiet", "--branch", `task/${b.parent.id}`, b.ws.path, leftover);
it.each<[string, (leftover: string, b: Board) => void, "remade" | "kept" | "unreadable"]>([
  [
    "tip が書く先の祖先で作業ツリーが clean な残骸は作り直される",
    (leftover, b) => {
      cloneTarget(leftover, b);
      git(leftover, "reset", "--quiet", "--hard", "HEAD~1");
    },
    "remade",
  ],
  // makeCheckout は init で HEAD を `main` に置き、書く先の branch を引く前に落ちうる
  ["書く先の branch が無い作りかけは作り直される", (leftover, b) => git(b.base, "init", "--quiet", "--initial-branch=main", leftover), "remade"],
  [
    "書く先に無い人間の commit を持つ作業台は作り直されず、拒否文が tip は運ばれる側を含まないと言う",
    (leftover, b) => {
      cloneTarget(leftover, b);
      commitWork(leftover, "stale.txt", "left behind\n");
    },
    "kept",
  ],
  [
    "読めない作業台は消されず、拒否文は人間が消してから答え直すよう言う",
    (leftover) => {
      mkdirSync(leftover);
      writeFileSync(join(leftover, ".git"), "gitdir: elsewhere\n");
    },
    "unreadable",
  ],
])("同じ鍵の作業台が既にあるとき、開く手は中身で決める —— %s", async (_case, leave, outcome) => {
  const b = await boardWithParent();
  const target = `task/${b.parent.id}`;
  let leftover = "";
  let source = "";
  await completedChild(b, {
    work: (_checkout, task) => {
      source = `task/${task.id}`;
      leftover = workbenchPath(b.base, target, source);
      mkdirSync(dirname(leftover), { recursive: true });
      leave(leftover, b);
    },
  });

  const purpose = quarantineQuestion(b.db, "workspace", b.ws.name)!.purpose;
  if (outcome === "unreadable") {
    expect(purpose).toContain(`${source} does not merge cleanly into '${target}'. The board cannot read the workbench at ${realpathSync(leftover)} (`);
    expect(purpose).toContain("); remove it by hand, then answer again. ");
    expect(readFileSync(join(leftover, ".git"), "utf8")).toBe("gitdir: elsewhere\n");
    return;
  }
  expect(git(leftover, "config", "--default", "", "receive.denyCurrentBranch")).toBe(outcome === "remade" ? "updateInstead" : "");
  if (outcome === "remade") {
    expect(git(leftover, "rev-parse", target)).toBe(git(b.ws.path, "rev-parse", target));
    expect(purpose).toContain(`The board opened the workbench at ${realpathSync(leftover)} for it. There`);
  } else {
    expect(git(leftover, "show", `${target}:stale.txt`)).toBe("left behind");
    expect(purpose).toContain(`The board opened the workbench at ${realpathSync(leftover)} for it; its tip does not contain ${source}. There`);
  }
});

it("取り込みの間に作業台へ着いた commit があれば、作業台は読まずに消されず残る", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  resolveInWorkbench(workbench, c.source);
  eventHook.onTakenIn = () => commitWork(workbench, "late.txt", "committed while the answer ran\n");
  try {
    await answer(c);
  } finally {
    eventHook.onTakenIn = undefined;
  }

  expect(quarantineQuestion(c.db, "workspace", c.ws.name)).toBeUndefined();
  expect(git(workbench, "show", `${c.target}:late.txt`)).toBe("committed while the answer ran");
  expect(git(c.ws.path, "ls-tree", "--name-only", c.target, "--", "late.txt")).toBe("");
});

// ADR 0382 決定2: tip が書く先のままでも HEAD が書く先の branch に居なければ、取り込むものが無いとは判定しない
it("作業台の HEAD が `board/*` に居れば、回答は HEAD を名指して拒まれ、引き直しはその commit で HEAD を切り離す", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  git(workbench, "checkout", "--quiet", `board/${c.source}`);
  const head = git(workbench, "rev-parse", "HEAD");
  const refs = refsOf(c.ws);

  await expect(answer(c)).rejects.toThrow(`its HEAD is not on ${c.target} — check out ${c.target} there`);

  expect(refsOf(c.ws)).toBe(refs);
  expect(() => git(workbench, "symbolic-ref", "-q", "HEAD")).toThrow();
  expect(git(workbench, "rev-parse", "HEAD")).toBe(head);
  expect(git(workbench, "rev-parse", c.target)).toBe(git(c.ws.path, "rev-parse", c.target));
  expect(git(workbench, "status", "--porcelain")).toBe("");
});

// ADR 0382 決定2・5: 作業ツリーが tip と同じでも merge の途中なら人間の作業が残っている —— 回答は拒まれ、作業台は作り直されない
it("作業ツリーが tip と同じ途中の merge(`-s ours --no-commit`)が残る作業台への回答は拒まれ、何も書かず、途中の merge は消えない", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  git(workbench, "merge", "--quiet", "-s", "ours", "--no-commit", `board/${c.source}`);
  const mergeHead = git(workbench, "rev-parse", "MERGE_HEAD");
  const refs = refsOf(c.ws);
  const events = latestEventId(c.db);

  await expect(answer(c)).rejects.toThrow(
    `the workbench at ${workbench} has nothing new on ${c.target}, but a merge is in progress — commit it on ${c.target} or run \`git merge --abort\`. Then answer again.`,
  );

  expect(refsOf(c.ws)).toBe(refs);
  expect(latestEventId(c.db)).toBe(events);
  expect(git(workbench, "rev-parse", "MERGE_HEAD")).toBe(mergeHead);
});

/** merge back を後始末で撃たずに Quarantine を立てる解放(token の失敗)—— 子の merge back は受理がやり直す。 */
const deferMergeBack = (b: Board) => (place: Parameters<typeof releaseWorkspace>[1], task: Parameters<typeof releaseWorkspace>[2]) =>
  releaseWorkspace(b.db, place, task, b.clock.now(), true, undefined, new Error("GitHub token acquisition failed"), true);

// ADR 0382 決定1・6: 入口は自分の鍵の作業台しか読まない。別の子の作業台の古い tip も、自分の鍵の作りかけも、clean な merge back を止めない
it.each<[string, (b: Board, clean: string) => string]>([
  [
    "別の子 X の作業台に書く先の祖先の古い tip がある",
    (b) => {
      const other = registerTask(b.db, { type: "work", title: "x", purpose: "why", completion_criteria: "done", parent_id: b.parent.id }, b.clock.now(), ...HUMAN_WEBUI);
      const leftover = workbenchPath(b.base, `task/${b.parent.id}`, `task/${other.id}`);
      mkdirSync(dirname(leftover), { recursive: true });
      git(b.ws.path, "clone", "--quiet", "--branch", `task/${b.parent.id}`, b.ws.path, leftover);
      git(leftover, "reset", "--quiet", "--hard", "HEAD~1");
      return leftover;
    },
  ],
  [
    "子 Y 自身の鍵に書く先の branch の無い作りかけがある",
    (b, clean) => {
      const leftover = workbenchPath(b.base, `task/${b.parent.id}`, clean);
      mkdirSync(dirname(leftover), { recursive: true });
      git(b.base, "init", "--quiet", "--initial-branch=main", leftover);
      return leftover;
    },
  ],
])("%sとき、受理の回答は clean な子 Y を盤面が運んで受理される", async (_case, leave) => {
  const b = await boardWithParent();
  let leftover = "";
  const y = await completedChild(b, {
    file: "y.txt",
    work: (_checkout, task) => {
      leftover = leave(b, `task/${task.id}`);
    },
    release: deferMergeBack(b),
  });

  await answer(b);

  expect(quarantineQuestion(b.db, "workspace", b.ws.name)).toBeUndefined();
  expect(git(b.ws.path, "merge-base", "--is-ancestor", `task/${y.id}`, `task/${b.parent.id}`)).toBe("");
  expect(takenIn(b.db)).toEqual([]);
  expect(existsSync(leftover)).toBe(true);
});

// ADR 0382 決定1・2: 人間の tip を持つ作業台の取り込みは、盤面の手の merge より先に —— 運ぶ順(新しい子から)に依らず1回で受理される
it.each([
  ["X の登録が先", true],
  ["Y の登録が先", false],
])("子 X の作業台で人間が X を merge し、子 Y が clean なら、回答は X を取り込み Y を盤面が運んで1回で受理される —— %s", async (_case, xFirst) => {
  const b = await boardWithParent();
  // 登録の新しいほうから運ぶ —— X が古ければ盤面は Y を先に運ぼうとする
  const [x, y] = xFirst ? [childOf(b), childOf(b)] : [childOf(b), childOf(b)].reverse() as [Task, Task];
  await completedChild(b, { child: x });
  await completedChild(b, { child: y, file: "y.txt", release: deferMergeBack(b) });
  const target = `task/${b.parent.id}`;
  resolveInWorkbench(realpathSync(workbenchPath(b.base, target, `task/${x.id}`)), `task/${x.id}`);

  await answer(b);

  expect(quarantineQuestion(b.db, "workspace", b.ws.name)).toBeUndefined();
  expect(git(b.ws.path, "show", `${target}:work.txt`)).toBe("from the parent\nfrom the child");
  expect(git(b.ws.path, "ls-tree", "--name-only", target)).toBe("README.md\nwork.txt\ny.txt");
  expect(takenIn(b.db)).toHaveLength(1);
});
