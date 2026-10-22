import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents, listEventsOfKinds } from "../src/events.js";
import {
  buildMetaReviewMaterial,
  completeMemoryReview,
  createBehaviorCandidate,
  defineMemoryByMetaReview,
  foldMemoryEntries,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  moveMemoryBranchByMetaReview,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  recordKnowledge,
  recordMetaReviewMaterial,
} from "../src/memory.js";
import { type MetaReviewSubject, registerMetaReview } from "../src/meta-review.js";
import { completeTask, escalateTask, getTask, listChildren, registerTask, type Task, taskVerbSwap } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
import { decomposeTaskViaWorker, FULL_HANDOFF, humanDecomposeTaskViaWebui, injectMemoryMaterial, judgmentRows, objectedJudgment } from "./harness.js";

/** memory meta-review は complete_memory_review で終わる(ADR 0278 決定1〜5 の memory、issue #2283)。 */

const at = new Date("2026-10-19T00:00:00.000Z");

/** 主題の meta-review を登録し、その task を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, subject: MetaReviewSubject, done = false): Task {
  registerMetaReview(db, subject, at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return getTask(db, taskId)!;
}

const deckhand = { activity: "worker_verb" as const, name: "deckhand" };
const metaReview = { activity: "meta_review" as const, name: "auditor" };
const knowledge = (db: Db, path: string, scope: string | null = "tidepool") =>
  recordKnowledge(db, { scope, path, title: path, text: `${path}.`, source: { commit: "0a46a46" }, author: deckhand }, "worker", at).entry_id;
const candidate = (db: Db, title: string) =>
  createBehaviorCandidate(db, { scope: null, path: "habits", title, text: `${title}.`, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;

/** 材料を注入した memory meta-review を登録する(setup): 完了の verb は注入の記録から項目を読む。 */
function injectedReview(db: Db) {
  const review = register(db, "memory");
  return { review, injected: injectMemoryMaterial(db, review.id, "auditor", at) };
}

/** 前回の後に worker が Knowledge を1つ書いた memory meta-review: 項目はそのエントリと、定義の無いその枝。 */
function cycle(db = openDb(":memory:")) {
  register(db, "memory", true);
  const written = knowledge(db, "notes");
  return { db, written, ...injectedReview(db) };
}

it("memory meta-review の verb の差し替えは complete_task と分解の verb を伏せ complete_memory_review を足す —— 帰り先の無い系譜(ADR 0301 決定3)", () => {
  const { db, review } = cycle();

  expect(taskVerbSwap(db, review.id)).toEqual({ withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_memory_review"] });
});

it("memory meta-review も、その判断の行への異議から立った RCA も分解できない —— verb を伏せ、worker の decompose も人間の decompose も直接の work の登録も系譜のルートを名指して拒み、何も登録しない(#2505 測定 G / ADR 0301 決定3)", () => {
  const { db, review } = cycle();
  const entry = appendEvent(db, { taskId: review.id, workerId: "auditor", origin: "worker", at, payload: { kind: "decision_logged", line: "keep entry 3" } });
  startTriage(db, at);
  raiseObjection(db, entry, "drop entry 3", at);
  commitTriage(db, at, [], new Map());
  const rca = listChildren(db, review.id).find((child) => child.title.startsWith("rca (auditor)"))!;
  const split = { reason: "fix it", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] };

  expect(taskVerbSwap(db, rca.id).withheld).toEqual(expect.arrayContaining(["decompose", "redecompose"]));
  for (const parent of [review, rca]) {
    expect(() => decomposeTaskViaWorker(db, parent, split, "auditor", at)).toThrow(/root is a memory meta-review/);
    expect(() => humanDecomposeTaskViaWebui(db, parent, split, at)).toThrow(/root is a memory meta-review/);
    // 直接の登録も同じ床に当たる
    expect(() => registerTask(db, { type: "work", ...split.children[0]!, parent_id: parent.id }, at, BOARD_WORKER_ID, "board")).toThrow(/^no work task grows here: this lineage's root is a memory meta-review/);
  }
  expect(listChildren(db, rca.id)).toEqual([]);
  expect(listChildren(db, review.id).map((child) => child.title)).toEqual([`rca (self): ${review.title}`, `rca (auditor): ${review.title}`]);
});

it.each([
  ["worker", "auditor", "worker"],
  ["人間", HUMAN_WORKER_ID, "webui"],
] as const)("memory meta-review への complete_task は %s の扉でも拒まれ、拒否文は complete_memory_review を指し、何も書かない", (_, workerId, origin) => {
  const { db, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => completeTask(db, review, FULL_HANDOFF, workerId, at, origin)).toThrow("complete_memory_review");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("項目に値も行為も無ければ unjudged で拒まれ、材料に無い id と path も名指して拒まれ、どちらも何も記録しない", () => {
  const { db, written, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => completeMemoryReview(db, review, { judgments: [] }, "auditor", at, "worker")).toThrow(`unjudged: entry #${written}, branch notes in scope tidepool`);
  expect(() =>
    completeMemoryReview(db, review, { judgments: [{ entry: written }, { branch: "notes", scope: "tidepool" }, { entry: 9999 }, { branch: "nowhere", scope: "tidepool" }] }, "auditor", at, "worker"),
  ).toThrow("not items to judge: entry #9999, branch nowhere in scope tidepool");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("注入された項目をそのまま left_as_is で渡しても、この session で引退・提案・移動・定義した項目は受け取って行を書かず、残りの項目だけが行になる", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const [retired, proposed] = ["Retired", "Proposed"].map((title) => candidate(db, title));
  const kept = knowledge(db, "notes");
  const moved = knowledge(db, "drafts/x");
  const { review, injected } = injectedReview(db);
  invalidateMemoryByMetaReview(db, { entry_id: retired!, reason: "rejected" }, "auditor", "worker", at, review.id);
  proposeMemoryChange(db, review.id, { op: "approve", candidate_id: proposed!, rationale: "r" }, "auditor", at);
  moveMemoryByMetaReview(db, { entry_id: moved, scope: "tidepool", path: "notes/x", mover: metaReview }, "worker", at, review.id);
  defineMemoryByMetaReview(db, { scope: "tidepool", path: "notes", text: "Notes.", author: metaReview }, "worker", at, review.id);

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(injected).toEqual([
    ...[retired!, proposed!, kept, moved].map((entry) => ({ entry })),
    { branch: "drafts", scope: "tidepool" },
    { branch: "drafts/x", scope: "tidepool" },
    { branch: "notes", scope: "tidepool" },
  ]);
  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id).map((row) => row.judgment)).toEqual([{ kind: "memory", entry: kept, value: "left_as_is" }]);
});

it("注入の後に他の worker が定義の無い path に Knowledge を書いても、注入した一覧どおりの完了は done になり、その枝の行は書かれない —— 項目の全体は注入の記録", () => {
  const { db, written, review, injected } = cycle();
  knowledge(db, "later");

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id).map((row) => row.judgment)).toEqual([
    { kind: "memory", entry: written, value: "left_as_is" },
    { kind: "memory", branch: "notes", scope: "tidepool", value: "left_as_is" },
  ]);
});

it("注入の後に人間が引退させた candidate への left_as_is は受け取られ、行を書かずに done になる —— 今の計算は絞り込みにだけ使う", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const retired = candidate(db, "Retired");
  const { review, injected } = injectedReview(db);
  invalidateMemoryEntry(db, { entry_id: retired, reason: "rejected" }, HUMAN_WORKER_ID, "webui", at);

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(injected).toContainEqual({ entry: retired });
  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it.each([
  ["人間が無効化した", (db: Db, entry: number) => invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, HUMAN_WORKER_ID, "webui", at)],
  ["他の worker が畳んだ", (db: Db, entry: number) => foldMemoryEntries(db, { replaces: [entry], successor_id: knowledge(db, "notes"), author: deckhand }, "worker", at)],
] as const)("注入の後に%s店の変更のエントリは行為済みで、注入した一覧どおりの完了は done になり、その行は書かれない", (_, act) => {
  const { db, written, review, injected } = cycle();
  act(db, written);

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id).map((row) => row.judgment)).not.toContainEqual(expect.objectContaining({ entry: written }));
});

it("注入の前(窓の中)に無効化された店の変更のエントリは項目に載らず、値なしで完了し、行は書かれない(ADR 0286 決定1)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const written = knowledge(db, "notes");
  invalidateMemoryEntry(db, { entry_id: written, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  const { review, injected } = injectedReview(db);

  expect(injected).toEqual([]);
  expect(completeMemoryReview(db, review, { judgments: [] }, "auditor", at, "worker").status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("材料を組んでから記録するまでの間に人間が引退させたエントリへの left_as_is は受け取られ、行を書かずに done になる(#2311 / ADR 0286 決定2)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const retired = knowledge(db, "notes");
  const review = register(db, "memory");
  const material = buildMetaReviewMaterial(db, review.id);
  if (material?.subject !== "memory") throw new Error("no memory material");
  invalidateMemoryEntry(db, { entry_id: retired, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  recordMetaReviewMaterial(db, review.id, "auditor", 42, material, at);

  const done = completeMemoryReview(db, review, { judgments: material.parts.items }, "auditor", at, "worker");

  expect(material.parts.items).toContainEqual({ entry: retired });
  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("窓で異議された前の判断の行が名指すエントリと枝は項目で、値も行為も無ければ unjudged で拒まれ、left_as_is を渡せば完了する(ADR 0279 決定5)", () => {
  const db = openDb(":memory:");
  defineMemoryByMetaReview(db, { scope: "tidepool", path: "notes", text: "Notes.", author: metaReview }, "worker", at, register(db, "memory", true).id);
  const kept = knowledge(db, "notes");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous.id, { kind: "memory", entry: kept, value: "left_as_is" }, at);
  objectedJudgment(db, previous.id, { kind: "memory", branch: "notes", scope: "tidepool", value: "left_as_is" }, at);
  const { review } = injectedReview(db);

  expect(() => completeMemoryReview(db, review, { judgments: [] }, "auditor", at, "worker")).toThrow(`unjudged: entry #${kept}, branch notes in scope tidepool —`);
  expect(completeMemoryReview(db, review, { judgments: [{ entry: kept }, { branch: "notes", scope: "tidepool" }] }, "auditor", at, "worker").status).toBe("done");
});

it("この review 自身が注入の後に書いたエントリへの値は注入した一覧に無いので名指して拒まれ、何も記録しない", () => {
  const { db, written, review } = cycle();
  const defined = defineMemoryByMetaReview(db, { scope: "tidepool", path: "notes", text: "Notes.", author: metaReview }, "worker", at, review.id).entry_id;
  const before = listEvents(db, review.id).length;

  expect(() => completeMemoryReview(db, review, { judgments: [{ entry: written }, { entry: defined }] }, "auditor", at, "worker")).toThrow(
    `not items to judge: entry #${defined}`,
  );
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("再 spawn で注入の記録が2つあれば最新の記録の項目を読み、2つ目で増えた項目は unjudged で拒まれる", () => {
  const { db, review, injected } = cycle();
  knowledge(db, "later");
  injectMemoryMaterial(db, review.id, "auditor", at);

  expect(() => completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker")).toThrow("unjudged: branch later in scope tidepool —");
});

it("材料の注入が記録されていない memory meta-review の完了は判断を要する項目が読めないので拒まれ、何も記録しない", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const written = knowledge(db, "notes");
  const review = register(db, "memory");
  const before = listEvents(db, review.id).length;

  expect(() => completeMemoryReview(db, review, { judgments: [{ entry: written }, { branch: "notes", scope: "tidepool" }] }, "auditor", at, "worker")).toThrow(
    "material was not injected",
  );
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("祖先の枝の移動は枝の項目を覆わず、その枝は unjudged で拒まれる", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stays = knowledge(db, "tools");
  const leaves = knowledge(db, "tools/node");
  const { review } = injectedReview(db);
  moveMemoryByMetaReview(db, { entry_id: leaves, scope: "tidepool", path: "misc", mover: metaReview }, "worker", at, review.id);

  expect(() => completeMemoryReview(db, review, { judgments: [{ entry: stays }] }, "auditor", at, "worker")).toThrow("unjudged: branch tools in scope tidepool —");
});

it("scope だけを変える移動(workspace → 盤面全体)は移動先の (path, 盤面全体) の項目を覆い、行を求めない(ADR 0282 決定4)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stored = [knowledge(db, "notes", null), knowledge(db, "notes")].map((entry) => ({ entry }));
  const { review, injected } = injectedReview(db);
  moveMemoryBranchByMetaReview(db, { scope: "tidepool", path: "notes", to_scope: null, to_path: "notes", mover: metaReview }, "worker", at, review.id);

  expect(injected).toEqual([...stored, { branch: "notes", scope: null }]);
  expect(completeMemoryReview(db, review, { judgments: stored }, "auditor", at, "worker").status).toBe("done");
});

/** charts と docks がそれぞれ定義の無い `tides` に Knowledge を持つ周期(#2326 の実測の盤面): 枝の項目は (tides, charts) と (tides, docks)。
 *  stored は店の変更の2つのエントリの項目(据え置きとして渡す)。 */
function twoScopeCycle() {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stored = ["charts", "docks"].map((scope) => ({ entry: knowledge(db, "tides", scope) }));
  return { db, stored, ...injectedReview(db) };
}

it("別の workspace に書いた定義はその workspace の枝の項目だけを覆い、残った scope の枝は path と scope を名指して unjudged で拒まれる —— 同じ scope の定義か盤面全体の定義なら覆われる(ADR 0282 決定4)", () => {
  const { db, review, injected, stored } = twoScopeCycle();
  defineMemoryByMetaReview(db, { scope: "docks", path: "tides", text: "Tides.", author: metaReview }, "worker", at, review.id);

  expect(injected).toEqual([
    ...stored,
    { branch: "tides", scope: "charts" },
    { branch: "tides", scope: "docks" },
  ]);
  expect(() => completeMemoryReview(db, review, { judgments: stored }, "auditor", at, "worker")).toThrow(/^unjudged: branch tides in scope charts —/);
  defineMemoryByMetaReview(db, { scope: "charts", path: "tides", text: "Tides.", author: metaReview }, "worker", at, review.id);
  expect(completeMemoryReview(db, review, { judgments: stored }, "auditor", at, "worker").status).toBe("done");

  const wide = twoScopeCycle();
  defineMemoryByMetaReview(wide.db, { scope: null, path: "tides", text: "Tides.", author: metaReview }, "worker", at, wide.review.id);
  expect(completeMemoryReview(wide.db, wide.review, { judgments: wide.stored }, "auditor", at, "worker").status).toBe("done");
});

it("workspace の枝の改名はその workspace の項目だけを覆い、同じ path の別 workspace の項目は unjudged で拒まれる(ADR 0282 決定4)", () => {
  const { db, review, stored } = twoScopeCycle();
  moveMemoryBranchByMetaReview(db, { scope: "docks", path: "tides", to_scope: "docks", to_path: "sea", mover: metaReview }, "worker", at, review.id);

  expect(() => completeMemoryReview(db, review, { judgments: [stored[0]!] }, "auditor", at, "worker")).toThrow(/^unjudged: branch tides in scope charts —/);
  expect(completeMemoryReview(db, review, { judgments: [stored[0]!, { branch: "tides", scope: "charts" }] }, "auditor", at, "worker").status).toBe("done");
});

it("盤面全体の枝の改名が連れて行った workspace の行はその workspace の項目を覆う —— 改名の後に同じ path へ戻った workspace の欠けにも行を求めない(ADR 0282 決定4 / ADR 0177 決定5)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const carried = knowledge(db, "tides", "charts");
  const { review, injected } = injectedReview(db);
  knowledge(db, "tides/x", null);
  moveMemoryBranchByMetaReview(db, { scope: null, path: "tides", to_scope: null, to_path: "sea", mover: metaReview }, "worker", at, review.id);
  knowledge(db, "tides", "charts");

  expect(injected).toEqual([{ entry: carried }, { branch: "tides", scope: "charts" }]);
  expect(completeMemoryReview(db, review, { judgments: [] }, "auditor", at, "worker").status).toBe("done");
});

it("注入した一覧に無い (path, scope) は path と scope を名指して拒まれ、盤面全体の枝の行の文は in the whole board と書く(ADR 0282 決定2)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stored = knowledge(db, "tides", null);
  const { review } = injectedReview(db);

  expect(() => completeMemoryReview(db, review, { judgments: [{ entry: stored }, { branch: "tides", scope: "charts" }] }, "auditor", at, "worker")).toThrow(
    "not items to judge: branch tides in scope charts",
  );
  completeMemoryReview(db, review, { judgments: [{ entry: stored }, { branch: "tides", scope: null, reason: "fine" }] }, "auditor", at, "worker");
  expect(judgmentRows(db, review.id)).toContainEqual({
    kind: "decision_logged",
    line: "left_as_is: branch tides in the whole board — fine",
    judgment: { kind: "memory", branch: "tides", scope: null, value: "left_as_is", reason: "fine" },
  });
});

/** 前の review の (tides, charts) の left_as_is に異議があり、charts の `tides` の Knowledge は人間が引退させ、charts の `tides/high` に
 *  candidate だけが残る周期(#2331 の実測1の盤面)。stored は起草された candidate の項目(据え置きとして渡す)—— 引退した Knowledge は項目でない(ADR 0286)。 */
function candidateOnlyCycle() {
  const db = openDb(":memory:");
  const retired = knowledge(db, "tides", "charts");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous.id, { kind: "memory", branch: "tides", scope: "charts", value: "left_as_is" }, at);
  invalidateMemoryEntry(db, { entry_id: retired, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  const drafted = createBehaviorCandidate(
    db,
    { scope: "charts", path: "tides/high", title: "High", text: "High.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  return { db, stored: [{ entry: drafted }], ...injectedReview(db) };
}

it("candidate だけが残る異議された枝の再掲は、値も行為も無ければ unjudged で拒まれ、left_as_is なら判断の行が書かれ、その scope の定義の後は値なしで完了する(ADR 0284 決定1)", () => {
  const left = candidateOnlyCycle();
  expect(left.injected).toEqual([...left.stored, { branch: "tides", scope: "charts" }]);
  expect(() => completeMemoryReview(left.db, left.review, { judgments: left.stored }, "auditor", at, "worker")).toThrow(/^unjudged: branch tides in scope charts —/);
  completeMemoryReview(left.db, left.review, { judgments: [...left.stored, { branch: "tides", scope: "charts" }] }, "auditor", at, "worker");
  expect(judgmentRows(left.db, left.review.id)).toContainEqual({
    kind: "decision_logged",
    line: "left_as_is: branch tides in scope charts",
    judgment: { kind: "memory", branch: "tides", scope: "charts", value: "left_as_is" },
  });

  const defined = candidateOnlyCycle();
  defineMemoryByMetaReview(defined.db, { scope: "charts", path: "tides", text: "Tides.", author: metaReview }, "worker", at, defined.review.id);
  expect(completeMemoryReview(defined.db, defined.review, { judgments: defined.stored }, "auditor", at, "worker").status).toBe("done");
});

it("再掲の (path, workspace) と構造の (path, 盤面全体) が並んでも、盤面全体の定義1手で両方が覆われる(ADR 0284 決定3 / ADR 0282 決定4)", () => {
  const db = openDb(":memory:");
  knowledge(db, "tides/low", "charts");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous.id, { kind: "memory", branch: "tides", scope: "charts", value: "left_as_is" }, at);
  const deep = knowledge(db, "tides/deep", null);
  const { review, injected } = injectedReview(db);
  const rest = [{ entry: deep }, { branch: "tides/deep", scope: null }, { branch: "tides/low", scope: "charts" }];
  defineMemoryByMetaReview(db, { scope: null, path: "tides", text: "Tides.", author: metaReview }, "worker", at, review.id);

  expect(injected).toEqual([{ entry: deep }, { branch: "tides", scope: null }, { branch: "tides", scope: "charts" }, ...rest.slice(1)]);
  expect(completeMemoryReview(db, review, { judgments: rest }, "auditor", at, "worker").status).toBe("done");
});

it("据え置いた項目ごとに対象を名指す型つきの decision_logged が1行、文は盤面が組み reason があれば添え、完了する", () => {
  const { db, written, review } = cycle();

  const done = completeMemoryReview(db, review, { judgments: [{ entry: written, reason: "  still accurate " }, { branch: "notes", scope: "tidepool" }] }, "auditor", at, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([
    { kind: "decision_logged", line: `left_as_is: entry #${written} — still accurate`, judgment: { kind: "memory", entry: written, value: "left_as_is", reason: "still accurate" } },
    { kind: "decision_logged", line: "left_as_is: branch notes in scope tidepool", judgment: { kind: "memory", branch: "notes", scope: "tidepool", value: "left_as_is" } },
  ]);
});

it("完了が拒まれれば判断の行も書かれない —— 行と完了は1つの transaction", () => {
  const { db, written, review } = cycle();
  escalateTask(db, review, { context: "c", questions: [{ title: "which scope?", options: ["a", "b"], recommendation: "a" }] }, "auditor", at, "worker");

  expect(() => completeMemoryReview(db, getTask(db, review.id)!, { judgments: [{ entry: written }, { branch: "notes", scope: "tidepool" }] }, "auditor", at, "worker")).toThrow(
    "unfinished children",
  );
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("memory meta-review でない task は拒まれる", () => {
  const db = openDb(":memory:");

  expect(() => completeMemoryReview(db, register(db, "routing"), { judgments: [] }, "auditor", at, "worker")).toThrow(
    "only a memory meta-review completes with complete_memory_review",
  );
});
