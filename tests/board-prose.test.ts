import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { boardDoctrine, boardProse } from "../src/board-prose.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { type AuthorityProfile, loadRegistry, REVIEWER_AUTHORITY_PROFILE } from "../src/registry.js";
import { cancelTaskDirectly, completeAudit, completeTask, getTask, listExaminees, logDecision, MEMORY_REPAIR_NOTICE, pickupTask, poseProbe, ROUTING_REPAIR_NOTICE, registerTask, type Task, taskVerbSwap, whyNoReturnDestination } from "../src/tasks.js";
import { decomposeTaskViaWorker, FULL_HANDOFF, HUMAN_WEBUI, poseAccepted, WORKER_SPAWNED } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

/** 文面の全体 —— 持ち主つきの部分を順に空文字で連結した値が harness へ渡る値(ADR 0313 決定2)。 */
const joined = (input: Parameters<typeof boardProse>[0]) =>
  boardProse(input)
    .map((part) => part.text)
    .join("");
/** 記憶の店に何も無い spawn の注入(節は空)。 */
const NO_MEMORY = { section: "" };

/** 帰り先の無い系譜で走った task の当時版が Authority 節の代わりに写す1文(ADR 0301 決定5)。 */
const NO_AUTHORITY_THEN = "You were given no Authority section and no Roster section then.";

// Board doctrine の文面(ADR 0157 決定3)。adapter への配線は claude-worker.test.ts / codex-worker.test.ts が言う。

const CLAUDE = { delegate: "the Agent tool", workflow: true };
const CODEX = { delegate: "a subagent", workflow: false };
const NOT_SPLIT =
  "This task is not split: complete it in this session. If it is larger than one session can finish, finish what you can and state in the handoff what remains.";
const words = (text: string) => text.replace(/\s+/g, " ");
/** adapter と同じく、文面を描く session の `worker_spawned` を先に刻んでその id を返す(ADR 0295 決定3)。 */
const spawn = (db: Db, task: Task, at: Date, actorId = "deckhand", commit = WORKER_SPAWNED.registry_commit) =>
  appendEvent(db, { taskId: task.id, actorId, origin: "board", at, payload: { ...WORKER_SPAWNED, registry_commit: commit } });
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
  expect(whyNoReturnDestination(db, task.id)).toMatch(/^the cancel of ancestor/);
  const verbs = taskVerbSwap(db, task.id);
  return joined({
    db,
    registryDir: "",
    registry: loadRegistry(await makeRegistry(), "purely-local"),
    task,
    spawnedEventId: spawn(db, task, at),
    definition: { systemPrompt: "", version: "0.0.0" },
    profile,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memory: NO_MEMORY,
    material: null,
  });
}

const REPAIR_NOTICES = [
  ["memory_repair", MEMORY_REPAIR_NOTICE],
  ["routing_repair", ROUTING_REPAIR_NOTICE],
] as const;

it.each(REPAIR_NOTICES)("%s の spawn の文面は Authority 節が修理の1行だけで、profile の guidance も Roster 節も無く、祖先の cancel の下でも前提の破綻の宣言も言わない(ADR 0272 決定3・追記3 / ADR 0279 決定4)", async (type, notice) => {
  const prose = await repairProse({ name: "standard", guidance: "Prefer reversible actions.", assignable_to: ["*"] }, type);

  expect(prose).toContain(`## Authority\n\n${notice}\n\n`);
  expect(prose).not.toContain("Prefer reversible actions.");
  expect(prose).not.toContain("## Roster");
  expect(prose).not.toContain("premise breach");
});

it.each(REPAIR_NOTICES)("profile が reviewer 定数でも、%s の Authority 節は修理の1行だけ(ADR 0272 追記3 / ADR 0279 決定4)", async (type, notice) => {
  const prose = await repairProse(REVIEWER_AUTHORITY_PROFILE, type);

  expect(prose).toContain(`## Authority\n\n${notice}\n\n`);
  expect(prose).not.toContain(REVIEWER_AUTHORITY_PROFILE.guidance);
});

/** `objected` の `worker` の判断の行への異議の RCA(`assignee` を渡せば self RCA)—— 帰り先の無い系譜(Interview の root)にも立つ(ADR 0301 決定2)。 */
function rcaOf(db: Db, objected: Task, at: Date, worker = "deckhand", assignee?: string) {
  const entryId = logDecision(db, objected, "kept the old index", worker, at, "worker");
  const objection = appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  return registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee, opened_on_event_ids: [objection] }, at, ...HUMAN_WEBUI);
}

/** `objected`(deckhand が pickup 済み)の deckhand の判断の行への異議の self RCA の文面 —— 当時版は registry の main の commit。
 *  `afterSpawn` は異議された task の spawn の後、判断の行の前に走る。 */
async function selfRcaProse(db: Db, objected: Task, at: Date, afterSpawn = () => {}) {
  const registryDir = await makeRegistry();
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  appendEvent(db, { taskId: objected.id, actorId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, registry_commit: commit } });
  afterSpawn();
  const rca = rcaOf(db, objected, at, "deckhand", "deckhand");
  return reviewProse(db, registryDir, rca, spawn(db, rca, at));
}

/** reviewer の authority で走る task の spawn `spawnedEventId` の文面(registry は `registryDir` の main、定義本文は `systemPrompt`)。 */
function reviewProse(db: Db, registryDir: string, task: Task, spawnedEventId: number, systemPrompt = "") {
  return joined(reviewInput(db, registryDir, task, spawnedEventId, systemPrompt));
}

function reviewInput(db: Db, registryDir: string, task: Task, spawnedEventId: number, systemPrompt = ""): Parameters<typeof boardProse>[0] {
  const verbs = taskVerbSwap(db, task.id);
  return {
    db,
    registryDir,
    registry: loadRegistry(registryDir, "purely-local"),
    task,
    spawnedEventId,
    definition: { systemPrompt, version: "0.0.0" },
    profile: REVIEWER_AUTHORITY_PROFILE,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memory: NO_MEMORY,
    material: null,
  };
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

it("review の spawn の Roster はその spawn の時点の Executor —— spawn の後に親が pickup されても空のままで、pickup の後の再 spawn は撮り直す(ADR 0295 決定1・2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  // 盤面名義の RCA(人間名義の review 子は実行前の親に付かない —— ADR 0292 決定2)
  const review = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_ACTOR_ID, "board");
  const beforePickup = spawn(db, review, at, "fugu");
  pickupTask(db, parent, "deckhand", at, { assignee: "deckhand" });
  const afterPickup = spawn(db, review, at, "fugu");
  const registryDir = await makeRegistry();

  expect(reviewProse(db, registryDir, review, beforePickup)).not.toContain("## Roster");
  expect(reviewProse(db, registryDir, review, afterPickup)).toContain("## Roster\n\ndeckhand — General work agent for the tidepool board");
});

it("異議された entry が同じ版の2つの spawn にまたがり、spawn ごとに Roster が違えば、self RCA の当時版は2節に分かれる(ADR 0270 追記 / ADR 0295)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const objected = pickupTask(db, registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_ACTOR_ID, "board"), "deckhand", at)!;
  const object = (entryId: number) =>
    appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  spawn(db, objected, at, "deckhand", commit);
  const beforePickup = logDecision(db, objected, "found nothing to repair", "deckhand", at, "worker");
  pickupTask(db, parent, "deckhand", at, { assignee: "deckhand" });
  spawn(db, objected, at, "deckhand", commit);
  const afterPickup = logDecision(db, objected, "kept the finding", "deckhand", at, "worker");
  object(beforePickup);
  object(afterPickup);
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand" }, at, ...HUMAN_WEBUI);

  const prose = reviewProse(db, registryDir, rca, spawn(db, rca, at));

  const [, first, second] = prose.split(/\n### Live for your objected /);
  expect([first?.split("\n", 1)[0], second?.split("\n", 1)[0]]).toEqual([`entry #${beforePickup}`, `entry #${afterPickup}`]);
  expect(first).not.toContain("Roster as it stood then");
  expect(second).toContain("#### Roster as it stood then (the board's reviewer authority)\n\ndeckhand — General work agent for the tidepool board");
});

it("2つの spawn で Executor が違っても描いた Roster が同じなら、self RCA の当時版は1節に畳む —— まだ居ない Executor と、その commit の registry に無い Executor はどちらも空(ADR 0270 追記)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const objected = pickupTask(db, registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_ACTOR_ID, "board"), "deckhand", at)!;
  const object = (entryId: number) =>
    appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  spawn(db, objected, at, "deckhand", commit);
  object(logDecision(db, objected, "found nothing to repair", "deckhand", at, "worker"));
  pickupTask(db, parent, "retired-agent", at, { assignee: "retired-agent" });
  spawn(db, objected, at, "deckhand", commit);
  object(logDecision(db, objected, "kept the finding", "deckhand", at, "worker"));
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand" }, at, ...HUMAN_WEBUI);

  const prose = reviewProse(db, registryDir, rca, spawn(db, rca, at));

  expect(prose).toContain("## Definition under review (as it stood when you ran the objected task)");
  expect(prose).not.toContain("### Live for your objected");
  expect(prose).not.toContain("Roster as it stood then");
});

/** suzumedai が pickup した Interview の root。 */
const interviewRoot = (db: Db, at: Date) =>
  pickupTask(
    db,
    registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, at, ...HUMAN_WEBUI),
    "suzumedai",
    at,
    { assignee: "suzumedai" },
  )!;
const PROBE = { title: "probe", probe: "p", completion_criteria: "c", rubric: "r" };

/** Interview の規律の節のうち旧本文から移した行(#2192 の匿名化の段落と ADR 0276 決定2 の1行は、文を変えずに移した)。 */
const INTERVIEW_DISCIPLINE_LINES = [
  "## Interview discipline",
  "- Compose the environment in your working directory, the interview room, not in the real environment you read: an anonymised reproduction of the work the probe needs, not a copy of the real environment. Each target solves the probe in its own fresh checkout of the room as it stands when you pose the probe.",
  "- Put in exactly what the probe needs and nothing more: no board vocabulary, no file that describes the board or how it works, and no name that points at the real environment. A target that can tell it is being measured, or that leans on material the probe does not need, measures the environment, not the target.",
  "- Do not list in .gitignore anything you want the targets to have: ignored files never reach their environment.",
  "- Aim at the tier's quality bar. A probe every target passes, or every target fails, measures nothing; pick work whose outcome separates a target that meets the bar from one that does not.",
  "- Make the probe self-contained in the environment you composed. A target that fails because the probe was ambiguous measures the probe, not the target.",
  "- Write the rubric as observable criteria: what a passing answer does, what a failing one does, which shortfalls disqualify and which are minor. Prefer checks a second scorer would apply the same way.",
];

it.each([
  ["本文が空の組み込み suzumedai", (registryDir: string) => loadRegistry(registryDir, "purely-local").agents.suzumedai!.systemPrompt],
  ["本文を持つ registry の agent", () => "You are my interviewer."],
])("Interview の root の spawn の文面は、%s でも出題前・出題後とも Interview の規律の節を持つ(ADR 0275 決定3)", async (_, body) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-22T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const root = interviewRoot(db, at);
  const systemPrompt = body(registryDir);

  const beforePose = reviewProse(db, registryDir, root, spawn(db, root, at, "suzumedai"), systemPrompt);
  poseAccepted(db, root, PROBE, "suzumedai", at, "worker", "0".repeat(40));
  const afterPose = reviewProse(db, registryDir, root, spawn(db, root, at, "suzumedai"), systemPrompt);

  for (const prose of [beforePose, afterPose]) for (const line of INTERVIEW_DISCIPLINE_LINES) expect(prose).toContain(line);
});

it("Interview の受験者・監査 review・suzumedai が取った memory_repair の spawn の文面には Interview の規律の節が無い(ADR 0275 決定3)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-22T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const root = interviewRoot(db, at);
  const audit = poseProbe(db, root, PROBE, "suzumedai", at, "worker", "0".repeat(40));
  completeAudit(db, audit, { verdict: "accepted", findings: "ok" }, "fugu", at, "worker");
  const [examinee] = listExaminees(db, root.id);
  const repair = registerTask(db, { type: "memory_repair", title: "repair", purpose: "p", completion_criteria: "c", parent_id: root.id, assignee: "suzumedai" }, at, ...HUMAN_WEBUI);
  const proseOf = (task: Task, worker: string) => reviewProse(db, registryDir, task, spawn(db, task, at, worker));

  for (const prose of [proseOf(audit, "fugu"), proseOf(examinee!, "deckhand"), proseOf(repair, "suzumedai")]) {
    expect(prose).not.toContain("Interview discipline");
    expect(prose).not.toContain("anonymised reproduction");
  }
});

/** 分解された work の root(`root` —— 人間が cancel できる)、その子の work(deckhand が完了済み)と、その子の下の RCA を deckhand が
 *  pickup したもの。 */
function rcaUnderWork(db: Db, at: Date) {
  const root = registerTask(db, { type: "work", title: "root", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const [child] = decomposeTaskViaWorker(db, root, { reason: "split", children: [{ title: "w", purpose: "p", completion_criteria: "c" }] }, "deckhand", at);
  const work = pickupTask(db, child!, "deckhand", at, { assignee: "deckhand" })!;
  const rca = rcaOf(db, work, at, "deckhand", "deckhand");
  const done = completeTask(db, work, FULL_HANDOFF, "deckhand", at, "worker");
  return { root, work: done, rca: pickupTask(db, rca, "deckhand", at)! };
}

/** 帰り先の無い系譜で reviewer の文を持って走る task(ADR 0301 決定5)。 */
const WITHOUT_DESTINATION: Array<[string, (db: Db, at: Date) => Task]> = [
  ["Interview の root の下の RCA", (db, at) => rcaOf(db, interviewRoot(db, at), at, "suzumedai")],
  [
    "cancelled の work の祖先の下の RCA",
    (db, at) => {
      const { root, rca } = rcaUnderWork(db, at);
      cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui");
      return rca;
    },
  ],
  ["出題の監査", (db, at) => poseProbe(db, interviewRoot(db, at), PROBE, "suzumedai", at, "worker", "0".repeat(40))],
  ["Interview の root", (db, at) => interviewRoot(db, at)],
  ["memory の meta-review", (db, at) => registerTask(db, { type: "review", title: "m", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, ...HUMAN_WEBUI)],
  ["routing の meta-review", (db, at) => registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", meta_review_subject: "routing" }, at, ...HUMAN_WEBUI)],
];

it.each(WITHOUT_DESTINATION)("%s の spawn の文面には Authority 節も Roster 節も無い(ADR 0301 決定5)", async (_, make) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const task = make(db, at);

  const prose = reviewProse(db, await makeRegistry(), task, spawn(db, task, at, "fugu"));

  expect(prose).not.toContain("## Authority");
  expect(prose).not.toContain("## Roster");
  expect(prose).not.toContain(REVIEWER_AUTHORITY_PROFILE.guidance);
});

/** 独立監査(主題の無いルートの review)を deckhand が pickup したもの。 */
const independentAudit = (db: Db, at: Date) =>
  pickupTask(db, registerTask(db, { type: "review", title: "audit", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
const DECKHAND_ROSTER = "## Roster\n\ndeckhand — General work agent for the tidepool board";

it.each<[string, (db: Db, at: Date) => Task, string]>([
  ["完了時レビュー", (db, at) => registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c", parent_id: rcaUnderWork(db, at).work.id }, at, BOARD_ACTOR_ID, "board"), DECKHAND_ROSTER],
  ["独立監査", (db, at) => independentAudit(db, at), "## Board doctrine"],
  ["独立監査の RCA", (db, at) => rcaOf(db, independentAudit(db, at), at), DECKHAND_ROSTER],
])("帰り先のある系譜の %s の spawn の文面は今どおり reviewer の文と Roster を持つ(ADR 0301 決定5)", async (_, make, next) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const task = make(db, at);

  const prose = reviewProse(db, await makeRegistry(), task, spawn(db, task, at, "fugu"));

  expect(prose).toContain(`## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}\n\n${next}`);
});

it("Interview の root への self RCA の当時版は、root の当時の文面に Authority 節も Roster 節も無かったことを写し、「同じ文」と指さない(ADR 0301 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const interview = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, at, ...HUMAN_WEBUI);
  const root = pickupTask(db, interview, "deckhand", at, { assignee: "deckhand" })!;

  const prose = await selfRcaProse(db, root, at);

  expect(prose).toContain(NO_AUTHORITY_THEN);
  expect(prose).not.toContain("Authority as it stood then");
  expect(prose).not.toContain("Roster as it stood then");
  expect(prose).not.toContain("the same text as your own");
});

it("祖先の work の cancel の前に spawn した RCA への self RCA の当時版は、reviewer の文とその時点の Roster を写し —— 自身は Authority 節を持たないので「同じ文」と指さない(ADR 0301 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const { root, rca } = rcaUnderWork(db, at);

  const prose = await selfRcaProse(db, rca, at, () => cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui"));

  expect(prose).not.toContain("\n## Authority");
  expect(prose).toContain(
    `### Authority as it stood then (the board's reviewer authority)\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}\n\n` +
      "This is the board's fixed reviewer authority. It is board code, not a registry profile, so it is not a target for a registry diff.",
  );
  expect(prose).toContain("### Roster as it stood then (the board's reviewer authority)\n\ndeckhand — General work agent for the tidepool board");
  expect(prose).not.toContain("the same text as your own");
});

it("祖先の work の cancel の後に spawn した RCA への self RCA の当時版は、Authority 節も Roster 節も無かったことを写す —— cancel は spawn の前に記録されたものだけ数える(ADR 0301 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const { root, rca } = rcaUnderWork(db, at);
  cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui");

  const prose = await selfRcaProse(db, rca, at);

  expect(prose).toContain(NO_AUTHORITY_THEN);
  expect(prose).not.toContain("Authority as it stood then");
  expect(prose).not.toContain("Roster as it stood then");
});

it("文面は持ち主つきの部分の列で、組んだ節だけを順に持ち、各部分は自分の区切りを含む —— 記憶の注入と主題の材料は別の部分(ADR 0313 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const registry = loadRegistry(registryDir, "purely-local");
  const task = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const verbs = taskVerbSwap(db, task.id);

  const parts = boardProse({
    db,
    registryDir,
    registry,
    task,
    spawnedEventId: spawn(db, task, at),
    definition: { systemPrompt: "You are Deckhand.", version: "0.3.1" },
    profile: { name: "standard", guidance: "Prefer reversible actions.", assignable_to: ["*"] },
    doctrine: "## Board doctrine\n\nStay on the board.",
    verbs,
    allowedDomains: undefined,
    memory: { section: "## Memory\n\nThe tide is high." },
    material: { section: "## Routing meta-review material\n\nThree routes." },
  });

  expect(parts.map((part) => part.part)).toEqual(["definition", "authority", "roster", "doctrine", "protocol", "memory", "meta_review_material"]);
  expect(parts[0]).toEqual({ part: "definition", text: "You are Deckhand.", builtin: false, registry_commit: registry.commit, definition_version: "0.3.1" });
  expect(parts[1]).toEqual({ part: "authority", text: "\n\n## Authority\n\nPrefer reversible actions." });
  expect(parts[2]!.text).toMatch(/^\n\n## Roster\n\n/);
  expect(parts[3]).toEqual({ part: "doctrine", text: "\n\n## Board doctrine\n\nStay on the board." });
  expect(parts.slice(5)).toEqual([
    { part: "memory", text: "\n\n## Memory\n\nThe tide is high." },
    { part: "meta_review_material", text: "\n\n## Routing meta-review material\n\nThree routes." },
  ]);
});

it("組み込みの agent の定義の部分は builtin 旗を持ち、記憶の節が空で材料の無い spawn は memory も meta_review_material も列に無い —— Interview の root は規律の部分を持つ(ADR 0313 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const root = interviewRoot(db, at);
  const suzumedai = loadRegistry(registryDir, "purely-local").agents.suzumedai!;

  const parts = boardProse({ ...reviewInput(db, registryDir, root, spawn(db, root, at, "suzumedai")), definition: suzumedai });

  expect(parts.map((part) => part.part)).toEqual(["definition", "doctrine", "interview_discipline", "protocol"]);
  expect(parts[0]).toMatchObject({ builtin: true, definition_version: suzumedai.version });
  expect(parts[2]!.text).toMatch(/^\n\n## Interview discipline\n/);
});

it("self RCA の当時版は historical_definition の部分 —— protocol の後に置く(ADR 0313 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const registryDir = await makeRegistry();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  appendEvent(db, { taskId: objected.id, actorId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, registry_commit: commit } });
  const rca = rcaOf(db, objected, at, "deckhand", "deckhand");

  const parts = boardProse(reviewInput(db, registryDir, rca, spawn(db, rca, at)));

  expect(parts.map((part) => part.part).slice(-2)).toEqual(["protocol", "historical_definition"]);
  expect(parts.at(-1)!.text).toMatch(/^\n\n## Definition under review/);
});
