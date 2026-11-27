import { afterEach, expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { cancelTaskDirectly, getTask, getTextAuthor, logDecision, pickupTask, placeInAnotherWorkspace, presentTask, registerTask, type Task } from "../src/tasks.js";
import { addTaskChange, api, bootTidepool, checkoutOf, completeIntegrationReviews, defaultingTo, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, HUMAN_WEBUI, makeLandingWorkspace, makeWorkspace, mcpClient, runNow, type Tidepool } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });
let db: Db;
let t: Tidepool | undefined;
afterEach(async () => {
  db?.close();
  await t?.stop();
  t = undefined;
});

const at = new Date(0);

function work(title: string, extra: Partial<Parameters<typeof registerTask>[1]> = {}): Task {
  return registerTask(db, { type: "work", title, purpose: `purpose of ${title}`, completion_criteria: `${title} is done`, workspace: "reef", ...extra }, at, ...HUMAN_WEBUI);
}

const ROOT = { title: "edit the registry", purpose: "add the new agent", completion_criteria: "the agent is registered", workspace: "registry" };

it("人間の「別の workspace に置く」は分解元の判断を残し、親も分解の判断も持たない根を指定の workspace に登録する(ADR 0384 決定3)", () => {
  db = openDb(":memory:");
  const origin = work("plan the feature");

  const root = placeInAnotherWorkspace(db, origin, { reason: "the registry lives elsewhere", root: ROOT }, at, "webui");

  const decision = listEvents(db, origin.id).find((event) => event.payload.kind === "decision_logged")!;
  expect(decision).toMatchObject({ actor_id: HUMAN_ACTOR_ID, payload: { line: "the registry lives elsewhere" } });
  expect(getTask(db, root.id)).toMatchObject({
    type: "work", title: "edit the registry", workspace: "registry",
    parent_id: null, based_on_decision: null, origin_task_id: origin.id, origin_decision: decision.id,
  });
  // 分解元は待たない —— この slice では委譲の読み手は分解元を読まない(#3424)
  expect(getTask(db, origin.id)!.status).toBe("todo");
});

it("分解元つきの根の文面の書き手は、分解元の判断の書き手(帰責と学習の起草が読む、ADR 0384 決定4・5)", () => {
  db = openDb(":memory:");
  const origin = work("plan the feature");
  // agent の分解(#3423)が残す形: 判断は agent が書き、根は承認した人間が登録する
  const decision = logDecision(db, origin, "the registry lives elsewhere", "tako", at, "worker");
  const root = registerTask(db, { type: "work", ...ROOT, origin_task_id: origin.id, origin_decision: decision }, at, ...HUMAN_WEBUI);

  expect(getTextAuthor(db, root.id)).toBe("tako");
});

it("この slice の分解元は根を待たず、分解元の cancel は根に届かない(待ちと cascade は #3424)", () => {
  db = openDb(":memory:");
  const origin = work("plan the feature");
  const root = placeInAnotherWorkspace(db, origin, { reason: "the registry lives elsewhere", root: ROOT }, at, "webui");
  expect(presentTask(db, origin).status).toBe("todo");

  cancelTaskDirectly(db, getTask(db, origin.id)!, null, at, {}, "webui");
  expect(getTask(db, root.id)!.status).toBe("todo");
});

async function context(taskId: string) {
  const client = await mcpClient(t!.mcpBaseUrl, taskId);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}

/** 分解元を置く workspace `origin-a` と根を置く `root-b` の盤面(既定は origin-a)。 */
async function twoWorkspaces() {
  const a = await makeWorkspace("origin-a");
  const b = await makeWorkspace("root-b");
  t = await bootTidepool({ workspace: a, resolveWorkspace: defaultingTo(a, b) });
  return t;
}

it("issue つきの計画の work から置いた根は、自分の pickup で分解元の issue を展開して凍結し、get_current_task の parent に分解元を受ける(ADR 0321 / ADR 0384 決定4)", async () => {
  const t = await twoWorkspaces();
  t.github.scriptIssue(49, { title: "plan at pickup", body: "the plan", comments: [] });
  const origin = registerTask(t.db, { type: "work", workspace: "origin-a", github_issue_number: 49, assignee: HUMAN_ACTOR_ID }, t.clock.now(), ...HUMAN_WEBUI);
  const root = placeInAnotherWorkspace(t.db, origin, { reason: "the registry lives elsewhere", root: { ...ROOT, workspace: "root-b" } }, t.clock.now(), "webui");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([root.id]);
  t.github.scriptIssue(49, { title: "edited plan", body: "a different plan", comments: [] });

  const { parent } = await context(root.id);
  expect(parent).toMatchObject({
    id: origin.id, title: "plan at pickup", purpose: "the plan", issue: { number: 49, state: "open" }, handoff_doc: null,
    history: [{ decision: "the registry lives elsewhere", children: [] }],
  });
});

it("付帯子の review から置いた根も、分解元の文面・handoff_doc・history を parent に受ける(ADR 0384 決定5)", async () => {
  const t = await twoWorkspaces();
  const done = registerTask(t.db, { type: "work", title: "shipped work", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  pickupTask(t.db, done, "fake-worker", t.clock.now());
  t.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(done.id);
  const review = registerTask(t.db, { type: "review", title: "review the shipped work", purpose: "find what is missing", completion_criteria: "reviewed", parent_id: done.id }, t.clock.now(), ...HUMAN_WEBUI);
  const root = placeInAnotherWorkspace(t.db, review, { reason: "the fix belongs to the registry", root: { ...ROOT, workspace: "root-b" } }, t.clock.now(), "webui");
  t.db.prepare("UPDATE tasks SET handoff_doc = 'the review so far' WHERE id = ?").run(review.id);
  await runNow(t, root.id);
  expect(t.worker.started.map((task) => task.id)).toEqual([root.id]);

  const { parent } = await context(root.id);
  expect(parent).toMatchObject({
    id: review.id, title: "review the shipped work", purpose: "find what is missing", completion_criteria: "reviewed", handoff_doc: "the review so far",
    history: [{ decision: "the fix belongs to the registry", children: [] }],
  });
});

it("置いた根は自分の workspace の保護ブランチから切られ、自分の完了時レビューを受け、自分の workspace に着地する(ADR 0384 決定3・4)", async () => {
  const a = await makeWorkspace("origin-a");
  const { workspace: b } = await makeLandingWorkspace("root-b");
  t = await bootTidepool({ workspace: a, resolveWorkspace: defaultingTo(a, b) });
  const origin = registerTask(t.db, { type: "work", title: "plan", purpose: "p", completion_criteria: "c", workspace: "origin-a", assignee: HUMAN_ACTOR_ID }, t.clock.now(), ...HUMAN_WEBUI);
  const root = placeInAnotherWorkspace(t.db, origin, { reason: "the registry lives elsewhere", root: { ...ROOT, workspace: "root-b" } }, t.clock.now(), "webui");
  await t.clock.advance(HOUR);
  expect(git(b.path, "rev-parse", `task/${root.id}`)).toBe(git(b.path, "rev-parse", "main"));

  addTaskChange(checkoutOf(t.db, root.id), root.id);
  const client = await mcpClient(t.mcpBaseUrl, root.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const reviews = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.type === "review");
  expect(reviews.map((review: any) => review.parent_id)).toEqual([root.id]);
  await completeIntegrationReviews(t, root.id);

  expect(t.github.requests).toMatchObject([{ path: b.path, branch: `task/${root.id}`, base: "main" }]);
});

it("REST の「別の workspace に置く」は根を 201 で返し、無い分解元は 404、門の拒否は 400 に写す", async () => {
  const t = await twoWorkspaces();
  const origin = registerTask(t.db, { type: "work", title: "plan", purpose: "p", completion_criteria: "c", assignee: HUMAN_ACTOR_ID }, t.clock.now(), ...HUMAN_WEBUI);
  const body = { reason: "the registry lives elsewhere", ...ROOT, workspace: "root-b" };

  const placed = await api(t.baseUrl, "POST", `/api/tasks/${origin.id}/place`, body);
  expect(placed.status).toBe(201);
  expect(placed.json).toMatchObject({ title: ROOT.title, workspace: "root-b", parent_id: null, origin_task_id: origin.id });
  expect((await api(t.baseUrl, "POST", "/api/tasks/no-such-task/place", body)).status).toBe(404);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${origin.id}/place`, { ...body, workspace: "nowhere" })).status).toBe(400);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${origin.id}/place`, { ...body, parent_id: origin.id })).status).toBe(400);
});
