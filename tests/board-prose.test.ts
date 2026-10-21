import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { boardDoctrine, boardProse } from "../src/board-prose.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { type AuthorityProfile, loadRegistry, REVIEWER_AUTHORITY_PROFILE } from "../src/registry.js";


import { ARTIFACT_DISCARDED_NOTICE, cancelTaskDirectly, INTERVIEW_AUDIT_NOTICE, isArtifactDiscarded, logDecision, MEMORY_REPAIR_NOTICE, pickupTask, poseProbe, ROUTING_REPAIR_NOTICE, registerTask, type Task, taskVerbSwap } from "../src/tasks.js";


import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

// Board doctrine の文面(ADR 0157 決定3)。adapter への配線は claude-worker.test.ts / codex-worker.test.ts が言う。

const CLAUDE = { delegate: "the Agent tool", workflow: true };
const CODEX = { delegate: "a subagent", workflow: false };
const NOT_SPLIT =
  "This task is not split: complete it in this session. If it is larger than one session can finish, finish what you can and state in the handoff what remains.";
const words = (text: string) => text.replace(/\s+/g, " ");
/** adapter と同じく、文面を描く session の `worker_spawned` を先に刻んでその id を返す(ADR 0295 決定3)。 */
const spawn = (db: Db, task: Task, at: Date, workerId = "deckhand", commit = WORKER_SPAWNED.registry_commit) =>
  appendEvent(db, { taskId: task.id, workerId, origin: "board", at, payload: { ...WORKER_SPAWNED, registry_commit: commit } });
/** task ごとの verb の差し替え(taskVerbSwap の値): 普通の task、分けない task(pin の子)、出題前と出題済みの Interview の root。 */
const SPLIT = { withheld: [], added: [] };
const NOT_SPLIT_SWAP = { withheld: ["decompose", "redecompose"] as const, added: [] };
const POSE = { withheld: ["decompose", "redecompose", "complete_task"] as const, added: ["pose_probe"] as const };
const POSED = { withheld: ["decompose", "redecompose", "complete_task"] as const, added: ["complete_interview", "report_broken_probe"] as const };

it("分ける task の doctrine はバイト単位で不変(#695)", () => {
  expect(boardDoctrine(CLAUDE, SPLIT)).toBe(
    "## Board doctrine\n\nWork that needs independent completion criteria, separate authority, its own\nrisk, or survival across sessions must not be routed to the Agent tool —\nthat is delegation smuggled past the board. Register that split with the\ntidepool MCP's decompose instead.\n\nThe Agent tool may only be used for labor-splitting that does not divide\naccountability (exploration, parallel research, mechanical edits): you carry\nfull accountability for its output as the parent task. If another registry\nagent's capability is needed, use decompose with an assignee, not the Agent\ntool.\n\nThe Workflow tool is off-limits in task sessions: a workflow script is a\ndecompose plan that never reached the board. If you find yourself wanting to\nwrite one, register that split with the tidepool MCP's decompose instead.\n\nBoard verbs (the tidepool MCP tools) are main-thread only: a subagent's call\nis denied by the harness, not by an attacker. If a subagent reports that\ndenial, make the call yourself from the main thread.",
  );
  expect(boardDoctrine(CODEX, SPLIT)).toBe(
    "## Board doctrine\n\nWork that needs independent completion criteria, separate authority, its own\nrisk, or survival across sessions must not be routed to a subagent —\nthat is delegation smuggled past the board. Register that split with the\ntidepool MCP's decompose instead.\n\nA subagent may only be used for labor-splitting that does not divide\naccountability (exploration, parallel research, mechanical edits): you carry\nfull accountability for its output as the parent task. If another registry\nagent's capability is needed, use decompose with an assignee, not a\nsubagent.\n\nBoard verbs (the tidepool MCP tools) are main-thread only: a subagent's call\nis denied by the harness, not by an attacker. If a subagent reports that\ndenial, make the call yourself from the main thread.",
  );
});

it("分けない task の doctrine は decompose を指さず、1 session で完了して残りを handoff に書けと言う(ADR 0245 決定2)", () => {
  for (const vocabulary of [CLAUDE, CODEX]) {
    const doctrine = boardDoctrine(vocabulary, NOT_SPLIT_SWAP);
    expect(doctrine).not.toContain("decompose");
    expect(words(doctrine)).toContain(NOT_SPLIT);
    expect(doctrine).not.toMatch(/interview|grad|scor/i);
  }
  expect(boardDoctrine(CLAUDE, NOT_SPLIT_SWAP)).toContain("The Workflow tool is off-limits in task sessions");
});

it("出題前の Interview の root の doctrine は出題の verb を指し、decompose も「このセッションで完了せよ」も指さない(ADR 0253 決定5)", () => {
  for (const vocabulary of [CLAUDE, CODEX]) {
    const doctrine = boardDoctrine(vocabulary, POSE);
    expect(doctrine).toContain("pose_probe");
    expect(doctrine).not.toContain("decompose");
    expect(words(doctrine)).not.toContain("complete it in this session");
  }
});

it("出題済みの Interview の root の doctrine は、採点完了の verb を足しても分けない task の doctrine のまま(ADR 0253 決定4 / ADR 0247 決定3)", () => {
  for (const vocabulary of [CLAUDE, CODEX]) expect(boardDoctrine(vocabulary, POSED)).toBe(boardDoctrine(vocabulary, NOT_SPLIT_SWAP));
});

/** 祖先の cancel の下の修理子(memory_repair / routing_repair)と、その文面(組み込みでない deckhand を持つ registry —— Roster が組める形)。 */
async function repairProse(profile: AuthorityProfile, type: "memory_repair" | "routing_repair") {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const parent = registerTask(db, { type: "work", title: "index the tide charts", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  cancelTaskDirectly(db, parent, null, at, {}, "webui");
  const task = registerTask(db, { type, title: "memory repair", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, ...HUMAN_WEBUI);
  expect(isArtifactDiscarded(db, task.id)).toBe(true);
  const verbs = taskVerbSwap(db, task.id);
  return boardProse({
    db,
    registryDir: "",
    registry: loadRegistry(await makeRegistry(), "purely-local"),
    task,
    spawnedEventId: spawn(db, task, at),
    systemPrompt: "",
    profile,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memorySection: null,
  });
}

const REPAIR_NOTICES = [
  ["memory_repair", MEMORY_REPAIR_NOTICE],
  ["routing_repair", ROUTING_REPAIR_NOTICE],
] as const;

it.each(REPAIR_NOTICES)("%s の spawn の文面は Authority 節が修理の1行だけで、profile の guidance も Roster 節も無く、祖先の cancel の下でも成果が捨てられた旨を置かず、前提の破綻の宣言も言わない(ADR 0272 決定3・追記3 / ADR 0279 決定4)", async (type, notice) => {
  const prose = await repairProse({ name: "standard", guidance: "Prefer reversible actions.", assignable_to: ["*"] }, type);

  expect(prose).toContain(`## Authority\n\n${notice}\n\n`);
  expect(prose).not.toContain("Prefer reversible actions.");
  expect(prose).not.toContain("## Roster");
  expect(prose).not.toContain(ARTIFACT_DISCARDED_NOTICE);
  expect(prose).not.toContain("premise breach");
});

it.each(REPAIR_NOTICES)("profile が reviewer 定数でも、%s の Authority 節は修理の1行だけ(ADR 0272 追記3 / ADR 0279 決定4)", async (type, notice) => {
  const prose = await repairProse(REVIEWER_AUTHORITY_PROFILE, type);

  expect(prose).toContain(`## Authority\n\n${notice}\n\n`);
  expect(prose).not.toContain(REVIEWER_AUTHORITY_PROFILE.guidance);
});

/** `objected`(deckhand が pickup 済み)の deckhand の判断の行への異議の self RCA の文面 —— 当時版は registry の main の commit。 */
async function selfRcaProse(db: Db, objected: Task, at: Date) {
  const registryDir = await makeRegistry();
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  appendEvent(db, { taskId: objected.id, workerId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, registry_commit: commit } });
  const entryId = logDecision(db, objected, "kept the old index", "deckhand", at, "worker");
  appendEvent(db, { taskId: objected.id, workerId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand" }, at, ...HUMAN_WEBUI);
  const verbs = taskVerbSwap(db, rca.id);
  return boardProse({
    db,
    registryDir,
    registry: loadRegistry(registryDir, "purely-local"),
    task: rca,
    spawnedEventId: spawn(db, rca, at),
    systemPrompt: "",
    profile: REVIEWER_AUTHORITY_PROFILE,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memorySection: null,
  });
}

it.each(REPAIR_NOTICES)("%s の task への self RCA の当時版は、Authority が修理の1行で Roster 節が無い —— spawn と同じ type の分岐(#2366)", async (type, notice) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const root = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const repair = pickupTask(db, registerTask(db, { type, title: "repair", purpose: "p", completion_criteria: "c", parent_id: root.id, assignee: "deckhand" }, at, ...HUMAN_WEBUI), "deckhand", at)!;

  const prose = await selfRcaProse(db, repair, at);

  expect(prose).toContain(`### Authority as it stood then (the board's repair notice)\n\n${notice}`);
  expect(prose).not.toContain("Roster as it stood then");
});

it("Interview の root への self RCA の当時版は、Authority が reviewer 定数を指す1行で、Roster 節は無い —— root の Roster は空(#2366)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const interview = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, at, ...HUMAN_WEBUI);
  const root = pickupTask(db, interview, "deckhand", at, { assignee: "deckhand" })!;

  const prose = await selfRcaProse(db, root, at);

  expect(prose).toContain(
    "### Authority as it stood then (the board's reviewer authority)\n\n" +
      "The board's fixed reviewer authority — the same text as your own `## Authority` above. " +
      "It is board code, not a registry profile, so it is not a target for a registry diff.",
  );
  expect(prose).not.toContain("Roster as it stood then");
});

it("Interview の監査 review の spawn の文面は reviewer の Authority の直後に、findings の行き先が complete_audit の判定だという1行を置く(ADR 0273 決定3・4 / ADR 0271 決定2 の形)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, at, ...HUMAN_WEBUI);
  const audit = poseProbe(db, root, { title: "probe", probe: "p", completion_criteria: "c", rubric: "r" }, "suzumedai", at, "worker", "0".repeat(40));
  const verbs = taskVerbSwap(db, audit.id);

  const prose = boardProse({
    db,
    registryDir: "",
    registry: { commit: "c", agents: {}, authority: {}, workspaces: {} },
    task: audit,
    spawnedEventId: spawn(db, audit, at, "fugu"),
    systemPrompt: "",
    profile: { name: "default", guidance: "Prefer reversible actions." },
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memorySection: null,
  });

  expect(prose).toContain(`## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}\n\n${INTERVIEW_AUDIT_NOTICE}\n\n`);
  expect(INTERVIEW_AUDIT_NOTICE).toBe("This task audits an Interview's probe: no repair task stands here, so give your findings with complete_audit's verdict.");
});

it("review の spawn の Roster はその spawn の時点の Executor —— spawn の後に親が pickup されても空のままで、pickup の後の再 spawn は撮り直す(ADR 0295 決定1・2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  // 盤面名義の RCA(人間名義の review 子は実行前の親に付かない —— ADR 0292 決定2)
  const review = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_WORKER_ID, "board");
  const beforePickup = spawn(db, review, at, "fugu");
  pickupTask(db, parent, "deckhand", at, { assignee: "deckhand" });
  const afterPickup = spawn(db, review, at, "fugu");
  const registryDir = await makeRegistry();
  const verbs = taskVerbSwap(db, review.id);
  const prose = (spawnedEventId: number) =>
    boardProse({
      db,
      registryDir,
      registry: loadRegistry(registryDir, "purely-local"),
      task: review,
      spawnedEventId,
      systemPrompt: "",
      profile: REVIEWER_AUTHORITY_PROFILE,
      doctrine: boardDoctrine(CLAUDE, verbs),
      verbs,
      allowedDomains: undefined,
      memorySection: null,
    });

  expect(prose(beforePickup)).not.toContain("## Roster");
  expect(prose(afterPickup)).toContain("## Roster\n\ndeckhand — General work agent for the tidepool board");
});

it("異議された entry が同じ版の2つの spawn にまたがり、spawn ごとに Roster が違えば、self RCA の当時版は2節に分かれる(ADR 0270 追記 / ADR 0295)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const objected = pickupTask(db, registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_WORKER_ID, "board"), "deckhand", at)!;
  const object = (entryId: number) =>
    appendEvent(db, { taskId: objected.id, workerId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  spawn(db, objected, at, "deckhand", commit);
  const beforePickup = logDecision(db, objected, "found nothing to repair", "deckhand", at, "worker");
  pickupTask(db, parent, "deckhand", at, { assignee: "deckhand" });
  spawn(db, objected, at, "deckhand", commit);
  const afterPickup = logDecision(db, objected, "kept the finding", "deckhand", at, "worker");
  object(beforePickup);
  object(afterPickup);
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand" }, at, ...HUMAN_WEBUI);
  const verbs = taskVerbSwap(db, rca.id);

  const prose = boardProse({
    db,
    registryDir,
    registry: loadRegistry(registryDir, "purely-local"),
    task: rca,
    spawnedEventId: spawn(db, rca, at),
    systemPrompt: "",
    profile: REVIEWER_AUTHORITY_PROFILE,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memorySection: null,
  });

  const [, first, second] = prose.split(/\n### Live for your objected /);
  expect([first?.split("\n", 1)[0], second?.split("\n", 1)[0]]).toEqual([`entry #${beforePickup}`, `entry #${afterPickup}`]);
  expect(first).not.toContain("Roster as it stood then");
  expect(second).toContain("#### Roster as it stood then (the board's reviewer authority)\n\ndeckhand — General work agent for the tidepool board");
});
