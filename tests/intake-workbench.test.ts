import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEventsOfKinds } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
import { quarantineStops } from "../src/quarantine.js";
import { cancelTaskDirectly, completeTask, getTask, listBoard, nextSlotTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { workbenchPath } from "../src/workbench.js";
import {
  holdsBaseline,
  openHumanContentWorkbench,
  openIntakeQuestionId,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  releaseWorkspace,
  takeWorkspaceInFlightKey,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { openWorkspaceWorkbench } from "../src/workspace-create.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, prepareAtPickup, seedTaskBranch, WORKER_SPAWNED, withPushDuringWrap } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

// `open_workbench` と `intake` question(ADR 0371 決定6 / ADR 0382 決定4〜6、spec #3273 group A の pin A7・A11・A13〜A15・B12 の intake の分)を
// domain 層で述べる。回答は人間の回答の verb を通す。人間面の写像は tests/open-workbench-boundary.test.ts。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const CALLER = { actorId: HUMAN_ACTOR_ID, origin: "webui" } as const;

/** purely-local の workspace と、基準を撮った pickup を1度済ませた盤面(`take in` は保護ブランチが基準と一致することを求める)。
 *  `pending` はその pickup の task —— 未決着で、タスクブランチに `pending.txt` の commit を持つ。`parent` は pickup されていない未決着の
 *  work で、`task/<parent>` を main に持つ(子の帰り先 —— 名前の場所の ref は最初の pickup の前に作る)。 */
async function board(name = "intake") {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace(name);
  const base = await tempDir("tidepool-workbenches-");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
  seedTaskBranch(db, ws, parent.id, "main");
  const pending = await taskWithCommit(db, clock, ws, "pending.txt");
  const open = () => openHumanContentWorkbench(db, ws, base, CALLER, () => clock.now(), { resolveRegistered: undefined });
  const workbench = () => realpathSync(workbenchPath(base, { workspace: ws.name }));
  const question = () => getTask(db, openIntakeQuestionId(db, ws.name)!)!;
  const answer = (option: string, workspace: WorkspaceConfig = ws, q: Task = question()) =>
    submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, workspace, workspacesDir: base }, q, [option], undefined, () => clock.now(), "webui");
  /** 今の保護ブランチを控え、拒否が何も書いていないこと(保護ブランチ・event・question)を確かめる手を返す。 */
  const unchanged = () => {
    const main = git(ws.path, "rev-parse", "refs/heads/main");
    const id = question().id;
    return () => {
      expect(git(ws.path, "rev-parse", "refs/heads/main")).toBe(main);
      expect(listEventsOfKinds(db, ["workbench_taken_in"])).toEqual([]);
      expect(getTask(db, id)?.status).toBe("todo");
    };
  };
  return { db, clock, ws, base, parent, pending, open, workbench, question, answer, unchanged };
}

type Board = Awaited<ReturnType<typeof board>>;

/** pickup してタスクブランチに `file` の commit を1つ載せ、解放した(merge back はしない)task。 */
async function taskWithCommit(db: Db, clock: FakeClock, ws: WorkspaceConfig, file: string) {
  const task = registerTask(db, { type: "work", title: file, purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, ws, task);
  commitWork(place.path, file, `${file}\n`);
  releaseWorkspace(db, place, task, clock.now());
  return task;
}

/** pickup してタスクブランチに `file` の commit を1つ記録し、完了させた work(`parent` の子にもできる)。 */
async function completedWork(b: Board, file: string, parent?: Task): Promise<Task> {
  const registered = registerTask(b.db, { type: "work", title: file, purpose: "why", completion_criteria: "done", parent_id: parent?.id }, b.clock.now(), ...HUMAN_WEBUI);
  const task = pickupTask(b.db, registered, "deckhand", b.clock.now())!;
  const place = await prepareAtPickup(b.db, b.ws, task, { now: b.clock.now() });
  appendEvent(b.db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  commitWork(place.path, file, `${file}\n`);
  recordTaskCheckoutTip(b.db, place, task.id);
  completeTask(b.db, task, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  return getTask(b.db, task.id)!;
}

/** `task` の着地 question(purely-local の根)。 */
function landingQuestion(b: Board, task: Task): Task {
  return registerTask(
    b.db,
    {
      type: "question",
      title: "land it",
      purpose: "a human decides whether to land",
      completion_criteria: "the answer is recorded",
      question: [{ title: "land it", options: ["merge", "hold"], recommendation: "merge" }],
      question_kind: { kind: "local_merge", task_id: task.id, tip: null },
    },
    b.clock.now(),
    ...HUMAN_WEBUI,
  );
}

/** spec #3273 text A14。 */
const opened = (b: Board, held = "") =>
  `opened the workbench at ${b.workbench()} for main of workspace ${b.ws.name}; answer question ${b.question().id} when your commits are there.${held}`;

/** spec #3273 への上書き(ADR 0382 決定4): 作業台が保護ブランチに無い commit をすでに持つときの句。 */
const HELD = " The workbench already holds commits that main does not have; to start over from the board's value, run `git reset --hard board/main` there.";

/** spec #3273 text C6。 */
const tookIn = (tip: string, commit: string, merge = "") =>
  `took ${tip} in as ${commit} on main. In a clone, fetch the workbench and fast-forward to \`board/main\` before you write on.${merge}`;

// pin A13: 1度目は作業台を開いて question を1つ立て、2度目は何も変えない
it("open_workbench は (workspace, 保護ブランチ) の作業台を開いて intake question を1つ立て、2度目は question を立てず作業台の commit も動かさない", async () => {
  const b = await board();

  const first = await b.open();

  const q = b.question();
  expect(first).toBe(opened(b));
  expect(b.workbench()).toBe(realpathSync(join(b.base, "@workbench", `@${b.ws.name}`)));
  expect(git(b.workbench(), "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(b.workbench(), "rev-parse", "main")).toBe(git(b.ws.path, "rev-parse", "main"));
  expect(q).toMatchObject({
    type: "question",
    status: "todo",
    workspace: b.ws.name,
    title: `take in commits for main of workspace ${b.ws.name}`,
    purpose:
      `You opened the workbench at ${b.workbench()}. Commit on main there (or, in your own clone with the workbench as a remote: fetch it, ` +
      "`git merge <remote>/board/main`, and push main to it). `take in`: the board checks the tip and writes it to main. `close`: closes this " +
      "question and takes nothing in; the workbench stays on disk.",
    question_items: [{ title: `take in commits for main of workspace ${b.ws.name}`, options: ["take in", "close"], recommendation: "take in" }],
  });

  commitWork(b.workbench(), "notes.txt", "the human's\n");
  const tip = git(b.workbench(), "rev-parse", "main");
  const second = await b.open();

  expect(second).toBe(opened(b, HELD));
  expect(listBoard(b.db).filter((task) => task.type === "question").map(({ id }) => id)).toEqual([q.id]);
  expect(git(b.workbench(), "rev-parse", "main")).toBe(tip);
});

// pin A13: question が開いていて作業台が disk にあれば、2度目は作業台に何もしない —— 人間の作業が何も無い作業台も作り直さない
// (作業台に足した remote が残る)
it("question が開いていて作業台が disk にあれば、2度目の open_workbench は作業台に触れず question も立てない", async () => {
  const b = await board();
  await b.open();
  const q = b.question();
  git(b.workbench(), "remote", "add", "mine", "/somewhere/else");

  expect(await b.open()).toBe(opened(b));

  expect(listBoard(b.db).filter((task) => task.type === "question").map(({ id }) => id)).toEqual([q.id]);
  expect(git(b.workbench(), "remote")).toBe("mine");
});

// pin A13: remote-backed の保護ブランチは origin で変える(text A9)。何も開かず何も立てない
it("open_workbench は remote-backed の workspace を text A9 で拒み、作業台も question も作らない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("intake-remote");
  const db = openDb(":memory:");
  const base = await tempDir("tidepool-workbenches-");

  await expect(openHumanContentWorkbench(db, workspace, base, CALLER, () => new Date(), { resolveRegistered: undefined })).rejects.toThrow(
    new DomainError(
      `workspace ${workspace.name} is remote-backed, so main is changed on origin. Put the change into origin's main — a fast-forward push from your own clone, ` +
        `or a merge of your own PR. Never push from ${workspace.path}. Tasks that have already forked do not get it; it takes effect from the next fork.`,
    ),
  );
  expect(existsSync(workbenchPath(base, { workspace: workspace.name }))).toBe(false);
  expect(openIntakeQuestionId(db, workspace.name)).toBeUndefined();
});

// pin A13: 名前は registry に登録された workspace のものだけ —— 面接室(root の id の名前)は登録されないので通らない(#3184)
it.each(["登録されていない名前", "面接室の名前"])("open_workbench は%sを拒み、何も立てない", async (which) => {
  const ws = await makeWorkspace("intake-registered");
  const registryDir = await makeRegistry({ "workspaces.yaml": `${ws.name}:\n  path: ${ws.path}\n` });
  const db = openDb(":memory:");
  const base = await tempDir("tidepool-workbenches-");
  const name =
    which === "面接室の名前"
      ? registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: ws.name, interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, new Date(), ...HUMAN_WEBUI).id
      : "nowhere";

  await expect(openWorkspaceWorkbench({ name }, "webui", { registry: { dir: registryDir, mode: "purely-local" }, workspacesBaseDir: base, db })).rejects.toThrow(UnknownWorkspaceError);
  expect(openIntakeQuestionId(db, name)).toBeUndefined();
  expect(existsSync(workbenchPath(base, { workspace: name }))).toBe(false);
});

/** 名前を引く registry の口(登録された workspace だけを返す)。 */
const registryOf =
  (...registered: WorkspaceConfig[]) =>
  (name: string | null): WorkspaceConfig => {
    const found = registered.find((workspace) => workspace.name === name);
    if (!found) throw new UnknownWorkspaceError(name ?? "");
    return found;
  };

/** 一度も pickup されていない purely-local の workspace と、別の workspace `other`(`holdsBaseline` で基準の行を持たせられる)。 */
async function untouched() {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("intake-untouched");
  const other = await makeWorkspace("intake-other");
  const base = await tempDir("tidepool-workbenches-");
  const open = (resolveRegistered: (name: string | null) => WorkspaceConfig = registryOf(ws, other)) =>
    openHumanContentWorkbench(db, ws, base, CALLER, () => clock.now(), { resolveRegistered });
  /** `other` を pickup して基準の行を撮る。 */
  const captureOther = async () => {
    const task = registerTask(db, { type: "work", title: "other", purpose: "why", completion_criteria: "done", workspace: other.name }, clock.now(), ...HUMAN_WEBUI);
    const place = await prepareAtPickup(db, other, task, { resolveRegistered: registryOf(ws, other) });
    releaseWorkspace(db, place, task, clock.now());
  };
  return { db, clock, ws, other, base, open, captureOther };
}

// ADR 0383 決定1・2: 盤面がまだ触れていない workspace は open_workbench が最初の撮りをする —— それまでに checkout に直接書いた commit は基準に入り、
// take in は Quarantine を立てずに取り込む
it("一度も pickup されていない purely-local の workspace でも、open_workbench が最初の撮りをし、take in が Quarantine を立てずに取り込む", async () => {
  const u = await untouched();
  commitWork(u.ws.path, "direct.txt", "written before the board touched it\n");

  await u.open();

  expect(holdsBaseline(u.db, u.ws.name)).toBe(true);
  const workbench = realpathSync(workbenchPath(u.base, { workspace: u.ws.name }));
  commitWork(workbench, "notes.txt", "the human's\n");
  const question = getTask(u.db, openIntakeQuestionId(u.db, u.ws.name)!)!;
  await submitAnswer({ db: u.db, pollNow: () => {}, landing: unusedLanding, workspace: u.ws, workspacesDir: u.base }, question, ["take in"], undefined, () => u.clock.now(), "webui");
  expect(git(u.ws.path, "show", "main:notes.txt")).toBe("the human's");
  expect(git(u.ws.path, "show", "main:direct.txt")).toBe("written before the board touched it");
  expect(listBoard(u.db).filter((task) => task.question_quarantine_kind !== null)).toEqual([]);
});

// ADR 0383 決定2: 最初の撮りの準備に落ちれば、作業台も question も開かず基準も撮らず、止めた Quarantine を名指して拒む(text C1a の形)
it.each<[string, (u: Awaited<ReturnType<typeof untouched>>) => Promise<string>]>([
  [
    "基準の行を持つ別の workspace の Quarantine が開いている(ADR 0373 決定13 追記の待ち)",
    async (u) => {
      await u.captureOther();
      quarantineWorkspace(u.db, u.other.name, new Error("broken"), u.clock.now());
      return u.other.name;
    },
  ],
  [
    "基準の行を持つ別の workspace の ref が休止中に動いた(決定13 の確認)",
    async (u) => {
      await u.captureOther();
      commitWork(u.other.path, "moved.txt", "moved by hand\n");
      return u.other.name;
    },
  ],
  [
    "checkout が宣言の無い origin を持つ(pickup が開く前に掛ける項)",
    async (u) => {
      git(u.ws.path, "remote", "add", "origin", "/somewhere/else");
      return u.ws.name;
    },
  ],
])("open_workbench は最初の撮りの準備に落ちれば何も開かず何も撮らない —— %s", async (_case, arrange) => {
  const u = await untouched();
  const stoppedBy = await arrange(u);

  const refused = u.open();

  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow(
    `cannot open a workbench: workspace ${stoppedBy} is quarantined — answer question ${listBoard(u.db).find((t) => t.question_quarantine_kind === "workspace" && t.question_quarantine_value === stoppedBy)?.id} first.`,
  );
  expect(existsSync(workbenchPath(u.base, { workspace: u.ws.name }))).toBe(false);
  expect(openIntakeQuestionId(u.db, u.ws.name)).toBeUndefined();
  expect(holdsBaseline(u.db, u.ws.name)).toBe(false);
});

// ADR 0383 決定2: registry が読めない落ち方は Quarantine を立てず、その理由を言う
it("最初の撮りの確認が registry を読めなければ、open_workbench は Quarantine を立てずにその理由を言い、何も開かない", async () => {
  const u = await untouched();
  await u.captureOther();

  await expect(
    u.open(() => {
      throw new Error("registry unreadable");
    }),
  ).rejects.toThrow(new DomainError("cannot open a workbench: the board could not read the registry (registry unreadable)."));
  expect(listBoard(u.db).filter((task) => task.question_quarantine_kind !== null)).toEqual([]);
  expect(existsSync(workbenchPath(u.base, { workspace: u.ws.name }))).toBe(false);
  expect(openIntakeQuestionId(u.db, u.ws.name)).toBeUndefined();
});

// ADR 0383 決定2: 答える時点で基準の行が無いのは盤面 DB の直接の書き換えだけ —— Quarantine を立てずに開き直しを言う
it("答える時点で基準の行が無ければ、take in は Quarantine を立てずに作業台の開き直しを言って拒む", async () => {
  const b = await board();
  await b.open();
  commitWork(b.workbench(), "notes.txt", "the human's\n");
  b.db.prepare("DELETE FROM workspace_state WHERE name = ?").run(b.ws.name);
  const nothingWritten = b.unchanged();

  await expect(b.answer("take in")).rejects.toThrow(
    new DomainError(`the board holds no baseline for workspace ${b.ws.name}, so it cannot check main — open the workbench again (\`open_workbench\`), then answer again.`),
  );
  nothingWritten();
  expect(listBoard(b.db).filter((task) => task.question_quarantine_kind !== null)).toEqual([]);
});

// pin A13: intake question は Quarantine ではない —— pickup を止めない
it("intake question が開いていても、その workspace の task は pickup の候補に残る", async () => {
  const b = await board();
  await b.open();
  const next = registerTask(b.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done", workspace: b.ws.name }, b.clock.now(), ...HUMAN_WEBUI);

  const head = nextSlotTask(b.db, b.ws.name, "deckhand", undefined, quarantineStops(b.db));

  expect([b.parent.id, b.pending.id, next.id]).toContain(head?.id);
});

// pin A13 / pin A11: `close` は何も取り込まず作業台を disk に残し、開き直すと作業台の commit はそのまま
it("close は question を閉じるだけで何も取り込まず作業台を残し、開き直すと残った commit を言って新しい question を立てる", async () => {
  const b = await board();
  await b.open();
  const first = b.question();
  commitWork(b.workbench(), "notes.txt", "the human's\n");
  const tip = git(b.workbench(), "rev-parse", "main");
  const main = git(b.ws.path, "rev-parse", "main");

  await b.answer("close");

  expect(getTask(b.db, first.id)).toMatchObject({ status: "done", question_answer: ["close"] });
  expect(git(b.ws.path, "rev-parse", "main")).toBe(main);
  expect(listEventsOfKinds(b.db, ["workbench_taken_in"])).toEqual([]);
  expect(git(b.workbench(), "rev-parse", "main")).toBe(tip);
  expect(await b.open()).toBe(opened(b, HELD));
  expect(b.question().id).not.toBe(first.id);
  expect(b.question().purpose).toContain(HELD);
  expect(git(b.workbench(), "rev-parse", "main")).toBe(tip);
});

// ADR 0382 決定5 / override: question が開いていて作業台が disk に無ければ、open_workbench が作り直す
it("question が開いたまま作業台が disk から消えていれば、open_workbench は同じ question のまま作業台を作り直す", async () => {
  const b = await board();
  await b.open();
  const q = b.question();
  execFileSync("rm", ["-rf", b.workbench()]);

  expect(await b.open()).toBe(opened(b));

  expect(b.question().id).toBe(q.id);
  expect(git(b.workbench(), "rev-parse", "main")).toBe(git(b.ws.path, "rev-parse", "main"));
});

// #3587: 判定が作業台に撃つ git が作業台の `.git` を読めなければ、開き直しでは直らない —— question が開いていてもいなくても手で消す文
it.each(["開いて", "閉じて"])("intake question が%sいるとき、作業台の .git/config が壊れていれば、open_workbench は作業台を名指して手で消してから開き直すよう言う", async (state) => {
  const b = await board();
  await b.open();
  if (state === "閉じて") await b.answer("close");
  writeFileSync(join(b.workbench(), ".git", "config"), "not a config\n");

  const refused = b.open();

  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow(`the board cannot read the workbench at ${workbenchPath(b.base, { workspace: b.ws.name })} (`);
  await expect(refused).rejects.toThrow("); remove it by hand, then open it again.");
  // 括弧の中は git の失敗だけ —— 作業台の名指しを重ねない
  await expect(refused).rejects.not.toThrow("(the workbench at ");
  expect(existsSync(b.workbench())).toBe(true);
});

// pin A7 / pin A15: 人間しか書けない path も取り込み、作業台は残してその branch を包む commit へ進め、`board/main` も新しい値になる
it("take in は人間しか書けない path を含む tip を包む commit で保護ブランチへ取り込み、作業台の branch を包む commit へ進めて clean のまま残す", async () => {
  const b = await board();
  await b.open();
  const before = git(b.ws.path, "rev-parse", "main");
  commitWork(b.workbench(), ".mcp.json", "{}\n");
  const tip = git(b.workbench(), "rev-parse", "main");

  const answered = await b.answer("take in");

  const commit = git(b.ws.path, "rev-parse", "main");
  expect(answered.notice).toBe(tookIn(tip, commit));
  expect(git(b.ws.path, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1)).toEqual([before, tip]);
  expect(git(b.ws.path, "rev-parse", `${commit}^{tree}`)).toBe(git(b.ws.path, "rev-parse", `${tip}^{tree}`));
  expect(git(b.ws.path, "show", "main:.mcp.json")).toBe("{}");
  expect(listEventsOfKinds(b.db, ["workbench_taken_in"]).map(({ actor_id, payload }) => ({ actor_id, payload }))).toEqual([
    { actor_id: HUMAN_ACTOR_ID, payload: { kind: "workbench_taken_in", workspace: b.ws.name, target: "refs/heads/main", tip, commit, entry: "intake_question" } },
  ]);
  expect(getTask(b.db, answered.id)).toMatchObject({ status: "done", question_answer: ["take in"] });
  expect(git(b.workbench(), "rev-parse", "main")).toBe(commit);
  expect(git(b.workbench(), "rev-parse", "board/main")).toBe(commit);
  expect(git(b.workbench(), "status", "--porcelain")).toBe("");
});

/** 一度取り込んだ `sub/kept.txt` の blob を名前の場所から消し、作業台は自前の store に持ったまま root に1 commit 積んで question を開き直す
 *  (取り込んでいない commit があるので作業台は作り直されない)—— 次の取り込みの pack は除外で blob も `sub` の tree も入れず、fetch も
 *  送らない。blob の id を返す。 */
async function holeHeldByWorkbench(b: Board): Promise<string> {
  await b.open();
  mkdirSync(join(b.workbench(), "sub"));
  commitWork(b.workbench(), "sub/kept.txt", "kept by the human\n");
  await b.answer("take in");
  const blob = git(b.ws.path, "rev-parse", "main:sub/kept.txt");
  rmSync(join(b.ws.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  commitWork(b.workbench(), "more.txt", "more\n");
  await b.open();
  return blob;
}

it("名前の場所から欠けた blob を作業台が自前の store に持てば、取り込みの確かめが捕まえて入れ直し、名前の場所で読める(ADR 0388 決定1・2 / ADR 0371)", async () => {
  const b = await board();
  const blob = await holeHeldByWorkbench(b);

  await b.answer("take in");

  expect(git(b.ws.path, "show", "main:more.txt")).toBe("more");
  expect(git(b.ws.path, "cat-file", "-p", blob)).toBe("kept by the human");
});

it("入れ直しが落ちれば取り込みは拒まれ、書く先の ref も workbench_taken_in も書かれず、理由が欠けた object を名指す(ADR 0388 決定1・2)", async () => {
  const b = await board();
  const blob = await holeHeldByWorkbench(b);
  const main = git(b.ws.path, "rev-parse", "main");
  const pack = join(b.ws.path, ".git", "objects", "pack");
  chmodSync(pack, 0o555);
  try {
    await expect(b.answer("take in")).rejects.toThrow(blob);
  } finally {
    chmodSync(pack, 0o755);
  }

  expect(git(b.ws.path, "rev-parse", "main")).toBe(main);
  expect(listEventsOfKinds(b.db, ["workbench_taken_in"])).toHaveLength(1);
});

// pin A15: 読んだ tip からの CAS —— 間に push が着けば作業台の branch は人間のまま残し、`board/main` を merge するよう言う
it("取り込みの間に作業台へ push が着けば、作業台の branch は進めず、応答が board/main の merge を言い、board/main は新しい値になる", async () => {
  const b = await board();
  await b.open();
  commitWork(b.workbench(), "notes.txt", "the human's\n");
  const tip = git(b.workbench(), "rev-parse", "main");
  // 包む commit を作る瞬間に、人間の clone からの push を模して作業台の main に commit を足す
  const answered = await withPushDuringWrap(b.workbench(), () => b.answer("take in"));

  const commit = git(b.ws.path, "rev-parse", "main");
  expect(answered.notice).toBe(tookIn(tip, commit, " Merge `board/main` into your branch before the next take-in."));
  expect(git(b.workbench(), "rev-parse", "main^")).toBe(tip);
  expect(git(b.workbench(), "log", "-1", "--format=%s", "main")).toBe("pushed");
  expect(git(b.workbench(), "rev-parse", "board/main")).toBe(commit);
});

// pin A14: 4つの拒否と、拒否が何も書かないこと
it.each<[string, (b: Board) => void | Promise<void>, (b: Board) => string]>([
  [
    "workspace の Quarantine が開いている(text A8a)",
    (b) => {
      commitWork(b.workbench(), "notes.txt", "the human's\n");
      quarantineWorkspace(b.db, b.ws.name, new Error("broken"), b.clock.now());
    },
    (b) => `workspace ${b.ws.name} is quarantined — answer question ${listBoard(b.db).find((t) => t.question_quarantine_kind === "workspace")!.id} first.`,
  ],
  ["tip が保護ブランチと同じ(text A8b)", () => {}, (b) => `nothing to take in: main in the workbench at ${b.workbench()} is the value the board already has.`],
  [
    "tip が未決着の task のブランチの commit を含む(text A8c)",
    (b) => git(b.workbench(), "merge", "--no-edit", `board/task/${b.pending.id}`),
    (b) =>
      `the tip of the workbench at ${b.workbench()} contains commits of task/${b.pending.id}, and that task's work enters main only through its landing — ` +
      "it has not landed yet. To take in only your own commits, start main in the workbench over with `git reset --hard board/main`, commit them again and answer again.",
  ],
  [
    "書き込む tree が隠せない形を持つ",
    (b) => commitWork(b.workbench(), ".claude", "a file\n"),
    (b) => `the tip of the workbench at ${b.workbench()} changes .claude, which is a shape the board cannot hide; take that change out and commit, then answer again.`,
  ],
  [
    "commit していない変更がある(text A7b)",
    (b) => {
      commitWork(b.workbench(), "notes.txt", "the human's\n");
      writeFileSync(join(b.workbench(), "notes.txt"), "not committed\n");
    },
    (b) => `the workbench at ${b.workbench()} has uncommitted changes — commit or discard them, then answer again.`,
  ],
  [
    "保護ブランチが基準と違う(local 着地の merge と同じ条件)",
    (b) => {
      commitWork(b.workbench(), "notes.txt", "the human's\n");
      commitWork(b.ws.path, "out-of-band.txt", "moved by hand\n");
    },
    (b) => `workspace ${b.ws.name}: protected branch 'main' moved out of band`,
  ],
  [
    "作業台が書く先の branch の無い作りかけ(ADR 0382 決定6)",
    (b) => {
      execFileSync("rm", ["-rf", b.workbench()]);
      git(".", "init", "--quiet", "--initial-branch=other", workbenchPath(b.base, { workspace: b.ws.name }));
    },
    // 文は workbench-ownership.test.ts が固定する —— ここは `take in` が盤面の手の無い入口として判定を呼ぶことだけ
    (b) => `the workbench at ${b.workbench()} has no main branch`,
  ],
])("take in は拒めば何も書かない —— %s", async (_case, write, says) => {
  const b = await board();
  await b.open();
  await write(b);
  const nothingWritten = b.unchanged();

  const refused = b.answer("take in");

  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow(says(b));
  nothingWritten();
});

// text A8c: 着地を待つ task は、その着地 question を名指す
it("take in は着地 question が開いている task のブランチの commit を含む tip を、その question を名指して拒む", async () => {
  const b = await board();
  const landing = landingQuestion(b, b.pending);
  await b.open();
  git(b.workbench(), "merge", "--no-edit", `board/task/${b.pending.id}`);
  const nothingWritten = b.unchanged();

  await expect(b.answer("take in")).rejects.toThrow(`that task's work enters main only through its landing — answer \`merge\` on question ${landing.id}.`);
  nothingWritten();
});

// pin A14 / ADR 0382 決定4: done の子の内容は根の着地で入る —— 子のブランチの commit を含む tip は、その根の着地 question を名指して拒む
it("take in は done の子のブランチの commit を含む tip を、その内容が着地する根の着地 question を名指して拒む", async () => {
  const b = await board();
  const child = await completedWork(b, "child.txt", b.parent);
  const landing = landingQuestion(b, b.parent);
  await b.open();
  git(b.workbench(), "merge", "--no-edit", `board/task/${child.id}`);
  const nothingWritten = b.unchanged();

  await expect(b.answer("take in")).rejects.toThrow(
    `contains commits of task/${child.id}, and that task's work enters main only through its landing — answer \`merge\` on question ${landing.id}.`,
  );
  nothingWritten();
});

// pin A14 / ADR 0382 決定4: hold した根は着地待ち —— その commit を含む tip は拒む
it("take in は着地を hold した根のブランチの commit を含む tip を拒む", async () => {
  const b = await board();
  const root = await completedWork(b, "held.txt");
  await submitAnswer({ db: b.db, pollNow: () => {}, landing: unusedLanding, workspace: b.ws, workspacesDir: b.base }, landingQuestion(b, root), ["hold"], undefined, () => b.clock.now(), "webui");
  await b.open();
  git(b.workbench(), "merge", "--no-edit", `board/task/${root.id}`);
  const nothingWritten = b.unchanged();

  await expect(b.answer("take in")).rejects.toThrow(`contains commits of task/${root.id}, and that task's work enters main only through its landing — it has not landed yet.`);
  nothingWritten();
});

// pin A14: 祖先だけを見る —— cancel した task のブランチの merge と、未決着の task の commit の cherry-pick は人間の内容として入る
it.each<[string, (b: Board) => void]>([
  [
    "cancel した task のブランチを merge した",
    (b) => {
      cancelTaskDirectly(b.db, getTask(b.db, b.pending.id)!, null, b.clock.now(), {}, "webui");
      git(b.workbench(), "merge", "--no-edit", `board/task/${b.pending.id}`);
    },
  ],
  // `-x` で写しの message を変える —— 同じ親・同じ秒の cherry-pick は元と同じ commit になる
  ["未決着の task の commit を cherry-pick した", (b) => git(b.workbench(), "cherry-pick", "-x", `board/task/${b.pending.id}`)],
])("take in は %s tip を取り込む", async (_case, write) => {
  const b = await board();
  await b.open();
  write(b);

  await b.answer("take in");

  expect(git(b.ws.path, "show", "main:pending.txt")).toBe("pending.txt");
});

// pin A14 / ADR 0382 決定4: cancel した親の下の done の子は着地しない —— そのブランチの merge は人間の内容として入る
it("take in は cancel した親の下の done の子のブランチを merge した tip を取り込む", async () => {
  const b = await board();
  const child = await completedWork(b, "child.txt", b.parent);
  cancelTaskDirectly(b.db, getTask(b.db, b.parent.id)!, null, b.clock.now(), {}, "webui");
  expect(getTask(b.db, child.id)?.status).toBe("done");
  await b.open();
  git(b.workbench(), "merge", "--no-edit", `board/task/${child.id}`);

  await b.answer("take in");

  expect(git(b.ws.path, "show", "main:child.txt")).toBe("child.txt");
});

// pin A14: purely-local であることは答えるときに確かめ直す(text A8d)
it("question を開いた後に workspace が remote-backed になれば、take in は text A8d で拒み何も書かない", async () => {
  const b = await board();
  await b.open();
  commitWork(b.workbench(), "notes.txt", "the human's\n");
  const origin = await tempDir("tidepool-intake-origin-");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  const published = { ...b.ws, repo: origin };
  // 公開を終えた行: 覚えた repo は宛先だけ(予告のままの行は宣言の無い旧い値も通す —— ADR 0391 決定2)
  b.db.prepare("UPDATE workspace_state SET remembered_repo = ? WHERE name = ?").run(JSON.stringify(origin), b.ws.name);
  const nothingWritten = b.unchanged();

  await expect(b.answer("take in", published)).rejects.toThrow(
    new DomainError(
      `workspace ${b.ws.name} is remote-backed now, so main is changed on origin. Put the change into origin's main — a fast-forward push from your own clone, ` +
        `or a merge of your own PR. Never push from ${b.ws.path}. Tasks that have already forked do not get it; it takes effect from the next fork. ` +
        `Commits you made in the workbench at ${b.workbench()} are not taken in: fetch them from the workbench into your own clone and carry them from there. Answer \`close\`.`,
    ),
  );
  nothingWritten();
});

// pin B12 の intake の分: 同じ workspace の別の回答か操作を検査している間は text B5 で拒む
it("同じ workspace の in-flight の鍵が取られている間、take in は text B5 で拒み何も書かない", async () => {
  const b = await board();
  await b.open();
  commitWork(b.workbench(), "notes.txt", "the human's\n");
  const nothingWritten = b.unchanged();
  const release = takeWorkspaceInFlightKey(b.db, b.ws.name)!;
  try {
    await expect(b.answer("take in")).rejects.toThrow(
      new DomainError(`another answer or operation for workspace ${b.ws.name} is being checked — try again once it has finished.`),
    );
  } finally {
    release();
  }
  nothingWritten();
});
