import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import {
  createBehaviorCandidate,
  defineMemoryBranch,
  foldMemory,
  HUMAN_AUTHOR,
  listMemoryEntries,
  moveMemoryBranchByMetaReview,
  moveMemoryByMetaReview,
  recordBehavior,
  recordKnowledge,
  repairInvalidate,
  repairMove,
  repairMoveBranchBack,
  repairReplace,
  repairRestore,
} from "../src/memory.js";
import { listChildren, logDecision, registerTask, type Task } from "../src/tasks.js";
import { commitTriage, listLog, raiseObjection } from "../src/triage.js";
import { HUMAN_WEBUI } from "./harness.js";

/** 書き込みの行への異議の修理 task の記憶の修理 verb(issue #632 / ADR 0252 決定4)のドメイン層。tool の登録と写像はサーバ境界
 *  (tests/mcp-memory-write-record.test.ts)が言う。 */
const at = new Date("2026-10-14T00:00:00.000Z");
const worker = { activity: "worker_verb" as const, name: "deckhand" };
const metaReview = { activity: "meta_review" as const, name: "auditor" };

function board() {
  const db = openDb(":memory:");
  const task = (title: string, extra: Partial<Parameters<typeof registerTask>[1]> = {}): Task =>
    registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c", workspace: "charts", ...extra }, at, ...HUMAN_WEBUI);
  const reviewed = task("memory meta-review", { type: "review", meta_review_subject: "memory" });
  const knowledge = (title: string, scope: string | null = "charts", path = "build") =>
    recordKnowledge(db, { scope, path, title, text: `${title}.`, source: { commit: "0a46a46" }, author: worker }, "worker", at).entry_id;
  /** 決定ログの行に異議を打って triage を閉じ、立った修理 task を返す。 */
  const repairOf = (rowId: number, objected: string): Task => {
    raiseObjection(db, rowId, "undo it", at);
    commitTriage(db, at);
    return listChildren(db, objected).filter((c) => c.type === "work").at(-1)!;
  };
  const entry = (id: number) => listMemoryEntries(db, {}).find((e) => e.id === id)!;
  return { db, task, reviewed, knowledge, repairOf, entry };
}

it("逆操作: 異議された畳みの後継を無効化し、畳まれたエントリを復元できる —— 修理の書き込みもそれぞれ修理 task の書き込みの記録(worker_verb)になる", () => {
  const { db, reviewed, knowledge, repairOf, entry } = board();
  const decision = logDecision(db, reviewed, "the two notes say the same", "auditor", at, "worker");
  const [a, b] = [knowledge("Tests need Node 22"), knowledge("Node 24 breaks the tests")];
  const fold = foldMemory(db, reviewed.id, { scope: "charts", path: "build", title: "Node 22 only", text: "Node 22 only.", replaces: [a, b], based_on_decision: decision, author: metaReview }, "worker", at);
  const repair = repairOf(fold.event_id, reviewed.id);
  const repairer = { taskId: repair.id, agent: "deckhand" };

  const dropped = repairInvalidate(db, repairer, { entry_id: fold.entry_id, reason: "capability" }, at);
  const [restoredA, restoredB] = [a, b].map((entry_id) => repairRestore(db, repairer, { entry_id }, at));

  expect(entry(fold.entry_id)).toMatchObject({ invalidation_reason: "capability", invalidated_by: { activity: "worker_verb" } });
  expect([entry(restoredA!.entry_id), entry(restoredB!.entry_id)]).toMatchObject([
    { title: "Tests need Node 22", invalidation_reason: null },
    { title: "Node 24 breaks the tests", invalidation_reason: null },
  ]);
  expect(listLog(db).filter((e) => e.task_id === repair.id).map((e) => [e.id, e.payload])).toEqual([
    [dropped.event_id, { kind: "memory_written", line: `dropped #${fold.entry_id} (capability)`, created: [], invalidated: [fold.entry_id] }],
    [restoredA!.event_id, { kind: "memory_written", line: `restored #${a} as #${restoredA!.entry_id} at build (charts)`, created: [restoredA!.entry_id], invalidated: [] }],
    [restoredB!.event_id, { kind: "memory_written", line: `restored #${b} as #${restoredB!.entry_id} at build (charts)`, created: [restoredB!.entry_id], invalidated: [] }],
  ]);
});

it("修理 verb は異議された書き込みが触ったエントリ(path_moved の鎖の先も)だけを受け、他のエントリ・書き込みの行への異議の無い task からの呼び出しは DomainError", () => {
  const { db, task, reviewed, knowledge, repairOf } = board();
  const objected = task("index the tide charts");
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, objected.id);
  const untouched = knowledge("Untouched");
  const repair = repairOf(wrote.event_id, objected.id);
  const later = moveMemoryByMetaReview(db, { entry_id: wrote.entry_id, scope: "charts", path: "build/squash", mover: metaReview }, "worker", at, reviewed.id).entry_id;
  const decisionRepair = repairOf(logDecision(db, objected, "squashed", "deckhand", at, "worker"), objected.id);
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, objection_event_ids: [] }, at, ...HUMAN_WEBUI);

  for (const taskId of [repair.id, decisionRepair.id, objected.id, rca.id]) {
    const repairer = { taskId, agent: "deckhand" };
    const entry_id = taskId === repair.id ? untouched : later;
    expect(() => repairInvalidate(db, repairer, { entry_id, reason: "capability" }, at)).toThrow(DomainError);
    expect(() => repairMove(db, repairer, { entry_id, scope: "charts", path: "elsewhere" }, at)).toThrow(DomainError);
    expect(() => repairReplace(db, repairer, { entry_id, title: "t", text: "x.", source: { commit: "0a46a46" } }, at)).toThrow(DomainError);
  }
  // 書き込みが作ったエントリは、後で移された複製まで鎖をたどって受ける
  expect(repairInvalidate(db, { taskId: repair.id, agent: "deckhand" }, { entry_id: later, reason: "capability" }, at)).toMatchObject({ event_id: expect.any(Number) });
});

it("移動: 異議された書き込みが移す前の置き場への移し戻しは門を掛けず、それ以外は meta-review と同じ門(scope は盤面全体へ広げる向きだけ)", () => {
  const { db, reviewed, knowledge, repairOf, entry } = board();
  const widened = moveMemoryByMetaReview(db, { entry_id: knowledge("Node 22"), scope: null, path: "toolchain", mover: metaReview }, "worker", at, reviewed.id);
  const repair = repairOf(widened.event_id, reviewed.id);
  const repairer = { taskId: repair.id, agent: "deckhand" };

  expect(() => repairMove(db, repairer, { entry_id: widened.entry_id, scope: "charts", path: "elsewhere" }, at)).toThrow("only within it or to the whole board");
  const back = repairMove(db, repairer, { entry_id: widened.entry_id, scope: "charts", path: "build" }, at);

  expect(entry(back.entry_id)).toMatchObject({ scope: "charts", path: "build", title: "Node 22", invalidation_reason: null });
  expect(entry(widened.entry_id)).toMatchObject({ invalidation_reason: "path_moved", successor_id: back.entry_id, invalidated_by: { activity: "worker_verb" } });
});

it("置き換え: Knowledge は同じ scope / path の新しい本文に record_knowledge と同じ出所の規則で、Definition は同じ枝の新しい定義に置き換え、Behavior / Exemplar は DomainError", () => {
  const { db, task, reviewed, entry } = board();
  const objected = task("index the tide charts");
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, objected.id);
  const defined = defineMemoryBranch(db, { scope: "charts", path: "build", text: "How it builds.", author: worker }, "worker", at, objected.id);
  const candidate = createBehaviorCandidate(db, { scope: "charts", path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;
  const moved = moveMemoryByMetaReview(db, { entry_id: candidate, scope: "charts", path: "habits/commits", mover: metaReview }, "worker", at, reviewed.id);
  raiseObjection(db, wrote.event_id, "wrong", at);
  raiseObjection(db, defined.event_id, "wrong too", at);
  raiseObjection(db, moved.event_id, "wrong place", at);
  commitTriage(db, at);
  const repairer = (objectedId: string) => ({ taskId: listChildren(db, objectedId).find((c) => c.type === "work")!.id, agent: "deckhand" });

  expect(() => repairReplace(db, repairer(objected.id), { entry_id: wrote.entry_id, title: "Rebase", text: "Always rebase." }, at)).toThrow("exactly one of event_id or commit");
  const knowledge = repairReplace(db, repairer(objected.id), { entry_id: wrote.entry_id, title: "Rebase", text: "Always rebase.", source: { commit: "1b57b57" } }, at);
  const definition = repairReplace(db, repairer(objected.id), { entry_id: defined.entry_id, text: "How the charts build." }, at);
  expect(() => repairReplace(db, repairer(reviewed.id), { entry_id: moved.entry_id, title: "t", text: "x." }, at)).toThrow(DomainError);

  expect([entry(knowledge.entry_id), entry(definition.entry_id)]).toMatchObject([
    { kind: "knowledge", scope: "charts", path: "build", title: "Rebase", text: "Always rebase.", source: { kind: "commit", ref: "1b57b57" }, author: worker },
    { kind: "definition", scope: "charts", path: "build", text: "How the charts build.", author: worker },
  ]);
  expect([entry(wrote.entry_id), entry(defined.entry_id)]).toMatchObject([
    { invalidation_reason: "superseded", successor_id: knowledge.entry_id },
    { invalidation_reason: "superseded", successor_id: definition.entry_id },
  ]);
});

it("逆操作は書き込みがしたことに結ぶ —— 移動の複製(approved の Behavior も)は無効化せず移し戻し、作ったエントリは復元せず、どれも DomainError で何も変わらない", () => {
  const { db, task, reviewed, repairOf, entry } = board();
  const behavior = recordBehavior(db, { scope: "charts", path: "habits", title: "Small commits", text: "Commit small.", addressee: null, author: HUMAN_AUTHOR }, "webui", at).entry_id;
  const moved = moveMemoryByMetaReview(db, { entry_id: behavior, scope: "charts", path: "habits/commits", mover: metaReview }, "worker", at, reviewed.id);
  const moveRepair = { taskId: repairOf(moved.event_id, reviewed.id).id, agent: "deckhand" };
  const objected = task("index the tide charts");
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, objected.id);
  const writeRepair = { taskId: repairOf(wrote.event_id, objected.id).id, agent: "deckhand" };

  expect(() => repairInvalidate(db, moveRepair, { entry_id: moved.entry_id, reason: "capability" }, at)).toThrow("was not created by the objected memory write");
  expect(() => repairRestore(db, moveRepair, { entry_id: behavior }, at)).toThrow("was not invalidated by the objected memory write");
  repairInvalidate(db, writeRepair, { entry_id: wrote.entry_id, reason: "capability" }, at);
  expect(() => repairRestore(db, writeRepair, { entry_id: wrote.entry_id }, at)).toThrow("was not invalidated by the objected memory write");

  expect(entry(moved.entry_id)).toMatchObject({ kind: "behavior", state: "approved", invalidation_reason: null });
  const back = repairMove(db, moveRepair, { entry_id: moved.entry_id, scope: "charts", path: "habits" }, at);
  expect(entry(back.entry_id)).toMatchObject({ kind: "behavior", state: "approved", path: "habits", invalidation_reason: null });
});

it("枝ごとの移し戻し: 異議された move_memory_branch が移したエントリを、定義ごとに書き込みの前の scope / path へ1回で戻し、あとから枝に入ったエントリは動かさない", () => {
  const { db, reviewed, knowledge, repairOf, entry } = board();
  const definition = defineMemoryBranch(db, { scope: "charts", path: "build", text: "How the charts build.", author: worker }, "worker", at).entry_id;
  const leaf = knowledge("Tests need Node 22", "charts", "build/tests");
  const branch = moveMemoryBranchByMetaReview(db, { scope: "charts", path: "build", to_scope: null, to_path: "toolchain", mover: metaReview }, "worker", at, reviewed.id);
  const later = knowledge("Arrived later", null, "toolchain/later");
  const repairer = { taskId: repairOf(branch.event_id, reviewed.id).id, agent: "deckhand" };

  expect(() => repairMoveBranchBack(db, repairer, { scope: null, path: "elsewhere" }, at)).toThrow(DomainError);
  const back = repairMoveBranchBack(db, repairer, { scope: null, path: "toolchain" }, at);

  expect(back).toEqual({ moved: 2, event_id: expect.any(Number) });
  const live = listMemoryEntries(db, { state: "approved" }).map((e) => [e.kind, e.scope, e.path, e.title]);
  expect(live).toEqual([
    ["knowledge", null, "toolchain/later", "Arrived later"],
    ["definition", "charts", "build", "How the charts build."],
    ["knowledge", "charts", "build/tests", "Tests need Node 22"],
  ]);
  expect([entry(definition), entry(leaf), entry(later)]).toMatchObject([{ invalidation_reason: "path_moved" }, { invalidation_reason: "path_moved" }, { invalidation_reason: null }]);
});
