import { expect, it } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { latestEventOfTask, listEvents } from "../src/events.js";
import {
  createBehaviorCandidate,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  HUMAN_AUTHOR,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryEntries,
  memoryRepairVerbs,
  moveMemoryBranchByMetaReview,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  recordBehavior,
  recordKnowledge,
  repairMoveBranchBack,
  repairReplace,
  repairRestore,
} from "../src/memory.js";
import { MEMORY_META_REVIEW_VERBS } from "../src/meta-review.js";
import { listChildren, logDecision, registerTask, type Task, taskHistoryRows } from "../src/tasks.js";
import { commitTriage, listLog, raiseObjection } from "../src/triage.js";
import { HUMAN_WEBUI, judgedMemoryReview, markPickedUp } from "./harness.js";

/** 修理子から同じ操作の verb を呼ぶ —— meta-review と1つの関数で、射程は門が対象で切り替える(ADR 0281 決定1)。 */
const invalidateAsRepairer = (db: Db, repairer: { taskId: string; agent: string }, input: { entry_id: number; reason: "capability" }, at: Date) => ({
  event_id: invalidateMemoryByMetaReview(db, input, repairer.agent, "worker", at, repairer.taskId),
});
const moveAsRepairer = (db: Db, repairer: { taskId: string; agent: string }, input: { entry_id: number; scope: string | null; path: string }, at: Date) =>
  moveMemoryByMetaReview(db, { ...input, mover: { activity: "worker_verb", name: repairer.agent } }, "worker", at, repairer.taskId);

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
  /** 束ねが立てた `type` の修理子(最後の1本)—— 記憶の書き込みの行への異議なら memory_repair、判断の行なら work。 */
  const repairChild = (objected: string, type: "work" | "memory_repair" = "memory_repair"): Task => listChildren(db, objected).filter((c) => c.type === type).at(-1)!;
  /** 決定ログの行に異議を打って triage を閉じ、その異議を材料にした修理 task を返す。 */
  const repairOf = (rowId: number, objected: string): Task => {
    raiseObjection(db, rowId, "undo it", at);
    commitTriage(db, at);
    return repairChild(objected);
  };
  const entry = (id: number) => listMemoryEntries(db, {}).find((e) => e.id === id)!;
  /** 型つきの判断の行を書いた memory meta-review(tests/harness.ts の judgedMemoryReview)。 */
  const judged = (stock: () => void, act?: (review: Task) => void) => judgedMemoryReview(db, at, stock, act);
  return { db, task, reviewed, knowledge, repairChild, repairOf, entry, judged };
}

it("逆操作: 異議された畳みの後継を無効化し、畳まれたエントリを復元できる —— 修理の書き込みもそれぞれ修理 task の書き込みの記録(worker_verb)になる", () => {
  const { db, reviewed, knowledge, repairOf, entry } = board();
  const decision = logDecision(db, reviewed, "the two notes say the same", "auditor", at, "worker");
  const [a, b] = [knowledge("Tests need Node 22"), knowledge("Node 24 breaks the tests")];
  const fold = foldMemory(db, reviewed.id, { scope: "charts", path: "build", title: "Node 22 only", text: "Node 22 only.", replaces: [a, b], based_on_decision: decision, author: metaReview }, "worker", at);
  const repair = repairOf(fold.event_id, reviewed.id);
  const repairer = { taskId: repair.id, agent: "deckhand" };

  const dropped = invalidateAsRepairer(db, repairer, { entry_id: fold.entry_id, reason: "capability" }, at);
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

it("修理 verb は異議された書き込みが触ったエントリ(path_moved の鎖の先も)だけを受けて他のエントリは DomainError、replace_memory は書き込みの行への異議の無い task・memory_repair でない修理子からの呼び出しも DomainError", () => {
  const { db, task, reviewed, knowledge, repairChild } = board();
  const objected = task("index the tide charts");
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, objected.id);
  const untouched = knowledge("Untouched");
  const objection = raiseObjection(db, wrote.event_id, "undo it", at);
  commitTriage(db, at);
  const repair = repairChild(objected.id);
  // 同じ書き込みの行への異議を材料にした work の修理子(束ねは立てないので手で)—— 対象は memory_repair の修理子にだけ立つ(ADR 0272 決定3)
  const workWriteRepair = registerTask(db, { type: "work", title: "repair", purpose: "p", completion_criteria: "c", parent_id: objected.id, opened_on_event_ids: [objection] }, at, ...HUMAN_WEBUI);
  const later = moveMemoryByMetaReview(db, { entry_id: wrote.entry_id, scope: "charts", path: "build/squash", mover: metaReview }, "worker", at, reviewed.id).entry_id;
  raiseObjection(db, logDecision(db, objected, "squashed", "deckhand", at, "worker"), "undo it", at);
  commitTriage(db, at);
  const decisionRepair = repairChild(objected.id, "work");
  markPickedUp(db, objected.id, at);
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, opened_on_event_ids: [] }, at, ...HUMAN_WEBUI);

  // invalidate_memory / move_memory は meta-review と1つの関数で、修理子でない書き手には meta-review の規則が掛かる —— その門は MCP の登録(ADR 0281 決定1)
  expect(() => invalidateAsRepairer(db, { taskId: repair.id, agent: "deckhand" }, { entry_id: untouched, reason: "capability" }, at)).toThrow(DomainError);
  expect(() => moveAsRepairer(db, { taskId: repair.id, agent: "deckhand" }, { entry_id: untouched, scope: "charts", path: "elsewhere" }, at)).toThrow(DomainError);
  for (const taskId of [repair.id, workWriteRepair.id, decisionRepair.id, objected.id, rca.id]) {
    const repairer = { taskId, agent: "deckhand" };
    const entry_id = taskId === repair.id ? untouched : later;
    expect(() => repairReplace(db, repairer, { entry_id, title: "t", text: "x.", source: { commit: "0a46a46" } }, at)).toThrow(DomainError);
  }
  // 書き込みが作ったエントリは、後で移された複製まで鎖をたどって受ける
  expect(invalidateAsRepairer(db, { taskId: repair.id, agent: "deckhand" }, { entry_id: later, reason: "capability" }, at)).toMatchObject({ event_id: expect.any(Number) });
});

it("移動: 異議された書き込みが移す前の置き場への移し戻しは門を掛けず、それ以外は scope を変えない(ADR 0285 決定2)", () => {
  const { db, reviewed, knowledge, repairOf, entry } = board();
  const widened = moveMemoryByMetaReview(db, { entry_id: knowledge("Node 22"), scope: null, path: "toolchain", mover: metaReview }, "worker", at, reviewed.id);
  const repair = repairOf(widened.event_id, reviewed.id);
  const repairer = { taskId: repair.id, agent: "deckhand" };

  expect(() => moveAsRepairer(db, repairer, { entry_id: widened.entry_id, scope: "charts", path: "elsewhere" }, at)).toThrow("a memory repair keeps entries in their scope: moving from the whole board to scope charts");
  const back = moveAsRepairer(db, repairer, { entry_id: widened.entry_id, scope: "charts", path: "build" }, at);

  expect(entry(back.entry_id)).toMatchObject({ scope: "charts", path: "build", title: "Node 22", invalidation_reason: null });
  expect(entry(widened.entry_id)).toMatchObject({ invalidation_reason: "path_moved", successor_id: back.entry_id, invalidated_by: { activity: "worker_verb" } });
});

it("置き換え: Knowledge は同じ scope / path の新しい本文に record_knowledge と同じ出所の規則で、Definition は同じ枝の新しい定義に置き換え、Behavior / Exemplar は DomainError", () => {
  const { db, task, reviewed, repairChild, entry } = board();
  const objected = task("index the tide charts");
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, objected.id);
  const defined = defineMemoryBranch(db, { scope: "charts", path: "build", text: "How it builds.", author: worker }, "worker", at, objected.id);
  const candidate = createBehaviorCandidate(db, { scope: "charts", path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;
  const moved = moveMemoryByMetaReview(db, { entry_id: candidate, scope: "charts", path: "habits/commits", mover: metaReview }, "worker", at, reviewed.id);
  raiseObjection(db, wrote.event_id, "wrong", at);
  raiseObjection(db, defined.event_id, "wrong too", at);
  raiseObjection(db, moved.event_id, "wrong place", at);
  commitTriage(db, at);
  const repairs = new Map([[objected.id, repairChild(objected.id)], [reviewed.id, repairChild(reviewed.id)]]);
  const repairer = (objectedId: string) => ({ taskId: repairs.get(objectedId)!.id, agent: "deckhand" });

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

  expect(() => invalidateAsRepairer(db, moveRepair, { entry_id: moved.entry_id, reason: "capability" }, at)).toThrow("was not created by the objected memory write");
  expect(() => repairRestore(db, moveRepair, { entry_id: behavior }, at)).toThrow("was not invalidated by the objected memory write");
  invalidateAsRepairer(db, writeRepair, { entry_id: wrote.entry_id, reason: "capability" }, at);
  expect(() => repairRestore(db, writeRepair, { entry_id: wrote.entry_id }, at)).toThrow("was not invalidated by the objected memory write");

  expect(entry(moved.entry_id)).toMatchObject({ kind: "behavior", state: "approved", invalidation_reason: null });
  const back = moveAsRepairer(db, moveRepair, { entry_id: moved.entry_id, scope: "charts", path: "habits" }, at);
  expect(entry(back.entry_id)).toMatchObject({ kind: "behavior", state: "approved", path: "habits", invalidation_reason: null });
});

it("枝ごとの移し戻し(restore_memory_branch): 異議された move_memory_branch が移したエントリを、定義ごとに書き込みの前の scope / path へ1回で戻し、あとから枝に入ったエントリは動かさない", () => {
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

it("memory meta-review の型つきの判断の行への異議は memory_repair を立て、同じ task の書き込みの行への異議と合わせて1本で opened_on_event_ids は和(ADR 0279 決定3)", () => {
  const { db, knowledge, repairChild, judged } = board();
  let note = 0;
  let moved: { entry_id: number; event_id: number } | undefined;
  const { review, row } = judged(
    () => (note = knowledge("Squash")),
    (review) => (moved = moveMemoryByMetaReview(db, { entry_id: knowledge("Elsewhere", "charts", "misc"), scope: "charts", path: "misc/old", mover: metaReview }, "worker", at, review.id)),
  );
  const objections = [raiseObjection(db, row(note), "fold it into the build note", at), raiseObjection(db, moved!.event_id, "move it back", at)];

  commitTriage(db, at);

  const repairs = listChildren(db, review.id).filter((child) => child.type === "memory_repair");
  expect(repairs).toHaveLength(1);
  expect(latestEventOfTask(db, repairs[0]!.id, "task_registered")?.payload).toMatchObject({ opened_on_event_ids: objections });
  expect(repairChild(review.id).purpose).toContain("fold it into the build note");
});

it("修理子の記憶の verb は運ぶ行の種類で決まる —— 書き込みの行だけなら6本、判断の行だけなら memory meta-review の13本、両方なら名前の集合の和(ADR 0281)", () => {
  const { db, task, knowledge, repairChild, judged } = board();
  const objected = task("index the tide charts");
  raiseObjection(db, recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, objected.id).event_id, "undo it", at);
  let note = 0;
  let moved = 0;
  const first = judged(() => (note = knowledge("Squash")));
  const second = judged(
    () => knowledge("High tide", "charts", "tides"),
    (review) => (moved = moveMemoryByMetaReview(db, { entry_id: note, scope: "charts", path: "build/squash", mover: metaReview }, "worker", at, review.id).event_id),
  );
  raiseObjection(db, first.row(note), "fold it", at);
  raiseObjection(db, second.row({ branch: "tides", scope: "charts" }), "define it", at);
  raiseObjection(db, moved, "move it back", at);
  commitTriage(db, at);

  const writes = ["invalidate_memory", "restore_memory", "move_memory", "move_memory_branch", "restore_memory_branch", "replace_memory"];
  expect(memoryRepairVerbs(db, repairChild(objected.id).id).sort()).toEqual(writes.sort());
  expect(memoryRepairVerbs(db, repairChild(first.review.id).id).sort()).toEqual([...MEMORY_META_REVIEW_VERBS].sort());
  expect(memoryRepairVerbs(db, repairChild(second.review.id).id).sort()).toEqual([...new Set([...MEMORY_META_REVIEW_VERBS, ...writes])].sort());
});

it("meta-review の下の書き込みの行だけを運ぶ修理子は、書き込みの修理 verb 6本に meta-review の id 読みを足す —— 親の主題の読み手(ADR 0283 決定3)", () => {
  const { db, reviewed, knowledge, repairOf } = board();
  const moved = moveMemoryByMetaReview(db, { entry_id: knowledge("Squash"), scope: "charts", path: "build/squash", mover: metaReview }, "worker", at, reviewed.id);

  const repair = repairOf(moved.event_id, reviewed.id);

  const writes = ["invalidate_memory", "restore_memory", "move_memory", "move_memory_branch", "restore_memory_branch", "replace_memory"];
  expect(memoryRepairVerbs(db, repair.id).sort()).toEqual([...writes, "read_memory_entries"].sort());
});

/** 書き込みの行と判断の行の両方を運ぶ修理子(ADR 0281 決定1): review が窓の外のエントリ P を盤面全体へ広げ、定義 D を書き、窓の candidate C・
 *  Knowledge K・approved の Behavior B を据え置いた。異議は移動と定義の書き込みの行と、C・K・B の判断の行。O は窓の外で誰も触らない。 */
function unionRepair() {
  const b = board();
  const { db, knowledge, repairChild, judged } = b;
  const [p, o] = [knowledge("Pinned note", "charts", "misc"), knowledge("Other note", "charts", "misc")];
  let c = 0;
  let k = 0;
  let behavior = 0;
  let widened = { entry_id: 0, event_id: 0 };
  let defined = { entry_id: 0, event_id: 0 };
  const { review, row } = judged(
    () => {
      c = createBehaviorCandidate(db, { scope: "charts", path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;
      k = knowledge("Squash");
      behavior = recordBehavior(db, { scope: "charts", path: "habits", title: "Rebase", text: "Rebase first.", addressee: null, author: HUMAN_AUTHOR }, "webui", at).entry_id;
    },
    (review) => {
      widened = moveMemoryByMetaReview(db, { entry_id: p, scope: null, path: "misc", mover: metaReview }, "worker", at, review.id);
      defined = defineMemoryByMetaReview(db, { scope: "charts", path: "defs", text: "Definitions.", author: metaReview }, "worker", at, review.id);
    },
  );
  for (const id of [widened.event_id, defined.event_id, row(c), row(k), row(behavior)]) raiseObjection(db, id, "redo it", at);
  commitTriage(db, at);
  const repair = repairChild(review.id);
  return { ...b, repair, o, c, k, behavior, widened, defined, mover: { activity: "worker_verb" as const, name: "deckhand" } };
}

it("両方の行の修理子の invalidate_memory / move_memory / move_memory_branch は対象で門が切り替わる —— (i) 書き込みの射程には修理の規則(移し戻しは scope の門なし)、(ii) 判断の行が名指す対象には meta-review の規則を対象の scope の中で(ADR 0285 決定2)、(iii) どちらにも無い対象は名指して拒む(ADR 0281 決定1)", () => {
  const { db, repair, o, c, k, behavior, widened, defined, mover, entry } = unionRepair();
  const invalidate = (entry_id: number, reason: "capability" | "rejected" = "capability") => invalidateMemoryByMetaReview(db, { entry_id, reason }, "deckhand", "worker", at, repair.id);
  const move = (entry_id: number, scope: string | null, path: string) => moveMemoryByMetaReview(db, { entry_id, scope, path, mover }, "worker", at, repair.id);

  // (i) 盤面全体へ広げた移動の移し戻しは狭める向きでも通り、書き込みが作った定義は落とせる
  const back = move(widened.entry_id, "charts", "misc");
  invalidate(defined.entry_id);
  // (ii) 判断の行が名指す candidate は rejected で引退でき、Knowledge は同じ scope の中で移せて盤面全体へは広げられず、approved の Behavior は拒む
  invalidate(c, "rejected");
  expect(() => move(k, null, "build")).toThrow("a memory repair keeps entries in their scope: moving from scope charts to the whole board");
  const kept = move(k, "charts", "build/squash");
  expect(() => invalidate(behavior)).toThrow(`memory entry ${behavior} is an approved behavior: propose it instead`);
  expect(() => move(behavior, null, "habits")).toThrow("a memory repair keeps entries in their scope: moving from scope charts to the whole board");
  // 拒否文は規則と対象だけを言い、判断をどの verb で言うかは worker 共通の規則に任せる(#2293)
  const scopeRefusal = (() => { try { move(behavior, null, "habits"); } catch (err) { return (err as Error).message; } })()!;
  expect(scopeRefusal).not.toContain("log_decision");
  // (iii) どちらの射程にも無いエントリと枝は名指して拒む
  expect(() => invalidate(o)).toThrow(`memory entry ${o} was neither touched by the objected memory write nor named by the objected judgment`);
  expect(() => move(o, "charts", "misc/other")).toThrow(`memory entry ${o} was neither touched by the objected memory write nor named by the objected judgment`);
  expect(() => moveMemoryBranchByMetaReview(db, { scope: "charts", path: "misc", to_scope: "charts", to_path: "other", mover }, "worker", at, repair.id)).toThrow(
    "branch misc in scope charts was neither defined nor moved into by the objected memory write, nor named by the objected judgment",
  );

  expect([entry(back.entry_id), entry(defined.entry_id), entry(c), entry(kept.entry_id), entry(o)]).toMatchObject([
    { scope: "charts", path: "misc", invalidation_reason: null },
    { invalidation_reason: "capability", invalidated_by: { activity: "worker_verb" } },
    { invalidation_reason: "rejected", invalidated_by: { activity: "worker_verb" } },
    { scope: "charts", path: "build/squash", invalidation_reason: null },
    { invalidation_reason: null },
  ]);
});

it("rejected は対象がどちらの射程にあっても candidate だけ —— 書き込みが作った定義にも DomainError(ADR 0281 帰結)", () => {
  const { db, repair, defined } = unionRepair();
  expect(() => invalidateMemoryByMetaReview(db, { entry_id: defined.entry_id, reason: "rejected" }, "deckhand", "worker", at, repair.id)).toThrow(
    `rejected retires only a candidate; memory entry ${defined.entry_id} is not one`,
  );
});

it("書き込みの行だけの修理子の move_memory_branch は、書き込みが定義を作った枝と、エントリを移し入れた枝(配下)を触っていない leaf ごと動かし、触っていない枝は名指して拒み、scope は変えない(ADR 0281 決定2 / ADR 0285 決定2)", () => {
  const { db, reviewed, knowledge, repairOf, entry } = board();
  const leaf = knowledge("Old leaf", "charts", "build/old");
  const untouched = knowledge("Untouched", "charts", "misc");
  const defined = defineMemoryByMetaReview(db, { scope: "charts", path: "build", text: "How the charts build.", author: metaReview }, "worker", at, reviewed.id);
  const moved = moveMemoryByMetaReview(db, { entry_id: knowledge("High tide", "charts", "notes"), scope: "charts", path: "tides/high", mover: metaReview }, "worker", at, reviewed.id);
  raiseObjection(db, defined.event_id, "wrong name", at);
  const repair = repairOf(moved.event_id, reviewed.id);
  const mover = { activity: "worker_verb" as const, name: "deckhand" };
  const moveBranch = (path: string, to_path: string) => moveMemoryBranchByMetaReview(db, { scope: "charts", path, to_scope: "charts", to_path, mover }, "worker", at, repair.id);

  expect(() => moveMemoryBranchByMetaReview(db, { scope: "charts", path: "build", to_scope: null, to_path: "build", mover }, "worker", at, repair.id)).toThrow(
    "a memory repair keeps entries in their scope: moving from scope charts to the whole board",
  );
  expect(moveBranch("build", "make")).toMatchObject({ moved: [{ entry_id: leaf }, { entry_id: defined.entry_id }] });
  expect(moveBranch("tides", "sea")).toMatchObject({ moved: [{ entry_id: moved.entry_id }] });
  expect(() => moveBranch("misc", "other")).toThrow("branch misc in scope charts was neither defined nor moved into by the objected memory write");

  const live = listMemoryEntries(db, { state: "approved" }).filter((e) => e.invalidation_reason === null).map((e) => [e.kind, e.path, e.title]);
  expect(live).toEqual(expect.arrayContaining([["definition", "make", "How the charts build."], ["knowledge", "make/old", "Old leaf"], ["knowledge", "sea/high", "High tide"]]));
  expect(entry(untouched)).toMatchObject({ path: "misc", invalidation_reason: null });
});

it("片側の verb の射程は広げない —— define_memory / fold_memory / propose_memory_change は判断の行が名指す対象だけ、restore_memory / replace_memory / restore_memory_branch は書き込みの射程だけで、外は対象を名指して拒む(ADR 0281 決定4)", () => {
  const { db, knowledge, repairChild, judged, entry } = board();
  const candidate = (title: string) =>
    createBehaviorCandidate(db, { scope: "charts", path: "habits", title, text: `${title}.`, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;
  const approved = (title: string) => recordBehavior(db, { scope: "charts", path: "habits", title, text: `${title}.`, addressee: null, author: HUMAN_AUTHOR }, "webui", at).entry_id;
  const [other, otherCandidate, otherApproved] = [knowledge("Other note"), candidate("Old habit"), approved("Rebase first")];
  let named = { c: 0, k: 0, k2: 0, b: 0, b2: 0 };
  const { review, row } = judged(() => {
    named = { c: candidate("Small commits"), k: knowledge("Squash"), k2: knowledge("Squash it"), b: approved("Merge often"), b2: approved("Tag releases") };
    knowledge("High tide", "charts", "tides");
  });
  for (const id of [row(named.c), row(named.k), row(named.k2), row(named.b), row(named.b2), row({ branch: "tides", scope: "charts" })]) raiseObjection(db, id, "redo it", at);
  commitTriage(db, at);
  const repair = repairChild(review.id);
  const author = { activity: "worker_verb" as const, name: "deckhand" };
  const define = (path: string) => defineMemoryByMetaReview(db, { scope: "charts", path, text: "Tides.", author }, "worker", at, repair.id);
  const decision = logDecision(db, repair, "the two say the same", "deckhand", at, "worker");
  const fold = (replaces: number[]) => foldMemory(db, repair.id, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", replaces, based_on_decision: decision, author }, "worker", at);
  const approve = (candidate_id: number) => proposeMemoryChange(db, repair.id, { op: "approve", candidate_id, rationale: "it holds" }, "deckhand", at);
  const repairer = { taskId: repair.id, agent: "deckhand" };

  expect(entry(define("tides").entry_id)).toMatchObject({ kind: "definition", path: "tides", author });
  expect(() => define("misc")).toThrow("branch misc in scope charts is not named by the objected judgment");
  expect(() => fold([named.k, other])).toThrow(`memory entry #${other} is not named by the objected judgment`);
  fold([named.k, named.k2]);
  expect(approve(named.c)).toMatchObject({ question_id: expect.any(String) });
  expect(() => approve(otherCandidate)).toThrow(`memory entry #${otherCandidate} is not named by the objected judgment`);
  // invalidate は target、consolidate は replaces が変える対象 —— consolidate の後継(candidate_id)は行き先なので名指されていなくてよい
  const propose = (input: Omit<Parameters<typeof proposeMemoryChange>[2], "rationale">) => proposeMemoryChange(db, repair.id, { ...input, rationale: "it holds" }, "deckhand", at);
  expect(() => propose({ op: "invalidate", target_id: otherApproved, reason: "capability" })).toThrow(`memory entry #${otherApproved} is not named by the objected judgment`);
  expect(propose({ op: "invalidate", target_id: named.b, reason: "capability" })).toMatchObject({ question_id: expect.any(String) });
  expect(() => propose({ op: "consolidate", candidate_id: otherCandidate, replaces: [otherApproved] })).toThrow(`memory entry #${otherApproved} is not named by the objected judgment`);
  expect(propose({ op: "consolidate", candidate_id: otherCandidate, replaces: [named.b2] })).toMatchObject({ question_id: expect.any(String) });
  for (const write of [
    () => repairRestore(db, repairer, { entry_id: named.k }, at),
    () => repairReplace(db, repairer, { entry_id: named.k2, title: "t", text: "x.", source: { commit: "0a46a46" } }, at),
    () => repairMoveBranchBack(db, repairer, { scope: "charts", path: "tides" }, at),
  ]) {
    expect(write).toThrow("memory repair verbs are only for a repair task opened on an objection to a memory write");
  }
});

it("判断の行の修理子の get_current_task は親の判断の行・異議の対・帰責の判定を運び、修理子の書き込みは親でなく修理子の task の memory_written の行になる(ADR 0279 決定3 / ADR 0252 決定2)", () => {
  const { db, knowledge, repairChild, judged } = board();
  let named = [0, 0];
  const { review, row } = judged(() => (named = [knowledge("Squash"), knowledge("Squash it")]));
  const [first, second] = named.map((id) => row(id));
  raiseObjection(db, first!, "fold the two squash notes", at);
  raiseObjection(db, second!, "fold the two squash notes", at);
  commitTriage(db, at, [], new Map([[first!, { cause: "capability", evidence: "the two notes say the same", wrong_memory_entries: null }]]));
  const repair = repairChild(review.id);

  expect(repair.purpose).toContain(`> left_as_is: memory entry #${named[0]}\n- fold the two squash notes\nboard judged: capability — the two notes say the same`);
  expect(taskHistoryRows(db, review.id, repair.id).map((r) => r.entry)).toEqual(
    expect.arrayContaining([expect.objectContaining({ decision: `left_as_is: memory entry #${named[0]}` }), expect.objectContaining({ decision: `left_as_is: memory entry #${named[1]}` })]),
  );
  const before = listEvents(db, review.id).length;
  const decision = logDecision(db, repair, "the two say the same", "deckhand", at, "worker");
  const fold = foldMemory(db, repair.id, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", replaces: named, based_on_decision: decision, author: worker }, "worker", at);

  expect(latestEventOfTask(db, repair.id, "memory_written")).toMatchObject({ id: fold.event_id, payload: { created: [fold.entry_id], invalidated: named } });
  expect(listEvents(db, review.id)).toHaveLength(before);
});

it("判断の行の修理子の define_memory / move_memory_branch は名指された (path, scope) そのものにだけ届き、別 workspace の同名の枝も同じ path の盤面全体の枝も (path, scope) を名指して拒み、枝を盤面全体へ広げない —— charts と docks が未定義の tides を持ち、charts の据え置きに異議(#2326 / #2330 の実測、ADR 0285 決定1・2)", () => {
  const { db, knowledge, repairChild, judged } = board();
  const { review, row } = judged(() => {
    for (const scope of ["charts", "docks"]) knowledge("High tide", scope, "tides");
  });
  raiseObjection(db, row({ branch: "tides", scope: "charts" }), "define it", at);
  commitTriage(db, at);
  const repair = repairChild(review.id);
  const mover = { activity: "worker_verb" as const, name: "deckhand" };
  const define = (scope: string | null) => defineMemoryByMetaReview(db, { scope, path: "tides", text: "Tides.", author: mover }, "worker", at, repair.id);
  const moveBranch = (scope: string | null, to_scope = scope) => moveMemoryBranchByMetaReview(db, { scope, path: "tides", to_scope, to_path: "sea", mover }, "worker", at, repair.id);

  expect(() => define("docks")).toThrow("branch tides in scope docks is not named by the objected judgment");
  expect(() => moveBranch("docks")).toThrow("branch tides in scope docks was neither defined nor moved into by the objected memory write, nor named by the objected judgment");
  expect(() => define(null)).toThrow("branch tides in the whole board is not named by the objected judgment");
  expect(() => moveBranch(null)).toThrow("branch tides in the whole board was neither defined nor moved into by the objected memory write, nor named by the objected judgment");
  expect(() => moveBranch("charts", null)).toThrow("a memory repair keeps entries in their scope: moving from scope charts to the whole board");
  const charts = define("charts");
  expect(moveBranch("charts").moved).toContainEqual(expect.objectContaining({ entry_id: charts.entry_id }));
  expect(listMemoryEntries(db, { state: "approved" }).filter((e) => e.scope === "docks" && e.invalidation_reason === null).map((e) => [e.kind, e.path])).toEqual([["knowledge", "tides"]]);
});

it("判断の行が (path, 盤面全体) を名指す修理子は盤面全体の枝を定義して改名でき、改名は全 workspace の配下を連れて行く(ADR 0285 決定1 / ADR 0177 決定5)", () => {
  const { db, knowledge, repairChild, judged } = board();
  const { review, row } = judged(() => {
    knowledge("High tide", null, "tides");
    for (const scope of ["charts", "docks"]) knowledge("Low tide", scope, "tides");
  });
  raiseObjection(db, row({ branch: "tides", scope: null }), "define it", at);
  commitTriage(db, at);
  const repair = repairChild(review.id);
  const mover = { activity: "worker_verb" as const, name: "deckhand" };

  defineMemoryByMetaReview(db, { scope: null, path: "tides", text: "Tides.", author: mover }, "worker", at, repair.id);
  moveMemoryBranchByMetaReview(db, { scope: null, path: "tides", to_scope: null, to_path: "sea", mover }, "worker", at, repair.id);

  const live = listMemoryEntries(db, { state: "approved" }).filter((e) => e.invalidation_reason === null).map((e) => [e.kind, e.scope, e.path]);
  expect(live).toEqual(expect.arrayContaining([["definition", null, "sea"], ["knowledge", null, "sea"], ["knowledge", "charts", "sea"], ["knowledge", "docks", "sea"]]));
  expect(live.filter(([, , path]) => path === "tides")).toEqual([]);
});

it("判断の行の修理子の fold_memory は後継を畳まれるエントリと同じ scope に限る —— 盤面全体の新しい Knowledge にも既存の盤面全体の後継にも畳まず、同じ scope には畳める(ADR 0285 決定2)", () => {
  const { db, knowledge, repairChild, judged, entry } = board();
  let named = [0, 0];
  const { review, row } = judged(() => (named = [knowledge("Squash"), knowledge("Squash it")]));
  for (const id of named) raiseObjection(db, row(id), "fold them", at);
  commitTriage(db, at);
  const repair = repairChild(review.id);
  const general = knowledge("Squash everywhere", null, "build");
  const decision = logDecision(db, repair, "the two say the same", "deckhand", at, "worker");
  const fold = (successor: { scope: string | null } | { successor_id: number }) =>
    foldMemory(
      db,
      repair.id,
      { ...("successor_id" in successor ? successor : { ...successor, path: "build", title: "Squash", text: "Always squash.", based_on_decision: decision }), replaces: named, author: worker },
      "worker",
      at,
    );
  const refusal = `a memory repair keeps entries in their scope: replacing memory entry ${named[0]} in scope charts with a successor in the whole board`;

  expect(() => fold({ scope: null })).toThrow(refusal);
  expect(listMemoryEntries(db, {}).filter((e) => e.scope === null).map((e) => e.id)).toEqual([general]);
  expect(() => fold({ successor_id: general })).toThrow(refusal);
  const folded = fold({ scope: "charts" });

  expect(entry(folded.entry_id)).toMatchObject({ kind: "knowledge", scope: "charts", path: "build" });
  expect(named.map((id) => entry(id))).toMatchObject([{ successor_id: folded.entry_id }, { successor_id: folded.entry_id }]);
});

it("判断の行の修理子の define_memory の supersedes は別 workspace の定義を盤面全体の定義で畳まない —— (tides, charts) の修理子には盤面全体が射程の外、(tides, 盤面全体) の修理子には後継の scope の門(#2330 の Q2、ADR 0285 決定1・2)", () => {
  const mover = { activity: "worker_verb" as const, name: "deckhand" };
  const define = (db: Db, repairId: string, supersedes: number[]) =>
    defineMemoryByMetaReview(db, { scope: null, path: "tides", text: "Tides.", supersedes, author: mover }, "worker", at, repairId);
  const docksDefinition = (db: Db) => defineMemoryBranch(db, { scope: "docks", path: "tides", text: "Docks tides.", author: HUMAN_AUTHOR }, "webui", at).entry_id;
  const reason = (db: Db, id: number) => listMemoryEntries(db, {}).find((e) => e.id === id)!.invalidation_reason;

  // (tides, charts) の修理子 —— 盤面全体の定義そのものが射程の外
  {
    const { db, knowledge, repairChild, judged } = board();
    let docks = 0;
    const { review, row } = judged(() => {
      knowledge("High tide", "charts", "tides");
      docks = docksDefinition(db);
    });
    raiseObjection(db, row({ branch: "tides", scope: "charts" }), "define it", at);
    commitTriage(db, at);
    expect(() => define(db, repairChild(review.id).id, [docks])).toThrow("branch tides in the whole board is not named by the objected judgment");
    expect(reason(db, docks)).toBeNull();
  }
  // (tides, 盤面全体) の修理子 —— 名指しは通るが、docks の定義を盤面全体の後継で畳まない(盤面全体の Knowledge が引退した後に人間が docks を定義した盤面)
  {
    const { db, knowledge, repairChild, judged } = board();
    let wide = 0;
    const { review, row } = judged(() => {
      wide = knowledge("High tide", null, "tides");
      knowledge("Low tide", "charts", "tides");
    });
    raiseObjection(db, row({ branch: "tides", scope: null }), "define it", at);
    commitTriage(db, at);
    invalidateMemoryEntry(db, { entry_id: wide, reason: "environment" }, HUMAN_ACTOR_ID, "webui", at);
    const docks = docksDefinition(db);
    expect(() => define(db, repairChild(review.id).id, [docks])).toThrow(
      `a memory repair keeps entries in their scope: replacing memory entry ${docks} in scope docks with a successor in the whole board`,
    );
    expect(reason(db, docks)).toBeNull();
  }
});
