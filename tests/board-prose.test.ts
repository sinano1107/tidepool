import { expect, it } from "vitest";
import { boardDoctrine, boardProse } from "../src/board-prose.js";
import { openDb } from "../src/db.js";
import { type AuthorityProfile, loadRegistry, REVIEWER_AUTHORITY_PROFILE } from "../src/registry.js";


import { ARTIFACT_DISCARDED_NOTICE, cancelTaskDirectly, INTERVIEW_AUDIT_NOTICE, isArtifactDiscarded, MEMORY_REPAIR_NOTICE, poseProbe, registerTask, taskVerbSwap } from "../src/tasks.js";


import { HUMAN_WEBUI } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

// Board doctrine の文面(ADR 0157 決定3)。adapter への配線は claude-worker.test.ts / codex-worker.test.ts が言う。

const CLAUDE = { delegate: "the Agent tool", workflow: true };
const CODEX = { delegate: "a subagent", workflow: false };
const NOT_SPLIT =
  "This task is not split: complete it in this session. If it is larger than one session can finish, finish what you can and state in the handoff what remains.";
const words = (text: string) => text.replace(/\s+/g, " ");
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

/** 祖先の cancel の下の memory_repair と、その文面(組み込みでない deckhand を持つ registry —— Roster が組める形)。 */
async function memoryRepairProse(profile: AuthorityProfile) {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const parent = registerTask(db, { type: "work", title: "index the tide charts", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  cancelTaskDirectly(db, parent, null, at, {}, "webui");
  const task = registerTask(db, { type: "memory_repair", title: "memory repair", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, ...HUMAN_WEBUI);
  expect(isArtifactDiscarded(db, task.id)).toBe(true);
  const verbs = taskVerbSwap(db, task.id);
  return boardProse({
    db,
    registryDir: "",
    registry: loadRegistry(await makeRegistry(), "purely-local"),
    task,
    systemPrompt: "",
    profile,
    doctrine: boardDoctrine(CLAUDE, verbs),
    verbs,
    allowedDomains: undefined,
    memorySection: null,
  });
}

it("memory_repair の spawn の文面は Authority 節が記憶の修理の1行だけで、profile の guidance も Roster 節も無く、祖先の cancel の下でも成果が捨てられた旨を置かず、前提の破綻の宣言も言わない(ADR 0272 決定3・追記3)", async () => {
  const prose = await memoryRepairProse({ name: "standard", guidance: "Prefer reversible actions.", assignable_to: ["*"] });

  expect(prose).toContain(`## Authority\n\n${MEMORY_REPAIR_NOTICE}\n\n`);
  expect(prose).not.toContain("Prefer reversible actions.");
  expect(prose).not.toContain("## Roster");
  expect(prose).not.toContain(ARTIFACT_DISCARDED_NOTICE);
  expect(prose).not.toContain("premise breach");
});

it("profile が reviewer 定数でも、memory_repair の Authority 節は記憶の修理の1行だけ(ADR 0272 追記3)", async () => {
  const prose = await memoryRepairProse(REVIEWER_AUTHORITY_PROFILE);

  expect(prose).toContain(`## Authority\n\n${MEMORY_REPAIR_NOTICE}\n\n`);
  expect(prose).not.toContain(REVIEWER_AUTHORITY_PROFILE.guidance);
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
