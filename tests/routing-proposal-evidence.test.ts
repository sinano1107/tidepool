import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, type EventPayload, getEvent, latestEventOfTask } from "../src/events.js";
import { applyExecutionSettingsChange, type RowKey } from "../src/execution-setting.js";
import { registerMetaReview } from "../src/meta-review.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { getTask, listBoard, listChildren, registerTask } from "../src/tasks.js";
import { readTiers, tierIdOf } from "../src/tier.js";
import { commitTriage, raiseObjection } from "../src/triage.js";
import { DECKHAND_AGENT, decomposedChild, examineeRootId, HUMAN_WEBUI, interviewExaminee, judgedRoutingReview, OPUS_ROW, routedOpusSessions, rowSession, WORKER_SPAWNED } from "./harness.js";

/** routing の提案の根拠は op の対象が決める母集団の部分集合で、検査・組・引用の外は盤面が母集団から組む(ADR 0302、issue #2485)の
 *  ドメイン層。昇格 / 降格の detail は tests/learner-promotion-evidence.test.ts、MCP の inputSchema はサーバ境界の各テストが言う。 */
const at = new Date("2026-10-23T00:00:00.000Z");
const OPUS = "anthropic / claude-opus-5-5 at effort high";
const SOL = { provider: "openai" as const, model: "gpt-5.6-sol", effort: "high" };

function board() {
  const db = openDb(":memory:");
  registerMetaReview(db, "routing", at);
  const review = listBoard(db).find((task) => task.meta_review_subject === "routing")!.id;
  const propose = (input: Omit<Parameters<typeof proposeRoutingChange>[2], "rationale">) =>
    proposeRoutingChange(db, review, { rationale: "r", ...input }, "auditor", at, () => [DECKHAND_AGENT]);
  return { db, review, propose };
}

/** setup のみ: work task(段 `requested` を要求、`writer` が登録)の session を1つ、行 `row` で段 `tier` に刻み、worker_spawned の id を返す。
 *  行の今の段で走る既定どおりの session は harness の rowSession。 */
function session(
  db: Db,
  options: { row?: RowKey; tier?: string; workspace?: string; agent?: string; source?: "task" | "agent"; requested?: string; writer?: readonly [string, "webui" | "mcp"] } = {},
): number {
  const { row = OPUS_ROW, tier = "standard", workspace = "reef", agent = "deckhand", source = "task", requested = tier, writer = HUMAN_WEBUI } = options;
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier: requested, workspace }, at, ...writer).id;
  return spawnOn(db, task, { row, tier, agent, source });
}

function spawnOn(db: Db, taskId: string, { row = OPUS_ROW, tier = "standard", agent = "deckhand", source = "task" }: { row?: RowKey; tier?: string; agent?: string; source?: "task" | "agent" } = {}): number {
  return appendEvent(db, {
    taskId,
    workerId: agent,
    origin: "board",
    at,
    payload: { ...WORKER_SPAWNED, ...row, advisor: null, tier_id: tierIdOf(db, tier), source: { tier: source, provider: "rank" } },
  });
}

/** setup のみ: session に配分評価を1件付ける。 */
function allocate(db: Db, spawned: number, allocation: "overpowered" | "underpowered", cause: "uncertain" | "capability") {
  const payload = { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, judge: { provider: "anthropic", model: "fable", effort: "high" }, allocation, cause, evidence: "e" };
  appendEvent(db, { taskId: taskOf(db, spawned), workerId: "tidepool", origin: "board", at, payload: payload as Extract<EventPayload, { kind: "allocation_reviewed" }> });
}

/** setup のみ: 行を別の段へ移す(人間の表の編集)。 */
const moveRow = (db: Db, row: RowKey, tier: string) =>
  applyExecutionSettingsChange(db, { setting: "row", key: row, row: { ...row, tier, price_in: 5, price_out: 25 } as never }, "webui", at);

const taskOf = (db: Db, spawned: number) => getEvent(db, spawned)!.task_id!;
const detailLines = (db: Db, questionId: string) => getTask(db, questionId)!.question_items![0]!.detail!.split("\n");

it("行の提案は根拠が無いと拒まれ、その行で今の段で走った本番 session を根拠にすると question が立ち、question_proposal に evidence が残り pin は行の全欄のまま", () => {
  const { db, propose } = board();
  const evidence = [rowSession(db, OPUS_ROW, at)];

  expect(() => propose({ op: "row", row: OPUS_ROW, change: { tier: "frontier" } })).toThrow(/op row names .* at least one evidence worker_spawned event id/);
  const { question_id } = propose({ op: "row", row: OPUS_ROW, change: { tier: "frontier" }, evidence });

  expect(getTask(db, question_id)!.question_proposal).toEqual({
    kind: "routing",
    op: "row",
    row: OPUS_ROW,
    change: { tier: tierIdOf(db, "frontier") },
    evidence,
    pin: { ...OPUS_ROW, tier: tierIdOf(db, "standard"), price_in: 5, price_out: 25 },
  });
});

it.each(["row", "interview"] as const)(
  "op %s の根拠は、work 側でない task(review・Interview の root)の session・Interview の受験者の session・別の行の session・行が前の段にいた頃の session をそれぞれ理由を名指して拒み、question は立たない",
  (op) => {
    const { db, review, propose } = board();
    const reviewSide = spawnOn(db, review);
    const examineeTask = interviewExaminee(db, at);
    const examinee = spawnOn(db, examineeTask.id);
    const root = spawnOn(db, examineeRootId(db, examineeTask.id));
    const sonnet = rowSession(db, { ...OPUS_ROW, model: "claude-sonnet-5-5" }, at);
    const earlier = rowSession(db, OPUS_ROW, at);
    moveRow(db, OPUS_ROW, "frontier");
    const proposeOn = (evidence: number[]) =>
      op === "row"
        ? propose({ op, row: OPUS_ROW, change: { effort: "max" }, evidence })
        : propose({ op, hypothesis: "h", tier: "frontier", targets: [{ ...OPUS_ROW, effort: "max" }], workspace: "reef", evidence });

    expect(() => proposeOn([reviewSide])).toThrow(`evidence ${reviewSide} is a session of a task of type review; only a work-side task's session has an outcome and allocation reviews`);
    expect(() => proposeOn([root])).toThrow(`evidence ${root} is a session of a task of type interview; only a work-side task's session has an outcome and allocation reviews`);
    expect(() => proposeOn([examinee])).toThrow(`evidence ${examinee} is not a worker_spawned event of a production work session: it is an Interview examinee's session`);
    if (op === "row") expect(() => proposeOn([sonnet])).toThrow(`evidence ${sonnet} ran on anthropic / claude-sonnet-5-5 at effort high, not on ${OPUS}`);
    expect(() => proposeOn([earlier])).toThrow(`evidence ${earlier} ran in tier standard, not in frontier, the current tier of ${OPUS}`);
    expect(listChildren(db, review)).toEqual([]);
  },
);

it("行の提案の detail は根拠を session の軸から行と段を落とした組(出所・agent・workspace・書き手)ごとに1行にまとめ、件数・task id・outcome の内訳・配分評価の allocation × cause の内訳と未評価の数を出し、引用の外の1行に母集団の総数・組の数・引用した数・引用されなかった組ごとの件数を出す", () => {
  const { db, propose } = board();
  const overpowered = rowSession(db, OPUS_ROW, at);
  const underpowered = rowSession(db, OPUS_ROW, at);
  allocate(db, overpowered, "overpowered", "uncertain");
  allocate(db, underpowered, "underpowered", "capability");
  const lagoon = session(db, { workspace: "lagoon" });
  session(db, { workspace: "atoll" });
  session(db, { workspace: "shoal" });
  session(db, { workspace: "shoal" });

  const { question_id } = propose({ op: "row", row: OPUS_ROW, change: { tier: "frontier" }, evidence: [overpowered, underpowered, lagoon] });

  const lines = detailLines(db, question_id);
  for (const line of [
    "Evidence: 3 cited worker session(s), one line per tier source, agent, workspace, writer:",
    `- tier source task, agent deckhand, workspace reef, writer human: 2 session(s) (tasks ${taskOf(db, overpowered)}, ${taskOf(db, underpowered)}); outcomes 0 accepted, 1 rejected, 1 excluded; allocation reviews overpowered/uncertain 1, underpowered/capability 1; 0 session(s) not yet reviewed`,
    `- tier source task, agent deckhand, workspace lagoon, writer human: 1 session(s) (tasks ${taskOf(db, lagoon)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    `All production sessions on ${OPUS} in its current tier standard, over all time: 6 in 4 line(s), 3 cited; lines not cited: tier source task, agent deckhand, workspace atoll, writer human: 1; tier source task, agent deckhand, workspace shoal, writer human: 2.`,
  ]) {
    expect(lines).toContain(line);
  }
  expect(lines.at(-3)).toBe("Rationale: r");
});

it("段を足す提案の根拠は、移す行の今の段にある全行のその段の session を通し(組は session の軸から段を落とした組)、他の段の行の session と移す行が前の段にいた頃の session を拒む", () => {
  const { db, propose } = board();
  moveRow(db, OPUS_ROW, "frontier");
  const earlier = rowSession(db, OPUS_ROW, at);
  moveRow(db, OPUS_ROW, "standard");
  const opus = rowSession(db, OPUS_ROW, at);
  const sol = rowSession(db, SOL, at);
  session(db, { row: SOL, workspace: "lagoon" });
  const sonnet = rowSession(db, { ...OPUS_ROW, model: "claude-sonnet-5-5" }, at);
  const proposeWith = (evidence: number[]) => propose({ op: "add_tier", tier: "careful", description: "Careful work.", position: 2, row: OPUS_ROW, evidence });

  expect(() => proposeWith([sonnet])).toThrow(`evidence ${sonnet} ran on anthropic / claude-sonnet-5-5 at effort high, which is not a row of tier standard, the tier of ${OPUS}`);
  expect(() => proposeWith([earlier])).toThrow(`evidence ${earlier} ran in tier frontier, not in standard, the current tier of ${OPUS}`);
  const { question_id } = proposeWith([opus, sol]);

  const lines = detailLines(db, question_id);
  for (const line of [
    "Evidence: 2 cited worker session(s), one line per tier source, row, agent, workspace, writer:",
    `- tier source task, row ${OPUS}, agent deckhand, workspace reef, writer human: 1 session(s) (tasks ${taskOf(db, opus)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    `- tier source task, row openai / gpt-5.6-sol at effort high, agent deckhand, workspace reef, writer human: 1 session(s) (tasks ${taskOf(db, sol)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    "All production sessions on the rows of tier standard in that tier, over all time: 3 in 3 line(s), 2 cited; lines not cited: tier source task, row openai / gpt-5.6-sol at effort high, agent deckhand, workspace lagoon, writer human: 1.",
  ]) {
    expect(lines).toContain(line);
  }
});

it("agent の段の提案の根拠は、その agent の段の出所が agent の本番 session を全期間通し(組は session の軸から出所と agent を落とした組)、review 側の session・他の agent の session・出所が task の session を拒む", () => {
  const { db, review, propose } = board();
  const reviewSide = spawnOn(db, review, { source: "agent" });
  const scout = session(db, { agent: "scout", source: "agent" });
  const requested = rowSession(db, OPUS_ROW, at);
  const standard = session(db, { source: "agent" });
  const frontier = session(db, { tier: "frontier", row: { ...OPUS_ROW, model: "claude-fable-5-1" }, source: "agent" });
  session(db, { source: "agent", workspace: "lagoon" });
  const proposeWith = (evidence: number[]) => propose({ op: "agent_tier", agent: "deckhand", to: "economy", evidence });

  expect(() => proposeWith([reviewSide])).toThrow(`evidence ${reviewSide} is a session of a task of type review`);
  expect(() => proposeWith([scout])).toThrow(`evidence ${scout} is not a worker_spawned event of deckhand`);
  expect(() => proposeWith([requested])).toThrow(`evidence ${requested} took its tier from task, not from deckhand's default tier`);
  const { question_id } = proposeWith([standard, frontier]);

  const lines = detailLines(db, question_id);
  for (const line of [
    "Evidence: 2 cited worker session(s), one line per row, tier, workspace, writer:",
    `- row ${OPUS}, tier standard, workspace reef, writer human: 1 session(s) (tasks ${taskOf(db, standard)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    `- row anthropic / claude-fable-5-1 at effort high, tier frontier, workspace reef, writer human: 1 session(s) (tasks ${taskOf(db, frontier)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    `All production sessions of deckhand whose tier came from its default tier, over all time: 3 in 3 line(s), 2 cited; lines not cited: row ${OPUS}, tier standard, workspace lagoon, writer human: 1.`,
  ]) {
    expect(lines).toContain(line);
  }
});

it("段の説明の提案の根拠は、説明が最後に変わった後にその段を要求した task の出所 task の session に限り(位置だけの編集と改名は範囲を切らない)、組は session の軸から出所と段を落とした組(task の書き手を含む)で、書き手が人間の task も数える", () => {
  const { db, propose } = board();
  const before = rowSession(db, OPUS_ROW, at);
  const edited = applyExecutionSettingsChange(db, { setting: "edit_tier", name: "standard", description: "Work that needs a plan." }, "webui", at)!;
  const byHuman = rowSession(db, OPUS_ROW, at);
  applyExecutionSettingsChange(db, { setting: "edit_tier", name: "standard", position: 0 }, "webui", at);
  const byScout = session(db, { writer: ["scout", "mcp"] });
  const fromAgent = session(db, { source: "agent" });
  const otherRequest = session(db, { requested: "economy" });
  session(db, { workspace: "lagoon" });
  applyExecutionSettingsChange(db, { setting: "rename_tier", name: "standard", to: "planned" }, "webui", at);
  const proposeWith = (evidence: number[]) => propose({ op: "tier_description", tier: "planned", description: "Work that needs a written plan.", evidence });

  expect(() => proposeWith([before])).toThrow(`evidence ${before} ran before tier planned's description last changed (event ${edited})`);
  expect(() => proposeWith([fromAgent])).toThrow(`evidence ${fromAgent} took its tier from agent, not from its task's request`);
  expect(() => proposeWith([otherRequest])).toThrow(`evidence ${otherRequest} is a session of a task that did not request planned`);
  const { question_id } = proposeWith([byHuman, byScout]);

  const lines = detailLines(db, question_id);
  for (const line of [
    "Evidence: 2 cited worker session(s), one line per row, agent, workspace, writer:",
    `- row ${OPUS}, agent deckhand, workspace reef, writer human: 1 session(s) (tasks ${taskOf(db, byHuman)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    `- row ${OPUS}, agent deckhand, workspace reef, writer scout: 1 session(s) (tasks ${taskOf(db, byScout)}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`,
    `All production sessions of tasks that requested tier planned (tier source task), since its description last changed (event ${edited}): 3 in 3 line(s), 2 cited; lines not cited: row ${OPUS}, agent deckhand, workspace lagoon, writer human: 1.`,
  ]) {
    expect(lines).toContain(line);
  }
});

it("段の説明の提案の根拠の書き手は文面の書き手で、agent が decompose し人間が approve して実体化した子の session は登録者の human でなく分解した agent の組に入る", () => {
  const { db, propose } = board();
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c", workspace: "reef" }, at, ...HUMAN_WEBUI);
  const child = decomposedChild(db, parent, "child", "scout", at, "standard");
  const { question_id } = propose({ op: "tier_description", tier: "standard", description: "Work that needs a plan.", evidence: [spawnOn(db, child.id)] });

  const lines = detailLines(db, question_id);
  expect(lines).toContain(`- row ${OPUS}, agent deckhand, workspace reef, writer scout: 1 session(s) (tasks ${child.id}); outcomes 0 accepted, 0 rejected, 1 excluded; allocation reviews none; 1 session(s) not yet reviewed`);
  expect(lines.some((line) => line.includes("writer human"))).toBe(false);
});

it("worker_spawned でない event を根拠にすると、どの op も同じ1つの文で拒まれる(#2489)", () => {
  const { db, review, propose } = board();
  const registered = latestEventOfTask(db, review, "task_registered")!.id;
  const evidence = [registered];
  const reason = `evidence ${registered} is not a worker_spawned event`;

  const inputs: Array<Parameters<typeof propose>[0]> = [
    { op: "row", row: OPUS_ROW, change: { tier: "frontier" }, evidence },
    { op: "add_tier", tier: "careful", description: "Careful work.", position: 2, row: OPUS_ROW, evidence },
    { op: "interview", hypothesis: "h", tier: "standard", targets: [{ ...OPUS_ROW, effort: "max" }], workspace: "reef", evidence },
    { op: "agent_tier", agent: "deckhand", to: "economy", evidence },
    { op: "tier_description", tier: "standard", description: "Work that needs a plan.", evidence },
    { op: "promote", evidence },
  ];
  for (const input of inputs) {
    expect(() => propose(input)).toThrow(new DomainError(reason));
  }
  applyExecutionSettingsChange(db, { setting: "learner_promoted", value: true }, "webui", at);
  expect(() => propose({ op: "demote", evidence })).toThrow(new DomainError(reason));
});

it("routing repair の行の提案も根拠を要し、同じ母集団の検査を通って修理子の子の question になる", () => {
  const db = openDb(":memory:");
  let evidence: number[] = [];
  const { review, row } = judgedRoutingReview(db, at, () => (evidence = routedOpusSessions(db, at)));
  raiseObjection(db, row({ row: OPUS_ROW }), "move it to frontier", at);
  commitTriage(db, at);
  const repair = listChildren(db, review.id).find((child) => child.type === "routing_repair")!.id;
  const examinee = spawnOn(db, interviewExaminee(db, at).id);
  const propose = (cited?: number[]) => proposeRoutingChange(db, repair, { op: "row", row: OPUS_ROW, change: { tier: "frontier" }, evidence: cited, rationale: "r" }, "auditor", at);

  expect(() => propose()).toThrow(/op row names .* at least one evidence worker_spawned event id/);
  expect(() => propose([examinee])).toThrow(`evidence ${examinee} is not a worker_spawned event of a production work session: it is an Interview examinee's session`);
  const { question_id } = propose(evidence);

  expect(getTask(db, question_id)).toMatchObject({ parent_id: repair, question_proposal: { op: "row", evidence } });
  expect(detailLines(db, question_id)).toContain("Evidence: 2 cited worker session(s), one line per tier source, agent, workspace, writer:");
});

it("説明が一度も変わっていない段の説明の提案は、全期間の session を母集団にする", () => {
  const { db, propose } = board();
  const cited = rowSession(db, OPUS_ROW, at);

  const { question_id } = propose({ op: "tier_description", tier: "standard", description: "Work that needs a plan.", evidence: [cited] });

  expect(detailLines(db, question_id)).toContain(
    "All production sessions of tasks that requested tier standard (tier source task), over all time (its description never changed): 1 in 1 line(s), 1 cited; lines not cited: none.",
  );
});

it("今と同じ説明に位置の変更を添えた段の編集は、説明の変更ではないので段の説明の提案の範囲を切らない", () => {
  const { db, propose } = board();
  const cited = rowSession(db, OPUS_ROW, at);
  const standard = readTiers(db).find((tier) => tier.name === "standard")!;
  applyExecutionSettingsChange(db, { setting: "edit_tier", name: "standard", description: standard.description, position: 0 }, "webui", at);

  const { question_id } = propose({ op: "tier_description", tier: "standard", description: "Work that needs a plan.", evidence: [cited] });

  expect(detailLines(db, question_id)).toContain(
    "All production sessions of tasks that requested tier standard (tier source task), over all time (its description never changed): 1 in 1 line(s), 1 cited; lines not cited: none.",
  );
});

it("Interview の提案の detail は根拠を session の6軸の組ごとに1行にまとめ、引用の外は根拠の行の session だけを数える", () => {
  const { db, propose } = board();
  const cited = rowSession(db, OPUS_ROW, at);
  allocate(db, cited, "underpowered", "capability");
  session(db, { workspace: "lagoon" });
  rowSession(db, SOL, at);

  const { question_id } = propose({ op: "interview", hypothesis: "h", tier: "standard", targets: [{ ...OPUS_ROW, effort: "max" }], workspace: "reef", evidence: [cited] });

  const lines = detailLines(db, question_id);
  for (const line of [
    `Rows the evidence ran on (pinned): ${OPUS} (standard)`,
    "Evidence: 1 cited worker session(s), one line per tier source, row, tier, agent, workspace, writer:",
    `- tier source task, row ${OPUS}, tier standard, agent deckhand, workspace reef, writer human: 1 session(s) (tasks ${taskOf(db, cited)}); outcomes 0 accepted, 1 rejected, 0 excluded; allocation reviews underpowered/capability 1; 0 session(s) not yet reviewed`,
    `All production sessions on the evidence rows in their current tiers, over all time: 2 in 2 line(s), 1 cited; lines not cited: tier source task, row ${OPUS}, tier standard, agent deckhand, workspace lagoon, writer human: 1.`,
  ]) {
    expect(lines).toContain(line);
  }
});
