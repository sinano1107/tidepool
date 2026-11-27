import { afterEach, expect, it, vi } from "vitest";
import { createLanding } from "../src/landing.js";
import { quarantineStops } from "../src/quarantine.js";
import { completeTask, decomposeTask, getTask, listChildren, placedRoots, registerTask } from "../src/tasks.js";
import { recordTaskCheckoutTip, releaseWorkspace } from "../src/workspace.js";
import { FakeGitHubClient } from "./fakes.js";
import {
  addTaskChange,
  answerQuestionViaWebui,
  api,
  bootTidepool,
  checkoutOf,
  completeIntegrationReviews,
  defaultingTo,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeLandingWorkspace,
  makeWorkspace,
  mcpClient,
  prepareAtPickup,
  registerWork,
  settleReview,
  type Tidepool,
} from "./harness.js";
import { answerLocalMerge, completeThroughTaskCheckout, convergeOn, openBoard, openLocalMergeQuestions } from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it.each(["purely local", "open PR"])("a completed work and its review's registry root land independently in the %s case (#2033)", async (mode) => {
  const github = mode === "open PR" ? new FakeGitHubClient() : null;
  const x = github ? (await makeLandingWorkspace("x")).workspace : await makeWorkspace("x");
  const reg = await makeWorkspace("reg");
  const { db, clock } = await openBoard();
  const now = clock.now();
  const work = registerTask(db, { type: "work", title: "ship the feature", purpose: "p", completion_criteria: "c", workspace: "x" }, now, ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, x, work);
  addTaskChange(place.path, work.id);
  recordTaskCheckoutTip(db, place, work.id);
  const done = completeTask(db, getTask(db, work.id)!, FULL_HANDOFF, "deckhand", now, "worker");
  releaseWorkspace(db, place, done, now, true, undefined, undefined, true);
  const review = listChildren(db, done.id).find((task) => task.type === "review")!;
  const isProtectedWorkspace = (name: string) => name === "reg";

  decomposeTask(db, review, {
    reason: "the review found a registry change",
    children: [{ title: "edit registry", purpose: "p", completion_criteria: "c", place_in_workspace: "reg" }],
  }, "shako", now, undefined, isProtectedWorkspace, "worker");

  const [approval] = listChildren(db, review.id);
  expect(approval?.purpose).toContain('protected workspace "reg"');
  answerQuestionViaWebui(db, approval!, ["approve"], now);
  const [placed] = placedRoots(db, review.id);
  const root = getTask(db, placed!.id)!;

  const registryBase = git(reg.path, "rev-parse", "refs/heads/main");
  const registryPlace = await prepareAtPickup(db, reg, root);
  expect(git(registryPlace.path, "rev-parse", "HEAD")).toBe(registryBase);
  expect(quarantineStops(db).workspaces).toEqual([]);
  releaseWorkspace(db, registryPlace, root, now);

  settleReview(db, getTask(db, review.id)!, "shako", now);
  const landing = createLanding({
    db, clock, workspace: x, resolveWorkspace: defaultingTo(x, reg), github, defaultAgentName: "deckhand", isProtectedWorkspace,
  });
  if (github) {
    await expect(convergeOn(landing, done.id)).resolves.toMatchObject({ form: "pull_request_opened", prNumber: 1 });
  } else {
    await expect(convergeOn(landing, done.id)).resolves.toMatchObject({ form: "local_merge_question" });
    const [merge] = openLocalMergeQuestions(db, done.id);
    expect(await answerLocalMerge({ db, clock, landing, workspace: x, work: done, question: merge!, base: "/dev/null/workbenches" })).toMatchObject({ status: "done" });
    expect(git(x.path, "show", `main:${work.id}.txt`)).toBe("finished");
  }
  expect(getTask(db, root.id)?.status).toBe("todo");

  const edited = await completeThroughTaskCheckout(db, clock, reg, root, "registry.txt", "updated\n");
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "local_merge_question" });
  const [registryMerge] = openLocalMergeQuestions(db, root.id);
  expect(await answerLocalMerge({ db, clock, landing, workspace: reg, work: edited, question: registryMerge!, base: "/dev/null/workbenches" }))
    .toMatchObject({ status: "done" });
  expect(git(reg.path, "show", "main:registry.txt")).toBe("updated");
  if (github) {
    await expect(github.readPullRequest({ workspace: x, number: 1 })).resolves.toMatchObject({ state: "OPEN" });
  }
});

const MINUTE = 60 * 1000;

it("completing a task in a protected workspace under the external merge dial still asks for a human merge (ADR 0079: the resource-side invariant outranks the dial)", async () => {
  const sandbox = await makeWorkspace("sandbox");
  const { workspace: registry } = await makeLandingWorkspace("registry");
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: defaultingTo(sandbox, registry),
    resolveAuthority: () => ({ name: "standard", guidance: "", merge: "external" }),
    isProtectedWorkspace: (name) => name === "registry",
  });

  const task = await registerWork(t, "apply the approved diff", "registry");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const mergeQuestion = board.find(
    (x: any) => x.type === "question" && x.title.startsWith("merge PR"),
  );
  expect(mergeQuestion).toBeDefined();
  expect(mergeQuestion.question_items[0].options).toEqual(["merge", "hold"]);
});

it("completing a low-risk task in a protected workspace under auto_if_ci_green asks for merge approval immediately, instead of queueing for auto-merge", async () => {
  const sandbox = await makeWorkspace("sandbox");
  const { workspace: registry } = await makeLandingWorkspace("registry");
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: defaultingTo(sandbox, registry),
    resolveAuthority: () => ({ name: "standard", guidance: "", merge: "auto_if_ci_green" }),
    isProtectedWorkspace: (name) => name === "registry",
  });

  const task = await registerWork(t, "apply the approved diff", "registry");
  await t.clock.advance(HOUR);
  addTaskChange(checkoutOf(t.db, task.id), task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  // asked right away — never queued for the unattended poll, despite carrying
  // no risk flag of its own
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const mergeQuestion = board.find(
    (x: any) => x.type === "question" && x.title.startsWith("merge PR"),
  );
  expect(mergeQuestion).toBeDefined();
  expect(mergeQuestion.question_items[0].options).toEqual(["merge", "hold"]);

  await t.clock.advance(MINUTE); // the auto-merge poll ticks; nothing was queued
  expect(t.github.merged).toEqual([]);
});
