import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { boardDoctrine, boardProse, fenced } from "../src/board-prose.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { type AuthorityProfile, loadRegistry, REVIEWER_AUTHORITY_PROFILE } from "../src/registry.js";
import { cancelTaskDirectly, completeAudit, completeTask, getTask, listExaminees, logDecision, MEMORY_REPAIR_NOTICE, pickupTask, poseProbe, ROUTING_REPAIR_NOTICE, registerTask, type Task, taskVerbSwap, whyNoReturnDestination } from "../src/tasks.js";
import { recordHumanStop } from "../src/watchdog.js";
import { definitionPart, recordPrompt } from "./fakes.js";
import { decomposeTaskViaWorker, FULL_HANDOFF, HUMAN_WEBUI, poseAccepted, skillCall, skillsInit, toolCall, WORKER_SPAWNED } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** 文面の全体 —— 持ち主つきの部分を順に空文字で連結した値が harness へ渡る値(ADR 0313 決定2)。 */
const joined = (input: Parameters<typeof boardProse>[0]) => boardProse(input).map((part) => part.text).join("");
/** 記憶の店に見える approved が無い spawn の注入(節は null)。 */
const NO_MEMORY = { section: null };

/** 帰り先の無い系譜で走った task の当時版が Authority 節の代わりに写す1文(ADR 0301 決定5)。 */
const NO_AUTHORITY_THEN = "You were given no Authority section and no Roster section then.";

// Board doctrine の文面(ADR 0157 決定3)。adapter への配線は claude-worker.test.ts / codex-worker.test.ts が言う。

const CLAUDE = { delegate: "the Agent tool", workflow: true };
const CODEX = { delegate: "a subagent", workflow: false };
const NOT_SPLIT =
  "This task is not split: complete it in this session. If it is larger than one session can finish, finish what you can and state in the handoff what remains.";
const words = (text: string) => text.replace(/\s+/g, " ");
/** adapter と同じく、文面を描く session の `worker_spawned` を先に刻んでその id を返す(ADR 0295 決定3)。 */
const spawn = (db: Db, task: Task, at: Date, actorId = "deckhand") => appendEvent(db, { taskId: task.id, actorId, origin: "board", at, payload: WORKER_SPAWNED });
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
    recordDir: await tempDir("tidepool-records-"),
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

it("authority の部分は出所の印を持つ —— 修理子は repair、帰り先のある review は reviewer で、どちらも profile 名を持たない(ADR 0314 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const dirs = await boardDirs();
  const root = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const repair = registerTask(db, { type: "memory_repair", title: "repair", purpose: "p", completion_criteria: "c", parent_id: root.id }, at, ...HUMAN_WEBUI);
  const audit = independentAudit(db, at);
  const authorityOf = (task: Task) => boardProse(reviewInput(db, dirs, task, spawn(db, task, at))).find((part) => part.part === "authority");

  expect([authorityOf(repair), authorityOf(audit)]).toEqual([
    { part: "authority", text: `\n\n## Authority\n\n${MEMORY_REPAIR_NOTICE}`, source: "repair" },
    { part: "authority", text: `\n\n## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}`, source: "reviewer" },
  ]);
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

/** 盤面の registry(fixture の main)と記録の器(transcript の dir)。 */
type BoardDirs = { registryDir: string; recordDir: string };
const boardDirs = async (): Promise<BoardDirs> => ({ registryDir: await makeRegistry(), recordDir: await tempDir("tidepool-records-") });

/** adapter と同じく、`task` の `actorId` の spawn を刻んでその文面を組み、記録の器に prompt を書く(ADR 0313 決定1)。定義と profile は
 *  registry のもの(組み込みは reviewer 定数)。 */
function recordedSpawn(db: Db, { registryDir, recordDir }: BoardDirs, task: Task, at: Date, actorId = "deckhand", harness: "claude-code" | "codex" = "claude-code"): number {
  const spawnedEventId = spawn(db, task, at, actorId);
  const registry = loadRegistry(registryDir, "purely-local");
  const definition = registry.agents[actorId]!;
  const verbs = taskVerbSwap(db, task.id);
  const system = boardProse({
    db,
    recordDir,
    registry,
    task,
    spawnedEventId,
    definition,
    profile: registry.authority[definition.authority] ?? REVIEWER_AUTHORITY_PROFILE,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memory: NO_MEMORY,
    material: null,
  });
  recordPrompt(recordDir, task.id, spawnedEventId, system, "", harness);
  return spawnedEventId;
}

/** self RCA の文面の当時版の部分(無ければ空)。 */
const historical = (input: Parameters<typeof boardProse>[0]) => boardProse(input).find((part) => part.part === "historical_definition")?.text ?? "";

/** `objected`(deckhand が pickup 済み)の deckhand の判断の行への異議の self RCA の当時版 —— 異議された task の spawn は記録を書く。
 *  `afterSpawn` は異議された task の spawn の後、判断の行の前に走る。 */
async function selfRcaHistory(db: Db, objected: Task, at: Date, afterSpawn = () => {}) {
  const dirs = await boardDirs();
  recordedSpawn(db, dirs, objected, at);
  afterSpawn();
  const rca = rcaOf(db, objected, at, "deckhand", "deckhand");
  return historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));
}

/** reviewer の authority で走る task の spawn `spawnedEventId` の文面(registry は `registryDir` の main、定義本文は `systemPrompt`)。 */
function reviewProse(db: Db, dirs: BoardDirs, task: Task, spawnedEventId: number, systemPrompt = "") {
  return joined(reviewInput(db, dirs, task, spawnedEventId, systemPrompt));
}

function reviewInput(db: Db, { registryDir, recordDir }: BoardDirs, task: Task, spawnedEventId: number, systemPrompt = ""): Parameters<typeof boardProse>[0] {
  const verbs = taskVerbSwap(db, task.id);
  return {
    db,
    recordDir,
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

it.each(["claude-code", "codex"] as const)("%s: 停止のself RCAは記録の定義・Authority・Rosterをstop id付きで読む(ADR 0326)", async (harness) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-27T00:00:00.000Z");
  const dirs = await boardDirs();
  const task = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  recordedSpawn(db, dirs, task, at, "deckhand", harness);
  recordHumanStop(db, task.id, "wrong approach", at, "webui");
  const stop = listEvents(db, task.id).find((event) => event.kind === "session_stopped_by_human")!;
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: task.id, assignee: "deckhand", opened_on_event_ids: [stop.id] }, at, ...HUMAN_WEBUI);

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toContain(`## Definition under review (as recorded at your spawn) — stop ${stop.id}`);
  expect(history).toContain(fenced("You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs."));
  expect(history).toContain(fenced("## Authority\n\nPrefer reversible actions. Anything irreversible is outside your authority.\n"));
  expect(history).toContain("## Roster");
  expect(history).toContain("deckhand — General work agent for the tidepool board");
});

it("停止の self RCA の記録が読めなければ、stop id の見出しと欠落の1行だけを出す(ADR 0314 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-27T00:00:00.000Z");
  const dirs = await boardDirs();
  const task = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const lost = recordedSpawn(db, dirs, task, at);
  recordHumanStop(db, task.id, "wrong approach", at, "webui");
  const stop = listEvents(db, task.id).find((event) => event.kind === "session_stopped_by_human")!;
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: task.id, assignee: "deckhand", opened_on_event_ids: [stop.id] }, at, ...HUMAN_WEBUI);
  rmSync(join(dirs.recordDir, `${task.id}.${lost}.prompt.json`));

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toBe(
    `\n\n## Definition under review (as recorded at your spawn) — stop ${stop.id}\n\n` +
      `No recorded definition could be read for your stop ${stop.id} (missing session record) — the text that shaped the decision now under review is not available as evidence.`,
  );
});

it("当時版はこの RCA の材料だけを覆い、同じ worker の別 session の異議を載せない(ADR 0171 決定2・3 / #2627)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-27T00:00:00.000Z");
  const dirs = await boardDirs();
  const task = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const entries: number[] = [];
  const objections = ["Covered first", "Outside material", "Covered last"].map((body) => {
    const spawned = spawn(db, task, at);
    recordPrompt(dirs.recordDir, task.id, spawned, [definitionPart(body)]);
    const entry = logDecision(db, task, "a decision", "deckhand", at, "worker");
    entries.push(entry);
    return appendEvent(db, { taskId: task.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entry, comment: "why?", session_id: entry } });
  });
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: task.id, assignee: "deckhand", opened_on_event_ids: [objections[2]!, objections[0]!] }, at, ...HUMAN_WEBUI);

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toContain(`### Live for your objected entry ${entries[0]}\n\n---\n\n${fenced("Covered first")}`);
  expect(history).toContain(`### Live for your objected entry ${entries[2]}\n\n---\n\n${fenced("Covered last")}`);
  expect(history).not.toContain("Outside material");
  expect(history).not.toContain(`entry ${entries[1]}`);
});

it.each([undefined, "deckhand"])("停止に異議もあるとき、assignee %s の材料無し review と auditor RCA には当時版を注入しない(ADR 0020 決定3)", async (assignee) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-27T00:00:00.000Z");
  const dirs = await boardDirs();
  const task = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  recordedSpawn(db, dirs, task, at);
  const selfRca = rcaOf(db, task, at, "deckhand", "deckhand");
  recordHumanStop(db, task.id, "wrong approach", at, "webui");
  const stop = listEvents(db, task.id).find((event) => event.kind === "session_stopped_by_human")!;
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: task.id, assignee, opened_on_event_ids: assignee ? undefined : [stop.id] }, at, ...HUMAN_WEBUI);

  expect(historical(reviewInput(db, dirs, selfRca, spawn(db, selfRca, at)))).toContain("## Definition under review");
  expect(historical(reviewInput(db, dirs, rca, spawn(db, rca, at)))).toBe("");
});

it.each(REPAIR_NOTICES)("%s の task への self RCA の当時版は、Authority が修理の1行で Roster 節が無い —— spawn と同じ type の分岐(#2366)", async (type, notice) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const root = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const repair = pickupTask(db, registerTask(db, { type, title: "repair", purpose: "p", completion_criteria: "c", parent_id: root.id, assignee: "deckhand" }, at, ...HUMAN_WEBUI), "deckhand", at)!;

  const history = await selfRcaHistory(db, repair, at);

  expect(history).toContain(`The Authority below is the board's repair notice.\n\n${fenced(`## Authority\n\n${notice}`)}`);
  expect(history).not.toContain("## Roster");
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
  const dirs = await boardDirs();

  expect(reviewProse(db, dirs, review, beforePickup)).not.toContain("## Roster");
  expect(reviewProse(db, dirs, review, afterPickup)).toContain("## Roster\n\ndeckhand — General work agent for the tidepool board");
});

it("異議された entry が同じ定義の2つの spawn にまたがり、spawn ごとに Roster が違えば、self RCA の当時版は記録の text の違いで2節に分かれる(ADR 0314 決定6 / ADR 0295)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const dirs = await boardDirs();
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const objected = pickupTask(db, registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_ACTOR_ID, "board"), "deckhand", at)!;
  const object = (entryId: number) =>
    appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  recordedSpawn(db, dirs, objected, at);
  const beforePickup = logDecision(db, objected, "found nothing to repair", "deckhand", at, "worker");
  pickupTask(db, parent, "deckhand", at, { assignee: "deckhand" });
  recordedSpawn(db, dirs, objected, at);
  const afterPickup = logDecision(db, objected, "kept the finding", "deckhand", at, "worker");
  const objections = [object(beforePickup), object(afterPickup)];
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand", opened_on_event_ids: objections }, at, ...HUMAN_WEBUI);

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  const [, first, second] = history.split(/\n### Live for your objected /);
  expect([first?.split("\n", 1)[0], second?.split("\n", 1)[0]]).toEqual([`entry ${beforePickup}`, `entry ${afterPickup}`]);
  expect(first).not.toContain("## Roster");
  expect(second).toContain(fenced("## Roster\n\ndeckhand — General work agent for the tidepool board"));
});

it("2つの spawn で Executor が違っても記録した Roster の text が同じなら、self RCA の当時版は1節に畳む —— まだ居ない Executor と、registry に無い Executor はどちらも空(ADR 0314 決定6)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const dirs = await boardDirs();
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const objected = pickupTask(db, registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_ACTOR_ID, "board"), "deckhand", at)!;
  const object = (entryId: number) =>
    appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  recordedSpawn(db, dirs, objected, at);
  const first = object(logDecision(db, objected, "found nothing to repair", "deckhand", at, "worker"));
  pickupTask(db, parent, "retired-agent", at, { assignee: "retired-agent" });
  recordedSpawn(db, dirs, objected, at);
  const second = object(logDecision(db, objected, "kept the finding", "deckhand", at, "worker"));
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand", opened_on_event_ids: [first, second] }, at, ...HUMAN_WEBUI);

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toMatch(/^\n\n## Definition under review \(as recorded at your spawn\)\n/);
  expect(history).not.toContain("### Live for your objected");
  expect(history).not.toContain("## Roster");
});

it("異議された entry の spawn の記録が無ければ、記録の読めた節を注入した上でその entry を「missing session record」の欠落として申告する(ADR 0314 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const lost = recordedSpawn(db, dirs, objected, at);
  const first = logDecision(db, objected, "kept the old index", "deckhand", at, "worker");
  recordedSpawn(db, dirs, objected, at);
  const second = logDecision(db, objected, "kept the old index", "deckhand", at, "worker");
  const objections = [first, second].map((entryId) => appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } }));
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand", opened_on_event_ids: objections }, at, ...HUMAN_WEBUI);
  rmSync(join(dirs.recordDir, `${objected.id}.${lost}.prompt.json`));

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toContain(fenced("You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs."));
  expect(history).toContain(`Note: no recorded definition could be read for your objected entry ${first} (missing session record)`);
});

it("異議されたどの entry の spawn の記録も無ければ、self RCA の当時版は見出しと欠落の1行だけを持つ(ADR 0020 Status 追記 / issue #2619)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const lost = recordedSpawn(db, dirs, objected, at);
  const rca = rcaOf(db, objected, at, "deckhand", "deckhand");
  rmSync(join(dirs.recordDir, `${objected.id}.${lost}.prompt.json`));

  const parts = boardProse(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  const entryId = listEvents(db, objected.id).find((event) => event.kind === "decision_logged")!.id;
  const history = parts.find((part) => part.part === "historical_definition")?.text;
  expect(history).toBe(
    "\n\n## Definition under review (as recorded at your spawn)\n\n" +
      `No recorded definition could be read for your objected entry ${entryId} (missing session record) — the text that shaped the decision now under review is not available as evidence.`,
  );
  expect(history).not.toContain("Read it as evidence");
  expect(history).not.toContain("```");
});

it("証拠節は複数の entry を名詞と裸の番号で名指し、# を付けない(ADR 0322 決定6)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-28T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const lost = recordedSpawn(db, dirs, objected, at);
  const first = logDecision(db, objected, "kept the old index", "deckhand", at, "worker");
  const second = logDecision(db, objected, "kept the old schema", "deckhand", at, "worker");
  const objections = [first, second].map((entryId) => appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } }));
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand", opened_on_event_ids: objections }, at, ...HUMAN_WEBUI);
  rmSync(join(dirs.recordDir, `${objected.id}.${lost}.prompt.json`));

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toContain(`No recorded definition could be read for your objected entries ${first}, ${second} (missing session record)`);
});

it("異議された entry が別の actor の行だけなら、この worker の self RCA に当時版の部分は無い(ADR 0020 Status 追記 / issue #2619)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  recordedSpawn(db, dirs, objected, at);
  const rca = rcaOf(db, objected, at, "fugu", "deckhand");

  const parts = boardProse(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(parts.map((part) => part.part)).not.toContain("historical_definition");
});

/** self RCA の材料: deckhand の session で、transcript `lines(entry)` の判断の行に異議を打つ。session は閉じない(走行中)。 */
async function skillRca(lines: (entryId: number) => string[]) {
  const db = openDb(":memory:");
  const at = new Date("2026-10-29T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const spawned = recordedSpawn(db, dirs, objected, at);
  const entryId = logDecision(db, objected, "ran make deploy", "deckhand", at, "worker");
  const stream = join(dirs.recordDir, `${objected.id}.${spawned}.stream.jsonl`);
  writeFileSync(stream, lines(entryId).join("\n"));
  const objection = appendEvent(db, { taskId: objected.id, actorId: HUMAN_WEBUI[0], origin: "webui", at, payload: { kind: "objection_raised", entry_id: entryId, comment: "why?", session_id: 0 } });
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: objected.id, assignee: "deckhand", opened_on_event_ids: [objection] }, at, ...HUMAN_WEBUI);
  const history = () => historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));
  return { entryId, stream, history };
}

it("self RCA の当時版は、材料の session が走行中でも、異議された行より前に従った skill の名前と本文を持ち、後の呼び出しは持たない(ADR 0325 決定3)", async () => {
  const b = await skillRca((entryId) => [
    skillsInit(["deploy", "lint"]),
    ...skillCall(1, "deploy", "Run make deploy."),
    ...toolCall(2, "mcp__tidepool__log_decision", entryId),
    ...skillCall(3, "lint", "Run make lint."),
  ]);

  const history = b.history();

  expect(history).toContain(`#### deploy\n\n${fenced("Run make deploy.")}`);
  expect(history).not.toContain("lint");
});

it("self RCA の材料の session の transcript が読めなければ、従った skill の欠落を申告する(ADR 0325 決定3 / ADR 0314 決定2)", async () => {
  const b = await skillRca(() => []);
  rmSync(b.stream);

  expect(b.history()).toContain(`No session transcript could be read for your objected entry ${b.entryId} — the skills you followed before it are not available as evidence.`);
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
  const dirs = await boardDirs();
  const root = interviewRoot(db, at);
  const systemPrompt = body(dirs.registryDir);

  const beforePose = reviewProse(db, dirs, root, spawn(db, root, at, "suzumedai"), systemPrompt);
  poseAccepted(db, root, PROBE, "suzumedai", at, "worker", "0".repeat(40));
  const afterPose = reviewProse(db, dirs, root, spawn(db, root, at, "suzumedai"), systemPrompt);

  for (const prose of [beforePose, afterPose]) for (const line of INTERVIEW_DISCIPLINE_LINES) expect(prose).toContain(line);
});

it("Interview の受験者・監査 review・suzumedai が取った memory_repair の spawn の文面には Interview の規律の節が無い(ADR 0275 決定3)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-22T00:00:00.000Z");
  const dirs = await boardDirs();
  const root = interviewRoot(db, at);
  const audit = poseProbe(db, root, PROBE, "suzumedai", at, "worker", "0".repeat(40));
  completeAudit(db, audit, { verdict: "accepted", findings: "ok" }, "fugu", at, "worker");
  const [examinee] = listExaminees(db, root.id);
  const repair = registerTask(db, { type: "memory_repair", title: "repair", purpose: "p", completion_criteria: "c", parent_id: root.id, assignee: "suzumedai" }, at, ...HUMAN_WEBUI);
  const proseOf = (task: Task, worker: string) => reviewProse(db, dirs, task, spawn(db, task, at, worker));

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

  const prose = reviewProse(db, await boardDirs(), task, spawn(db, task, at, "fugu"));

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

  const prose = reviewProse(db, await boardDirs(), task, spawn(db, task, at, "fugu"));

  expect(prose).toContain(`## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}\n\n${next}`);
});

it("Interview の root への self RCA の当時版は、root の当時の文面に Authority 節も Roster 節も無かったことを写し、「同じ文」と指さない(ADR 0301 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00.000Z");
  const interview = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, at, ...HUMAN_WEBUI);
  const root = pickupTask(db, interview, "deckhand", at, { assignee: "deckhand" })!;

  const history = await selfRcaHistory(db, root, at);

  expect(history).toContain(NO_AUTHORITY_THEN);
  expect(history).not.toContain("## Authority");
  expect(history).not.toContain("## Roster");
  expect(history).not.toContain("the same text as your own");
});

it("祖先の work の cancel の前に spawn した RCA への self RCA の当時版は、reviewer の文とその時点の Roster を写し —— 自身は Authority 節を持たないので「同じ文」と指さない(ADR 0301 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const { root, rca } = rcaUnderWork(db, at);

  const history = await selfRcaHistory(db, rca, at, () => cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui"));

  expect(history).toContain(
    "The Authority below is the board's fixed reviewer authority. It is board code, not a registry profile, so it is not a target for a registry diff.\n\n" +
      `${fenced(`## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}`)}\n\n${fenced("## Roster\n\ndeckhand — General work agent for the tidepool board")}`,
  );
  expect(history).not.toContain("the same text as your own");
});

it("記録した reviewer の Authority の text が今の reviewer 定数と違えば、self RCA の当時版は「同じ文」と指さない(ADR 0314 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  const older = "\n\n## Authority\n\nAn older reviewer authority.";
  recordPrompt(dirs.recordDir, objected.id, spawn(db, objected, at), [definitionPart("You are Deckhand."), { part: "authority", text: older, source: "reviewer" }]);
  const rca = rcaOf(db, objected, at, "deckhand", "deckhand");

  const history = historical(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(history).toContain(
    "The Authority below is the board's fixed reviewer authority. It is board code, not a registry profile, so it is not a target for a registry diff.\n\n" +
      fenced(older.trimStart()),
  );
  expect(history).not.toContain("the same text as your own");
});

it("assignable_to が \"*\" の authority の worker への self RCA の当時版 Roster は、registry の agent を載せ組み込み(fugu / suzumedai)を載せない —— spawn 時の Roster と同じ集合(#2602)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const work = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c", assignee: "deckhand" }, at, ...HUMAN_WEBUI), "deckhand", at)!;

  const roster = (await selfRcaHistory(db, work, at)).split("## Roster")[1] ?? "";
  expect(roster).toContain("deckhand — General work agent for the tidepool board");
  expect(roster).not.toContain("fugu");
  expect(roster).not.toContain("suzumedai");
});

it("祖先の work の cancel の後に spawn した RCA への self RCA の当時版は、Authority 節も Roster 節も無かったことを写す —— cancel は spawn の前に記録されたものだけ数える(ADR 0301 決定5)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const { root, rca } = rcaUnderWork(db, at);
  cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui");

  const history = await selfRcaHistory(db, rca, at);

  expect(history).toContain(NO_AUTHORITY_THEN);
  expect(history).not.toContain("## Authority");
  expect(history).not.toContain("## Roster");
});

it("文面は持ち主つきの部分の列で、組んだ節だけを順に持ち、各部分は自分の区切りを含む —— 記憶の注入と主題の材料は別の部分(ADR 0313 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const registry = loadRegistry(await makeRegistry(), "purely-local");
  const task = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const verbs = taskVerbSwap(db, task.id);

  const parts = boardProse({
    db,
    recordDir: await tempDir("tidepool-records-"),
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
  expect(parts[1]).toEqual({ part: "authority", text: "\n\n## Authority\n\nPrefer reversible actions.", source: "profile", profile: "standard" });
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
  const dirs = await boardDirs();
  const root = interviewRoot(db, at);
  const suzumedai = loadRegistry(dirs.registryDir, "purely-local").agents.suzumedai!;

  const parts = boardProse({ ...reviewInput(db, dirs, root, spawn(db, root, at, "suzumedai")), definition: suzumedai });

  expect(parts.map((part) => part.part)).toEqual(["definition", "doctrine", "interview_discipline", "protocol"]);
  expect(parts[0]).toMatchObject({ builtin: true, definition_version: suzumedai.version });
  expect(parts[2]!.text).toMatch(/^\n\n## Interview discipline\n/);
});

it("self RCA の当時版は historical_definition の部分 —— protocol の後に置く(ADR 0313 決定2)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-26T00:00:00.000Z");
  const dirs = await boardDirs();
  const objected = pickupTask(db, registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), "deckhand", at, { assignee: "deckhand" })!;
  recordedSpawn(db, dirs, objected, at);
  const rca = rcaOf(db, objected, at, "deckhand", "deckhand");

  const parts = boardProse(reviewInput(db, dirs, rca, spawn(db, rca, at)));

  expect(parts.map((part) => part.part).slice(-2)).toEqual(["protocol", "historical_definition"]);
  expect(parts.at(-1)!.text).toMatch(/^\n\n## Definition under review/);
  // RCA は registry の hash を読む手段を持たない(issue #1741)—— 記録した commit は証拠に出さない
  expect(parts.at(-1)!.text).not.toContain(loadRegistry(dirs.registryDir, "purely-local").commit.slice(0, 7));
});
