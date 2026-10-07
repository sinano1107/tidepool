import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, getEvent, latestEventOfTask, listEvents } from "../src/events.js";
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
  type MemoryAmendment,
  moveMemory,
  proposeMemoryChange,
  pullMemoryBranches,
  pullMemoryList,
  pullMemoryProposals,
  readMemory,
  readMemoryEntries,
  recordBehavior,
  recordExemplar,
  recordKnowledge,
  rejectMemoryProposal,
  restoreMemoryEntry,
  searchMemory,
  searchMemoryEntries,
} from "../src/memory.js";
import { EXTRACTOR_VERSION, entriesReadBefore, entriesSeenBefore, projectEpisode } from "../src/precedent.js";
import { getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";
import { answerQuestionViaWebui, bundledObjection, HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";

/** meta-review の読み口(issue #619 / ADR 0120 決定2)のドメイン層。verb への写像はサーバ境界
 *  (tests/mcp-memory-meta-review.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");

function board() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, ...HUMAN_WEBUI);
  const decision = logDecision(db, task, "kept the note short", "deckhand", at, "worker");
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
  });
  expect(current).not.toHaveProperty("next");
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
  const { db, task, decision, reader, behavior, knowledge } = board();
  const propose = (input: Parameters<typeof proposeMemoryChange>[2]) => proposeMemoryChange(db, task.id, input, "auditor", at).question_id;
  const answer = (questionId: string, option: "approve" | "reject", rest: { comment?: string; amendment?: MemoryAmendment } = {}) => {
    const question = getTask(db, questionId)!;
    answerQuestionViaWebui(db, question, [option], at, { comment: rest.comment, amendment: rest.amendment });
    const proposal = question.question_proposal as MemoryProposal;
    if (option === "approve") approveMemoryProposal(db, proposal, questionId, "webui", at, rest.amendment);
    else rejectMemoryProposal(db, proposal, questionId, "webui", at);
  };
  return { db, task, decision, reader, behavior, knowledge, propose, answer };
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

/** 人間が原文つきで書いた Behavior と、注釈の原文つきで書いた Exemplar(出所は board の decision)。 */
function humanOriginals({ db, decision }: ReturnType<typeof board>) {
  const behavior = recordBehavior(
    db,
    humanEntryInput(db, { workspace: "tidepool", path: "habits", title: "Pin Node", text: "Pin Node 22.", addressee: "deckhand", original_title: "Node を固定", original_text: "Node 22 に固定する" }),
    "webui",
    at,
  ).entry_id;
  const annotations = [{ anchor: { field: "decision", quote: "short" }, polarity: "imitate", text: "Keep the note short.", original: "メモは短く" }];
  const exemplar = recordExemplar(db, humanEntryInput(db, { workspace: null, path: "habits", title: "Short note", addressee: null, source_event_id: decision, annotations }), "webui", at).entry_id;
  return { behavior, exemplar };
}

it("一覧2つの返却はエントリの原文 original も Exemplar の注釈の原文 annotations[].original も持たない —— 人間の面の一覧は注釈の原文を返し続ける(#1052 / ADR 0122 追記 #1225)", () => {
  const b = board();
  const { db, reader, behavior } = b;
  behavior({ title: "Still a candidate" });
  const { exemplar } = humanOriginals(b);

  for (const verb of ["list_memory_candidates", "list_memory_entries"] as const) {
    const { entries } = pullMemoryList(db, reader, verb, {}, at);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("original");
      for (const annotation of entry.annotations ?? []) expect(annotation).not.toHaveProperty("original");
    }
  }
  expect(pullMemoryList(db, reader, "list_memory_entries", {}, at).entries.find((e) => e.id === exemplar)!.annotations).toEqual([
    { anchor: { field: "decision", quote: "short" }, polarity: "imitate", text: "Keep the note short." },
  ]);
  expect(listMemoryEntries(db, {}).find((e) => e.id === exemplar)!.annotations![0]!.original).toMatchObject({ text: "メモは短く" });
});

it("list_memory_proposals の amendment は人間の原文 original_title / original_text も注釈の原文 annotations[].original も持たない —— 正本の question_answered には残る(#1173 / ADR 0122 追記 #1225)", () => {
  const { reader, db, task, decision, behavior, propose, answer } = proposals();
  const candidate = behavior({ title: "Long notes" });
  const question = propose({ op: "approve", candidate_id: candidate, rationale: "r" });
  const amendment = { title: "Short notes", text: "Keep notes to one line.", original_title: "短いメモ", original_text: "メモは1行にする" };
  answer(question, "approve", { amendment });
  // setup のみ: Exemplar の candidate(出所は帰責 event)を注釈の原文つきの修正値で approve する
  const drafted = behavior({ title: "Short note", source: attribution({ db, task, decision }) });
  const text = { scope: null, path: "habits", title: "Short note", addressee: null, kind: "exemplar" as const, annotations: [{ anchor: "whole" as const, polarity: "imitate" as const, text: "Keep it short." }] };
  const exemplar = propose({ op: "consolidate", text, replaces: [drafted], based_on_decision: decision, rationale: "r" });
  const annotated = { annotations: [{ anchor: "whole" as const, polarity: "imitate" as const, text: "Keep it this short.", original: "この短さで" }] };
  answer(exemplar, "approve", { amendment: annotated });

  const [pulled, pulledExemplar] = pullMemoryProposals(db, reader, {}, at).proposals;
  expect(pulled!.amendment).toEqual({ title: "Short notes", text: "Keep notes to one line." });
  expect(pulledExemplar!.amendment).toEqual({ annotations: [{ anchor: "whole", polarity: "imitate", text: "Keep it this short." }] });
  expect(latestEventOfTask(db, question, "question_answered")!.payload.amendment).toMatchObject(amendment);
  expect(latestEventOfTask(db, exemplar, "question_answered")!.payload.amendment).toMatchObject(annotated);
});

it("一覧は応答予算で切り、next と remaining が続きを言う。next を追うと残りが続く", () => {
  const { db, reader, behavior } = board();
  const ids = Array.from({ length: 21 }, (_, i) => behavior({ title: `habit ${i} ${"y".repeat(1_000)}` }));
  const first = pullMemoryList(db, reader, "list_memory_candidates", {}, at);
  const second = pullMemoryList(db, reader, "list_memory_candidates", { next: first.next }, at);
  expect(first.entries.map((e) => e.id)).toEqual(ids.slice(0, first.entries.length));
  expect(first.remaining).toBe(21 - first.entries.length);
  expect(second.entries.map((e) => e.id)).toEqual(ids.slice(first.entries.length));
  expect(second).not.toHaveProperty("next");
});

it("read_memory_entries と list_memory_proposals も応答予算で切り、next を追うと id 順 / 古い順に欠けも重複もなく揃う。missing は最初の応答だけに載り、各応答の memory_pulled は最初の input とその応答で返した id を持つ", () => {
  const { db, task, reader, behavior } = board();
  const ids = Array.from({ length: 20 }, (_, i) => behavior({ title: `tide ${i} ${"y".repeat(2_000)}` }));
  const proposed = ids.map((candidate_id) => {
    const { question_id } = proposeMemoryChange(db, task.id, { op: "approve", candidate_id, rationale: "r" }, "auditor", at);
    answerQuestionViaWebui(db, getTask(db, question_id)!, ["reject"], at, { comment: "c".repeat(2_000) });
    return question_id;
  });
  const input = { ids: [9999, ...[...ids].reverse()] };

  const reads = [readMemoryEntries(db, reader, input, at)];
  while (reads.at(-1)!.next) reads.push(readMemoryEntries(db, reader, { next: reads.at(-1)!.next }, at));
  const proposals = [pullMemoryProposals(db, reader, {}, at)];
  while (proposals.at(-1)!.next) proposals.push(pullMemoryProposals(db, reader, { next: proposals.at(-1)!.next }, at));

  expect(reads.length).toBeGreaterThan(1);
  expect(reads.flatMap((r) => r.entries.map((e) => e.id))).toEqual(ids);
  expect(reads[0]!.missing).toEqual([9999]);
  for (const r of reads.slice(1)) expect(r).not.toHaveProperty("missing");
  for (const r of reads) expect(getEvent(db, r.event_id)?.payload).toMatchObject({ verb: "read_memory_entries", input, returned_ids: r.entries.map((e) => e.id) });
  expect(proposals.length).toBeGreaterThan(1);
  expect(proposals.flatMap((r) => r.proposals.map((p) => p.question_id))).toEqual(proposed);
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
const withScopeSets = (rows: ReturnType<typeof listMemoryBranches>) => rows.map((row) => ({ ...row, scopes: new Set(row.scopes) }));

it("枝の一覧は approved・未無効化のエントリ(宛先つきも)の path とその上位の prefix を1枝1行・木の順で返し、candidate だけ・無効化済みだけの path は行を作らない —— 未定義の枝は Definition の欄が空で scope の欄に配下の scope(盤面全体は null)が並ぶ(#1209)", () => {
  const { db, behavior, knowledge } = board();
  knowledge("tidepool", "a");
  knowledge("tidepool", "a-x");
  knowledge("charts", "a/b/c");
  knowledge(null, "a/b");
  behavior({ title: "Short notes", scope: "tidepool", path: "pending" });
  invalidateMemoryEntry(db, { entry_id: knowledge("tidepool", "gone"), reason: "environment" }, "human", "webui", at);
  recordBehavior(db, humanEntryInput(db, { workspace: "charts", path: "addressed", title: "Pin Node", text: "Pin Node 22.", addressee: "deckhand" }), "webui", at);

  expect(withScopeSets(listMemoryBranches(db))).toEqual([
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
  expect(withScopeSets(listMemoryBranches(db))).toEqual([
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
function objectedDecision({ db, task }: ReturnType<typeof board>, i: number, padding = "") {
  const decision = logDecision(db, task, `decision ${i}${padding}`, "deckhand", at, "worker");
  db.prepare("INSERT INTO episodes (id, worker_spawned_event_id, extractor_version, task_id, agent, lines) VALUES (?, ?, ?, ?, 'deckhand', '{}')").run(i, i, EXTRACTOR_VERSION, task.id);
  db.prepare("INSERT INTO episode_markers (episode_id, seq, kind, position, event_id) VALUES (?, 0, 'decision', 0, ?)").run(i, decision);
  const objection = bundledObjection(db, task.id, decision, at, `objection ${i}`);
  return { decision, objection };
}

it("Precedent も応答予算で切り、next を追うと残りが出る", () => {
  const b = board();
  const { db, reader } = b;
  const decisions = Array.from({ length: 21 }, (_, i) => objectedDecision(b, i + 1, ` ${"y".repeat(2_000)}`).decision);

  const first = listPrecedents(db, reader, {}, at);
  const second = listPrecedents(db, reader, { next: first.next }, at);
  expect(first.precedents.map((p) => p.decision_event_id)).toEqual(decisions.slice(0, first.precedents.length));
  expect(first.remaining).toBe(21 - first.precedents.length);
  expect(second.precedents.map((p) => p.decision_event_id)).toEqual(decisions.slice(first.precedents.length));
  expect(second).not.toHaveProperty("next");
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

const approve = (db: ReturnType<typeof openDb>, candidate_id: number) =>
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id, replaces: [] }, "question-1", "webui", at);

/** setup のみ: board の decision への異議の帰責 event(RCA 起草の出所)。 */
const attribution = ({ db, task, decision }: Pick<ReturnType<typeof board>, "db" | "task" | "decision">, comment?: string) =>
  appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, task.id, decision, at, comment)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at,
  });

const human = { activity: "human" as const, name: "human" };

it("read_memory_entries は別の workspace のエントリ・別の agent 宛ての Behavior・candidate を id で返し、行は list_memory_entries の行に case を足したもの(id 昇順)—— Knowledge と Definition は出所が事例でも case が null(ADR 0122 追記 #1225)", () => {
  const b = board();
  const { db, reader, behavior, knowledge, define } = b;
  const attributed = attribution(b);
  const other = knowledge("charts", "build");
  const addressed = behavior({ title: "Deckhand pins Node", scope: "tidepool", addressee: "deckhand" });
  approve(db, addressed);
  const candidate = behavior({ title: "Still a candidate" });
  const cited = recordKnowledge(
    db,
    { scope: null, path: "habits", title: "Short notes", text: "Notes are short.", source: { event_id: attributed }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    at,
  ).entry_id;
  const defined = define(null, "habits");

  const read = readMemoryEntries(db, reader, { ids: [defined, candidate, other, cited, addressed] }, at);

  const listed = pullMemoryList(db, reader, "list_memory_entries", {}, at).entries;
  expect(read.entries).toEqual([other, addressed, candidate, cited, defined].map((id) => ({ ...listed.find((e) => e.id === id), case: null })));
  expect(read.missing).toEqual([]);
});

it("read_memory_entries の approved の Behavior と Exemplar の case は、同じエントリを worker の read_memory で読んだ case と一致する(ADR 0153 決定3)", () => {
  const b = board();
  const { db, task, reader, behavior } = b;
  const drafted = behavior({ title: "Short notes", source: attribution(b) });
  approve(db, drafted);
  const { exemplar } = humanOriginals(b);

  const worker = readMemory(db, { taskId: task.id, scope: null, agent: "auditor" }, { ids: [drafted, exemplar] }, at).entries.map((e) => e.case);
  expect(worker).toEqual([expect.objectContaining({ decision: "kept the note short" }), expect.objectContaining({ decision: "kept the note short" })]);
  expect(readMemoryEntries(db, reader, { ids: [drafted, exemplar] }, at).entries.map((e) => e.case)).toEqual(worker);
});

it("出所が帰責 event の Behavior candidate(worker の read_memory では読めない)も read_memory_entries では case を返し、異議された decision の本文と steering を含む", () => {
  const b = board();
  const { db, task, reader, behavior } = b;
  const candidate = behavior({ title: "Short notes", source: attribution(b, "say why it is short") });

  expect(readMemory(db, { taskId: task.id, scope: null, agent: "auditor" }, { ids: [candidate] }, at).entries).toEqual([]);
  expect(readMemoryEntries(db, reader, { ids: [candidate] }, at).entries[0]!.case).toMatchObject({ decision: "kept the note short", steering: ["say why it is short"] });
});

it("read_memory_entries は path_moved の id に鎖の末尾の行を requested_id つきで返す —— 2度移した id も末尾に着き、末尾の scope が求めた行と違っても返る。pull は求めた ids とたどった先の returned_ids を memory_pulled に残す(ADR 0167 決定1)", () => {
  const { db, reader, knowledge } = board();
  const once = knowledge("tidepool", "notes");
  const twice = knowledge("tidepool", "tools");
  const copy = moveMemory(db, { entry_id: once, scope: "tidepool", path: "elsewhere", mover: human }, "webui", at).entry_id;
  const middle = moveMemory(db, { entry_id: twice, scope: "tidepool", path: "a", mover: human }, "webui", at).entry_id;
  const tail = moveMemory(db, { entry_id: middle, scope: null, path: "b", mover: human }, "webui", at).entry_id;

  const read = readMemoryEntries(db, reader, { ids: [once, twice] }, at);

  expect(read.entries.map(({ id, scope, text, requested_id }) => ({ id, scope, text, requested_id }))).toEqual([
    { id: copy, scope: "tidepool", text: "notes.", requested_id: once },
    { id: tail, scope: null, text: "tools.", requested_id: twice },
  ]);
  const pulled = getEvent(db, read.event_id)!;
  expect(pulled).toMatchObject({ task_id: reader.taskId, worker_id: "auditor", payload: { kind: "memory_pulled", verb: "read_memory_entries", input: { ids: [once, twice] }, returned_ids: [copy, tail] } });
  expect(pulled.payload).not.toHaveProperty("dropped");
});

it("read_memory_entries は理由コードで無効化したあと復元した id に復元の複製を、移したあと末尾が理由コードで無効化された id に末尾の行を本文と invalidation_reason ごと、どちらも requested_id つきで返す", () => {
  const { db, reader, knowledge } = board();
  const old = knowledge("tidepool", "notes");
  invalidateMemoryEntry(db, { entry_id: old, reason: "capability" }, "human", "webui", at);
  const copy = restoreMemoryEntry(db, { entry_id: old, restorer: human }, "webui", at).entry_id;
  const moved = knowledge("tidepool", "tools");
  const tail = moveMemory(db, { entry_id: moved, scope: "tidepool", path: "elsewhere", mover: human }, "webui", at).entry_id;
  invalidateMemoryEntry(db, { entry_id: tail, reason: "environment" }, "human", "webui", at);

  expect(readMemoryEntries(db, reader, { ids: [old, moved] }, at).entries).toMatchObject([
    { id: copy, requested_id: old, text: "notes.", invalidation_reason: null },
    { id: tail, requested_id: moved, text: "tools.", invalidation_reason: "environment" },
  ]);
});

it("read_memory_entries は superseded と理由コードで無効化された id に、その行自身を本文・invalidation_reason・successor_id・invalidated_by ごと返し、requested_id は付かない", () => {
  const { db, reader, knowledge } = board();
  const replaced = knowledge("tidepool", "notes");
  const successor = knowledge("tidepool", "notes/short");
  invalidateMemoryEntry(db, { entry_id: replaced, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const retired = knowledge("tidepool", "tools");
  invalidateMemoryByMetaReview(db, { entry_id: retired, reason: "capability" }, "auditor", "worker", at);

  const { entries } = readMemoryEntries(db, reader, { ids: [replaced, retired] }, at);

  expect(entries).toMatchObject([
    { id: replaced, text: "notes.", invalidation_reason: "superseded", successor_id: successor, invalidated_by: { worker: "human" } },
    { id: retired, text: "tools.", invalidation_reason: "capability", successor_id: null, invalidated_by: { activity: "meta_review" } },
  ]);
  for (const entry of entries) expect(entry.requested_id).toBeUndefined();
});

it("read_memory_entries に旧 id とそれが着く先の id を同時に求めると、行は1件で requested_id は付かない", () => {
  const { db, reader, knowledge } = board();
  const old = knowledge("tidepool", "notes");
  const tail = moveMemory(db, { entry_id: old, scope: "tidepool", path: "elsewhere", mover: human }, "webui", at).entry_id;

  expect(readMemoryEntries(db, reader, { ids: [old, tail] }, at).entries.map(({ id, requested_id }) => ({ id, requested_id }))).toEqual([{ id: tail, requested_id: undefined }]);
});

it("read_memory_entries の存在しない id は missing に並び、ほかの id の行は返る", () => {
  const { db, reader, knowledge } = board();
  const id = knowledge("tidepool", "notes");

  const read = readMemoryEntries(db, reader, { ids: [9999, id, 9998] }, at);

  expect(read.entries.map((e) => e.id)).toEqual([id]);
  expect(read.missing).toEqual([9999, 9998]);
});

it("read_memory_entries の行は、人間が原文つきで書いたエントリの原文 original も Exemplar の注釈の原文 annotations[].original も持たない", () => {
  const b = board();
  const { behavior, exemplar } = humanOriginals(b);

  const { entries } = readMemoryEntries(b.db, b.reader, { ids: [behavior, exemplar] }, at);

  expect(entries).toHaveLength(2);
  for (const entry of entries) expect(entry).not.toHaveProperty("original");
  expect(entries[1]!.annotations).toEqual([{ anchor: { field: "decision", quote: "short" }, polarity: "imitate", text: "Keep the note short." }]);
});

it("session の中で read_memory_entries が返した id は、その session の Precedent の entries_seen に入り entries_read に入らない(ADR 0122 追記 #1225)", () => {
  const { db, task, reader, knowledge } = board();
  const spawned = appendEvent(db, { taskId: task.id, workerId: "auditor", origin: "board", payload: WORKER_SPAWNED, at });
  const id = knowledge("tidepool", "notes");
  const read = readMemoryEntries(db, reader, { ids: [id] }, at);
  const decision = logDecision(db, task, "retired the stale note", "auditor", at, "worker");
  const toolCall = (n: number, name: string, eventId: number) => [
    `{"type":"assistant","uuid":"a${n}","message":{"content":[{"type":"tool_use","id":"t${n}","name":"${name}","input":{}}]}}`,
    `{"type":"user","uuid":"r${n}","message":{"content":[{"type":"tool_result","tool_use_id":"t${n}","content":[{"type":"text","text":"{\\"event_id\\":${eventId}}"}]}]}}`,
  ];
  const events = listEvents(db, task.id);

  const episode = projectEpisode({
    transcriptLines: [...toolCall(1, "mcp__tidepool__read_memory_entries", read.event_id), ...toolCall(2, "mcp__tidepool__log_decision", decision)],
    events,
    workerSpawnedEventId: spawned,
    extractorVersion: "test",
  });

  expect(entriesSeenBefore(episode, events, decision)).toEqual([id]);
  expect(entriesReadBefore(episode, events, decision)).toEqual([]);
});

it("search_memory_entries の query は全 scope・全宛先の approved と candidate の Knowledge・Behavior・Exemplar を返し、Definition は返さない —— 行はポインタで本文・原文を持たない(ADR 0180 決定3)", () => {
  const { db, reader, behavior, knowledge, define } = board();
  const other = knowledge("charts", "tide");
  const addressed = behavior({ title: "Deckhand reads the tide", scope: "tidepool", addressee: "deckhand" });
  approve(db, addressed);
  const candidate = behavior({ title: "Check the tide first", scope: null });
  define(null, "tide");
  knowledge("tidepool", "harbor");

  const searched = searchMemoryEntries(db, reader, { query: "tide" }, at);
  const { results } = searched;

  expect(new Set(results.map((r) => r.id))).toEqual(new Set([other, addressed, candidate]));
  expect(results.find((r) => r.id === addressed)).toEqual({
    id: addressed,
    kind: "behavior",
    state: "approved",
    scope: "tidepool",
    path: "habits",
    title: "Deckhand reads the tide",
    addressee: "deckhand",
    invalidation_reason: null,
  });
  expect(searched).not.toHaveProperty("next");
});

it("search_memory_entries は後継なしで落とされたエントリ(capability の Knowledge・reject された candidate)を理由つきで返し、superseded と path_moved の行は返さない", () => {
  const { db, reader, behavior, knowledge, propose, answer } = proposals();
  const dropped = knowledge("tidepool", "tide/dropped");
  invalidateMemoryEntry(db, { entry_id: dropped, reason: "capability" }, "human", "webui", at);
  const rejected = behavior({ title: "Wait for the tide" });
  answer(propose({ op: "approve", candidate_id: rejected, rationale: "r" }), "reject", { comment: "The tide is not ours to wait for." });
  const replaced = knowledge("tidepool", "tide/replaced");
  const successor = knowledge("tidepool", "tide/kept");
  invalidateMemoryEntry(db, { entry_id: replaced, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const moved = knowledge("tidepool", "tide/moved");
  const copy = moveMemory(db, { entry_id: moved, scope: null, path: "tide/copied", mover: human }, "webui", at).entry_id;

  const { results } = searchMemoryEntries(db, reader, { query: "tide" }, at);

  expect(new Map(results.map((r) => [r.id, r.invalidation_reason]))).toEqual(
    new Map<number, string | null>([
      [dropped, "capability"],
      [rejected, "rejected"],
      [successor, null],
      [copy, null],
    ]),
  );
});

/** setup のみ: title と text を指定した Knowledge。 */
const fact = (db: ReturnType<typeof openDb>, scope: string | null, title: string, text: string) =>
  recordKnowledge(db, { scope, path: "build", title, text, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;

it("言い換えのエントリの like は元のエントリを返す —— 同じ語の組を worker の search_memory(AND)で引くと元のエントリには当たらない(#1226 の実測)", () => {
  const { db, task, reader } = board();
  const original = fact(db, "tidepool", "Tests need Node 22", "Run the suite on Node 22 or the sqlite binding breaks.");
  const paraphrase = fact(db, "tidepool", "Node version for the test suite", "The test suite must run under Node 22.");
  const terms = "Node version for the test suite\nThe test suite must run under Node 22.";

  expect(searchMemory(db, { taskId: task.id, scope: "tidepool", agent: "deckhand" }, { query: terms }, at).results.map((r) => r.id)).not.toContain(original);
  expect(searchMemoryEntries(db, reader, { like: paraphrase }, at).results.map((r) => r.id)).toEqual([original]);
});

it("like の結果にそのエントリ自身も、本文が同じ鎖(path_moved の複製・復元の複製と復元元)も出ない —— 無効化済みの id も like に取れる", () => {
  const { db, reader } = board();
  const other = fact(db, "tidepool", "Tide tables", "Tide tables come from the harbor office.");
  const moved = fact(db, "tidepool", "Tide charts", "Tide charts come from the harbor office.");
  const copy = moveMemory(db, { entry_id: moved, scope: null, path: "charts", mover: human }, "webui", at).entry_id;
  const dropped = fact(db, "tidepool", "Tide clocks", "Tide clocks come from the harbor office.");
  invalidateMemoryEntry(db, { entry_id: dropped, reason: "capability" }, "human", "webui", at);
  const restored = restoreMemoryEntry(db, { entry_id: dropped, restorer: human }, "webui", at).entry_id;
  const ids = (like: number) => searchMemoryEntries(db, reader, { like }, at).results.map((r) => r.id);

  expect(new Set(ids(moved))).toEqual(new Set([other, dropped, restored]));
  expect(new Set(ids(copy))).toEqual(new Set([other, dropped, restored]));
  expect(new Set(ids(restored))).toEqual(new Set([other, copy]));
  expect(new Set(ids(dropped))).toEqual(new Set([other, copy]));
});

it("search_memory_entries は query と like の両方・どちらも無し・存在しない like・引ける語の無い query を domain error で断り、memory_pulled を残さない", () => {
  const { db, reader, knowledge } = board();
  const id = knowledge("tidepool", "tide");
  const pulls = () => listEvents(db, reader.taskId).filter((e) => e.kind === "memory_pulled").length;

  for (const input of [{ query: "tide", like: id }, {}, { like: 9999 }, { query: "the of and" }]) {
    expect(() => searchMemoryEntries(db, reader, input, at)).toThrow(DomainError);
  }
  expect(pulls()).toBe(0);
});

it("search_memory_entries は応答予算で切って next と remaining を言い、呼び出しは verb・最初の input・その応答で返した id を memory_pulled に残して event id を返す", () => {
  const { db, reader, behavior } = board();
  const ids = Array.from({ length: 21 }, (_, i) => behavior({ title: `tide ${i} ${"y".repeat(2_000)}` }));

  const first = searchMemoryEntries(db, reader, { query: "tide" }, at);
  const second = searchMemoryEntries(db, reader, { next: first.next }, at);

  expect(first.remaining).toBe(21 - first.results.length);
  expect(second).not.toHaveProperty("next");
  expect([...first.results, ...second.results].map((r) => r.id).sort((a, b) => a - b)).toEqual(ids);
  expect(getEvent(db, second.event_id)).toMatchObject({
    task_id: reader.taskId,
    worker_id: "auditor",
    payload: { kind: "memory_pulled", verb: "search_memory_entries", input: { query: "tide" }, returned_ids: second.results.map((r) => r.id) },
  });
});
