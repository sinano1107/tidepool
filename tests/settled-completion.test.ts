import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { cancelTaskDirectly, completeTask, getTask, listChildren, registerTask } from "../src/tasks.js";
import { FULL_HANDOFF, HUMAN_WEBUI, humanDecomposeTaskViaWebui } from "./harness.js";

const NOW = new Date("2026-10-23T00:00:00.000Z");
let db: Db;
afterEach(() => db?.close());

it.each([false, true])("cancelled の work は review_flag=%s でも完了できず、記録を書き換えない(ADR 0304 決定2)", (review_flag) => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "plan", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const task = humanDecomposeTaskViaWebui(db, root, { reason: "split", children: [{ title: "cancelled work", purpose: "p", completion_criteria: "c", review_flag }] }, NOW)[0]!;
  cancelTaskDirectly(db, task, null, NOW, {}, "webui");
  const before = { task: getTask(db, task.id), events: listEvents(db, task.id), children: listChildren(db, task.id) };

  expect(() => completeTask(db, task, FULL_HANDOFF, "deckhand", NOW, "worker")).toThrow(new DomainError("a settled task cannot be completed"));
  expect({ task: getTask(db, task.id), events: listEvents(db, task.id), children: listChildren(db, task.id) }).toEqual(before);
});

it.each(["current", "stale"] as const)("done の work の再完了は %s snapshot でも拒まれ、完了 event・統合レビュー・最初の handoff を保つ(ADR 0304 決定2)", (snapshot) => {
  db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "completed work", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const done = completeTask(db, task, FULL_HANDOFF, "deckhand", NOW, "worker");
  const reviews = listChildren(db, task.id);
  expect(listEvents(db, task.id).filter((event) => event.kind === "task_completed")).toHaveLength(1);
  expect(reviews).toHaveLength(1);

  expect(() => completeTask(db, snapshot === "stale" ? task : done, { ...FULL_HANDOFF, outcome: "overwritten" }, "deckhand", NOW, "worker")).toThrow(new DomainError("a settled task cannot be completed"));
  expect(getTask(db, task.id)).toEqual(done);
  expect(listEvents(db, task.id).filter((event) => event.kind === "task_completed")).toHaveLength(1);
  expect(listChildren(db, task.id)).toEqual(reviews);
});
