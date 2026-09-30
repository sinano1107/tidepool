import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import {
  approveMemoryProposal,
  createBehaviorCandidate,
  deferMemoryProposal,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  humanEntryInput,
  type InvalidationReason,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryEntries,
  moveMemoryBranchByMetaReview,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  recordBehavior,
  recordKnowledge,
  rejectMemoryProposal,
} from "../src/memory.js";
import { DomainError, getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";
import { bundledObjection } from "./harness.js";

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
const knowledgeEntry = (db: ReturnType<typeof openDb>, scope: string | null = null) =>
  recordKnowledge(db, { scope, path: "habits", title: "k", text: "k.", source: { commit: "0a46a46" }, author: metaReview }, "worker", at).entry_id;
const definitionEntry = (db: ReturnType<typeof openDb>) =>
  defineMemoryByMetaReview(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;
const decisionOfAnotherTask = (db: ReturnType<typeof openDb>) =>
  logDecision(db, registerTask(db, { type: "work", title: "o", purpose: "p", completion_criteria: "c" }, at), "someone else's reasoning", "deckhand", at);

it("fold_memory は新しい Knowledge を decision(推論)を出所に作り、replaces をその後継つき superseded にする", () => {
  const { db, task, decision, knowledge } = board();
  const a = knowledge("Tests need Node 22");
  const b = knowledge("Node 24 breaks the tests");

  const { entry_id } = foldMemory(
    db,
    task.id,
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
  const { db, task, decision, knowledge } = board();
  const kept = knowledge("kept");
  const dead = knowledge("dead");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "environment" }, "human", "webui", at);
  const definition = defineMemoryByMetaReview(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;
  const candidate = createBehaviorCandidate(
    db,
    { scope: null, path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { event_id: decision }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  const before = listMemoryEntries(db, {});
  const fold = (replaces: number[], based_on_decision = decision) => () =>
    foldMemory(db, task.id, { scope: "tidepool", path: "build", title: "Folded", text: "Folded.", replaces, based_on_decision, author: metaReview }, "worker", at);

  for (const replaces of [[kept, dead], [kept, definition], [kept, candidate], [kept, 999], []]) {
    expect(fold(replaces)).toThrow(DomainError);
  }
  // 出所は decision_logged の event に限る(それ以外の event は推論として載せない)。それも自分の task の decision に限る(ADR 0115 追記)
  expect(fold([kept], kept)).toThrow(DomainError);
  const othersDecision = decisionOfAnotherTask(db);
  expect(fold([kept], othersDecision)).toThrow(`event ${othersDecision} is not a decision of this task`);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("meta-review の move_memory は4種別の approved / candidate を同じ scope の別 path へ移し、複製は書き手・状態・出所・版を継ぐ —— 移した meta-review は無効化 event の activity に載る(ADR 0176 決定1 / ADR 0162 決定5)", () => {
  const { db, attributed, drafted, consolidate, behavior, exemplar, replaced } = approvedPair();
  const candidateExemplar = consolidate([drafted("Keep it split", { event_id: attributed("kept the two commits apart") })], { kind: "exemplar", annotations }).candidate_id;
  const human = recordKnowledge(
    db,
    { scope: "tidepool", path: "notes", title: "Deploy on Fridays is fine", text: "Deploys are safe any day.", original: { title: "金曜デプロイ可", text: "何曜でも安全", language: "Japanese" }, author: { activity: "human", name: "human" } },
    "webui",
    at,
  ).entry_id;
  const olds = [behavior, exemplar, replaced("Two commits per migration"), candidateExemplar, knowledgeEntry(db, "tidepool"), human].map((id) => entry(db, id)!);
  expect(olds.map((old) => [old.kind, old.state])).toEqual([
    ["behavior", "approved"],
    ["exemplar", "approved"],
    ["behavior", "candidate"],
    ["exemplar", "candidate"],
    ["knowledge", "approved"],
    ["knowledge", "approved"],
  ]);

  const copies = olds.map((old) => moveMemoryByMetaReview(db, { entry_id: old.id, scope: old.scope, path: "moved/here", mover: metaReview }, "worker", at).entry_id);

  olds.forEach((old, i) => {
    const copy = copies[i]!;
    expect(entry(db, copy)).toEqual({ ...old, id: copy, path: "moved/here", replaced_ids: [], source: old.source.ref === old.id ? { kind: "event", ref: copy } : old.source });
    expect(entry(db, old.id)).toMatchObject({ invalidation_reason: "path_moved", successor_id: copy, invalidated_by: { activity: "meta_review" } });
  });
});

it("meta-review の move_memory は Knowledge・Definition・candidate を workspace から盤面全体へ広げ、書き手と状態を継ぐ(ADR 0176 決定2)", () => {
  const { db, replaced } = approvedPair();
  const moves: Array<[number, string]> = [
    [knowledgeEntry(db, "tidepool"), "toolchain/node"],
    [definitionEntry(db), "build"],
    [replaced("Two commits per migration"), "habits"],
  ];

  const widened = moves.map(([entry_id, path]) => moveMemoryByMetaReview(db, { entry_id, scope: null, path, mover: metaReview }, "worker", at).entry_id);

  expect(widened.map((id) => entry(db, id))).toMatchObject([
    { kind: "knowledge", state: "approved", scope: null, path: "toolchain/node", author: metaReview },
    { kind: "definition", state: "approved", scope: null, path: "build", author: metaReview },
    { kind: "behavior", state: "candidate", scope: null, path: "habits", author: { activity: "rca", name: "auditor" } },
  ]);
});

/** meta-review の scope を跨ぐ移動の門(ADR 0176 決定2〜4)。approved の Exemplar は workspace にも1つ置く。 */
function rescoping() {
  const fixture = approvedPair();
  const { db, attributed, drafted, consolidate } = fixture;
  const workspaceExemplar = () => {
    const proposal = consolidate([drafted("Split it", { event_id: attributed("split it into two commits") })], { kind: "exemplar", annotations, scope: "tidepool" });
    approveMemoryProposal(db, proposal, "question-workspace-exemplar", "webui", at);
    return proposal.candidate_id;
  };
  const move = (entry_id: number, scope: string | null) => () => moveMemoryByMetaReview(db, { entry_id, scope, path: "moved", mover: metaReview }, "worker", at);
  return { ...fixture, workspaceExemplar, move };
}
type Rescoping = ReturnType<typeof rescoping>;
const pinned = /open proposal question/;

it.each([
  ["盤面全体の Knowledge を workspace へ", (f: Rescoping) => [knowledgeEntry(f.db), "tidepool"], DomainError],
  ["workspace の Knowledge を別の workspace へ", (f: Rescoping) => [knowledgeEntry(f.db, "tidepool"), "charts"], DomainError],
  ["workspace の approved の Behavior を盤面全体へ", (f: Rescoping) => [f.approvedReplaced("Pin npm"), null], DomainError],
  ["workspace の approved の Exemplar を盤面全体へ", (f: Rescoping) => [f.workspaceExemplar(), null], DomainError],
  ["盤面全体の approved の Behavior を workspace へ", (f: Rescoping) => [f.behavior, "tidepool"], DomainError],
  ["盤面全体の approved の Exemplar を workspace へ", (f: Rescoping) => [f.exemplar, "tidepool"], DomainError],
  ["open な提案 question の candidate を盤面全体へ", (f: Rescoping) => [f.consolidate([f.replaced("Pin npm")], { scope: "tidepool", text: "Pin npm." }).candidate_id, null], pinned],
  [
    "open な提案 question の replaces を盤面全体へ",
    (f: Rescoping) => {
      const replaced = f.replaced("Pin npm");
      f.consolidate([replaced], { scope: "tidepool", text: "Pin npm." });
      return [replaced, null];
    },
    pinned,
  ],
  [
    "open な提案 question の既存の後継を盤面全体へ",
    (f: Rescoping) => {
      const successor = f.approvedReplaced("Pin npm");
      f.propose({ successor_id: successor, replaces: [f.approvedReplaced("Pin pnpm")] });
      return [successor, null];
    },
    pinned,
  ],
  [
    "open な提案 question の invalidate の target を盤面全体へ",
    (f: Rescoping) => {
      const target = f.approvedReplaced("Pin npm");
      proposeMemoryChange(f.db, f.task.id, { op: "invalidate", target_id: target, reason: "environment", rationale: "r" }, "auditor", at);
      return [target, null];
    },
    pinned,
  ],
] as const)("meta-review の move_memory で%s移すと domain error で何も書かず、同じエントリの同じ scope の中の移動は通る(ADR 0176 決定2〜4)", (_, setup, refusal) => {
  const fixture = rescoping();
  const [id, scope] = setup(fixture) as [number, string | null];
  const before = listMemoryEntries(fixture.db, {});

  expect(fixture.move(id, scope)).toThrow(refusal);
  expect(listMemoryEntries(fixture.db, {})).toEqual(before);
  const { scope: own } = entry(fixture.db, id)!;
  expect(entry(fixture.db, fixture.move(id, own)().entry_id)).toMatchObject({ scope: own, path: "moved" });
});

const moveBranch = (db: ReturnType<typeof openDb>, scope: string | null, to_scope: string | null, to_path = "habits", merge?: boolean) =>
  moveMemoryBranchByMetaReview(db, { scope, path: "habits", to_scope, to_path, merge, mover: metaReview }, "worker", at);
const liveUnder = (db: ReturnType<typeof openDb>, scope: string | null, path: string) =>
  listMemoryEntries(db, {}).filter((e) => e.scope === scope && e.invalidation_reason === null && (e.path === path || e.path.startsWith(`${path}/`)));

it("meta-review の move_memory_branch は同じ scope の中で枝を改名し、4種別(approved / candidate、open な提案が名指すものも)を配下ごと移して旧 id → 複製の id を返す(ADR 0176 決定1)", () => {
  const f = rescoping();
  const ids = [
    defineMemoryByMetaReview(f.db, { scope: "tidepool", path: "habits", text: "How we work.", author: metaReview }, "worker", at).entry_id,
    f.approvedReplaced("Pin npm"),
    f.workspaceExemplar(),
    f.consolidate([f.replaced("Pin pnpm")], { scope: "tidepool", text: "Pin pnpm." }).candidate_id,
    knowledgeEntry(f.db, "tidepool"),
  ];
  const under = liveUnder(f.db, "tidepool", "habits");

  const { moved } = moveBranch(f.db, "tidepool", "tidepool", "practices");

  expect(moved.map(({ entry_id }) => entry_id)).toEqual(under.map((e) => e.id));
  expect(moved.map(({ entry_id }) => entry_id)).toEqual(expect.arrayContaining(ids));
  expect(moved.map(({ entry_id, successor_id }) => [entry(f.db, entry_id)!.successor_id, entry(f.db, successor_id)])).toEqual(
    under.map((old, i) => [moved[i]!.successor_id, expect.objectContaining({ kind: old.kind, state: old.state, author: old.author, scope: "tidepool", path: old.path.replace(/^habits/, "practices") })]),
  );
  expect(liveUnder(f.db, "tidepool", "habits")).toEqual([]);
});

it("meta-review の move_memory_branch は approved の Behavior / Exemplar も名指されたエントリも無い workspace の枝を盤面全体へ広げる(ADR 0176 決定2)", () => {
  const f = rescoping();
  defineMemoryByMetaReview(f.db, { scope: "tidepool", path: "habits", text: "How we work.", author: metaReview }, "worker", at);
  knowledgeEntry(f.db, "tidepool");
  f.replaced("Rebase before push");
  const under = liveUnder(f.db, "tidepool", "habits");

  const { moved } = moveBranch(f.db, "tidepool", null);

  expect(moved.map(({ successor_id }) => entry(f.db, successor_id))).toMatchObject(under.map(({ kind, state, path }) => ({ kind, state, scope: null, path })));
  expect(liveUnder(f.db, "tidepool", "habits")).toEqual([]);
});

it("meta-review の move_memory_branch の盤面全体 → 盤面全体の移動は、workspace の approved の Behavior / Exemplar を運んでも scope が変わらないので門に掛からず、それぞれの scope のまま移す(ADR 0177 決定5)", () => {
  const f = rescoping();
  const carried = [f.approvedReplaced("Pin npm"), f.workspaceExemplar()];

  const { moved } = moveBranch(f.db, null, null, "practices");

  expect(carried.map((id) => entry(f.db, moved.find((m) => m.entry_id === id)!.successor_id))).toMatchObject([
    { kind: "behavior", state: "approved", scope: "tidepool", path: "practices" },
    { kind: "exemplar", state: "approved", scope: "tidepool", path: "practices" },
  ]);
  expect(liveUnder(f.db, "tidepool", "habits")).toEqual([]);
});

it("meta-review の move_memory_branch は scope が変わるとき、配下に approved の Behavior / Exemplar か open な提案が名指すエントリが1件でもあれば全体を domain error で拒んでそのすべてを名指し、行き先が別 workspace・狭める向きも拒む —— どれも何も変わらない(ADR 0176 決定2・5)", () => {
  const f = rescoping();
  defineMemoryByMetaReview(f.db, { scope: "tidepool", path: "habits", text: "How we work.", author: metaReview }, "worker", at);
  knowledgeEntry(f.db, "tidepool");
  const approved = f.approvedReplaced("Pin npm");
  const exemplar = f.workspaceExemplar();
  const replaced = f.replaced("Pin pnpm");
  const { candidate_id } = f.consolidate([replaced], { scope: "tidepool", text: "Pin pnpm." });
  const before = listMemoryEntries(f.db, {});

  for (const id of [approved, exemplar, replaced, candidate_id]) {
    expect(() => moveBranch(f.db, "tidepool", null)).toThrow(`memory entry ${id} (`);
  }
  expect(() => moveBranch(f.db, "tidepool", "charts")).toThrow(DomainError);
  // 盤面全体の枝(approvedPair の approved の Behavior / Exemplar)を workspace へ
  expect(() => moveBranch(f.db, null, "tidepool")).toThrow(DomainError);
  expect(listMemoryEntries(f.db, {})).toEqual(before);
});

it.each([
  ["同じ scope の中で", "tidepool"],
  ["盤面全体へ広げる向きで", null],
] as const)("meta-review の move_memory_branch の merge は%s、移される定義を行き先の定義へ meta_review の印で畳み、残りを移す(ADR 0177 決定7)", (_, to_scope) => {
  const { db } = board();
  const old = defineMemoryByMetaReview(db, { scope: "tidepool", path: "habits", text: "How we work.", author: metaReview }, "worker", at).entry_id;
  const fact = knowledgeEntry(db, "tidepool");
  const kept = defineMemoryByMetaReview(db, { scope: to_scope, path: "practices", text: "How we practise.", author: metaReview }, "worker", at).entry_id;

  const { moved, folded } = moveBranch(db, "tidepool", to_scope, "practices", true);

  expect(folded).toEqual([{ entry_id: old, successor_id: kept }]);
  expect(entry(db, old)).toMatchObject({ invalidation_reason: "superseded", successor_id: kept, invalidated_by: { activity: "meta_review" } });
  expect(moved).toEqual([{ entry_id: fact, successor_id: expect.any(Number) }]);
  expect(entry(db, moved[0]!.successor_id)).toMatchObject({ scope: to_scope, path: "practices", invalidation_reason: null });
});

it("meta-review の move_memory_branch の merge も、scope の門に掛かる行(approved の Behavior)が配下にあれば全体を domain error で拒み何も変わらない(ADR 0177 決定7 / ADR 0176 決定2)", () => {
  const f = rescoping();
  defineMemoryByMetaReview(f.db, { scope: "tidepool", path: "habits", text: "How we work.", author: metaReview }, "worker", at);
  const approved = f.approvedReplaced("Pin npm");
  defineMemoryByMetaReview(f.db, { scope: null, path: "practices", text: "How we practise.", author: metaReview }, "worker", at);
  const before = listMemoryEntries(f.db, {});

  expect(() => moveBranch(f.db, "tidepool", null, "practices", true)).toThrow(`memory entry ${approved} (an approved behavior)`);
  expect(listMemoryEntries(f.db, {})).toEqual(before);
});

it("meta-review の move_memory_branch は Knowledge だけの枝でも、別 workspace へ・盤面全体から workspace へは domain error で拒み何も変わらない(ADR 0176 決定2)", () => {
  const { db } = board();
  knowledgeEntry(db, "tidepool");
  knowledgeEntry(db, null);
  const before = listMemoryEntries(db, {});

  expect(() => moveBranch(db, "tidepool", "charts")).toThrow("only within it or to the whole board");
  expect(() => moveBranch(db, null, "tidepool")).toThrow("only within it or to the whole board");
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("meta-review の無効化は candidate・Knowledge・Definition に効き、approved の Behavior と後継つきの理由(superseded / path_moved)は domain error で拒む(ADR 0161 決定2)", () => {
  const { db, decision, knowledge } = board();
  const fact = knowledge("stale fact");
  const successor = knowledge("fresh fact", null);
  const definition = defineMemoryByMetaReview(db, { scope: "tidepool", path: "build", text: "How it builds.", author: metaReview }, "worker", at).entry_id;
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
  invalidate(fact, "capability");
  invalidate(definition, "environment");
  expect(() => invalidate(approved, "capability")).toThrow(DomainError);
  // 同じ種別の Knowledge なので種別の線には当たらない —— 断るのは verb
  for (const reason of ["superseded", "path_moved"] as const) {
    expect(() => invalidate(successor, reason, knowledge("fresher fact"))).toThrow(`invalidate_memory does not take ${reason}`);
  }

  expect(listMemoryEntries(db, { state: "invalidated" }).map((e) => [e.id, e.invalidation_reason, e.successor_id])).toEqual([
    [fact, "capability", null],
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

it("meta-review の無効化は approved の Exemplar をどの理由でも domain error で拒み、candidate の Exemplar は直接無効化できる(ADR 0160 決定1)", () => {
  const { db, attributed, drafted, consolidate, exemplar } = approvedPair();
  const candidate = consolidate([drafted("Keep it split", { event_id: attributed("kept the two commits apart") })], { kind: "exemplar", annotations }).candidate_id;
  const invalidate = (entry_id: number, reason: InvalidationReason) => invalidateMemoryByMetaReview(db, { entry_id, reason }, "auditor", "worker", at);

  for (const reason of ["capability", "environment", "requirement_change"] as const) {
    expect(() => invalidate(exemplar, reason)).toThrow(/propose it instead/);
  }
  invalidate(candidate, "requirement_change");

  expect([entry(db, exemplar), entry(db, candidate)]).toMatchObject([
    { state: "approved", invalidation_reason: null },
    { state: "candidate", invalidation_reason: "requirement_change", successor_id: null },
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
  const attributed = (line: string) => {
    const entry_id = logDecision(db, task, line, "deckhand", at);
    return appendEvent(db, {
      taskId: task.id,
      workerId: "tidepool",
      origin: "board",
      payload: { kind: "objection_attributed", entry_id, objection_event_ids: [bundledObjection(db, task.id, entry_id, at)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
      at,
    });
  };
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

it("memory 提案の reject は comment が空・空白だけなら domain error で何も変えない(ADR 0159 決定3)", () => {
  const { db, attributed, drafted, consolidate } = drafts();
  const proposal = consolidate([drafted("Split migrations", { event_id: attributed("split the migration into two commits") })], { kind: "exemplar", annotations });
  const before = listMemoryEntries(db, {});

  for (const comment of [undefined, "", " \n "]) expect(() => rejectMemoryProposal(db, proposal, "question-1", "webui", at, comment)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("memory 提案の defer は comment が空・空白だけなら domain error で断る(ADR 0165 決定3)", () => {
  for (const comment of [undefined, "", " \n "]) expect(() => deferMemoryProposal(comment)).toThrow(DomainError);
  expect(() => deferMemoryProposal("Not sure the split holds for data-only migrations.")).not.toThrow();
});

it("memory の提案 question は approve / reject / defer の3択で推奨は approve、detail は open な間の門と defer の案内の1文で終わる(ADR 0165 決定3・4)", () => {
  const { db, task, drafted } = drafts();
  const candidate_id = drafted("Split migrations", { commit: "0a46a46" });

  const question = getTask(db, proposeMemoryChange(db, task.id, { op: "approve", candidate_id, rationale: "r" }, "auditor", at).question_id)!;

  expect(question.question_items).toMatchObject([{ options: ["approve", "reject", "defer"], recommendation: "approve" }]);
  expect(question.question_items![0]!.detail).toMatch(
    /\nWhile this question is open, the next memory meta-review is not registered; if you cannot decide yet, answer defer with a comment\.$/,
  );
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
  expect(() => consolidate([human], { kind: "exemplar", annotations })).toThrow(/share one source/);
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

/** approved の Exemplar と approved の Behavior(ADR 0160 の無効化と、既存の後継を名指す consolidate の相手)。replaced は candidate、
 *  approvedReplaced は既存の後継を名指す consolidate の replaces に取れる approved の Behavior(ADR 0161 決定5)。 */
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
  const approvedReplaced = (title: string) => {
    const proposal = consolidate([replaced(title)], { scope: "tidepool", title, text: `${title}.` });
    approveMemoryProposal(db, proposal, `question-${title}`, "webui", at);
    return proposal.candidate_id;
  };
  return { ...fixture, exemplar: exemplar.candidate_id, behavior: behavior.candidate_id, propose, replaced, approvedReplaced };
}

it("consolidate の successor_id は既存の approved の Exemplar / Behavior を後継に名指して版を pin し、新しい entry を作らず、detail に replaces と後継の本文を載せる(ADR 0160 決定2・4)", () => {
  const { db, exemplar: successor, behavior, propose, approvedReplaced } = approvedPair();
  const replaces = [approvedReplaced("Two commits per migration"), approvedReplaced("One schema change per commit")];
  const before = listMemoryEntries(db, {});

  const question = propose({ successor_id: successor, replaces });

  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(question.question_proposal).toEqual({
    kind: "memory",
    op: "consolidate",
    successor: { id: successor, version: entry(db, successor)!.version },
    replaces: replaces.map((id) => ({ id, version: entry(db, id)!.version })),
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
  const intoBehavior = propose({ successor_id: behavior, replaces: [approvedReplaced("Pin npm")] }).question_items![0]!.detail;
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
  ["後継が replaces に含まれる", (f: Fixture) => ({ successor_id: f.exemplar, replaces: [f.approvedReplaced("Two commits again"), f.exemplar] })],
  ["successor_id の replaces に candidate を含める(それは fold_memory の successor_id、ADR 0161 決定5)", (f: Fixture) => ({ successor_id: f.exemplar, replaces: [f.replaced("Candidate")] })],
] as const)("consolidate で%sと domain error で、何も pin せず entry も書かない", (_, input) => {
  const fixture = approvedPair();
  const { db, exemplar: successor, propose, approvedReplaced } = fixture;
  const replaces = [approvedReplaced("Two commits per migration")];
  const bad = input(fixture);
  const before = listMemoryEntries(db, {});

  expect(() => propose({ replaces, ...bad })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(propose({ successor_id: successor, replaces }).question_proposal).toMatchObject({ successor: { id: successor } });
});
type Fixture = ReturnType<typeof approvedPair>;

it("既存の後継の consolidate は approve で replaces を後継つき superseded(人間名義・question の印)にし、修正値は断り、reject は何も変えない(ADR 0160 決定2)", () => {
  const { db, exemplar: successor, propose, approvedReplaced } = approvedPair();
  const kept = [approvedReplaced("Two commits per migration")];
  const replaces = [approvedReplaced("One schema change per commit"), approvedReplaced("Separate the data migration")];

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
    { state: "approved", invalidation_reason: null },
    { invalidation_reason: "superseded", successor_id: successor, invalidated_by: { question_id: question.id } },
    { invalidation_reason: "superseded", successor_id: successor, invalidated_by: { question_id: question.id } },
    { state: "approved", invalidation_reason: null },
  ]);
});

it("既存の後継は pin に入り、提案の open 中に無効化されると question は観測で決着し承認も stale で断る —— 同じ後継の2件目(別の replaces)は通り、同じ replaces の2件目は断る(ADR 0160 決定3)", () => {
  const { db, exemplar: successor, propose, approvedReplaced } = approvedPair();
  const replaces = [approvedReplaced("Two commits per migration")];
  const first = propose({ successor_id: successor, replaces });
  const second = propose({ successor_id: successor, replaces: [approvedReplaced("One schema change per commit")] });
  expect(() => propose({ successor_id: successor, replaces })).toThrow(/already in an open proposal question/);

  const observed = invalidateMemoryEntry(db, { entry_id: successor, reason: "requirement_change" }, "human", "webui", at);

  for (const question of [first, second]) {
    expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
    expect(listEvents(db, question.id).at(-1)).toMatchObject({ kind: "memory_proposal_stale", payload: { entry_id: successor, observed_event_id: observed } });
  }
  expect(() => approveMemoryProposal(db, first.question_proposal as MemoryProposal, first.id, "webui", at)).toThrow(/stale/);
  expect(entry(db, replaces[0]!)).toMatchObject({ invalidation_reason: null });
});

/** 既存 candidate の consolidate(ADR 0174 決定1)。陳腐化で閉じた統合の提案の candidate を、生き残った replaces で出し直す。 */
function staleConsolidation() {
  const fixture = approvedPair();
  const { db, replaced, consolidate } = fixture;
  const [kept, dropped] = [replaced("Split migrations"), replaced("Two commits per migration")];
  const { candidate_id } = consolidate([kept, dropped], { text: "Split schema and data changes." });
  invalidateMemoryEntry(db, { entry_id: dropped, reason: "requirement_change" }, "human", "webui", at);
  return { ...fixture, candidate_id, kept, dropped };
}

it("consolidate の candidate_id は陳腐化で閉じた提案の既存 candidate を後継に名指し、replaces を選び直して新しい entry を作らない(ADR 0174 決定1)", () => {
  const { db, candidate_id, kept, propose } = staleConsolidation();
  const before = listMemoryEntries(db, {});

  const question = propose({ candidate_id, replaces: [kept] });

  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(question.question_proposal).toEqual({ kind: "memory", op: "consolidate", candidate_id, replaces: [{ id: kept, version: null }] });
  expect(question.question_items![0]!.detail).toContain(
    `Consolidate into existing behavior candidate #${candidate_id}, replacing:\n#${kept} (scope: tidepool, addressee: every agent): Split migrations.`,
  );
});

type StaleConsolidation = ReturnType<typeof staleConsolidation>;

it.each([
  ["text と candidate_id の両方を渡す", (f: StaleConsolidation) => ({ candidate_id: f.candidate_id, text: { scope: null, path: "habits", title: "Split", text: "Split it.", addressee: null } })],
  ["successor_id と candidate_id の両方を渡す", (f: StaleConsolidation) => ({ candidate_id: f.candidate_id, successor_id: f.behavior })],
  ["candidate_id に based_on_decision を添える(新しい entry を作らないので出所は要らない)", (f: StaleConsolidation) => ({ candidate_id: f.candidate_id, based_on_decision: f.decision })],
  ["名指す entry が approved", (f: StaleConsolidation) => ({ candidate_id: f.behavior })],
  ["名指す candidate が無効化済み", (f: StaleConsolidation) => ({ candidate_id: f.dropped })],
  ["名指す entry が Knowledge", (f: StaleConsolidation) => ({ candidate_id: knowledgeEntry(f.db) })],
  ["名指す entry が Definition", (f: StaleConsolidation) => ({ candidate_id: definitionEntry(f.db) })],
  ["名指す candidate が replaces に含まれる", (f: StaleConsolidation) => ({ candidate_id: f.candidate_id, replaces: [f.kept, f.candidate_id] })],
] as const)("consolidate の candidate_id で%sと domain error で、何も pin せず entry も書かない(ADR 0174 決定1)", (_, input) => {
  const fixture = staleConsolidation();
  const { db, candidate_id, kept, propose } = fixture;
  const bad = input(fixture);
  const before = listMemoryEntries(db, {});

  expect(() => propose({ replaces: [kept], ...bad })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(propose({ candidate_id, replaces: [kept] }).question_proposal).toMatchObject({ candidate_id });
});

it("consolidate の candidate_id の replaces は text の形と同じ門で、approved の Behavior / Exemplar も取れる —— successor_id の形の approved 限定は掛けない(ADR 0174 決定1)", () => {
  const { candidate_id, kept, behavior, exemplar, propose } = staleConsolidation();

  expect(propose({ candidate_id, replaces: [kept, behavior, exemplar] }).question_proposal).toMatchObject({
    candidate_id,
    replaces: [{ id: kept }, { id: behavior }, { id: exemplar }],
  });
});

it("既存 candidate の consolidate は初回の統合と同じく、approve で candidate を approved にして replaces をそれを後継とする superseded にし、reject は candidate だけを rejected にし、defer は何も変えない(ADR 0174 決定1)", () => {
  const settle = (answer: (db: ReturnType<typeof openDb>, proposal: MemoryProposal, questionId: string) => void) => {
    const { db, candidate_id, kept, behavior, propose } = staleConsolidation();
    const question = propose({ candidate_id, replaces: [kept, behavior] });
    answer(db, question.question_proposal as MemoryProposal, question.id);
    return [candidate_id, kept, behavior].map((id) => entry(db, id));
  };

  const [approved, ...superseded] = settle((db, proposal, questionId) => approveMemoryProposal(db, proposal, questionId, "webui", at));
  expect(approved).toMatchObject({ state: "approved", invalidation_reason: null });
  expect(superseded).toMatchObject(superseded.map(() => ({ invalidation_reason: "superseded", successor_id: approved!.id })));

  expect(settle((db, proposal, questionId) => rejectMemoryProposal(db, proposal, questionId, "webui", at, "Two rules after all."))).toMatchObject([
    { state: "candidate", invalidation_reason: "rejected" },
    { state: "candidate", invalidation_reason: null },
    { state: "approved", invalidation_reason: null },
  ]);

  expect(settle(() => deferMemoryProposal("Not sure yet."))).toMatchObject([
    { state: "candidate", invalidation_reason: null },
    { state: "candidate", invalidation_reason: null },
    { state: "approved", invalidation_reason: null },
  ]);
});

it("既存 candidate の consolidate の修正値つき approve は人間名義の approved を作り、candidate と replaces をそれを後継とする superseded にする(ADR 0174 決定1)", () => {
  const { db, candidate_id, kept, propose } = staleConsolidation();
  const question = propose({ candidate_id, replaces: [kept] });

  const amended = approveMemoryProposal(db, question.question_proposal as MemoryProposal, question.id, "webui", at, { text: "Keep schema and data changes apart." });

  expect(entry(db, amended)).toMatchObject({ kind: "behavior", state: "approved", text: "Keep schema and data changes apart." });
  expect([candidate_id, kept].map((id) => entry(db, id))).toMatchObject([
    { invalidation_reason: "superseded", successor_id: amended },
    { invalidation_reason: "superseded", successor_id: amended },
  ]);
});

/** 陳腐化で閉じた Exemplar の統合の提案の candidate。 */
function staleExemplarConsolidation() {
  const fixture = approvedPair();
  const { db, attributed, drafted, consolidate } = fixture;
  const source = attributed("split the migration into two commits again");
  const [kept, dropped] = [drafted("Split migrations", { event_id: source }), drafted("Two commits per migration", { event_id: source })];
  const { candidate_id } = consolidate([kept, dropped], { kind: "exemplar", annotations: [annotations[1]] });
  invalidateMemoryEntry(db, { entry_id: dropped, reason: "requirement_change" }, "human", "webui", at);
  const approveQuestion = () => getTask(db, approve(fixture)(candidate_id).question_id)!;
  return { ...fixture, candidate_id, kept, approveQuestion };
}

it("approve は Exemplar candidate を受けて見出しに kind を出し、前に置き換えようとした entry が生きていても承認で approved にし、その entry はそのまま残す(ADR 0174 決定2・3)", () => {
  const { db, candidate_id, kept, approveQuestion } = staleExemplarConsolidation();

  const question = approveQuestion();
  expect(question.question_items![0]!.detail).toContain(`Approve exemplar candidate #${candidate_id} as worded.`);

  approveMemoryProposal(db, question.question_proposal as MemoryProposal, question.id, "webui", at);
  expect([candidate_id, kept].map((id) => entry(db, id))).toMatchObject([
    { kind: "exemplar", state: "approved", invalidation_reason: null },
    { state: "candidate", invalidation_reason: null },
  ]);
});

it("approve の Exemplar candidate は修正値つきでも承認でき、前に置き換えようとした entry はそのまま残す(ADR 0174 決定2・3)", () => {
  const { db, candidate_id, kept, approveQuestion } = staleExemplarConsolidation();
  const question = approveQuestion();

  const amended = approveMemoryProposal(db, question.question_proposal as MemoryProposal, question.id, "webui", at, { title: "Split the migration in two" });

  expect([amended, candidate_id, kept].map((id) => entry(db, id))).toMatchObject([
    { kind: "exemplar", state: "approved", title: "Split the migration in two" },
    { invalidation_reason: "superseded", successor_id: amended },
    { state: "candidate", invalidation_reason: null },
  ]);
});

it.each([
  ["出所の違う candidate", (f: Fixture) => f.drafted("Pin Node", { event_id: f.attributed("pinned Node 22") })],
  ["出所の違う approved の Exemplar", (f: Fixture) => f.exemplar],
  ["出所を添えずに人間が書いた Behavior", (f: Fixture) => recordBehavior(f.db, { ...humanEntryInput(f.db, { workspace: "tidepool", path: "habits", title: "Pin", text: "Pin." }), addressee: null }, "webui", at).entry_id],
] as const)("consolidate の candidate_id が Exemplar のとき replaces に%sを含めると、candidate の出所を共有しないので domain error(ADR 0174 決定1)", (_, makeBad) => {
  const fixture = staleExemplarConsolidation();
  const { db, candidate_id, kept, propose } = fixture;
  const bad = makeBad(fixture);
  const before = listMemoryEntries(db, {});

  expect(() => propose({ candidate_id, replaces: [kept, bad] })).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(propose({ candidate_id, replaces: [kept] }).question_items![0]!.detail).toContain(`Consolidate into existing exemplar candidate #${candidate_id}, replacing:`);
});

/** fold_memory の既にある後継(ADR 0161 決定2)。 */
const foldInto = (f: Fixture) => (input: Omit<Parameters<typeof foldMemory>[2], "author">) => foldMemory(f.db, f.task.id, { ...input, author: metaReview }, "worker", at);

it("fold_memory の successor_id は replaces を既にある approved の後継つき superseded(meta_review の印)にし、新しい entry を作らない —— Knowledge → Knowledge、Definition → Definition、candidate の Behavior / Exemplar → approved の Behavior / Exemplar(ADR 0161 決定2)", () => {
  const fixture = approvedPair();
  const { db, attributed, drafted, consolidate, exemplar, behavior, replaced } = fixture;
  const [fact, kept] = [knowledgeEntry(db), knowledgeEntry(db)];
  const branch = definitionEntry(db);
  const merged = defineMemoryByMetaReview(db, { scope: null, path: "build", text: "How the board builds.", author: metaReview }, "worker", at).entry_id;
  const candidateBehavior = replaced("Two commits per migration");
  const candidateExemplar = consolidate([drafted("Keep it split", { event_id: attributed("kept the two commits apart") })], { kind: "exemplar", annotations }).candidate_id;
  const before = listMemoryEntries(db, {}).length;

  expect(foldInto(fixture)({ successor_id: kept, replaces: [fact] })).toEqual({ entry_id: kept, event_ids: [expect.any(Number)] });
  foldInto(fixture)({ successor_id: merged, replaces: [branch] });
  foldInto(fixture)({ successor_id: exemplar, replaces: [candidateBehavior] });
  foldInto(fixture)({ successor_id: behavior, replaces: [candidateExemplar] });

  expect(listMemoryEntries(db, {})).toHaveLength(before);
  expect([fact, branch, candidateBehavior, candidateExemplar].map((id) => entry(db, id))).toMatchObject([
    { invalidation_reason: "superseded", successor_id: kept, invalidated_by: { activity: "meta_review" } },
    { invalidation_reason: "superseded", successor_id: merged, invalidated_by: { activity: "meta_review" } },
    { invalidation_reason: "superseded", successor_id: exemplar, invalidated_by: { activity: "meta_review" } },
    { invalidation_reason: "superseded", successor_id: behavior, invalidated_by: { activity: "meta_review" } },
  ]);
});

it.each([
  ["replaces の組が混ざる(Knowledge と candidate の Behavior)", (f: Fixture) => ({ successor_id: knowledgeEntry(f.db), replaces: [knowledgeEntry(f.db), f.replaced("Mixed")] })],
  [
    "後継が replaces に含まれる",
    (f: Fixture) => {
      const kept = knowledgeEntry(f.db);
      return { successor_id: kept, replaces: [knowledgeEntry(f.db), kept] };
    },
  ],
  ["replaces に approved の Behavior を含める(それは consolidate の提案、ADR 0160)", (f: Fixture) => ({ successor_id: f.exemplar, replaces: [f.behavior] })],
  ["text の側の欄と successor_id の両方を渡す", (f: Fixture) => ({ successor_id: f.exemplar, replaces: [f.replaced("Both")], scope: null, path: "habits", title: "Split", text: "Split it." })],
  ["text の側の欄も successor_id も渡さない", (f: Fixture) => ({ replaces: [f.replaced("Neither")] })],
  ["successor_id に based_on_decision を添える(新しい entry を作らないので出所は要らない)", (f: Fixture) => ({ successor_id: f.exemplar, replaces: [f.replaced("Sourced")], based_on_decision: f.decision })],
] as const)("fold_memory で%sと domain error で、何も書かない(ADR 0161 決定2)", (_, input) => {
  const fixture = approvedPair();
  const bad = input(fixture);
  const before = listMemoryEntries(fixture.db, {});

  expect(() => foldInto(fixture)(bad)).toThrow(DomainError);
  expect(listMemoryEntries(fixture.db, {})).toEqual(before);
  expect(foldInto(fixture)({ successor_id: fixture.exemplar, replaces: [fixture.replaced("Good")] })).toMatchObject({ entry_id: fixture.exemplar });
});

/** 覆いの門(ADR 0161 決定6): 後継の scope が盤面全体か replaces と同じ、宛先が全員か replaces と同じ。宛先の組は Behavior /
 *  Exemplar だけで、新しく書く後継は Knowledge なので、宛先の行は successor_id の形だけ。 */
function covering() {
  const { db, task, decision, knowledge } = board();
  const knowledgeIn = (scope: string | null) => knowledge("k", scope);
  const candidateFor = (addressee: string | null) =>
    createBehaviorCandidate(
      db,
      { scope: "tidepool", path: "habits", title: "c", text: "c.", addressee, source: { event_id: decision }, author: { activity: "rca", name: "auditor" } },
      "worker",
      at,
    ).entry_id;
  const approvedFor = (addressee: string | null) =>
    recordBehavior(db, { ...humanEntryInput(db, { workspace: "tidepool", path: "habits", title: "b", text: "b." }), addressee }, "webui", at).entry_id;
  const into = (replaces: number[], successor_id: number) => () => foldMemory(db, task.id, { replaces, successor_id, author: metaReview }, "worker", at);
  const intoNew = (replaces: number[], scope: string | null) => () =>
    foldMemory(db, task.id, { scope, path: "build", title: "Folded", text: "Folded.", replaces, based_on_decision: decision, author: metaReview }, "worker", at);
  return { db, knowledgeIn, candidateFor, approvedFor, into, intoNew };
}
type Covering = ReturnType<typeof covering>;

it.each([
  ["既にある後継の scope が別 workspace", (c: Covering) => c.into([c.knowledgeIn("tidepool")], c.knowledgeIn("charts"))],
  ["新しく書く後継の scope が別 workspace", (c: Covering) => c.intoNew([c.knowledgeIn("tidepool")], "charts")],
  ["新しく書く後継の scope が replaces の1つとだけ同じ", (c: Covering) => c.intoNew([c.knowledgeIn("tidepool"), c.knowledgeIn("charts")], "tidepool")],
  ["後継の宛先が replaces と別", (c: Covering) => c.into([c.candidateFor("deckhand")], c.approvedFor("helmsman"))],
  ["replaces が全員宛で後継が個別宛", (c: Covering) => c.into([c.candidateFor(null)], c.approvedFor("deckhand"))],
] as const)("fold_memory で%sだと、後継が replaces を覆わないので domain error で、何も書かない(ADR 0161 決定6)", (_, setup) => {
  const fixture = covering();
  const fold = setup(fixture);
  const before = listMemoryEntries(fixture.db, {});

  expect(fold).toThrow(DomainError);
  expect(listMemoryEntries(fixture.db, {})).toEqual(before);
});

it.each([
  ["既にある後継が盤面全体", (c: Covering) => ({ replaces: [c.knowledgeIn("tidepool"), c.knowledgeIn("charts")], fold: (r: number[]) => c.into(r, c.knowledgeIn(null)) })],
  ["新しく書く後継が盤面全体", (c: Covering) => ({ replaces: [c.knowledgeIn("tidepool"), c.knowledgeIn("charts")], fold: (r: number[]) => c.intoNew(r, null) })],
  ["後継が全員宛", (c: Covering) => ({ replaces: [c.candidateFor("deckhand"), c.candidateFor("helmsman")], fold: (r: number[]) => c.into(r, c.approvedFor(null)) })],
] as const)("fold_memory で%sなら、後継が replaces を覆うので畳める(ADR 0161 決定6)", (_, setup) => {
  const fixture = covering();
  const { replaces, fold } = setup(fixture);

  const { entry_id } = fold(replaces)();

  expect(replaces.map((id) => entry(fixture.db, id))).toMatchObject(replaces.map(() => ({ invalidation_reason: "superseded", successor_id: entry_id })));
});

const defineByMetaReview = (db: ReturnType<typeof openDb>, scope: string | null, path: string, supersedes?: number[]) =>
  defineMemoryByMetaReview(db, { scope, path, text: `What ${path} holds.`, supersedes, author: metaReview }, "worker", at).entry_id;

it.each([
  ["同じ scope・同じ path の定義を(改訂、ADR 0161 決定2)", "tidepool", "tidepool"],
  ["workspace の定義を盤面全体の定義で(ADR 0161 追記7)", "tidepool", null],
] as const)("define_memory の supersedes は%s置き換える", (_, from, to) => {
  const { db } = board();
  const old = defineByMetaReview(db, from, "build");

  const successor = defineByMetaReview(db, to, "build", [old]);

  expect(entry(db, old)).toMatchObject({ invalidation_reason: "superseded", successor_id: successor });
});

it.each([
  ["盤面全体の定義を workspace の定義で", null],
  ["別 workspace の定義を", "charts"],
] as const)("define_memory の supersedes で%s置き換えると、新しい定義が覆わないので domain error で、何も書かない(ADR 0161 追記7)", (_, from) => {
  const { db } = board();
  const old = defineByMetaReview(db, from, "build");
  const before = listMemoryEntries(db, {});

  expect(() => defineByMetaReview(db, "tidepool", "build", [old])).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("人間の面の定義の書き込みは、盤面全体の定義を workspace の定義で置き換えられる —— 覆いの門は meta-review の口だけ(ADR 0161 追記7)", () => {
  const { db } = board();
  const old = defineByMetaReview(db, null, "build");

  const { entry_id } = defineMemoryBranch(db, humanEntryInput(db, { workspace: "tidepool", path: "build", text: "How tidepool builds.", supersedes: [old] }), "webui", at);

  expect(entry(db, old)).toMatchObject({ invalidation_reason: "superseded", successor_id: entry_id });
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

it("consolidate の based_on_decision が decision_logged でない event か別の task の decision だと domain error で、entry も書かない(ADR 0115 追記)", () => {
  const { db, task, decision, drafted } = drafts();
  const replaces = [drafted("Good", { commit: "0a46a46" })];
  const notDecision = listEvents(db, task.id)[0]!.id; // task_registered
  const othersDecision = decisionOfAnotherTask(db);
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
  expect(() => propose(othersDecision)).toThrow(`event ${othersDecision} is not a decision of this task`);
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
  [
    "approve の candidate を既存 candidate の consolidate で名指す(ADR 0174 決定1)",
    (f: Fixture) => {
      const pinned = f.replaced("A");
      approve(f)(pinned);
      const replaces = [f.replaced("C")];
      return { pinned, free: f.replaced("B"), propose: (candidate_id: number) => f.propose({ candidate_id, replaces }) };
    },
  ],
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

it("op consolidate に invalidate の欄(target_id)を渡すと、candidate_id は両方の op の欄でも、今の op に無い欄として domain error で断る(ADR 0174 決定1)", () => {
  const { candidate_id, kept, behavior, propose } = staleConsolidation();

  expect(() => propose({ candidate_id, replaces: [kept], target_id: behavior })).toThrow("op consolidate does not take target_id");
  expect(propose({ candidate_id, replaces: [kept] }).question_proposal).toMatchObject({ candidate_id });
});
