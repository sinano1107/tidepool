import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { appendEvent } from "../src/events.js";
import { IssueGoneError } from "../src/github.js";
import { logDecision, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { definitionPart, FakeAttributionClient, recordPrompt } from "./fakes.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, HUMAN_WEBUI, humanDecomposeTaskViaWebui, makeWorkspace, mcpClient, QUIET_EXIT, type Tidepool, WORKER_SPAWNED } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });
let t: Tidepool;
afterEach(() => t?.stop());

function issueParentChild(path: string) {
  const parent = registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 49 }, t.clock.now(), ...HUMAN_WEBUI);
  git(path, "branch", `task/${parent.id}`);
  const [child] = humanDecomposeTaskViaWebui(t.db, parent, {
    reason: "split off the implementation",
    children: [{ title: "implement", purpose: "implement the plan", completion_criteria: "implemented" }],
  }, t.clock.now());
  return { parent, child: child! };
}

async function context(taskId: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}

function objection(parent: Task, entry: number) {
  return appendEvent(t.db, { taskId: parent.id, actorId: HUMAN_WEBUI[0], origin: "webui", at: t.clock.now(), payload: { kind: "objection_raised", entry_id: entry, comment: "why?", session_id: 0 } });
}

function session(parent: Task, user: string, lines: string[]) {
  const spawned = appendEvent(t.db, { taskId: parent.id, actorId: "fake-worker", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
  recordPrompt(t.dir, parent.id, spawned, [definitionPart("original worker")], user);
  const entries = lines.map((line) => logDecision(t.db, parent, line, "fake-worker", t.clock.now(), "worker"));
  appendEvent(t.db, { taskId: parent.id, actorId: "fake-worker", origin: "board", at: t.clock.now(), payload: { kind: "worker_exited", worker_spawned_event_id: spawned, output_closed: true, usage: null, model_swaps: [], refusals: [], advisor: null, ...QUIET_EXIT } });
  return { spawned, entries };
}

function rca(parent: Task, materials: number[]) {
  t.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(parent.id);
  return registerTask(t.db, { type: "review", title: "rca", purpose: "explain the decisions", completion_criteria: "explained", parent_id: parent.id, opened_on_event_ids: materials }, t.clock.now(), BOARD_ACTOR_ID, "board");
}

it("work 子の parent は pickup 時の issue の3欄と open 状態を保持し、編集・close 後も読める(ADR 0321)", async () => {
  const workspace = await makeWorkspace("tidepool");
  t = await bootTidepool({ workspace });
  t.github.scriptIssue(49, { title: "parent at pickup", body: "original plan", comments: ["pickup comment"] });
  const { parent, child } = issueParentChild(workspace.path);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toContain(child.id);
  t.github.scriptIssue(49, { title: "edited parent", body: "different plan", comments: ["later comment"] });

  const expected = {
    id: parent.id, title: "parent at pickup", purpose: "original plan\n\n## Issue comments\n\npickup comment",
    completion_criteria: "See the issue content above for completion criteria.", issue: { number: 49, state: "open" },
  };
  expect((await context(child.id)).parent).toMatchObject(expected);
  t.github.scriptIssueFailure(new IssueGoneError({ path: "/unused", number: 49 }, "closed"));
  expect((await context(child.id)).parent).toMatchObject(expected);
});

it.each(["closed", "not_found"] as const)("pickup 時の親の issue が %s でも子は走り、状態を返し failure question を立てない(ADR 0321)", async (state) => {
  const workspace = await makeWorkspace("tidepool");
  t = await bootTidepool({ workspace });
  t.github.scriptIssue(49, { title: "closed parent", body: "preserved plan", comments: ["final comment"], state: "closed" });
  if (state === "not_found") t.github.scriptIssueFailure(new IssueGoneError({ path: workspace.path, number: 49 }, state));
  const { parent, child } = issueParentChild(workspace.path);
  await t.clock.advance(HOUR);

  const briefing = (await context(child.id)).parent;
  expect(briefing).toMatchObject({ id: parent.id, issue: { number: 49, state } });
  if (state === "closed") {
    expect(briefing).toMatchObject({
      title: "closed parent", purpose: "preserved plan\n\n## Issue comments\n\nfinal comment",
      completion_criteria: "See the issue content above for completion criteria.",
    });
  } else {
    for (const field of ["title", "purpose", "completion_criteria"]) expect(briefing).not.toHaveProperty(field);
  }
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((task: any) => task.type === "question")).toEqual([]);
});

it("親の issue の一時失敗は子の pickup を cycle skip し、failure question 無しで次の poll に再試行する(ADR 0321)", async () => {
  const workspace = await makeWorkspace("tidepool");
  t = await bootTidepool({ workspace });
  const { child } = issueParentChild(workspace.path);
  t.github.scriptIssueFailure(new Error("GitHub is down"));
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  const skipped = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(skipped.find((task: any) => task.id === child.id).status).toBe("todo");
  expect(skipped.filter((task: any) => task.type === "question")).toEqual([]);

  t.github.scriptIssueFailure(null);
  t.github.scriptIssue(49, { title: "restored parent", body: "restored plan", comments: [] });
  await t.clock.advance(HOUR);
  expect((await context(child.id)).parent).toMatchObject({ title: "restored parent", purpose: "restored plan", issue: { number: 49, state: "open" } });
});

it("停止の RCA 子は親の issue を再読せず、判事と同じ記録の user を parent.briefing_as_spawned で読む(ADR 0321)", async () => {
  const workspace = await makeWorkspace("tidepool");
  const attributionClient = new FakeAttributionClient();
  attributionClient.scriptStopJudgment({ cause: "capability", evidence: "ignored the request" });
  t = await bootTidepool({ workspace, attributionClient });
  const parent = registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 49 }, t.clock.now(), ...HUMAN_WEBUI);
  git(workspace.path, "branch", `task/${parent.id}`);
  pickupTask(t.db, parent, "fake-worker", t.clock.now());
  const spawned = appendEvent(t.db, { taskId: parent.id, actorId: "fake-worker", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
  const user = "First call get_current_task.\n\nPurpose: keep the original fixtures.\nCompletion criteria: fixtures still exist.";
  recordPrompt(t.dir, parent.id, spawned, [definitionPart("You are the original worker.")], user);
  const stop = appendEvent(t.db, { taskId: parent.id, actorId: HUMAN_WEBUI[0], origin: "webui", at: t.clock.now(), payload: { kind: "session_stopped_by_human", reason: "deleted fixtures" } });
  appendEvent(t.db, { taskId: parent.id, actorId: "fake-worker", origin: "board", at: t.clock.now(), payload: { kind: "worker_exited", worker_spawned_event_id: spawned, output_closed: true, usage: null, model_swaps: [], refusals: [], advisor: null, ...QUIET_EXIT } });
  t.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(parent.id);
  t.github.scriptIssue(49, { title: "edited after stop", body: "a different request", comments: ["later human comment"] });
  t.github.scriptIssueFailure(new Error("parent cannot be read"));
  await t.clock.advance(2 * HOUR);

  const rca = t.worker.started[0]!;
  expect(rca?.type).toBe("review");
  const briefing = (await context(rca.id)).parent;
  expect(briefing).toMatchObject({ id: parent.id, briefing_as_spawned: [{ text: user, for: [stop] }] });
  expect(briefing.briefing_as_spawned[0].text).toBe(attributionClient.stopCalls[0]!.input.task);
  for (const field of ["title", "purpose", "completion_criteria"]) expect(briefing).not.toHaveProperty(field);
});

it("stored の親の異議 RCA も記録の user ごとに束ね、重複材料の anchor は1度だけ昇順に載せる(ADR 0321)", async () => {
  t = await bootTidepool();
  const parent = pickupTask(t.db, registerTask(t.db, { type: "work", title: "original parent", purpose: "original purpose", completion_criteria: "original criteria" }, t.clock.now(), ...HUMAN_WEBUI), "fake-worker", t.clock.now())!;
  const first = session(parent, "the first user turn", ["first decision", "second decision"]).entries;
  const second = session(parent, "the revised user turn", ["third decision"]).entries[0]!;
  const third = session(parent, "the first user turn", ["fourth decision"]).entries[0]!;
  const child = rca(parent, [objection(parent, third), objection(parent, second), objection(parent, first[1]!), objection(parent, first[0]!), objection(parent, first[0]!)]);
  t.db.prepare("UPDATE tasks SET title = 'edited parent', purpose = 'edited purpose' WHERE id = ?").run(parent.id);
  await t.clock.advance(HOUR);

  const briefing = (await context(child.id)).parent;
  expect(briefing.briefing_as_spawned).toEqual([
    { text: "the first user turn", for: [first[0], first[1], third] },
    { text: "the revised user turn", for: [second] },
  ]);
  for (const field of ["title", "purpose", "completion_criteria", "issue"]) expect(briefing).not.toHaveProperty(field);
});

it("RCA の spawn はあっても記録が失われた anchor は text: null に束ね、pickup 後の記録の削除は文面を変えない(ADR 0321)", async () => {
  t = await bootTidepool();
  const parent = registerTask(t.db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  const lost = session(parent, "lost user", ["first"]);
  const kept = session(parent, "kept user", ["second"]);
  const alsoLost = session(parent, "also lost", ["third"]);
  const child = rca(parent, [objection(parent, alsoLost.entries[0]!), objection(parent, kept.entries[0]!), objection(parent, lost.entries[0]!)]);
  // 1本目と3本目の記録だけが pickup 前に失われた。
  for (const spawned of [lost.spawned, alsoLost.spawned]) rmSync(join(t.dir, `${parent.id}.${spawned}.prompt.json`));
  await t.clock.advance(HOUR);
  rmSync(join(t.dir, `${parent.id}.${kept.spawned}.prompt.json`));

  expect((await context(child.id)).parent.briefing_as_spawned).toEqual([
    { text: null, for: [lost.entries[0], alsoLost.entries[0]] },
    { text: "kept user", for: [kept.entries[0]] },
  ]);
});

it.each([false, true])("session の無い材料を持つ RCA は pickup 時の3欄と理由を載せる(spawn 材料との混在: %s)(ADR 0321)", async (mixed) => {
  t = await bootTidepool();
  const parent = registerTask(t.db, { type: "work", title: "parent at pickup", purpose: "human plan", completion_criteria: "human criteria" }, t.clock.now(), ...HUMAN_WEBUI);
  const human = logDecision(t.db, parent, "human decomposition", HUMAN_WEBUI[0], t.clock.now(), "webui");
  const spawned = mixed ? session(parent, "worker user", ["worker decision"]).entries[0]! : undefined;
  const child = rca(parent, [...(spawned ? [objection(parent, spawned)] : []), objection(parent, human)]);
  await t.clock.advance(HOUR);
  t.db.prepare("UPDATE tasks SET title = 'edited after pickup', purpose = 'later plan' WHERE id = ?").run(parent.id);

  const briefing = (await context(child.id)).parent;
  expect(briefing).toMatchObject({
    title: "parent at pickup", purpose: "human plan", completion_criteria: "human criteria",
    briefing_note: "no worker session preceded the judged decision; this is the parent as it stood at your pickup",
  });
  if (mixed) expect(briefing.briefing_as_spawned).toEqual([{ text: "worker user", for: [spawned] }]);
  else expect(briefing).not.toHaveProperty("briefing_as_spawned");
  expect(briefing).not.toHaveProperty("issue");
});
