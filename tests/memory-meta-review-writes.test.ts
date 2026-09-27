import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import {
  approveMemoryProposal,
  createBehaviorCandidate,
  defineMemoryBranch,
  foldMemory,
  humanEntryInput,
  type InvalidationReason,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryEntries,
  moveMemory,
  proposeMemoryChange,
  recordBehavior,
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
const knowledgeEntry = (db: ReturnType<typeof openDb>) =>
  recordKnowledge(db, { scope: null, path: "habits", title: "k", text: "k.", source: { commit: "0a46a46" }, author: metaReview }, "worker", at).entry_id;
const definitionEntry = (db: ReturnType<typeof openDb>) =>
  defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;

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

it("meta-review の無効化は approved の Exemplar を superseded を含むどの理由でも domain error で拒み、candidate の Exemplar は直接無効化できる(ADR 0160 決定1)", () => {
  const { db, attributed, drafted, consolidate, exemplar, behavior } = approvedPair();
  const candidate = consolidate([drafted("Keep it split", { event_id: attributed("kept the two commits apart") })], { kind: "exemplar", annotations }).candidate_id;
  const invalidate = (entry_id: number, reason: InvalidationReason, successor_id?: number) =>
    invalidateMemoryByMetaReview(db, { entry_id, reason, successor_id }, "auditor", "worker", at);

  for (const [reason, successor_id] of [["superseded", behavior], ["capability"], ["environment"], ["requirement_change"]] as const) {
    expect(() => invalidate(exemplar, reason, successor_id)).toThrow(/propose it instead/);
  }
  invalidate(candidate, "superseded", exemplar);

  expect([entry(db, exemplar), entry(db, candidate)]).toMatchObject([
    { state: "approved", invalidation_reason: null },
    { state: "candidate", invalidation_reason: "superseded", successor_id: exemplar },
  ]);
});

it("invalidate の提案は approved の Exemplar も target に取り、見出しを kind で出し分け、approve で target を理由コードのまま後継なしで無効化する(ADR 0160 決定2)", () => {
  const { db, task, exemplar, behavior } = approvedPair();
  const invalidate = (target_id: number) =>
    getTask(db, proposeMemoryChange(db, task.id, { op: "invalidate", target_id, reason: "environment", rationale: "The CI no longer squashes." }, "auditor", at).question_id)!;

  const question = invalidate(exemplar);
  expect(question.question_items![0]!.detail).toContain(`Invalidate approved exemplar #${exemplar} (reason: environment).`);
  expect(invalidate(behavior).question_items![0]!.detail).toContain(`Invalidate approved behavior #${behavior} (reason: environment).`);

  approveMemoryProposal(db, question.question_proposal as MemoryProposal, question.id, "webui", at);
  expect(entry(db, exemplar)).toMatchObject({ invalidation_reason: "environment", successor_id: null });
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
  return { db, task, decision, attributed, drafted, consolidate };
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

  rejectMemoryProposal(db, rejected, "question-1", "webui", at, "Too particular.");
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

it("memory 提案の reject は comment が空・空白だけなら domain error で何も変えない(ADR 0159 決定3)", () => {
  const { db, attributed, drafted, consolidate } = drafts();
  const proposal = consolidate([drafted("Split migrations", { event_id: attributed("split the migration into two commits") })], { kind: "exemplar", annotations });
  const before = listMemoryEntries(db, {});

  for (const comment of [undefined, "", " \n "]) expect(() => rejectMemoryProposal(db, proposal, "question-1", "webui", at, comment)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("出所を添えずに人間が書いた Behavior だけを replaces に取る consolidate は、その作成 event を継がず Behavior なら decision を出所にし、Exemplar なら domain error", () => {
  const { db, decision, consolidate } = drafts();
  const human = recordBehavior(
    db,
    { ...humanEntryInput(db, { workspace: "tidepool", path: "habits", title: "Pin Node", text: "Pin Node 22." }), addressee: null },
    "webui",
    at,
  ).entry_id;

  expect(entry(db, consolidate([human], { text: "Pin the toolchain." }).candidate_id)).toMatchObject({ source: { kind: "decision", ref: decision } });
  expect(() => consolidate([human], { kind: "exemplar", annotations })).toThrow(/case the board can render/);
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

/** approved の Exemplar と approved の Behavior(ADR 0160 の無効化と、既存の後継を名指す consolidate の相手)。 */
function approvedPair() {
  const fixture = drafts();
  const { db, task, attributed, drafted, consolidate } = fixture;
  const exemplar = consolidate([drafted("Split migrations", { event_id: attributed("split the migration into two commits") })], { kind: "exemplar", annotations });
  approveMemoryProposal(db, exemplar, "question-1", "webui", at);
  const behavior = consolidate([drafted("Pin Node", { commit: "0a46a46" })], { text: "Pin Node 22." });
  approveMemoryProposal(db, behavior, "question-2", "webui", at);
  const propose = (input: Omit<Parameters<typeof proposeMemoryChange>[2], "op" | "rationale">) =>
    getTask(db, proposeMemoryChange(db, task.id, { op: "consolidate", rationale: "The same case as the kept one.", ...input }, "auditor", at).question_id)!;
  const replaced = (title: string) => drafted(title, { commit: "0a46a46" });
  return { ...fixture, exemplar: exemplar.candidate_id, behavior: behavior.candidate_id, propose, replaced };
}

it("consolidate の successor_id は既存の approved の Exemplar / Behavior を後継に名指して版を pin し、新しい entry を作らず、detail に replaces と後継の本文を載せる(ADR 0160 決定2・4)", () => {
  const { db, exemplar: successor, behavior, propose, replaced } = approvedPair();
  const replaces = [replaced("Two commits per migration"), replaced("One schema change per commit")];
  const before = listMemoryEntries(db, {});

  const question = propose({ successor_id: successor, replaces });

  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(question.question_proposal).toEqual({
    kind: "memory",
    op: "consolidate",
    successor: { id: successor, version: entry(db, successor)!.version },
    replaces: replaces.map((id) => ({ id, version: null })),
  });
  const { detail } = question.question_items![0]!;
  for (const shown of [
    `Consolidate into existing exemplar #${successor}, replacing:`,
    `#${replaces[0]} (scope: tidepool, addressee: every agent): Two commits per migration.`,
    `#${replaces[1]} (scope: tidepool, addressee: every agent): One schema change per commit.`,
    'Annotations:\n- imitate (decision: "two commits"): Split schema changes from data changes.',
    "Case:\nDecision: split the migration into two commits",
  ]) {
    expect(detail).toContain(shown);
  }
  const intoBehavior = propose({ successor_id: behavior, replaces: [replaced("Pin npm")] }).question_items![0]!.detail;
  expect(intoBehavior).toContain(`Consolidate into existing behavior #${behavior}, replacing:`);
  expect(intoBehavior).toContain("Pin Node 22.");
});

it.each([
  ["text と successor_id の両方を渡す", (f: Fixture) => ({ successor_id: f.exemplar, text: { scope: null, path: "habits", title: "Split", text: "Split it.", addressee: null } })],
  ["text も successor_id も渡さない", () => ({})],
  ["successor_id に based_on_decision を添える(新しい entry を作らないので出所は要らない)", (f: Fixture) => ({ successor_id: f.exemplar, based_on_decision: f.decision })],
  ["後継が candidate", (f: Fixture) => ({ successor_id: f.replaced("Split migrations again") })],
  [
    "後継が無効化済み",
    (f: Fixture) => {
      invalidateMemoryEntry(f.db, { entry_id: f.behavior, reason: "requirement_change" }, "human", "webui", at);
      return { successor_id: f.behavior };
    },
  ],
  ["後継が Knowledge", (f: Fixture) => ({ successor_id: knowledgeEntry(f.db) })],
  ["後継が replaces に含まれる", (f: Fixture) => ({ successor_id: f.exemplar, replaces: [f.replaced("Two commits again"), f.exemplar] })],
] as const)("consolidate で%sと domain error で、何も pin せず entry も書かない", (_, input) => {
  const fixture = approvedPair();
  const { db, exemplar: successor, propose, replaced } = fixture;
  const replaces = [replaced("Two commits per migration")];
  const bad = input(fixture);
  const before = listMemoryEntries(db, {});

  expect(() => propose({ replaces, ...bad })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(propose({ successor_id: successor, replaces }).question_proposal).toMatchObject({ successor: { id: successor } });
});
type Fixture = ReturnType<typeof approvedPair>;

it("既存の後継の consolidate は approve で replaces を後継つき superseded(人間名義・question の印)にし、修正値は断り、reject は何も変えない(ADR 0160 決定2)", () => {
  const { db, exemplar: successor, propose, replaced } = approvedPair();
  const kept = [replaced("Two commits per migration")];
  const replaces = [replaced("One schema change per commit"), replaced("Separate the data migration")];

  const refused = propose({ successor_id: successor, replaces: kept });
  const before = listMemoryEntries(db, {});
  rejectMemoryProposal(db, refused.question_proposal as MemoryProposal, refused.id, "webui", at, "A different case.");
  expect(listMemoryEntries(db, {})).toEqual(before);

  const question = propose({ successor_id: successor, replaces });
  const proposal = question.question_proposal as MemoryProposal;
  expect(() => approveMemoryProposal(db, proposal, question.id, "webui", at, { title: "Split it" })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);

  approveMemoryProposal(db, proposal, question.id, "webui", at);
  expect([...kept, ...replaces, successor].map((id) => entry(db, id))).toMatchObject([
    { state: "candidate", invalidation_reason: null },
    { invalidation_reason: "superseded", successor_id: successor, invalidated_by: { question_id: question.id } },
    { invalidation_reason: "superseded", successor_id: successor, invalidated_by: { question_id: question.id } },
    { state: "approved", invalidation_reason: null },
  ]);
});

it("既存の後継は pin に入り、提案の open 中に無効化されると question は観測で決着し承認も stale で断る —— 同じ後継の2件目(別の replaces)は通り、同じ replaces の2件目は断る(ADR 0160 決定3)", () => {
  const { db, exemplar: successor, propose, replaced } = approvedPair();
  const replaces = [replaced("Two commits per migration")];
  const first = propose({ successor_id: successor, replaces });
  const second = propose({ successor_id: successor, replaces: [replaced("One schema change per commit")] });
  expect(() => propose({ successor_id: successor, replaces })).toThrow(/already in an open proposal question/);

  const observed = invalidateMemoryEntry(db, { entry_id: successor, reason: "requirement_change" }, "human", "webui", at);

  for (const question of [first, second]) {
    expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
    expect(listEvents(db, question.id).at(-1)).toMatchObject({ kind: "memory_proposal_stale", payload: { entry_id: successor, observed_event_id: observed } });
  }
  expect(() => approveMemoryProposal(db, first.question_proposal as MemoryProposal, first.id, "webui", at)).toThrow(/stale/);
  expect(entry(db, replaces[0]!)).toMatchObject({ invalidation_reason: null });
});

/** 提案の時点の拒否(issue #1034 / ADR 0107 決定3)。server boundary(tests/memory-proposal-question.test.ts)は tool error への
 *  写像だけを言う。各テストは欠陥だけを抜いた同じ呼び出しが通ることを対照に持つ —— 別の理由の domain error で緑にならないように。 */
type Drafts = ReturnType<typeof drafts>;
const approve = (f: Fixture) => (candidate_id: number) => proposeMemoryChange(f.db, f.task.id, { op: "approve", candidate_id, rationale: "r" }, "auditor", at);
const invalidate = (f: Fixture) => (target_id: number) =>
  proposeMemoryChange(f.db, f.task.id, { op: "invalidate", target_id, reason: "environment", rationale: "r" }, "auditor", at);
const replacing = (f: Drafts) => (id: number) => f.consolidate([id], { text: "One rule." });

it.each([
  ["Knowledge", (f: Drafts) => knowledgeEntry(f.db)],
  ["Definition", (f: Drafts) => definitionEntry(f.db)],
  [
    "無効化済みの Behavior",
    (f: Drafts) => {
      const id = f.drafted("Dead", { commit: "0a46a46" });
      invalidateMemoryEntry(f.db, { entry_id: id, reason: "environment" }, "human", "webui", at);
      return id;
    },
  ],
] as const)("consolidate の replaces に%sを含めると domain error で、entry も書かない", (_, makeBad) => {
  const fixture = drafts();
  const bad = makeBad(fixture);
  const before = listMemoryEntries(fixture.db, {});

  expect(() => replacing(fixture)(bad)).toThrow(DomainError);
  expect(listMemoryEntries(fixture.db, {})).toEqual(before);
  expect(replacing(fixture)(fixture.drafted("Good", { commit: "0a46a46" }))).toMatchObject({ candidate_id: expect.any(Number) });
});

it("consolidate の based_on_decision が decision_logged でない event だと domain error で、entry も書かない", () => {
  const { db, task, decision, drafted } = drafts();
  const replaces = [drafted("Good", { commit: "0a46a46" })];
  const notDecision = listEvents(db, task.id)[0]!.id; // task_registered
  const propose = (based_on_decision: number) =>
    proposeMemoryChange(
      db,
      task.id,
      { op: "consolidate", text: { scope: null, path: "habits", title: "One rule", text: "One rule.", addressee: null }, replaces, based_on_decision, rationale: "r" },
      "auditor",
      at,
    );
  const before = listMemoryEntries(db, {});

  expect(() => propose(notDecision)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(propose(decision)).toMatchObject({ question_id: expect.any(String) });
});

it.each([
  ["candidate の Behavior", (f: Fixture) => f.replaced("Bad")],
  ["Knowledge", (f: Fixture) => knowledgeEntry(f.db)],
  ["Definition", (f: Fixture) => definitionEntry(f.db)],
  [
    "無効化済みの Behavior",
    (f: Fixture) => {
      invalidateMemoryEntry(f.db, { entry_id: f.behavior, reason: "requirement_change" }, "human", "webui", at);
      return f.behavior;
    },
  ],
] as const)("invalidate の target_id に%sを渡すと domain error", (_, makeBad) => {
  const fixture = approvedPair();

  expect(() => invalidate(fixture)(makeBad(fixture))).toThrow(DomainError);
  expect(invalidate(fixture)(fixture.exemplar)).toMatchObject({ question_id: expect.any(String) });
});

/** 既存の後継への pin は「既存の後継は pin に入り…」のテストが言う。ここは op を跨いだ pin。 */
it.each([
  [
    "approve の candidate を consolidate の replaces に取る",
    (f: Fixture) => {
      const pinned = f.replaced("A");
      approve(f)(pinned);
      return { pinned, free: f.replaced("B"), propose: replacing(f) };
    },
  ],
  [
    "invalidate の target を consolidate の replaces に取る",
    (f: Fixture) => {
      invalidate(f)(f.exemplar);
      return { pinned: f.exemplar, free: f.behavior, propose: replacing(f) };
    },
  ],
  [
    "consolidate の replaces の candidate を approve する",
    (f: Fixture) => {
      const pinned = f.replaced("A");
      replacing(f)(pinned);
      return { pinned, free: f.replaced("B"), propose: approve(f) };
    },
  ],
  [
    "consolidate の replaces の approved を invalidate する",
    (f: Fixture) => {
      replacing(f)(f.behavior);
      return { pinned: f.behavior, free: f.exemplar, propose: invalidate(f) };
    },
  ],
  ["consolidate が作った新 candidate を approve する", (f: Fixture) => ({ pinned: replacing(f)(f.replaced("A")).candidate_id, free: f.replaced("B"), propose: approve(f) })],
] as const)("%sと、既に open な提案に pin されているので domain error で entry も書かない", (_, setup) => {
  const fixture = approvedPair();
  const { pinned, free, propose } = setup(fixture);
  const before = listMemoryEntries(fixture.db, {});

  expect(() => propose(pinned)).toThrow(DomainError);
  expect(listMemoryEntries(fixture.db, {})).toEqual(before);
  expect(() => propose(free)).not.toThrow();
});

it("op approve に consolidate の欄(replaces)を渡すと、黙って捨てずに domain error で断る", () => {
  const { db, task, drafted } = drafts();
  const candidate_id = drafted("A", { commit: "0a46a46" });

  expect(() => proposeMemoryChange(db, task.id, { op: "approve", candidate_id, replaces: [999999], rationale: "r" }, "auditor", at)).toThrow(DomainError);
  expect(proposeMemoryChange(db, task.id, { op: "approve", candidate_id, rationale: "r" }, "auditor", at)).toMatchObject({ question_id: expect.any(String) });
});
