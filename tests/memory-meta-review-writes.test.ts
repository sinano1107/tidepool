import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import {
  approveMemoryProposal,
  createBehaviorCandidate,
  defineMemoryBranch,
  foldMemory,
  type InvalidationReason,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryEntries,
  moveMemory,
  proposeMemoryChange,
  recordKnowledge,
  rejectMemoryProposal,
} from "../src/memory.js";
import { DomainError, getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";

/** meta-review の直接適用(issue #619 / ADR 0122 決定1)のドメイン層。verb への写像はサーバ境界
 *  (tests/mcp-memory-meta-review.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");
const metaReview = { activity: "meta_review" as const, name: "auditor" };

function board() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at);
  const decision = logDecision(db, task, "these two notes say the same thing", "auditor", at);
  const knowledge = (title: string, scope: string | null = "tidepool") =>
    recordKnowledge(
      db,
      { scope, path: "build/tests", title, text: `${title}.`, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
      "worker",
      at,
    ).entry_id;
  return { db, task, decision, knowledge };
}

const entry = (db: ReturnType<typeof openDb>, id: number) => listMemoryEntries(db, {}).find((e) => e.id === id);

it("fold_memory は新しい Knowledge を decision(推論)を出所に作り、replaces をその後継つき superseded にする", () => {
  const { db, decision, knowledge } = board();
  const a = knowledge("Tests need Node 22");
  const b = knowledge("Node 24 breaks the tests");

  const { entry_id } = foldMemory(
    db,
    { scope: null, path: "build", title: "Node 22 only", text: "Tests run on Node 22 only.", replaces: [a, b], based_on_decision: decision, author: metaReview },
    "worker",
    at,
  );

  expect(entry(db, entry_id)).toMatchObject({
    kind: "knowledge",
    state: "approved",
    scope: null,
    path: "build",
    source: { kind: "decision", ref: decision },
    author: metaReview,
    invalidation_reason: null,
  });
  expect([entry(db, a), entry(db, b)]).toMatchObject([
    { invalidation_reason: "superseded", successor_id: entry_id },
    { invalidation_reason: "superseded", successor_id: entry_id },
  ]);
});

it("fold_memory の replaces に畳めないものが1つでもあれば domain error で、新しい Knowledge も書かれず、他の replaces も残る", () => {
  const { db, decision, knowledge } = board();
  const kept = knowledge("kept");
  const dead = knowledge("dead");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "environment" }, "human", "webui", at);
  const definition = defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;
  const candidate = createBehaviorCandidate(
    db,
    { scope: null, path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { event_id: decision }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  const before = listMemoryEntries(db, {});
  const fold = (replaces: number[], based_on_decision = decision) => () =>
    foldMemory(db, { scope: "tidepool", path: "build", title: "Folded", text: "Folded.", replaces, based_on_decision, author: metaReview }, "worker", at);

  for (const replaces of [[kept, dead], [kept, definition], [kept, candidate], [kept, 999], []]) {
    expect(fold(replaces)).toThrow(DomainError);
  }
  // 出所は decision_logged の event に限る(それ以外の event は推論として載せない)
  expect(fold([kept], kept)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("move_memory は title / text / 出所(原文も)を写した Knowledge を別の scope・path に作り、旧を path_moved で新へ指す", () => {
  const { db, knowledge } = board();
  const old = knowledge("Tests need Node 22");
  const human = recordKnowledge(
    db,
    { scope: "tidepool", path: "notes", title: "Deploy on Fridays is fine", text: "Deploys are safe any day.", original: { title: "金曜デプロイ可", text: "何曜でも安全", language: "Japanese" }, author: { activity: "human", name: "human" } },
    "webui",
    at,
  ).entry_id;

  const moved = moveMemory(db, { entry_id: old, scope: null, path: "toolchain/node", author: metaReview }, "worker", at).entry_id;
  const movedHuman = moveMemory(db, { entry_id: human, scope: "charts", path: "deploy", author: metaReview }, "worker", at).entry_id;

  expect(entry(db, moved)).toMatchObject({
    kind: "knowledge",
    scope: null,
    path: "toolchain/node",
    title: "Tests need Node 22",
    text: "Tests need Node 22.",
    source: { kind: "commit", ref: "0a46a46" },
    author: metaReview,
    invalidation_reason: null,
  });
  expect(entry(db, old)).toMatchObject({ invalidation_reason: "path_moved", successor_id: moved });
  // 人間の Knowledge の出所は自身の作成 event —— 移動後もそれを指す
  expect(entry(db, movedHuman)).toMatchObject({
    scope: "charts",
    original: { title: "金曜デプロイ可", text: "何曜でも安全", language: "Japanese" },
    source: { kind: "event", ref: human },
  });
});

it("move_memory は Definition と Behavior を domain error で拒み、何も書かない", () => {
  const { db, decision } = board();
  const definition = defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;
  const behavior = createBehaviorCandidate(
    db,
    { scope: null, path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { event_id: decision }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  const before = listMemoryEntries(db, {});
  for (const entry_id of [definition, behavior]) {
    expect(() => moveMemory(db, { entry_id, scope: null, path: "elsewhere", author: metaReview }, "worker", at)).toThrow(DomainError);
  }
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("meta-review の無効化は candidate・Knowledge・Definition に効き、approved の Behavior と path_moved は domain error で拒む", () => {
  const { db, decision, knowledge } = board();
  const fact = knowledge("stale fact");
  const successor = knowledge("fresh fact", null);
  const definition = defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;
  const behavior = (title: string) =>
    createBehaviorCandidate(
      db,
      { scope: null, path: "habits", title, text: `${title}.`, addressee: null, source: { event_id: decision }, author: { activity: "rca", name: "auditor" } },
      "worker",
      at,
    ).entry_id;
  const candidate = behavior("Small commits");
  const approved = behavior("Rebase before push");
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: approved, replaces: [] }, "question-1", "webui", at);
  const invalidate = (entry_id: number, reason: InvalidationReason, successor_id?: number) =>
    invalidateMemoryByMetaReview(db, { entry_id, reason, successor_id }, "auditor", "worker", at);

  invalidate(candidate, "requirement_change");
  invalidate(fact, "superseded", successor);
  invalidate(definition, "environment");
  expect(() => invalidate(approved, "capability")).toThrow(DomainError);
  expect(() => invalidate(successor, "path_moved", approved)).toThrow(DomainError);

  expect(listMemoryEntries(db, { state: "invalidated" }).map((e) => [e.id, e.invalidation_reason, e.successor_id])).toEqual([
    [fact, "superseded", successor],
    [definition, "environment", null],
    [candidate, "requirement_change", null],
  ]);
});

it("meta-review の無効化の rejected は candidate(Behavior / Exemplar)だけを引退させ、candidate でないものへは domain error(issue #954)", () => {
  const { db, attributed, drafted, consolidate } = drafts();
  const behavior = drafted("Split migrations", { event_id: attributed("split the migration into two commits") });
  const exemplar = consolidate([drafted("Two commits", { event_id: attributed("kept two commits") })], { kind: "exemplar", annotations: [annotations[1]] }).candidate_id;
  const fact = recordKnowledge(
    db,
    { scope: "tidepool", path: "build", title: "Node 22", text: "Node 22.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    at,
  ).entry_id;
  const reject = (entry_id: number) => invalidateMemoryByMetaReview(db, { entry_id, reason: "rejected" }, "auditor", "worker", at);

  reject(behavior);
  reject(exemplar);
  expect(() => reject(fact)).toThrow(DomainError);

  expect([entry(db, behavior), entry(db, exemplar), entry(db, fact)]).toMatchObject([
    { invalidation_reason: "rejected", successor_id: null },
    { invalidation_reason: "rejected", successor_id: null },
    { invalidation_reason: null },
  ]);
});

/** consolidate の kind exemplar(issue #954 / ADR 0153)。replaces は RCA の起草と同じ形 —— 異議された decision への帰責 event を
 *  出所に持つ Behavior candidate。 */
function drafts() {
  const { db, task, decision } = board();
  const attributed = (line: string) =>
    appendEvent(db, {
      taskId: task.id,
      workerId: "tidepool",
      origin: "board",
      payload: { kind: "objection_attributed", entry_id: logDecision(db, task, line, "deckhand", at), objection_event_ids: [], cause: "preference", evidence: "e", round: "after_rca" },
      at,
    });
  const drafted = (title: string, source: { event_id: number } | { commit: string }) =>
    createBehaviorCandidate(
      db,
      { scope: "tidepool", path: "habits/migrations", title, text: `${title}.`, addressee: null, source, author: { activity: "rca", name: "auditor" } },
      "worker",
      at,
    ).entry_id;
  const consolidate = (replaces: number[], text: Record<string, unknown>) =>
    getTask(
      db,
      proposeMemoryChange(
        db,
        task.id,
        {
          op: "consolidate",
          text: { scope: null, path: "habits", title: "Split the migration", addressee: null, ...text } as never,
          replaces,
          based_on_decision: decision,
          rationale: "Too particular for a rule.",
        },
        "auditor",
        at,
      ).question_id,
    )!.question_proposal as MemoryProposal & { candidate_id: number };
  return { db, decision, attributed, drafted, consolidate };
}
const annotations = [
  { anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split schema changes from data changes." },
  { anchor: "whole", polarity: "avoid", text: "Do not mix in unrelated refactors." },
];

it("consolidate の kind exemplar は注釈つきの Exemplar candidate を meta_review 名義で作り、出所は replaces が共有する出所、text は注釈の英語 text の連結", () => {
  const { db, attributed, drafted, consolidate } = drafts();
  const source = attributed("split the migration into two commits");
  const replaces = [drafted("Split migrations", { event_id: source }), drafted("Two commits per migration", { event_id: source })];

  const { candidate_id } = consolidate(replaces, { kind: "exemplar", annotations });

  expect(entry(db, candidate_id)).toMatchObject({
    kind: "exemplar",
    state: "candidate",
    scope: null,
    path: "habits",
    title: "Split the migration",
    text: "Split schema changes from data changes.\nDo not mix in unrelated refactors.",
    annotations,
    source: { kind: "event", ref: source },
    author: metaReview,
    invalidation_reason: null,
  });
});

it.each([
  ["replaces の出所が揃わない", "mixed", { annotations }],
  ["共有出所が meta-review の推論(decision)で case を描けない", "decision", { annotations: [annotations[1]] }],
  ["共有出所が commit で case を描けない", "commit", { annotations: [annotations[1]] }],
  ["text を渡す(text は注釈から導く)", "shared", { annotations, text: "Split it." }],
  ["注釈に原文を渡す(原文は人間のもの)", "shared", { annotations: [{ ...annotations[1], original: "無関係なリファクタを混ぜない" }] }],
  ["注釈が空", "shared", { annotations: [] }],
  ["quote が case の欄の逐語部分文字列でない", "shared", { annotations: [{ anchor: { field: "decision", quote: "three commits" }, polarity: "avoid", text: "x" }] }],
  ["polarity が無い", "shared", { annotations: [{ anchor: "whole", text: "x" }] }],
] as const)("consolidate の kind exemplar で%sと domain error で、candidate も question も書かれない", (_, sources, text) => {
  const { db, decision, attributed, drafted, consolidate } = drafts();
  const shared = attributed("split the migration into two commits");
  const source = (i: number) =>
    ({
      mixed: { event_id: i === 0 ? shared : attributed("kept the migration whole") },
      decision: { event_id: decision },
      commit: { commit: "0a46a46" },
      shared: { event_id: shared },
    })[sources];
  const replaces = [drafted("Split migrations", source(0)), drafted("Two commits per migration", source(1))];
  const before = listMemoryEntries(db, {});

  expect(() => consolidate(replaces, { kind: "exemplar", ...text })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("Exemplar の consolidate は approve で candidate を approved にして replaces をそれを後継とする superseded にし、reject で candidate だけを rejected にする", () => {
  const { db, attributed, drafted, consolidate } = drafts();
  const source = attributed("split the migration into two commits");
  const replaces = [drafted("Split migrations", { event_id: source }), drafted("Two commits per migration", { event_id: source })];
  const rejected = consolidate(replaces, { kind: "exemplar", annotations });

  rejectMemoryProposal(db, rejected, "question-1", "webui", at);
  expect(listMemoryEntries(db, {}).filter((e) => e.kind !== "knowledge").map((e) => [e.id, e.state, e.invalidation_reason, e.successor_id])).toEqual([
    [replaces[0], "candidate", null, null],
    [replaces[1], "candidate", null, null],
    [rejected.candidate_id, "candidate", "rejected", null],
  ]);

  const approved = consolidate(replaces, { kind: "exemplar", annotations });
  approveMemoryProposal(db, approved, "question-2", "webui", at);
  expect(listMemoryEntries(db, { state: "approved" }).map((e) => [e.id, e.kind])).toEqual([[approved.candidate_id, "exemplar"]]);
  expect(replaces.map((id) => entry(db, id))).toMatchObject([
    { invalidation_reason: "superseded", successor_id: approved.candidate_id },
    { invalidation_reason: "superseded", successor_id: approved.candidate_id },
  ]);
});

it("Exemplar の提案の修正値つき approve は domain error で何も変えない(注釈の修正は #944 の拡張)", () => {
  const { db, attributed, drafted, consolidate } = drafts();
  const source = attributed("split the migration into two commits");
  const proposal = consolidate([drafted("Split migrations", { event_id: source })], { kind: "exemplar", annotations });
  const before = listMemoryEntries(db, {});

  expect(() => approveMemoryProposal(db, proposal, "question-1", "webui", at, { title: "Split it" })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("kind を省いた consolidate は Behavior candidate を作り、replaces(Exemplar も取れる)の出所が揃えばそれを継ぎ、揃わなければ meta-review の推論(decision)を出所にする", () => {
  const { db, decision, attributed, drafted, consolidate } = drafts();
  const source = attributed("split the migration into two commits");
  const exemplar = consolidate([drafted("Split migrations", { event_id: source })], { kind: "exemplar", annotations });
  approveMemoryProposal(db, exemplar, "question-1", "webui", at);
  const behavior = { text: "Keep schema and data changes in separate commits." };

  const inherited = consolidate([exemplar.candidate_id], behavior).candidate_id;
  const mixed = consolidate([drafted("Pin Node", { event_id: attributed("pinned Node 22") }), drafted("Pin npm", { commit: "0a46a46" })], behavior).candidate_id;

  expect([entry(db, inherited), entry(db, mixed)]).toMatchObject([
    { kind: "behavior", state: "candidate", text: behavior.text, source: { kind: "event", ref: source }, author: metaReview },
    { kind: "behavior", state: "candidate", text: behavior.text, source: { kind: "decision", ref: decision }, author: metaReview },
  ]);
});
