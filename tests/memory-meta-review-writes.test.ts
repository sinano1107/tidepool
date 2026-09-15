import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  createBehaviorCandidate,
  defineMemoryBranch,
  foldMemory,
  type InvalidationReason,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryEntries,
  moveMemory,
  recordKnowledge,
} from "../src/memory.js";
import { DomainError, logDecision, registerTask } from "../src/tasks.js";

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
  // setup のみ: Behavior の承認経路は #620 なので、承認済みの行を直接置く
  db.prepare("UPDATE memory_entries SET state = 'approved', version = id WHERE id = ?").run(approved);
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
