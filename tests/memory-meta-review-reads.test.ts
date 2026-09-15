import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, getEvent } from "../src/events.js";
import { createBehaviorCandidate, invalidateMemoryEntry, pullMemoryList, recordKnowledge } from "../src/memory.js";
import { logDecision, registerTask } from "../src/tasks.js";

/** meta-review の読み口(issue #619 / ADR 0120 決定2)のドメイン層。verb への写像はサーバ境界
 *  (tests/mcp-memory-meta-review.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");

function board() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at);
  const decision = logDecision(db, task, "kept the note short", "deckhand", at);
  const reader = { taskId: task.id, agent: "auditor" };
  const behavior = (fields: { title: string; scope?: string | null; addressee?: string | null; source?: number }) =>
    createBehaviorCandidate(
      db,
      {
        scope: fields.scope ?? null,
        path: "habits",
        title: fields.title,
        text: `${fields.title}.`,
        addressee: fields.addressee ?? null,
        source: { event_id: fields.source ?? decision },
        author: { activity: "rca", name: "auditor" },
      },
      "worker",
      at,
    ).entry_id;
  return { db, task, decision, reader, behavior };
}

it("list_memory_candidates は candidate を cause・author・出所つきで返し、include_invalidated で無効化済みを理由コードと後継ごと足す。pull は memory_pulled に載る", () => {
  const { db, task, decision, reader, behavior } = board();
  const attributed = appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [], cause: "preference", evidence: "e", round: "after_rca" },
    at,
  });
  const open = behavior({ title: "Short notes", source: attributed });
  const stale = behavior({ title: "Long notes" });
  const replaced = behavior({ title: "Medium notes" });
  const successor = recordKnowledge(
    db,
    { scope: null, path: "notes", title: "Notes are medium", text: "Notes are medium.", source: { event_id: decision }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    at,
  ).entry_id;
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

it("list_memory_behaviors は approved の Behavior を宛先・scope で絞らずに返し、candidate と無効化済みは返さない", () => {
  const { db, reader, behavior } = board();
  const approved = [
    behavior({ title: "Everyone rebases", scope: null }),
    behavior({ title: "Deckhand pins Node", scope: "charts", addressee: "deckhand" }),
    behavior({ title: "Tako writes tests", scope: "tidepool", addressee: "tako" }),
  ];
  const retired = behavior({ title: "Retired habit" });
  behavior({ title: "Still a candidate" });
  // setup のみ: Behavior の承認経路は #620 なので、承認済みの行を直接置く
  for (const id of [...approved, retired]) db.prepare("UPDATE memory_entries SET state = 'approved', version = id WHERE id = ?").run(id);
  invalidateMemoryEntry(db, { entry_id: retired, reason: "environment" }, "human", "webui", at);

  expect(pullMemoryList(db, reader, "list_memory_behaviors", {}, at).entries.map((e) => e.id)).toEqual(approved);
});

it("一覧はページ長で切り、truncated が次のページを言う", () => {
  const { db, reader, behavior } = board();
  const ids = Array.from({ length: 21 }, (_, i) => behavior({ title: `habit ${i}` }));
  const first = pullMemoryList(db, reader, "list_memory_candidates", {}, at);
  const second = pullMemoryList(db, reader, "list_memory_candidates", { page: 2 }, at);
  expect([first.entries.length, first.truncated]).toEqual([20, true]);
  expect([second.entries.map((e) => e.id), second.truncated]).toEqual([[ids[20]], false]);
});
