import { afterEach, expect, it } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange, readExecutionSettings } from "../src/execution-setting.js";
import { buildMetaReviewMaterial, defineMemoryByMetaReview, invalidateMemoryByMetaReview, recordKnowledge } from "../src/memory.js";
import {
  META_REVIEW_SUBJECTS,
  type MetaReviewSubject,
  materialEvents,
  metaReviewWindow,
  readMetaReviewStatus,
  registerDueMetaReviews,
  startFirstMetaReview,
} from "../src/meta-review.js";
import { listBoard, registerTask, type Task } from "../src/tasks.js";
import { answerQuestionViaWebui, api, bootTidepool, failureQuestion, HUMAN_WEBUI, managementMcpClient, settleReview, type Tidepool, writerTask } from "./harness.js";

/** 主題の初回の meta-review(ADR 0300)のドメイン層: 初回は周期では立たず、人間が扉で起こす。以後は周期。 */
const at = new Date("2026-10-22T00:00:00.000Z");
const days = (n: number) => new Date(at.getTime() + n * 24 * 60 * 60 * 1000);

/** 表の先頭の行の価格を1つ上げる人間の行の編集(routing の材料、ADR 0319 決定3)。`questionId` を渡せば提案 question への回答の適用。 */
function editRow(db: Db, now: Date, origin: "webui" | "mcp", questionId?: string) {
  const [row] = readExecutionSettings(db).table;
  applyExecutionSettingsChange(db, { setting: "row", key: { provider: row!.provider, model: row!.model, effort: row!.effort }, row: { ...row!, price_in: row!.price_in + 1 } }, origin, now, questionId);
}

/** 主題の材料を1つ(memory は worker の Knowledge、routing は人間の行の編集)。 */
function material(db: Db, subject: MetaReviewSubject, now = at) {
  if (subject === "memory") {
    recordKnowledge(db, { scope: null, path: "build", title: "Use Node 22", text: "Use Node 22.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", now);
  } else {
    editRow(db, now, "mcp");
  }
}

const registrations = (db: Db, subject: MetaReviewSubject) => listEventsOfKinds(db, ["meta_review_registered"]).filter((e) => e.payload.subject === subject);

it.each(["memory", "routing"] as const)("前回の登録が無い主題(%s)は、材料があっても周期の登録が立てない", (subject) => {
  const db = openDb(":memory:");
  material(db, subject);

  registerDueMetaReviews(db, days(30));

  expect(registrations(db, subject)).toEqual([]);
});

it.each(["memory", "routing"] as const)("扉で起こした初回の %s meta-review は人間の経路で登録され、その後は周期が働く", (subject) => {
  const db = openDb(":memory:");
  material(db, subject);

  const first = startFirstMetaReview(db, subject, "webui", at);

  expect(first).toMatchObject({ type: "review", meta_review_subject: subject, status: "todo", assignee: null });
  expect(registrations(db, subject)).toMatchObject([{ task_id: first.id, actor_id: HUMAN_ACTOR_ID, origin: "webui" }]);
  settleReview(db, first, "fugu", at);
  material(db, subject, days(1));
  registerDueMetaReviews(db, days(6));
  expect(registrations(db, subject)).toHaveLength(1);
  registerDueMetaReviews(db, days(8));
  expect(registrations(db, subject)).toMatchObject([{ task_id: first.id }, { actor_id: BOARD_ACTOR_ID, origin: "board" }]);
});

it("扉で起こした初回の窓は盤面の始まりから自身の登録までで、窓と材料の節の読み口がそのまま読む", () => {
  const db = openDb(":memory:");
  const before = recordKnowledge(db, { scope: null, path: "build", title: "Before", text: "Before.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  const first = startFirstMetaReview(db, "memory", "webui", at);
  recordKnowledge(db, { scope: null, path: "build", title: "After", text: "After.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at);
  const [registered] = registrations(db, "memory");

  expect(metaReviewWindow(db, first.id)).toEqual({ after: 0, upTo: registered!.payload.material_watermark });
  const material = buildMetaReviewMaterial(db, first.id);
  expect(material?.subject === "memory" && material.parts.store_changes.map((row) => row.id)).toEqual([before]);
});

it("材料の件数は材料の event の読みと同じ集合を数える —— meta-review 自身の書き込みと提案 question への回答の適用は数えない(ADR 0151)", () => {
  const db = openDb(":memory:");
  const metaReview = { activity: "meta_review" as const, name: "fugu" };
  material(db, "memory");
  const stale = recordKnowledge(db, { scope: null, path: "build", title: "Old", text: "Old.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  defineMemoryByMetaReview(db, { scope: null, path: "build", text: "How it builds.", author: metaReview }, "worker", at, writerTask(db));
  invalidateMemoryByMetaReview(db, { entry_id: stale, reason: "environment" }, "fugu", "worker", at, writerTask(db));
  material(db, "routing");
  editRow(db, at, "webui", "question-1");
  const kinds = { memory: META_REVIEW_SUBJECTS.memory.material, routing: META_REVIEW_SUBJECTS.routing.material };

  expect(readMetaReviewStatus(db)).toMatchObject({ memory: { material: 2 }, routing: { material: 1 } });
  expect(materialEvents(db, kinds.memory, { after: 0 })).toHaveLength(2);
  expect(materialEvents(db, kinds.routing, { after: 0 })).toHaveLength(1);
});

it("面の読みは主題ごとに、初回が未実施なら盤面の始まりからの回を開く event の数と最初の時刻を、登録済みなら前回の登録の時刻・次に立てられる最早の時刻・次の回を開く event の数を返す", () => {
  const db = openDb(":memory:");
  expect(readMetaReviewStatus(db)).toEqual({
    memory: { first_review: "not_started", material: 0, first_material_at: null },
    routing: { first_review: "not_started", material: 0, first_material_at: null },
  });

  material(db, "memory", days(1));
  material(db, "memory", days(2));
  expect(readMetaReviewStatus(db).memory).toEqual({ first_review: "not_started", material: 2, first_material_at: days(1).toISOString() });

  const first = startFirstMetaReview(db, "memory", "webui", days(3));
  material(db, "memory", days(4));
  const registered = { first_review: "registered", last_registered_at: days(3).toISOString(), next_earliest_at: days(10).toISOString(), material_since: 1 };
  expect(readMetaReviewStatus(db)).toEqual({ memory: registered, routing: { first_review: "not_started", material: 0, first_material_at: null } });
  settleReview(db, first, "fugu", days(4));
  expect(readMetaReviewStatus(db).memory).toEqual(registered);
});

it("取り消された初回の窓は次の回が読むので、面の次の回を開く event の数は盤面の始まりから数える(ADR 0193 決定3)", () => {
  const db = openDb(":memory:");
  material(db, "memory", days(1));
  const first = startFirstMetaReview(db, "memory", "webui", days(3));
  material(db, "memory", days(4));

  answerQuestionViaWebui(db, failureQuestion(db, first.id, days(4)), ["abandon"], days(4));

  expect(readMetaReviewStatus(db).memory).toMatchObject({ first_review: "registered", material_since: 2 });
});

let t: Tidepool;
afterEach(() => t?.stop());

const knowledgeOn = (tp: Tidepool) =>
  recordKnowledge(tp.db, { scope: null, path: "build", title: "Use Node 22", text: "Use Node 22.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", tp.clock.now());

it("WebUI の面: GET が主題ごとの初回の状態を返し、扉の POST で盤面名義の meta-review が立ち(人間は編集できない)、登録の経路は webui —— 門に当たれば 400 で門を名指す", async () => {
  t = await bootTidepool();
  knowledgeOn(t);
  expect((await api(t.baseUrl, "GET", "/api/settings/meta-review/status")).json).toEqual({
    memory: { first_review: "not_started", material: 1, first_material_at: t.clock.now().toISOString() },
    routing: { first_review: "not_started", material: 0, first_material_at: null },
  });

  const started = await api(t.baseUrl, "POST", "/api/settings/meta-review/first", { subject: "memory" });

  expect(started.status).toBe(200);
  const { id } = started.json;
  expect((await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json).toMatchObject({ type: "review", meta_review_subject: "memory", registrant: BOARD_ACTOR_ID, raw_assignee: null });
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
  expect(events.filter((e) => e.kind === "meta_review_registered")).toMatchObject([{ actor_id: HUMAN_ACTOR_ID, origin: "webui", payload: { subject: "memory" } }]);
  const edit = await api(t.baseUrl, "PATCH", `/api/tasks/${id}`, { purpose: "my own words" });
  expect(edit).toMatchObject({ status: 400, json: { error: expect.stringContaining("only a human-authored task can be edited") } });
  expect((await api(t.baseUrl, "GET", "/api/settings/meta-review/status")).json.memory).toMatchObject({ first_review: "registered" });
  expect(await api(t.baseUrl, "POST", "/api/settings/meta-review/first", { subject: "memory" })).toMatchObject({ status: 400, json: { error: expect.stringContaining("already registered") } });
  expect(await api(t.baseUrl, "POST", "/api/settings/meta-review/first", { subject: "routing" })).toMatchObject({ status: 400, json: { error: expect.stringContaining("no routing meta-review material") } });
  expect((await api(t.baseUrl, "POST", "/api/settings/meta-review/first", { subject: "work" })).status).toBe(400);
});

it("管理MCP: 一覧に初回の状態の読みと扉があり、説明が門を言い、扉の登録の経路は mcp —— 門に当たれば tool error で門を名指す", async () => {
  t = await bootTidepool();
  knowledgeOn(t);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description;
    expect(description("read_meta_review_status")).toContain("first meta-review");
    expect(description("start_first_meta_review")).toContain(
      "Refused when a meta-review of the subject was ever registered (cancelled ones included), when the subject has no material, or while an unsettled task or proposal question of the subject is open.",
    );
    const read = (await client.callTool({ name: "read_meta_review_status", arguments: {} })) as any;
    expect(JSON.parse(read.content[0].text).memory).toMatchObject({ first_review: "not_started", material: 1 });

    const started = (await client.callTool({ name: "start_first_meta_review", arguments: { subject: "memory" } })) as any;

    const { id } = JSON.parse(started.content[0].text);
    const events = (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
    expect(events.filter((e) => e.kind === "meta_review_registered")).toMatchObject([{ actor_id: HUMAN_ACTOR_ID, origin: "mcp" }]);
    const refused = (await client.callTool({ name: "start_first_meta_review", arguments: { subject: "routing" } })) as any;
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no routing meta-review material") }] });
  } finally {
    await client.close();
  }
});

/** 扉の拒否は登録も task も増やさない(routing の未決着の門の前の陳腐化の決着は、agents を渡せば周期の登録と同じく残る)。 */
function expectRefused(db: Db, subject: MetaReviewSubject, gate: RegExp) {
  const before = { registrations: registrations(db, subject).length, tasks: listBoard(db).length };
  expect(() => startFirstMetaReview(db, subject, "mcp", days(1))).toThrow(DomainError);
  expect(() => startFirstMetaReview(db, subject, "mcp", days(1))).toThrow(gate);
  expect({ registrations: registrations(db, subject).length, tasks: listBoard(db).length }).toEqual(before);
}

it.each([
  ["open", (_db: Db, _first: Task) => {}],
  ["done", (db: Db, first: Task) => settleReview(db, first, "fugu", at)],
  ["cancelled", (db: Db, first: Task) => answerQuestionViaWebui(db, failureQuestion(db, first.id, at), ["abandon"], at)],
] as const)("登録が在る主題(初回が %s)の扉は拒まれる —— 扉は初回だけ", (_, settle) => {
  const db = openDb(":memory:");
  material(db, "memory");
  settle(db, startFirstMetaReview(db, "memory", "webui", at));
  material(db, "memory", days(1));

  expectRefused(db, "memory", /already registered/);
});

it.each(["memory", "routing"] as const)("材料が0件の主題(%s)の扉は拒まれる", (subject) => {
  const db = openDb(":memory:");

  expectRefused(db, subject, /no .* material/);
});

it.each(["memory", "routing"] as const)("同主題の未決着がある主題(%s)の扉は拒まれる", (subject) => {
  const db = openDb(":memory:");
  material(db, subject);
  registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: subject }, at, ...HUMAN_WEBUI);

  expectRefused(db, subject, /unsettled/);
});
