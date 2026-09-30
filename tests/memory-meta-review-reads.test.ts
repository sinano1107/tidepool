import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, getEvent, latestEventOfTask } from "../src/events.js";
import {
  approveMemoryProposal,
  createBehaviorCandidate,
  defineMemoryBranch,
  humanEntryInput,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryBranches,
  listMemoryEntries,
  listPrecedents,
  proposeMemoryChange,
  pullMemoryBranches,
  pullMemoryList,
  pullMemoryProposals,
  recordBehavior,
  recordKnowledge,
  rejectMemoryProposal,
} from "../src/memory.js";
import { answerQuestion, DomainError, getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";
import { bundledObjection } from "./harness.js";

/** meta-review の読み口(issue #619 / ADR 0120 決定2)のドメイン層。verb への写像はサーバ境界
 *  (tests/mcp-memory-meta-review.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");

function board() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at);
  const decision = logDecision(db, task, "kept the note short", "deckhand", at);
  const reader = { taskId: task.id, agent: "auditor" };
  const behavior = (fields: { title: string; scope?: string | null; addressee?: string | null; source?: number; path?: string }) =>
    createBehaviorCandidate(
      db,
      {
        scope: fields.scope ?? null,
        path: fields.path ?? "habits",
        title: fields.title,
        text: `${fields.title}.`,
        addressee: fields.addressee ?? null,
        source: { event_id: fields.source ?? decision },
        author: { activity: "rca", name: "auditor" },
      },
      "worker",
      at,
    ).entry_id;
  const knowledge = (scope: string | null, path: string) =>
    recordKnowledge(db, { scope, path, title: path, text: `${path}.`, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  const define = (scope: string | null, path: string) => defineMemoryBranch(db, { scope, path, text: `What ${path} holds.`, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  return { db, task, decision, reader, behavior, knowledge, define };
}

it("list_memory_candidates は candidate を cause・author・出所つきで返し、include_invalidated で無効化済みを理由コードと後継ごと足す。pull は memory_pulled に載る", () => {
  const { db, task, decision, reader, behavior } = board();
  const attributed = appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, task.id, decision, at)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at,
  });
  const open = behavior({ title: "Short notes", source: attributed });
  const stale = behavior({ title: "Long notes" });
  const replaced = behavior({ title: "Medium notes" });
  const successor = behavior({ title: "Notes are medium" });
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: successor, replaces: [] }, "question-1", "webui", at);
  invalidateMemoryEntry(db, { entry_id: stale, reason: "requirement_change" }, "human", "webui", at);
  invalidateMemoryEntry(db, { entry_id: replaced, reason: "superseded", successor_id: successor }, "human", "webui", at);

  const current = pullMemoryList(db, reader, "list_memory_candidates", {}, at);
  expect(current).toMatchObject({
    entries: [
      {
        id: open,
        state: "candidate",
        cause: "preference",
        author: { activity: "rca", name: "auditor" },
        source: { kind: "event", ref: attributed },
        invalidation_reason: null,
        successor_id: null,
      },
    ],
    truncated: false,
  });
  expect(current.entries).toHaveLength(1);
  expect(getEvent(db, current.event_id)).toMatchObject({
    task_id: task.id,
    worker_id: "auditor",
    payload: { kind: "memory_pulled", verb: "list_memory_candidates", input: {}, returned_ids: [open] },
  });

  const all = pullMemoryList(db, reader, "list_memory_candidates", { include_invalidated: true }, at);
  expect(all.entries.map((e) => [e.id, e.invalidation_reason, e.successor_id])).toEqual([
    [open, null, null],
    [stale, "requirement_change", null],
    [replaced, "superseded", successor],
  ]);
});

it("list_memory_candidates の無効化済みは、修正つきで承認された candidate に人間名義の後継の文言を載せる", () => {
  const { db, reader, behavior } = board();
  const amended = behavior({ title: "Short notes", addressee: "deckhand" });
  const plain = behavior({ title: "Long notes" });
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: amended, replaces: [] }, "question-1", "webui", at, { text: "Keep notes to one line." });
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: plain, replaces: [] }, "question-2", "webui", at);

  const { entries } = pullMemoryList(db, reader, "list_memory_candidates", { include_invalidated: true }, at);
  expect(entries).toEqual([
    expect.objectContaining({
      id: amended,
      text: "Short notes.",
      invalidation_reason: "superseded",
      successor: { title: "Short notes", text: "Keep notes to one line.", addressee: "deckhand", author: { activity: "human", name: "human" } },
    }),
  ]);
});

it("list_memory_candidates は kind で絞れる —— exemplar なら Exemplar の candidate だけ(issue #954)", () => {
  const { db, task, decision, reader, behavior } = board();
  const attributed = appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, task.id, decision, at)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at,
  });
  const drafted = behavior({ title: "Short notes", source: attributed });
  const annotations = [{ anchor: "whole", polarity: "imitate", text: "Keep it this short." }];
  const text = { scope: null, path: "habits", title: "Short notes", addressee: null, kind: "exemplar" as const, annotations };
  const { question_id } = proposeMemoryChange(db, task.id, { op: "consolidate", text, replaces: [drafted], based_on_decision: decision, rationale: "r" }, "auditor", at);
  const exemplar = (getTask(db, question_id)!.question_proposal as { candidate_id: number }).candidate_id;

  const ids = (kind: "behavior" | "exemplar") => pullMemoryList(db, reader, "list_memory_candidates", { kind }, at).entries.map((e) => e.id);
  expect(ids("exemplar")).toEqual([exemplar]);
  expect(ids("behavior")).toEqual([drafted]);
});

/** 提案 question を立て、回答(question_answered)と適用を人間の扉と同じ順で書く。 */
function proposals() {
  const { db, task, reader, behavior } = board();
  const propose = (input: Parameters<typeof proposeMemoryChange>[2]) => proposeMemoryChange(db, task.id, input, "auditor", at).question_id;
  const answer = (questionId: string, option: "approve" | "reject", rest: { comment?: string; amendment?: { title?: string; text: string; original_title?: string; original_text?: string } } = {}) => {
    const question = getTask(db, questionId)!;
    answerQuestion(db, question, [option], at, undefined, rest.comment, rest.amendment);
    const proposal = question.question_proposal as MemoryProposal;
    if (option === "approve") approveMemoryProposal(db, proposal, questionId, "webui", at, rest.amendment);
    else rejectMemoryProposal(db, proposal, questionId, "webui", at, rest.comment);
  };
  return { db, reader, behavior, propose, answer };
}

it("list_memory_proposals は過去の memory 提案を approve・修正つき approve・comment つき reject・invalidate の reject・既存の後継の consolidate・陳腐化の決着ごと返し、returned_ids は各提案が名指す entry(ADR 0159 決定1 / ADR 0160 決定2)", () => {
  const { db, reader, behavior, propose, answer } = proposals();
  const [approved, amended, rejected, stale, replaced] = ["Short notes", "Long notes", "Loud notes", "Old notes", "Brief notes"].map((title) => behavior({ title }));
  const plain = propose({ op: "approve", candidate_id: approved!, rationale: "r" });
  answer(plain, "approve");
  const withAmendment = propose({ op: "approve", candidate_id: amended!, rationale: "r" });
  answer(withAmendment, "approve", { amendment: { text: "Keep notes to one line." } });
  const refused = propose({ op: "approve", candidate_id: rejected!, rationale: "r" });
  answer(refused, "reject", { comment: "Notes are not about volume." });
  const kept = propose({ op: "invalidate", target_id: approved!, reason: "environment", rationale: "r" });
  answer(kept, "reject", { comment: "The CI still squashes." });
  // 既にある後継の consolidate の replaces は approved だけ(ADR 0161 決定5)—— question を立てずに承認して提案の一覧に足さない
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: replaced!, replaces: [] }, "question-replaced", "webui", at);
  const merged = propose({ op: "consolidate", successor_id: approved!, replaces: [replaced!], rationale: "r" });
  answer(merged, "approve");
  const settled = propose({ op: "approve", candidate_id: stale!, rationale: "r" });
  const retired = invalidateMemoryByMetaReview(db, { entry_id: stale!, reason: "rejected" }, "auditor", "worker", at);

  const pulled = pullMemoryProposals(db, reader, {}, at);
  expect(pulled.proposals).toEqual([
    { question_id: plain, proposal: expect.objectContaining({ op: "approve", candidate_id: approved }), answer: "approve", amendment: null, comment: null, observed: null },
    { question_id: withAmendment, proposal: expect.objectContaining({ candidate_id: amended }), answer: "approve", amendment: { text: "Keep notes to one line." }, comment: null, observed: null },
    { question_id: refused, proposal: expect.objectContaining({ candidate_id: rejected }), answer: "reject", amendment: null, comment: "Notes are not about volume.", observed: null },
    { question_id: kept, proposal: expect.objectContaining({ op: "invalidate", target: expect.objectContaining({ id: approved }) }), answer: "reject", amendment: null, comment: "The CI still squashes.", observed: null },
    { question_id: merged, proposal: expect.objectContaining({ op: "consolidate", successor: expect.objectContaining({ id: approved }) }), answer: "approve", amendment: null, comment: null, observed: null },
    { question_id: settled, proposal: expect.objectContaining({ candidate_id: stale }), answer: null, amendment: null, comment: null, observed: { entry_id: stale, observed_event_id: retired } },
  ]);
  expect(getEvent(db, pulled.event_id)).toMatchObject({ payload: { returned_ids: [approved, amended, rejected, stale] } });
});

it("無効化済みのエントリは書き手の印 invalidated_by を持つ —— 人間の reject は question、meta-review の引退は activity、印の無い無効化は worker(ADR 0159 決定2)", () => {
  const { db, behavior, propose, answer } = proposals();
  const [byHuman, byMetaReview, bySettings, open] = ["Short notes", "Long notes", "Loud notes", "Quiet notes"].map((title) => behavior({ title }));
  const refused = propose({ op: "approve", candidate_id: byHuman!, rationale: "r" });
  answer(refused, "reject", { comment: "Notes are not about length." });
  invalidateMemoryByMetaReview(db, { entry_id: byMetaReview!, reason: "rejected" }, "auditor", "worker", at);
  invalidateMemoryEntry(db, { entry_id: bySettings!, reason: "environment" }, "human", "webui", at);

  expect(listMemoryEntries(db, {}).map((e) => [e.id, e.invalidation_reason, e.invalidated_by])).toEqual([
    [byHuman, "rejected", { question_id: refused }],
    [byMetaReview, "rejected", { activity: "meta_review" }],
    [bySettings, "environment", { worker: "human" }],
    [open, null, null],
  ]);
});

it("list_memory_behaviors は approved の Behavior を宛先・scope で絞らずに返し、candidate と無効化済みは返さない", () => {
  const { db, reader, behavior } = board();
  const approved = [
    behavior({ title: "Everyone rebases", scope: null }),
    behavior({ title: "Deckhand pins Node", scope: "charts", addressee: "deckhand" }),
    behavior({ title: "Tako writes tests", scope: "tidepool", addressee: "tako" }),
  ];
  const retired = behavior({ title: "Retired habit" });
  behavior({ title: "Still a candidate" });
  for (const id of [...approved, retired])
    approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: id, replaces: [] }, "question-1", "webui", at);
  invalidateMemoryEntry(db, { entry_id: retired, reason: "environment" }, "human", "webui", at);

  expect(pullMemoryList(db, reader, "list_memory_behaviors", {}, at).entries.map((e) => e.id)).toEqual(approved);
});

it("一覧3つの返却はエントリの原文 original を持たない —— meta-review が読むのは英語の正文だけ(#1052)", () => {
  const { db, reader, behavior } = board();
  behavior({ title: "Still a candidate" });
  recordBehavior(
    db,
    humanEntryInput(db, { workspace: "tidepool", path: "habits", title: "Pin Node", text: "Pin Node 22.", addressee: "deckhand", original_title: "Node を固定", original_text: "Node 22 に固定する" }),
    "webui",
    at,
  );

  for (const verb of ["list_memory_candidates", "list_memory_behaviors", "list_memory_entries"] as const) {
    const { entries } = pullMemoryList(db, reader, verb, {}, at);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry).not.toHaveProperty("original");
  }
});

it("list_memory_proposals の amendment は人間の原文 original_title / original_text を持たない —— 正本の question_answered には残る(#1173)", () => {
  const { reader, db, behavior, propose, answer } = proposals();
  const candidate = behavior({ title: "Long notes" });
  const question = propose({ op: "approve", candidate_id: candidate, rationale: "r" });
  const amendment = { title: "Short notes", text: "Keep notes to one line.", original_title: "短いメモ", original_text: "メモは1行にする" };
  answer(question, "approve", { amendment });

  const [pulled] = pullMemoryProposals(db, reader, {}, at).proposals;
  expect(pulled!.amendment).toEqual({ title: "Short notes", text: "Keep notes to one line." });
  expect(latestEventOfTask(db, question, "question_answered")!.payload.amendment).toMatchObject(amendment);
});

it("一覧はページ長で切り、truncated が次のページを言う", () => {
  const { db, reader, behavior } = board();
  const ids = Array.from({ length: 21 }, (_, i) => behavior({ title: `habit ${i}` }));
  const first = pullMemoryList(db, reader, "list_memory_candidates", {}, at);
  const second = pullMemoryList(db, reader, "list_memory_candidates", { page: 2 }, at);
  expect([first.entries.length, first.truncated]).toEqual([20, true]);
  expect([second.entries.map((e) => e.id), second.truncated]).toEqual([[ids[20]], false]);
});

it("list_memory_entries の path は P とその配下 P/… だけを返して P-x を返さず、scope / kind / state と同時に効く —— NFD の入力は NFC の枝に当たり、不正な path は domain error(#1209)", () => {
  const { db, behavior, knowledge, define } = board();
  const own = knowledge("tidepool", "habits");
  const child = knowledge("tidepool", "habits/tests");
  const other = knowledge("charts", "habits/tests");
  knowledge("tidepool", "habits-x");
  const candidate = behavior({ title: "Short notes", scope: "tidepool" });
  const defined = define("tidepool", "habits");
  const guide = knowledge("tidepool", "ガイド");
  const ids = (filter: Parameters<typeof listMemoryEntries>[1]) => listMemoryEntries(db, filter).map((e) => e.id);

  expect(ids({ path: "habits" })).toEqual([own, child, other, candidate, defined]);
  expect(ids({ path: "habits", scope: "tidepool" })).toEqual([own, child, candidate, defined]);
  expect(ids({ path: "habits", kind: "definition" })).toEqual([defined]);
  expect(ids({ path: "habits", state: "candidate" })).toEqual([candidate]);
  expect(ids({ path: "ガイド".normalize("NFD") })).toEqual([guide]);
  expect(() => listMemoryEntries(db, { path: "habits/" })).toThrow(DomainError);
});

/** 行の scope の欄は集合として比べる(並びは言わない)。 */
const branchRows = (rows: ReturnType<typeof listMemoryBranches>) => rows.map((row) => ({ ...row, scopes: new Set(row.scopes) }));

it("枝の一覧は approved・未無効化のエントリ(宛先つきも)の path とその上位の prefix を1枝1行・木の順で返し、candidate だけ・無効化済みだけの path は行を作らない —— 未定義の枝は Definition の欄が空で scope の欄に配下の scope(盤面全体は null)が並ぶ(#1209)", () => {
  const { db, behavior, knowledge } = board();
  knowledge("tidepool", "a");
  knowledge("tidepool", "a-x");
  knowledge("charts", "a/b/c");
  knowledge(null, "a/b");
  behavior({ title: "Short notes", scope: "tidepool", path: "pending" });
  invalidateMemoryEntry(db, { entry_id: knowledge("tidepool", "gone"), reason: "environment" }, "human", "webui", at);
  recordBehavior(db, humanEntryInput(db, { workspace: "charts", path: "addressed", title: "Pin Node", text: "Pin Node 22.", addressee: "deckhand" }), "webui", at);

  expect(branchRows(listMemoryBranches(db))).toEqual([
    { path: "a", definitions: [], scopes: new Set(["tidepool", "charts", null]) },
    { path: "a/b", definitions: [], scopes: new Set(["charts", null]) },
    { path: "a/b/c", definitions: [], scopes: new Set(["charts"]) },
    { path: "a-x", definitions: [], scopes: new Set(["tidepool"]) },
    { path: "addressed", definitions: [], scopes: new Set(["charts"]) },
  ]);
});

it("枝の一覧の行はその path の Definition をすべて並べ(同じ path を定義する workspace が2つなら2つ)、scope の欄は Definition もエントリとして数える —— 子の枝の Definition だけを持つ workspace も親の行に並ぶ(#1209)", () => {
  const { db, knowledge, define } = board();
  const tidepool = define("tidepool", "tools");
  const charts = define("charts", "tools");
  const docs = define(null, "docs");
  knowledge(null, "build/x");
  const child = define("charts", "build/y");

  const definition = (id: number, scope: string | null, path: string) => ({ id, scope, text: `What ${path} holds.`, original: null });
  expect(branchRows(listMemoryBranches(db))).toEqual([
    { path: "build", definitions: [], scopes: new Set([null, "charts"]) },
    { path: "build/x", definitions: [], scopes: new Set([null]) },
    { path: "build/y", definitions: [definition(child, "charts", "build/y")], scopes: new Set(["charts"]) },
    { path: "docs", definitions: [definition(docs, null, "docs")], scopes: new Set([null]) },
    { path: "tools", definitions: [definition(tidepool, "tidepool", "tools"), definition(charts, "charts", "tools")], scopes: new Set(["tidepool", "charts"]) },
  ]);
});

it("meta-review の枝の一覧は memory_pulled を残して返した id = 行の Definition の id とし、Definition の原文 original を運ばない(#1209)", () => {
  const { db, reader, knowledge, define } = board();
  knowledge("tidepool", "build/tests");
  const human = defineMemoryBranch(db, humanEntryInput(db, { workspace: "tidepool", path: "tools", text: "Tools.", original_text: "道具" }), "webui", at).entry_id;
  const whole = define(null, "docs");

  const pulled = pullMemoryBranches(db, reader, at);

  expect(pulled.branches.map((row) => row.definitions)).toEqual([[], [], [{ id: whole, scope: null, text: "What docs holds." }], [{ id: human, scope: "tidepool", text: "Tools." }]]);
  expect(listMemoryBranches(db).find((row) => row.path === "tools")!.definitions[0]!.original).toMatchObject({ text: "道具" });
  expect(getEvent(db, pulled.event_id)!.payload).toMatchObject({ kind: "memory_pulled", verb: "list_memory_branches", input: {}, returned_ids: [whole, human] });
});

/** setup のみ: 1 marker = 1 episode の直挿しで異議つき decision を安く並べる(#356 の投影は使わない)。異議の event id と decision を返す。 */
function objectedDecision({ db, task }: ReturnType<typeof board>, i: number) {
  const decision = logDecision(db, task, `decision ${i}`, "deckhand", at);
  db.prepare("INSERT INTO episodes (id, worker_spawned_event_id, extractor_version, task_id, agent, lines) VALUES (?, ?, '3', ?, 'deckhand', '{}')").run(i, i, task.id);
  db.prepare("INSERT INTO episode_markers (episode_id, seq, kind, position, event_id) VALUES (?, 0, 'decision', 0, ?)").run(i, decision);
  const objection = bundledObjection(db, task.id, decision, at, `objection ${i}`);
  return { decision, objection };
}

it("Precedent もページ長で切り、2 ページ目に残りが出る", () => {
  const b = board();
  const { db, reader } = b;
  const decisions = Array.from({ length: 21 }, (_, i) => objectedDecision(b, i + 1).decision);

  const first = listPrecedents(db, reader, {}, at);
  const second = listPrecedents(db, reader, { page: 2 }, at);
  expect([first.precedents.length, first.truncated]).toEqual([20, true]);
  expect([second.precedents.map((p) => p.decision_event_id), second.truncated]).toEqual([[decisions[20]], false]);
});

it("Precedent は最新の帰責の entries を運ぶ —— memory なら名指された id 列、他の cause は null(ADR 0166 決定5)", () => {
  const b = board();
  const { db, task, reader } = b;
  // setup のみ: 帰責の event
  const objected = (i: number, cause: "memory" | "capability", entries: number[] | null) => {
    const { decision, objection } = objectedDecision(b, i);
    appendEvent(db, { taskId: task.id, workerId: "tidepool", origin: "board", payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [objection], cause, evidence: "e", entries, round: "initial" }, at });
    return decision;
  };
  const followed = objected(1, "memory", [41, 42]);
  const own = objected(2, "capability", null);

  expect(listPrecedents(db, reader, {}, at).precedents.map((p) => [p.decision_event_id, p.cause, p.entries])).toEqual([
    [followed, "memory", [41, 42]],
    [own, "capability", null],
  ]);
});
