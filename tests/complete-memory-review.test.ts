import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents, listEventsOfKinds } from "../src/events.js";
import {
  completeMemoryReview,
  createBehaviorCandidate,
  defineMemoryByMetaReview,
  invalidateMemoryByMetaReview,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  recordKnowledge,
} from "../src/memory.js";
import { type MetaReviewSubject, registerMetaReview } from "../src/meta-review.js";
import { completeTask, getTask, type Task, taskVerbSwap } from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { FULL_HANDOFF, humanDecomposeTaskViaWebui, injectedJudgmentItems, judgmentRows } from "./harness.js";

/** memory meta-review は complete_memory_review で終わる(ADR 0278 決定1〜5 の memory、issue #2283)。 */

const at = new Date("2026-10-19T00:00:00.000Z");

/** 主題の meta-review を登録し、その task を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, subject: MetaReviewSubject, done = false): Task {
  registerMetaReview(db, subject, at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return getTask(db, taskId)!;
}

const deckhand = { activity: "worker_verb" as const, name: "deckhand" };
const metaReview = { activity: "meta_review" as const, name: "auditor" };
const knowledge = (db: Db, path: string) =>
  recordKnowledge(db, { scope: "tidepool", path, title: path, text: `${path}.`, source: { commit: "0a46a46" }, author: deckhand }, "worker", at).entry_id;
const candidate = (db: Db, title: string) =>
  createBehaviorCandidate(db, { scope: null, path: "habits", title, text: `${title}.`, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;

/** 前回の後に worker が Knowledge を1つ書いた memory meta-review: 項目はそのエントリと、定義の無いその枝。 */
function cycle(db = openDb(":memory:")) {
  register(db, "memory", true);
  const written = knowledge(db, "notes");
  return { db, written, review: register(db, "memory") };
}

it("memory meta-review の verb の差し替えは complete_task を伏せ complete_memory_review を足し、routing meta-review は差し替えない", () => {
  const { db, review } = cycle();

  expect(taskVerbSwap(db, review.id)).toEqual({ withheld: ["complete_task"], added: ["complete_memory_review"] });
  expect(taskVerbSwap(db, register(db, "routing").id)).toEqual({ withheld: [], added: [] });
});

it.each([
  ["worker", "auditor", "worker"],
  ["人間", HUMAN_WORKER_ID, "webui"],
] as const)("memory meta-review への complete_task は %s の扉でも拒まれ、拒否文は complete_memory_review を指し、何も書かない", (_, workerId, origin) => {
  const { db, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => completeTask(db, review, FULL_HANDOFF, workerId, at, origin)).toThrow("complete_memory_review");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("項目に値も行為も無ければ unjudged で拒まれ、材料に無い id と path も名指して拒まれ、どちらも何も記録しない", () => {
  const { db, written, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => completeMemoryReview(db, review, { judgments: [] }, "auditor", at, "worker")).toThrow(`unjudged: entry #${written}, branch notes`);
  expect(() =>
    completeMemoryReview(db, review, { judgments: [{ entry: written }, { branch: "notes" }, { entry: 9999 }, { branch: "nowhere" }] }, "auditor", at, "worker"),
  ).toThrow("not items to judge: entry #9999, branch nowhere");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("注入された項目をそのまま left_as_is で渡しても、この session で引退・提案・移動・定義した項目は受け取って行を書かず、残りの項目だけが行になる", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const [retired, proposed] = ["Retired", "Proposed"].map((title) => candidate(db, title));
  const kept = knowledge(db, "notes");
  const moved = knowledge(db, "drafts/x");
  const review = register(db, "memory");
  const injected = injectedJudgmentItems(db, review.id);
  invalidateMemoryByMetaReview(db, { entry_id: retired!, reason: "rejected" }, "auditor", "worker", at, review.id);
  proposeMemoryChange(db, review.id, { op: "approve", candidate_id: proposed!, rationale: "r" }, "auditor", at);
  moveMemoryByMetaReview(db, { entry_id: moved, scope: "tidepool", path: "notes/x", mover: metaReview }, "worker", at, review.id);
  defineMemoryByMetaReview(db, { scope: "tidepool", path: "notes", text: "Notes.", author: metaReview }, "worker", at, review.id);

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(injected).toEqual([
    ...[retired!, proposed!, kept, moved].map((entry) => ({ entry })),
    { branch: "drafts" },
    { branch: "drafts/x" },
    { branch: "notes" },
  ]);
  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id).map((row) => row.judgment)).toEqual([{ kind: "memory", entry: kept, value: "left_as_is" }]);
});

it("祖先の枝や scope だけの移動は枝の項目を覆わず、その枝は unjudged で拒まれる", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stays = knowledge(db, "tools");
  const leaves = knowledge(db, "tools/node");
  const review = register(db, "memory");
  moveMemoryByMetaReview(db, { entry_id: leaves, scope: "tidepool", path: "misc", mover: metaReview }, "worker", at, review.id);
  moveMemoryByMetaReview(db, { entry_id: stays, scope: null, path: "tools", mover: metaReview }, "worker", at, review.id);

  expect(() => completeMemoryReview(db, review, { judgments: [] }, "auditor", at, "worker")).toThrow("unjudged: branch tools —");
});

it("据え置いた項目ごとに対象を名指す型つきの decision_logged が1行、文は盤面が組み reason があれば添え、完了する", () => {
  const { db, written, review } = cycle();

  const done = completeMemoryReview(db, review, { judgments: [{ entry: written, reason: "  still accurate " }, { branch: "notes" }] }, "auditor", at, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([
    { kind: "decision_logged", line: `left_as_is: entry #${written} — still accurate`, judgment: { kind: "memory", entry: written, value: "left_as_is", reason: "still accurate" } },
    { kind: "decision_logged", line: "left_as_is: branch notes", judgment: { kind: "memory", branch: "notes", value: "left_as_is" } },
  ]);
});

it("完了が拒まれれば判断の行も書かれない —— 行と完了は1つの transaction", () => {
  const { db, written, review } = cycle();
  humanDecomposeTaskViaWebui(db, review, { reason: "split", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] }, at);

  expect(() => completeMemoryReview(db, getTask(db, review.id)!, { judgments: [{ entry: written }, { branch: "notes" }] }, "auditor", at, "worker")).toThrow(
    "unfinished children",
  );
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("memory meta-review でない task は拒まれる", () => {
  const db = openDb(":memory:");

  expect(() => completeMemoryReview(db, register(db, "routing"), { judgments: [] }, "auditor", at, "worker")).toThrow(
    "only a memory meta-review completes with complete_memory_review",
  );
});
