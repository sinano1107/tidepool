import { afterEach, expect, it } from "vitest";
import { warnCliAuthExpiry } from "../src/cli-auth.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { createBehaviorCandidate, proposeMemoryChange } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import {
  cancelTaskDirectly,
  completeTask,
  decomposeTask,
  editTask,
  getTask,
  listBoard,
  listChildren,
  logDecision,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { FULL_HANDOFF, HOUR, HUMAN_WEBUI } from "./harness.js";

/** 直接 cancel と Edit の範囲(ADR 0198)のドメイン層。直接 cancel は「人間が登録した task、または盤面が登録した
 *  root(question を除く)」、Edit は「人間が登録した task」のまま。 */
const NOW = new Date("2026-10-05T00:00:00.000Z");

let db: Db;
afterEach(() => db?.close());

function metaReview(db: Db): Task {
  registerMetaReview(db, "memory", NOW);
  return getTask(db, listBoard(db).find((task) => task.meta_review_subject === "memory")!.id)!;
}

it("盤面が登録した todo の meta-review は直接 cancel でき、cancelled になって task_cancelled_directly が残る", () => {
  db = openDb(":memory:");
  const review = metaReview(db);

  cancelTaskDirectly(db, review, null, NOW, {}, "webui");

  expect(getTask(db, review.id)!.status).toBe("cancelled");
  expect(listEvents(db, review.id).some((e) => e.kind === "task_cancelled_directly")).toBe(true);
});

it("盤面が登録した meta-review の下で開いている提案 question は、meta-review の直接 cancel で道連れになる", () => {
  db = openDb(":memory:");
  const review = metaReview(db);
  const candidate = createBehaviorCandidate(
    db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    NOW,
  ).entry_id;
  const { question_id } = proposeMemoryChange(db, review.id, { op: "approve", candidate_id: candidate, rationale: "r" }, "auditor", NOW);

  cancelTaskDirectly(db, getTask(db, review.id)!, null, NOW, {}, "webui");

  expect(getTask(db, question_id)!.status).toBe("cancelled");
});

it("盤面が登録した root の question(CLI 認証期限の警告)は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  warnCliAuthExpiry(db, new Date(NOW.getTime() + HOUR), NOW);
  const warning = getTask(db, listBoard(db).find((task) => task.type === "question")!.id)!;

  expect(() => cancelTaskDirectly(db, warning, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, warning.id)!.status).toBe("todo");
});

it("盤面名義の完了時レビュー(統合点の付帯子)は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  completeTask(db, root, FULL_HANDOFF, "deckhand", NOW, "worker");
  const [review] = listChildren(db, root.id);

  expect(review!.type).toBe("review");
  expect(() => cancelTaskDirectly(db, review!, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, review!.id)!.status).toBe("todo");
});

it("盤面名義の RCA review(異議の付帯子)は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "deckhand's call", "deckhand", NOW, "worker");
  startTriage(db, NOW);
  raiseObjection(db, entry, "redo it", NOW);
  commitTriage(db, NOW);
  const rcas = listChildren(db, task.id).filter((child) => child.title.startsWith("rca"));

  expect(rcas).toHaveLength(2);
  for (const rca of rcas) {
    expect(() => cancelTaskDirectly(db, rca, null, NOW, {}, "webui")).toThrow(DomainError);
    expect(getTask(db, rca.id)!.status).toBe("todo");
  }
});

it("盤面が登録した meta-review は Edit を拒否される(Edit の範囲は人間が登録した task のまま)", () => {
  db = openDb(":memory:");
  const review = metaReview(db);

  expect(() => editTask(db, review, { title: "rewritten" }, NOW, "webui")).toThrow(DomainError);
  expect(getTask(db, review.id)!.title).toBe(review.title);
});

/** agent が decompose で登録した、まだ todo の子(拒否が「実行中」でなく登録者の線から来ることを見るため)。 */
function todoAgentChild(db: Db): Task {
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [child] = decomposeTask(
    db,
    parent,
    { reason: "split", children: [{ title: "agent child", purpose: "p", completion_criteria: "c" }] },
    "deckhand",
    NOW,
    undefined,
    undefined,
    "worker",
  );
  expect(child!.status).toBe("todo");
  return child!;
}

it("agent が decompose で登録した todo の子は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const child = todoAgentChild(db);

  expect(() => cancelTaskDirectly(db, child, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, child.id)!.status).toBe("todo");
});

it("agent が decompose で登録した todo の子は Edit を拒否される", () => {
  db = openDb(":memory:");
  const child = todoAgentChild(db);

  expect(() => editTask(db, child, { title: "rewritten" }, NOW, "webui")).toThrow(DomainError);
  expect(getTask(db, child.id)!.title).toBe("agent child");
});
