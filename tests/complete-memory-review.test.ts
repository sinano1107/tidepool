import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents, listEventsOfKinds } from "../src/events.js";
import {
  completeMemoryReview,
  createBehaviorCandidate,
  defineMemoryByMetaReview,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  recordKnowledge,
} from "../src/memory.js";
import { type MetaReviewSubject, registerMetaReview } from "../src/meta-review.js";
import { completeTask, getTask, type Task, taskVerbSwap } from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { FULL_HANDOFF, humanDecomposeTaskViaWebui, injectMemoryMaterial, judgmentRows } from "./harness.js";

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

/** 材料を注入した memory meta-review を登録する(setup): 完了の verb は注入の記録から項目を読む。 */
function injectedReview(db: Db) {
  const review = register(db, "memory");
  return { review, injected: injectMemoryMaterial(db, review.id, "auditor", at) };
}

/** 前回の後に worker が Knowledge を1つ書いた memory meta-review: 項目はそのエントリと、定義の無いその枝。 */
function cycle(db = openDb(":memory:")) {
  register(db, "memory", true);
  const written = knowledge(db, "notes");
  return { db, written, ...injectedReview(db) };
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
  const { review, injected } = injectedReview(db);
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

it("注入の後に他の worker が定義の無い path に Knowledge を書いても、注入した一覧どおりの完了は done になり、その枝の行は書かれない —— 項目の全体は注入の記録", () => {
  const { db, written, review, injected } = cycle();
  knowledge(db, "later");

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id).map((row) => row.judgment)).toEqual([
    { kind: "memory", entry: written, value: "left_as_is" },
    { kind: "memory", branch: "notes", value: "left_as_is" },
  ]);
});

it("注入の後に人間が引退させた candidate への left_as_is は受け取られ、行を書かずに done になる —— 今の計算は絞り込みにだけ使う", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const retired = candidate(db, "Retired");
  const { review, injected } = injectedReview(db);
  invalidateMemoryEntry(db, { entry_id: retired, reason: "rejected" }, HUMAN_WORKER_ID, "webui", at);

  const done = completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker");

  expect(injected).toContainEqual({ entry: retired });
  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("この review 自身が注入の後に書いたエントリへの値は注入した一覧に無いので名指して拒まれ、何も記録しない", () => {
  const { db, written, review } = cycle();
  const defined = defineMemoryByMetaReview(db, { scope: "tidepool", path: "notes", text: "Notes.", author: metaReview }, "worker", at, review.id).entry_id;
  const before = listEvents(db, review.id).length;

  expect(() => completeMemoryReview(db, review, { judgments: [{ entry: written }, { entry: defined }] }, "auditor", at, "worker")).toThrow(
    `not items to judge: entry #${defined}`,
  );
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("再 spawn で注入の記録が2つあれば最新の記録の項目を読み、2つ目で増えた項目は unjudged で拒まれる", () => {
  const { db, review, injected } = cycle();
  knowledge(db, "later");
  injectMemoryMaterial(db, review.id, "auditor", at);

  expect(() => completeMemoryReview(db, review, { judgments: injected }, "auditor", at, "worker")).toThrow("unjudged: branch later —");
});

it("材料の注入が記録されていない memory meta-review の完了は判断を要する項目が読めないので拒まれ、何も記録しない", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const written = knowledge(db, "notes");
  const review = register(db, "memory");
  const before = listEvents(db, review.id).length;

  expect(() => completeMemoryReview(db, review, { judgments: [{ entry: written }, { branch: "notes" }] }, "auditor", at, "worker")).toThrow(
    "material was not injected",
  );
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("祖先の枝や scope だけの移動は枝の項目を覆わず、その枝は unjudged で拒まれる", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stays = knowledge(db, "tools");
  const leaves = knowledge(db, "tools/node");
  const { review } = injectedReview(db);
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
