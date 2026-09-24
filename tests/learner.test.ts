import { afterEach, expect, it } from "vitest";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { appendEvent, type EventPayload } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting } from "../src/execution-setting.js";
import { aggregateCells, episodeOutcome, type LearnerEpisode, recommend, selectorBranch } from "../src/learner.js";
import { listRoutingShadow } from "../src/routing-review.js";
import { healthyOpenai } from "./fakes.js";
import {
  bootTidepool,
  completeIntegrationReviews,
  completeMetaReviews,
  completeViaMcp,
  HOUR,
  loggedEntry,
  registerWork,
  type Tidepool,
} from "./harness.js";

/** selector が並べた候補(除外を当てた後)。表の綴り —— anthropic は alias 行。 */
const candidate = (
  provider: ExecutionSetting["provider"],
  model: string,
  advisor: string | undefined = undefined,
): ExecutionSetting => ({
  provider,
  model,
  effort: "high",
  advisor,
  source: { tier: "task", provider: "rank" },
});
const opus = candidate("anthropic", "opus");
const sol = candidate("openai", "gpt-5.6-sol");

/** 観測された episode の既定形。テストが言いたい1点だけを上書きする。 */
function episode(overrides: Partial<LearnerEpisode> = {}): LearnerEpisode {
  return {
    cell: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: null },
    workspace: "tidepool",
    outcome: "accepted",
    cost_usd: null,
    duration_ms: null,
    ...overrides,
  };
}

/** 盤面全体の episode 列から、この workspace 向けの推薦を1回引く。 */
function recommendFor(episodes: LearnerEpisode[], candidates: ExecutionSetting[], workspace = "tidepool", priority: "quality" | "cost" = "quality") {
  return recommend({
    candidates,
    board: aggregateCells(episodes),
    workspace: aggregateCells(episodes.filter((e) => e.workspace === workspace)),
    priority,
  });
}

it("データの無いセルでは推薦が表(selector の先頭)と一致し、出所は prior(AC1)", () => {
  expect(recommendFor([], [opus, sol])).toEqual({ recommended: opus, basis: "prior" });
  expect(recommendFor([], [sol, opus])).toEqual({ recommended: sol, basis: "prior" });
});

it("観測された具体 id は表の alias 行に当たり、受理されなかった行は表の並びより下がる —— 出所は data", () => {
  const rejected = episode({ cell: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: null }, outcome: "rejected" });
  expect(recommendFor([rejected], [opus, sol])).toEqual({ recommended: sol, basis: "data" });
});

it("受理1件では表の並びを追い越さない —— 表の行は受理1件分の疑似観測で、少データでも表より悪くならない(ADR 0110 決定4)", () => {
  const accepted = episode({ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null } });
  expect(recommendFor([accepted], [opus, sol])).toEqual({ recommended: opus, basis: "data" });
  // 表の行に反する観測が積もれば追い越す: opus が 1勝1敗(2/3)、sol は 3勝0敗(4/4)
  const mixed = [
    episode({ outcome: "accepted" }),
    episode({ outcome: "rejected" }),
    accepted,
    accepted,
    accepted,
  ];
  expect(recommendFor(mixed, [opus, sol]).recommended).toEqual(sol);
});

it("同じ episode 列を与えると同じ推薦を返し、並び順にも依らない(AC2: 乱数を持たない)", () => {
  const episodes = [
    episode({ outcome: "rejected" }),
    episode({ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null }, outcome: "accepted" }),
    episode({ outcome: "accepted", workspace: "other" }),
    episode({ outcome: "excluded" }),
  ];
  const first = recommendFor(episodes, [opus, sol]);
  expect(recommendFor(episodes, [opus, sol])).toEqual(first);
  expect(recommendFor([...episodes].reverse(), [opus, sol])).toEqual(first);
});

it("盤面全体の事後分布が workspace の事前分布 —— 自分の workspace の観測が他所の観測より重く、観測の無い workspace は盤面の事後分布に従う", () => {
  const opusCell = { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: null } as const;
  const solCell = { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null } as const;
  const episodes = [
    ...Array.from({ length: 3 }, () => episode({ cell: opusCell, workspace: "other", outcome: "rejected" })),
    ...Array.from({ length: 3 }, () => episode({ cell: opusCell, workspace: "tidepool", outcome: "accepted" })),
    episode({ cell: solCell, workspace: "other", outcome: "accepted" }),
    episode({ cell: solCell, workspace: "other", outcome: "rejected" }),
  ];
  expect(recommendFor(episodes, [opus, sol], "tidepool").recommended).toEqual(opus);
  expect(recommendFor(episodes, [opus, sol], "other").recommended).toEqual(sol);
  expect(recommendFor(episodes, [opus, sol], "fresh").recommended).toEqual(sol);
});

it("受理率が同点のときだけ、cost の要求では観測された session 費用の平均が鍵になる —— 両方に観測があるときに限り、quality では selector の並びのまま", () => {
  const cheapSol = episode({ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null }, cost_usd: 0.5 });
  const pricyOpus = episode({ cost_usd: 2 });
  expect(recommendFor([cheapSol, pricyOpus], [opus, sol], "tidepool", "cost").recommended).toEqual(sol);
  expect(recommendFor([cheapSol, pricyOpus], [opus, sol], "tidepool", "quality").recommended).toEqual(opus);
  // opus 側に費用の観測が無ければ比べられない —— 表の並びに戻る
  expect(recommendFor([cheapSol, episode()], [opus, sol], "tidepool", "cost").recommended).toEqual(opus);
});

it("selector の分岐: 昇格前は表の先頭が走り shadow の推薦が学習器、昇格後は学習器の選択が出所 learner で走り shadow の推薦が表の先頭", () => {
  const rejected = [episode({ outcome: "rejected" }), episode({ outcome: "rejected" })];
  const branch = (promoted: boolean) =>
    selectorBranch({ promoted, candidates: [opus, sol], board: aggregateCells(rejected), workspace: aggregateCells(rejected), priority: "quality" });
  const learnerSol = { ...sol, source: { ...sol.source, provider: "learner" } };

  expect(branch(false)).toEqual({ chosen: opus, shadow: { recommended: sol, actual: opus, basis: "data" } });
  expect(branch(true)).toEqual({ chosen: learnerSol, shadow: { recommended: opus, actual: learnerSol, basis: "data" } });
});

it("昇格後もデータの無いセルでは学習器の選択が表の先頭と一致する —— 昇格初日は表と同じ(出所だけが learner)", () => {
  const { chosen, shadow } = selectorBranch({ promoted: true, candidates: [opus, sol], board: [], workspace: [], priority: "quality" });
  expect(chosen).toEqual({ ...opus, source: { ...opus.source, provider: "learner" } });
  expect(shadow).toEqual({ recommended: opus, actual: chosen, basis: "prior" });
});

it("outcome は受理 = 統合点レビューがすべて完了、負 = capability の帰責か underpowered × capability の配分評価、それ以外は数えない(ADR 0115 決定5)", () => {
  const facts = { accepted: false, causes: [] as const, allocations: [] as const };
  expect(episodeOutcome({ ...facts, accepted: true })).toBe("accepted");
  expect(episodeOutcome(facts)).toBe("excluded");
  expect(episodeOutcome({ ...facts, accepted: true, causes: ["capability"] })).toBe("rejected");
  expect(episodeOutcome({ ...facts, causes: ["preference", "requirement_change", "environment", "uncertain"] })).toBe("excluded");
  expect(episodeOutcome({ ...facts, allocations: [{ allocation: "underpowered", cause: "capability" }] })).toBe("rejected");
  expect(episodeOutcome({ ...facts, accepted: true, allocations: [{ allocation: "underpowered", cause: "environment" }] })).toBe("accepted");
  expect(episodeOutcome({ ...facts, accepted: true, allocations: [{ allocation: "overpowered", cause: "capability" }] })).toBe("accepted");
  // reviewer が複数なら配分評価も session に複数並ぶ(ADR 0111 決定2)—— 1つでも負なら負
  expect(
    episodeOutcome({
      ...facts,
      accepted: true,
      allocations: [
        { allocation: "underpowered", cause: "capability" },
        { allocation: "appropriate", cause: "uncertain" },
      ],
    }),
  ).toBe("rejected");
});

it("advisor pin ありの episode は advisor 無しのセルに合流しない —— 相談回数ではなく pin がセルを割る(AC4)", () => {
  const opusWithAdvisor = candidate("anthropic", "opus", "fable");
  // pin あり・相談0回で受理されなかった session。pin が同じセルだけが下がる
  const pinnedRejected = episode({
    cell: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: "fable" },
    outcome: "rejected",
  });
  expect(recommendFor([pinnedRejected], [opus, sol])).toEqual({ recommended: opus, basis: "prior" });
  expect(recommendFor([pinnedRejected], [opusWithAdvisor, sol])).toEqual({ recommended: sol, basis: "data" });
});

/* ------------------------------------------------------------------ *
 * 盤面境界: pickup ごとの shadow 行(選択には介入しない)。行は routing meta-review の
 * 読み口(listRoutingShadow)で読む。
 * ------------------------------------------------------------------ */

let t: Tidepool;
afterEach(() => t?.stop());

const shadowRows = (t: Tidepool) =>
  listRoutingShadow(t.db, "", { since_watermark: 0 }).shadow.map(({ task_id, recommended, actual, source, basis }) => ({ task_id, recommended, actual, source, basis }));

it("work task の pickup ごとに shadow 行が1件記録され、selector の選択は変わらない —— review task では学習器を参照せず行も無い", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
  const work = await registerWork(t, "learned");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings).toEqual([opus]);
  const cell = { provider: "anthropic", model: "opus", effort: "high", advisor: null };
  expect(shadowRows(t)).toEqual([
    { task_id: work.id, recommended: cell, actual: cell, source: opus.source, basis: "prior" },
  ]);

  // 完了で統合点レビュー(review task)が生まれ、次の poll で pickup される
  await completeViaMcp(t, work.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.type)).toEqual(["work", "review"]);
  expect(shadowRows(t)).toHaveLength(1);
});

/** opus の session が1つ capability と帰責された盤面にする —— 学習器は opus を下げ、sol を推薦するようになる。 */
async function rejectOpusSession(t: Tidepool) {
  const earlier = await registerWork(t, "earlier");
  await t.clock.advance(HOUR);
  // ScriptedWorker は spawn しないので、その session の記録(spawn + 決定 + 帰責)を setup として置く
  const spawnedId = appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_spawned",
      registry_commit: "commit",
      definition_version: "1",
      advisor: null,
      provider: "anthropic",
      model: "opus",
      effort: "high",
      source: { tier: "board", provider: "rank" },
      harness: "claude-code",
      cli_version: "1",
    },
  });
  const entry = await loggedEntry(t, earlier.id, "took the shortcut");
  expect(entry.id).toBeGreaterThan(spawnedId);
  const attributed: EventPayload = {
    kind: "objection_attributed",
    entry_id: entry.id,
    objection_event_ids: [],
    cause: "capability",
    evidence: "the shortcut missed the second criterion",
    round: "initial",
  };
  appendEvent(t.db, { taskId: earlier.id, workerId: "board", origin: "board", at: t.clock.now(), payload: attributed });
  await completeViaMcp(t, earlier.id);
  await completeIntegrationReviews(t, earlier.id);
  await completeMetaReviews(t);

}

it("観測が効くと shadow 行は selector と乖離しうるが、選択は変わらない —— capability と帰責された session の行が下がり、出所は data", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
  await rejectOpusSession(t);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings.at(-1)).toEqual(opus);
  expect(shadowRows(t).at(-1)).toEqual({
    task_id: later.id,
    recommended: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null },
    actual: { provider: "anthropic", model: "opus", effort: "high", advisor: null },
    source: opus.source,
    basis: "data",
  });
});

it("advisor pin ありで相談0回の session は、盤面の記録から読んでも advisor 無しのセルに合流しない —— 観測された具体 id も alias 行に当たる(AC4)", async () => {
  const opusWithAdvisor = candidate("anthropic", "opus", "fable");
  t = await bootTidepool({ taskExecutionCandidates: () => [opusWithAdvisor, opus] });
  const earlier = await registerWork(t, "earlier");
  await t.clock.advance(HOUR);
  // ScriptedWorker は spawn しないので、その session の記録(pin あり spawn + 帰責 + 相談0回の exit)を setup として置く
  const spawnedId = appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_spawned",
      registry_commit: "commit",
      definition_version: "1",
      advisor: "fable",
      provider: "anthropic",
      model: "opus",
      effort: "high",
      source: { tier: "board", provider: "rank" },
      harness: "claude-code",
      cli_version: "1",
    },
  });
  const entry = await loggedEntry(t, earlier.id, "took the shortcut");
  const attributed: EventPayload = {
    kind: "objection_attributed",
    entry_id: entry.id,
    objection_event_ids: [],
    cause: "capability",
    evidence: "the shortcut missed the second criterion",
    round: "initial",
  };
  appendEvent(t.db, { taskId: earlier.id, workerId: "board", origin: "board", at: t.clock.now(), payload: attributed });
  const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5 };
  appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      stderr_tail: null,
      worker_spawned_event_id: spawnedId,
      usage: { ...tokens, advisor: null, models: { "claude-opus-4-1": tokens } },
    },
  });
  await completeViaMcp(t, earlier.id);
  await completeIntegrationReviews(t, earlier.id);
  await completeMetaReviews(t);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings.at(-1)).toEqual(opusWithAdvisor);
  expect(shadowRows(t).at(-1)).toMatchObject({
    task_id: later.id,
    recommended: { provider: "anthropic", model: "opus", effort: "high", advisor: null },
    actual: { provider: "anthropic", model: "opus", effort: "high", advisor: "fable" },
    basis: "data",
  });
});

it("セルの model は観測された具体 id —— pin が alias でも、人間が足した具体 id の行に観測が当たる", async () => {
  const opus41 = candidate("anthropic", "claude-opus-4-1");
  t = await bootTidepool({ taskExecutionCandidates: () => [opus41, sol] });
  const earlier = await registerWork(t, "earlier");
  await t.clock.advance(HOUR);
  // pin は alias の opus、CLI が報告した具体 id は claude-opus-4-1(ScriptedWorker は spawn しないので setup として置く)
  const spawnedId = appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_spawned",
      registry_commit: "commit",
      definition_version: "1",
      advisor: null,
      provider: "anthropic",
      model: "opus",
      effort: "high",
      source: { tier: "board", provider: "rank" },
      harness: "claude-code",
      cli_version: "1",
    },
  });
  const entry = await loggedEntry(t, earlier.id, "took the shortcut");
  const attributed: EventPayload = {
    kind: "objection_attributed",
    entry_id: entry.id,
    objection_event_ids: [],
    cause: "capability",
    evidence: "the shortcut missed the second criterion",
    round: "initial",
  };
  appendEvent(t.db, { taskId: earlier.id, workerId: "board", origin: "board", at: t.clock.now(), payload: attributed });
  const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5 };
  appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      stderr_tail: null,
      worker_spawned_event_id: spawnedId,
      usage: { ...tokens, advisor: null, models: { "claude-opus-4-1": tokens } },
    },
  });
  await completeViaMcp(t, earlier.id);
  await completeIntegrationReviews(t, earlier.id);
  await completeMetaReviews(t);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  // pin の綴り(opus)のままなら claude-opus-4-1 の行に当たらず、推薦は表の先頭のまま
  expect(t.worker.startedSettings.at(-1)).toEqual(opus41);
  expect(shadowRows(t).at(-1)).toMatchObject({
    task_id: later.id,
    recommended: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null },
    basis: "data",
  });
});

/** 学習器を昇格させる —— approve の適用と同じ書き口。設定の変更は routing meta-review の材料なので、登録されたそれを先に済ませる。 */
async function promote(t: Tidepool) {
  applyExecutionSettingsChange(t.db, { setting: "learner_promoted", value: true }, "webui", t.clock.now());
  await t.clock.advance(HOUR);
  await completeMetaReviews(t);
}
const byLearner = (s: ExecutionSetting): ExecutionSetting => ({ ...s, source: { ...s.source, provider: "learner" } });
const cellOf = (s: ExecutionSetting) => ({ provider: s.provider, model: s.model, effort: s.effort, advisor: null });
/** task が pickup されたときの実行設定(設定の変更は routing meta-review の材料なので、それが先に slot を取りうる)。 */
const settingsOf = (t: Tidepool, taskId: string) => t.worker.startedSettings[t.worker.started.findIndex((task) => task.id === taskId)];

it("昇格中の work task は学習器の選択で走り出所は learner、shadow 行は表の選択を推薦に・学習器の選択を実際に持つ —— review task は表のまま", async () => {
  t = await bootTidepool({ openaiUsage: healthyOpenai, taskExecutionCandidates: () => [opus, sol] });
  await promote(t);
  await rejectOpusSession(t);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(settingsOf(t, later.id)).toEqual(byLearner(sol));
  expect(shadowRows(t).at(-1)).toEqual({
    task_id: later.id,
    recommended: cellOf(opus),
    actual: cellOf(sol),
    source: byLearner(sol).source,
    basis: "data",
  });

  await completeViaMcp(t, later.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.at(-1)).toMatchObject({ type: "review", parent_id: later.id });
  expect(t.worker.startedSettings.at(-1)).toEqual(opus);
});

it("昇格中も学習器の選択は Throttle の除外を通る —— 選んだ Provider が throttle 中なら除外を当てた残りから選び直す", async () => {
  const throttledOpenai = async (now: Date): Promise<CodexAppServerProbeResult> => ({
    status: "observed",
    provider: "openai",
    cliVersion: "codex-cli 0.147.0",
    plan: "plus",
    windows: [{ name: "primary", model: null, usedPercent: 100, durationMs: 5 * HOUR, resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString() }],
  });
  t = await bootTidepool({ openaiUsage: throttledOpenai, taskExecutionCandidates: () => [opus, sol] });
  await promote(t);
  await rejectOpusSession(t);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(settingsOf(t, later.id)).toEqual(byLearner(opus));
  expect(shadowRows(t).at(-1)).toMatchObject({ task_id: later.id, recommended: cellOf(opus), actual: cellOf(opus) });
});
