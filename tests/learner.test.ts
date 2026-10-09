import { afterEach, expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { appendEvent, type EventPayload } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting } from "../src/execution-setting.js";
import { episodeOutcome, type LearnerEpisode, loadEpisodes, observedInTier, recommend, selectorBranch } from "../src/learner.js";
import { listRoutingShadow } from "../src/routing-review.js";
import { type Tier, tierIdOf } from "../src/tier.js";
import { healthyOpenai, listedOpenaiModels } from "./fakes.js";
import {
  api,
  bootTidepool,
  bundledObjection,
  completeIntegrationReviews,
  completeMetaReviews,
  completeViaMcp,
  executionSetting,
  HOUR,
  loggedEntry,
  QUIET_EXIT,
  registerWork,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

const opus = executionSetting("anthropic", "claude-opus-5-5");
const sol = executionSetting("openai", "gpt-5.6-sol");

/** 観測された episode の既定形。テストが言いたい1点だけを上書きする。 */
function episode(overrides: Partial<LearnerEpisode> = {}): LearnerEpisode {
  return {
    cell: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: null },
    tier_id: 1,
    workspace: "tidepool",
    outcome: "accepted",
    cost_usd: null,
    duration_ms: null,
    ...overrides,
  };
}

/** sol の行に当たる受理された episode(2番目の候補に観測を持たせる)。 */
const solAccepted = episode({ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null } });

/** 盤面全体の episode 列から、この workspace 向けの selector の分岐を1回引く。 */
function branchFor(episodes: LearnerEpisode[], candidates: ExecutionSetting[], promoted: boolean, workspace = "tidepool") {
  return selectorBranch({ promoted, candidates, ...observedInTier(episodes, candidates[0]!.tier_id, workspace) });
}

/** 盤面全体の episode 列から、この workspace 向けの推薦を1回引く。 */
function recommendFor(episodes: LearnerEpisode[], candidates: ExecutionSetting[], workspace = "tidepool") {
  return recommend({ candidates, ...observedInTier(episodes, candidates[0]!.tier_id, workspace) });
}

it("データの無いセルでは推薦が表(selector の先頭)と一致し、basis は prior(AC1)", () => {
  expect(recommendFor([], [opus, sol])).toEqual({ recommended: opus, basis: "prior" });
  expect(recommendFor([], [sol, opus])).toEqual({ recommended: sol, basis: "prior" });
});

it("セルは綴りの一致する表の行に当たり、受理されなかった行は観測のある候補より下がる —— basis は data", () => {
  const rejected = episode({ outcome: "rejected" });
  expect(recommendFor([rejected, solAccepted], [opus, sol])).toEqual({ recommended: sol, basis: "data" });
});

it("先頭に 100 受理 / 1 却下、2番目が未観測なら推薦は先頭 —— 学習器は未観測の候補へ移らず、昇格の前後とも先頭が走る(ADR 0181 決定1)", () => {
  const episodes = [...Array.from({ length: 100 }, () => episode()), episode({ outcome: "rejected" })];
  expect(recommendFor(episodes, [opus, sol])).toEqual({ recommended: opus, basis: "data" });
  expect(branchFor(episodes, [opus, sol], false)).toMatchObject({ chosen: opus, shadow: { recommended: opus, actual: opus } });
  expect(branchFor(episodes, [opus, sol], true)).toMatchObject({ chosen: byLearner(opus), shadow: { recommended: opus, actual: byLearner(opus) } });
});

it("先頭が未観測なら、ほかの候補に観測があっても推薦は先頭 —— basis は data のまま、昇格の前後とも先頭が走る(ADR 0181 決定2)", () => {
  expect(recommendFor([solAccepted], [opus, sol])).toEqual({ recommended: opus, basis: "data" });
  expect(branchFor([solAccepted], [opus, sol], false)).toMatchObject({ chosen: opus, shadow: { recommended: opus, actual: opus } });
  expect(branchFor([solAccepted], [opus, sol], true)).toMatchObject({ chosen: byLearner(opus), shadow: { recommended: opus, actual: byLearner(opus) } });
});

it("候補が3行で先頭に却下、2番目が未観測、3番目に却下の無い観測があれば推薦は3番目 —— 未観測の候補は飛ばす", () => {
  const sonnet = executionSetting("anthropic", "claude-sonnet-4-5");
  const episodes = [
    episode({ outcome: "rejected" }),
    episode({ cell: { provider: "anthropic", model: "claude-sonnet-4-5", effort: "high", advisor: null } }),
  ];
  expect(recommendFor(episodes, [opus, sol, sonnet])).toEqual({ recommended: sonnet, basis: "data" });
});

it("受理1件では表の並びを追い越さない —— 表の行は受理1件分の疑似観測で、少データでも表より悪くならない(ADR 0110 決定4)", () => {
  const accepted = episode({ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null } });
  expect(recommendFor([episode(), accepted], [opus, sol])).toEqual({ recommended: opus, basis: "data" });
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

it("先頭の観測が移る先より少ないあいだは却下数で比べる —— 0 受理 / 1 却下の先頭は 100 / 1 の相手に移らず、却下が2件で移り、相手に却下が並べば戻る(ADR 0182 決定4)", () => {
  const solEpisodes = (accepted: number, rejected: number) => [
    ...Array.from({ length: accepted }, () => solAccepted),
    ...Array.from({ length: rejected }, () => ({ ...solAccepted, outcome: "rejected" as const })),
  ];
  const headRejected = episode({ outcome: "rejected" });
  expect(recommendFor([headRejected, ...solEpisodes(100, 1)], [opus, sol]).recommended).toEqual(opus);
  expect(recommendFor([headRejected, headRejected, ...solEpisodes(100, 1)], [opus, sol]).recommended).toEqual(sol);
  expect(recommendFor([headRejected, headRejected, ...solEpisodes(100, 2)], [opus, sol]).recommended).toEqual(opus);
});

it("先頭の観測が移る先以上なら事後平均の比較 —— 101 / 1 の先頭は 2 / 0 の相手へ移る(ADR 0181 決定3)", () => {
  const episodes = [...Array.from({ length: 101 }, () => episode()), episode({ outcome: "rejected" }), solAccepted, solAccepted];
  expect(recommendFor(episodes, [opus, sol]).recommended).toEqual(sol);
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
  const opusCell = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: null } as const;
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

/** 費用を報告する claude-code harness の2行(codex は報告しない)—— 両方に費用の観測が付く、本番で同点の起きうる組(#1250)。kimi が安い。 */
const kimi = executionSetting("moonshot", "kimi-k3");
const cheapKimi = episode({ cell: { provider: "moonshot", model: "kimi-k3", effort: "high", advisor: null }, cost_usd: 0.5 });
const pricyOpus = episode({ cost_usd: 2 });

it("事後平均が同点なら、両方に費用の観測があっても推薦は先頭 —— 観測された session 費用は推薦の鍵にならない(ADR 0183)", () => {
  expect(recommendFor([cheapKimi, pricyOpus], [opus, kimi]).recommended).toEqual(opus);
});

it("両者無傷で相手が安いまま受理を積んでも、推薦はずっと先頭 —— 先頭 5/0・相手 3/0 から 7/0・8/0 まで pickup ごとに入れ替わらない(#1250)", () => {
  const steps: [number, number][] = [[5, 3], [5, 4], [5, 5], [5, 6], [6, 6], [6, 7], [7, 7], [7, 8]];
  for (const [head, other] of steps) {
    const episodes = [...Array.from({ length: head }, () => pricyOpus), ...Array.from({ length: other }, () => cheapKimi)];
    expect(recommendFor(episodes, [opus, kimi]).recommended, `${head}/0 vs ${other}/0`).toEqual(opus);
  }
});

it("selector の分岐: 両方に観測があり2番目が上なら、昇格前は表の先頭が走り shadow の推薦が学習器、昇格後は学習器の選択が出所 learner で走り shadow の推薦が表の先頭", () => {
  const episodes = [episode({ outcome: "rejected" }), episode({ outcome: "rejected" }), solAccepted];
  const learnerSol = { ...sol, source: { ...sol.source, provider: "learner" } };

  expect(branchFor(episodes, [opus, sol], false)).toMatchObject({ chosen: opus, shadow: { recommended: sol, actual: opus, basis: "data" } });
  expect(branchFor(episodes, [opus, sol], true)).toMatchObject({ chosen: learnerSol, shadow: { recommended: opus, actual: learnerSol, basis: "data" } });
});

it("shadow の組は推薦したセルと走ったセルの実績(盤面の段と workspace の段、疑似観測なし)と候補数を持つ —— 昇格後は役割が反転しても実績はセルに付いて回る(ADR 0181 決定5)", () => {
  // opus: tidepool で却下1件・他所で受理1件、sol: tidepool で受理1件、除外は数えない
  const episodes = [episode({ outcome: "rejected" }), episode({ workspace: "other" }), episode({ outcome: "excluded" }), solAccepted];
  const opusRecord = { board: { accepted: 1, rejected: 1 }, workspace: { accepted: 0, rejected: 1 } };
  const solRecord = { board: { accepted: 1, rejected: 0 }, workspace: { accepted: 1, rejected: 0 } };

  expect(branchFor(episodes, [opus, sol], false).shadow).toMatchObject({ recommended: sol, recommended_record: solRecord, actual_record: opusRecord, candidates: 2 });
  expect(branchFor(episodes, [opus, sol], true).shadow).toMatchObject({ recommended: opus, recommended_record: opusRecord, actual_record: solRecord, candidates: 2 });
  expect(branchFor([], [opus], false).shadow).toMatchObject({
    recommended_record: { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 } },
    candidates: 1,
  });
});

it("昇格後もどの候補にも観測が無ければ学習器の選択は表の先頭と一致する —— basis は prior で、出所の provider だけが learner", () => {
  const { chosen, shadow } = selectorBranch({ promoted: true, candidates: [opus, sol], board: [], workspace: [] });
  expect(chosen).toEqual({ ...opus, source: { ...opus.source, provider: "learner" } });
  expect(shadow).toMatchObject({ recommended: opus, actual: chosen, basis: "prior" });
});

it("outcome は受理 = 統合点レビューがすべて完了、負 = capability の帰責か underpowered × capability の配分評価、それ以外は数えない(ADR 0115 決定5)", () => {
  const facts = { accepted: false, causes: [] as const, allocations: [] as const, swapped: false };
  expect(episodeOutcome({ ...facts, accepted: true })).toBe("accepted");
  expect(episodeOutcome(facts)).toBe("excluded");
  expect(episodeOutcome({ ...facts, accepted: true, causes: ["capability"] })).toBe("rejected");
  expect(episodeOutcome({ ...facts, causes: ["preference", "requirement_change", "environment", "memory", "uncertain"] })).toBe("excluded");
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
  const opusWithAdvisor = executionSetting("anthropic", "claude-opus-5-5", { advisor: "claude-fable-5-1" });
  // pin あり・相談0回で受理されなかった session。pin が同じセルだけが下がる
  const pinnedRejected = episode({
    cell: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: "claude-fable-5-1" },
    outcome: "rejected",
  });
  // 合流すれば opus 行に却下が付いて観測のある sol へ移る
  expect(recommendFor([pinnedRejected, solAccepted], [opus, sol])).toEqual({ recommended: opus, basis: "data" });
  expect(recommendFor([pinnedRejected, solAccepted], [opusWithAdvisor, sol])).toEqual({ recommended: sol, basis: "data" });
});

/* ------------------------------------------------------------------ *
 * 盤面境界: pickup ごとの shadow 行(選択には介入しない)。行は routing meta-review の
 * 読み口(listRoutingShadow)で読む。
 * ------------------------------------------------------------------ */

let t: Tidepool;
afterEach(() => t?.stop());

/** ScriptedWorker は spawn しないので、その session の開始を setup として置く。 */
const recordSpawn = (taskId: string) =>
  appendEvent(t.db, { taskId, workerId: "fake-worker", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });

const shadowRows = (t: Tidepool) =>
  listRoutingShadow(t.db, "", { since_watermark: 0 }).shadow.map(({ task_id, recommended, actual, source, basis, candidates }) => ({ task_id, recommended, actual, source, basis, candidates }));

it("work task の pickup ごとに shadow 行が1件記録され、selector の選択は変わらない —— review task では学習器を参照せず行も無い", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
  const work = await registerWork(t, "learned");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings).toEqual([opus]);
  const cell = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: null };
  expect(shadowRows(t)).toEqual([
    { task_id: work.id, recommended: cell, actual: cell, source: opus.source, basis: "prior", candidates: 2 },
  ]);

  // 完了で統合点レビュー(review task)が生まれ、次の poll で pickup される
  await completeViaMcp(t, work.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.type)).toEqual(["work", "review"]);
  expect(shadowRows(t)).toHaveLength(1);
});

/** `run` で走って完了した session がある盤面にする。`causes` を渡すとその session の1つの entry が異議群ごとに
 *  `causes` と帰責される —— capability があれば学習器はその行を下げる。渡さなければ受理された観測になる —— 学習器は
 *  未観測の候補へ移らない(ADR 0181)ので、移る先に観測を置くのに使う。 */
async function settledSession(t: Tidepool, run: ExecutionSetting, causes: Cause[] = []) {
  const earlier = await registerWork(t, "earlier");
  await t.clock.advance(HOUR);
  // ScriptedWorker は spawn しないので、その session の記録(spawn + 決定 + 帰責)を setup として置く
  const spawnedId = appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: { ...WORKER_SPAWNED, advisor: null, provider: run.provider, model: run.model, effort: run.effort, tier_id: run.tier_id },
  });
  if (causes.length > 0) {
    const entry = await loggedEntry(t, earlier.id, "took the shortcut");
    expect(entry.id).toBeGreaterThan(spawnedId);
    for (const [i, cause] of causes.entries()) {
      const objectionId = bundledObjection(t.db, earlier.id, entry.id, t.clock.now(), `objection ${i}`);
      const attributed: EventPayload = {
        kind: "objection_attributed",
        entry_id: entry.id,
        objection_event_ids: [objectionId],
        cause,
        evidence: "the shortcut missed the second criterion",
        entries: null,
        round: "initial",
      };
      appendEvent(t.db, { taskId: earlier.id, workerId: "board", origin: "board", at: t.clock.now(), payload: attributed });
    }
  }
  await completeViaMcp(t, earlier.id);
  await completeIntegrationReviews(t, earlier.id);
  await completeMetaReviews(t);
}

it("観測が効くと shadow 行は selector と乖離しうるが、選択は変わらない —— capability と帰責された session の行が下がり、basis は data", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
  await settledSession(t, opus, ["capability"]);
  await settledSession(t, sol);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings.at(-1)).toEqual(opus);
  expect(shadowRows(t).at(-1)).toEqual({
    task_id: later.id,
    recommended: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null },
    actual: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: null },
    source: opus.source,
    basis: "data",
    candidates: 2,
  });
});

it("同じ entry の前の異議群が capability、後の異議群が preference と帰責された session も負として数える —— 学習器は opus の行を下げる(ADR 0170 決定3)", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
  await settledSession(t, opus, ["capability", "preference"]);
  await settledSession(t, sol);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(shadowRows(t).at(-1)).toMatchObject({
    task_id: later.id,
    recommended: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null },
    basis: "data",
  });
});

it("行を段 T から T' へ settings で移すと T' の pickup の shadow 行は未観測(prior)、T へ戻すと T の観測がまた数えられて data に戻る(ADR 0210 決定2)", async () => {
  t = await bootTidepool();
  // 動かすのは standard の opus の行 —— 盤面既定の economy には sonnet の行が残り、統合点レビューはそこで走る
  const key = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" } as const;
  // standard の opus の行で走り、受理された session
  await settledSession(t, executionSetting(key.provider, key.model, { tier_id: tierIdOf(t.db, "standard") }));
  const moveTo = async (tier: Tier) => {
    applyExecutionSettingsChange(t.db, { setting: "row", key, row: { ...key, tier, price_in: 5, price_out: 25 } }, "webui", t.clock.now());
    await t.clock.advance(HOUR);
    await completeMetaReviews(t);
  };
  const pickupIn = async (tier: Tier) => {
    const task = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", title: `in ${tier}`, purpose: "p", completion_criteria: "c", tier })).json;
    await t.clock.advance(HOUR);
    const row = shadowRows(t).find((r) => r.task_id === task.id);
    // slot を空ける(ScriptedWorker は spawn しないので episode は増えない)
    await completeViaMcp(t, task.id);
    await completeIntegrationReviews(t, task.id);
    return row;
  };

  // economy の候補は sonnet(先頭)と移ってきた opus —— opus の standard の受理は数えない
  await moveTo("economy");
  expect(await pickupIn("economy")).toMatchObject({ basis: "prior", candidates: 2 });
  await moveTo("standard");
  expect(await pickupIn("standard")).toMatchObject({ actual: { ...key, advisor: null }, basis: "data" });
});

it("advisor pin ありで相談0回の session は、盤面の記録から読んでも advisor 無しのセルに合流しない(AC4)", async () => {
  const opusWithAdvisor = executionSetting("anthropic", "claude-opus-5-5", { advisor: "claude-fable-5-1" });
  t = await bootTidepool({ taskExecutionCandidates: () => [opusWithAdvisor, opus] });
  await settledSession(t, opus);
  const earlier = await registerWork(t, "earlier");
  await t.clock.advance(HOUR);
  // ScriptedWorker は spawn しないので、その session の記録(pin あり spawn + 帰責 + 相談0回の exit)を setup として置く
  const spawnedId = appendEvent(t.db, {
    taskId: earlier.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: { ...WORKER_SPAWNED, advisor: "claude-fable-5-1", provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  });
  const entry = await loggedEntry(t, earlier.id, "took the shortcut");
  const attributed: EventPayload = {
    kind: "objection_attributed",
    entry_id: entry.id,
    objection_event_ids: [bundledObjection(t.db, earlier.id, entry.id, t.clock.now())],
    cause: "capability",
    evidence: "the shortcut missed the second criterion",
    entries: null,
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
      ...QUIET_EXIT,
      worker_spawned_event_id: spawnedId,
      output_closed: true,
      usage: { ...tokens, advisor: null, model_swaps: [], refusals: [], models: { "claude-opus-5-5": tokens } },
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
    recommended: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: null },
    actual: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: "claude-fable-5-1" },
    basis: "data",
  });
});

it("行との照合は完全一致 —— 行 claude-opus-5 は claude-opus-5-5 のセルの却下を数えず、未観測の先頭のまま(ADR 0182 決定3)", () => {
  const opus5 = executionSetting("anthropic", "claude-opus-5");
  expect(recommendFor([episode({ outcome: "rejected" }), solAccepted], [opus5, sol])).toEqual({ recommended: opus5, basis: "data" });
});

it("effort「無い」の episode は1つのセルに集まり、表の行との照合は完全一致 —— 「無い」の行の候補には当たり、同じ model の high の行には当たらない(ADR 0218 決定5)", () => {
  const model = "claude-haiku-4-5-20251001";
  const noEffort = { provider: "anthropic", model, effort: null, advisor: null } as const;
  const episodes = [episode({ cell: noEffort, outcome: "rejected" }), episode({ cell: noEffort, outcome: "rejected" }), solAccepted];
  expect(observedInTier(episodes, 1, "tidepool").board).toContainEqual({ cell: noEffort, accepted: 0, rejected: 2 });
  expect(recommendFor(episodes, [executionSetting("anthropic", model, { effort: null }), sol])).toEqual({ recommended: sol, basis: "data" });
  const high = executionSetting("anthropic", model);
  expect(recommendFor(episodes, [high, sol])).toEqual({ recommended: high, basis: "data" });
});

it("同じセルの episode が段 T と T' に分かれていれば、T の候補の推薦は T の観測だけで決まる —— T' の却下は盤面の段でも workspace の段でも T の推薦を動かさない(ADR 0210 決定2)", () => {
  const rejectedInOther = (workspace: string) => episode({ tier_id: 2, workspace, outcome: "rejected" });
  // T(id 1)では opus が未観測の先頭なので推薦は opus —— T' の却下が数えられれば sol へ移る
  expect(recommendFor([solAccepted, rejectedInOther("elsewhere")], [opus, sol])).toEqual({ recommended: opus, basis: "data" });
  expect(recommendFor([solAccepted, rejectedInOther("tidepool")], [opus, sol])).toEqual({ recommended: opus, basis: "data" });
  // 同じ却下が T で起きていれば sol へ移る
  expect(recommendFor([solAccepted, episode({ outcome: "rejected" })], [opus, sol])).toEqual({ recommended: sol, basis: "data" });
  // T' の候補から見れば T' の却下だけが観測で、T の sol の受理は数えない —— 未観測の sol へは移らない
  const inOther = (s: ExecutionSetting) => ({ ...s, tier_id: 2 });
  expect(recommendFor([solAccepted, rejectedInOther("tidepool")], [inOther(opus), inOther(sol)])).toEqual({ recommended: inOther(opus), basis: "data" });
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
  await settledSession(t, opus, ["capability"]);
  await settledSession(t, sol);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(settingsOf(t, later.id)).toEqual(byLearner(sol));
  expect(shadowRows(t).at(-1)).toEqual({
    task_id: later.id,
    recommended: cellOf(opus),
    actual: cellOf(sol),
    source: byLearner(sol).source,
    basis: "data",
    candidates: 2,
  });

  await completeViaMcp(t, later.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.at(-1)).toMatchObject({ type: "review", parent_id: later.id });
  expect(t.worker.startedSettings.at(-1)).toEqual(opus);
});

it("昇格中も学習器の選択は Throttle の除外を通る —— 選んだ Provider が throttle 中なら除外を当てた残りから選び直し、shadow 行の候補数は除外後の行の数", async () => {
  const throttledOpenai = async (now: Date): Promise<CodexAppServerProbeResult> => ({
    status: "observed",
    provider: "openai",
    cliVersion: "codex-cli 0.147.0",
    plan: "plus",
    models: listedOpenaiModels,
    windows: [{ name: "primary", model: null, usedPercent: 100, durationMs: 5 * HOUR, resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString() }],
  });
  t = await bootTidepool({ openaiUsage: throttledOpenai, taskExecutionCandidates: () => [opus, sol] });
  await promote(t);
  await settledSession(t, opus, ["capability"]);
  await settledSession(t, sol);

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(settingsOf(t, later.id)).toEqual(byLearner(opus));
  // 候補数は除外を当てた後の行の数 —— openai が外れて opus の1行だけ
  expect(shadowRows(t).at(-1)).toMatchObject({ task_id: later.id, recommended: cellOf(opus), actual: cellOf(opus), candidates: 1 });
});

it("別タスクの entry への帰責は、id 窓が重なっても開いたままの session の episode に混ざらない —— cause はタスクの照合で決まる(loadEpisodes)", async () => {
  t = await bootTidepool();
  // A は完了しても session は開いたまま(exit も次の spawn も無い)。その後ろで B が spawn して帰責される —— A の id 窓は B の帰責を含む
  const a = await registerWork(t, "a");
  await t.clock.advance(HOUR);
  const aSpawnedId = recordSpawn(a.id);
  await completeViaMcp(t, a.id);
  await completeIntegrationReviews(t, a.id);
  const b = await registerWork(t, "b");
  await t.clock.advance(HOUR);
  const bSpawnedId = recordSpawn(b.id);
  const entry = await loggedEntry(t, b.id, "took the shortcut");
  const attributed: EventPayload = {
    kind: "objection_attributed",
    entry_id: entry.id,
    objection_event_ids: [bundledObjection(t.db, b.id, entry.id, t.clock.now())],
    cause: "capability",
    evidence: "the shortcut missed the second criterion",
    entries: null,
    round: "initial",
  };
  appendEvent(t.db, { taskId: b.id, workerId: "board", origin: "board", at: t.clock.now(), payload: attributed });

  const episodes = loadEpisodes(t.db);
  const outcomeOf = (spawnedId: number) => episodes.find((e) => e.worker_spawned_event_id === spawnedId)?.outcome;
  expect(episodes).toHaveLength(2);
  expect(outcomeOf(bSpawnedId)).toBe("rejected");
  expect(outcomeOf(aSpawnedId)).not.toBe("rejected");
});

it("受理された work task の episode は、後から別の work task が spawn しても accepted のまま —— 次の spawn はタスクの照合で決まる(loadEpisodes)", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "a");
  await t.clock.advance(HOUR);
  const aSpawnedId = recordSpawn(a.id);
  await completeViaMcp(t, a.id);
  await completeIntegrationReviews(t, a.id);
  const b = await registerWork(t, "b");
  await t.clock.advance(HOUR);
  recordSpawn(b.id);

  const episodes = loadEpisodes(t.db);
  expect(episodes.find((e) => e.worker_spawned_event_id === aSpawnedId)?.outcome).toBe("accepted");
});

it("行の拒否で落ちた session は、そのタスクが別の行で受理されても excluded —— 受理されたのは次の session(ADR 0184 / ADR 0115 決定5、loadEpisodes)", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "a");
  await t.clock.advance(HOUR);
  const refusedId = recordSpawn(a.id);
  const at = t.clock.now();
  appendEvent(t.db, { taskId: a.id, workerId: "fake-worker", origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, exit_code: 1, worker_spawned_event_id: refusedId, output_closed: true, usage: null } });
  appendEvent(t.db, { taskId: a.id, workerId: "tidepool", origin: "board", at, payload: { kind: "row_refused", provider: "anthropic", model: WORKER_SPAWNED.model, worker_spawned_event_id: refusedId, cause: "api_404" } });
  const rerunId = recordSpawn(a.id);
  await completeViaMcp(t, a.id);
  await completeIntegrationReviews(t, a.id);

  const episodes = loadEpisodes(t.db);
  const outcomeOf = (spawnedId: number) => episodes.find((e) => e.worker_spawned_event_id === spawnedId)?.outcome;
  expect({ refused: outcomeOf(refusedId), rerun: outcomeOf(rerunId) }).toEqual({ refused: "excluded", rerun: "accepted" });
});

// ── 差し替え(issue #1523 / ADR 0215 決定4)────────────────────────────

it("main が替わった session は受理でも却下でも excluded —— 仕事をしたのは表に無い model(episodeOutcome)", () => {
  const facts = { accepted: true, causes: [] as const, allocations: [] as const, swapped: true };
  expect(episodeOutcome(facts)).toBe("excluded");
  expect(episodeOutcome({ ...facts, causes: ["capability"] })).toBe("excluded");
  expect(episodeOutcome({ ...facts, accepted: false, allocations: [{ allocation: "underpowered", cause: "capability" }] })).toBe("excluded");
});

it.each([
  ["session", "excluded"],
  [null, "excluded"],
  ["local", "accepted"],
] as const)("scope %s の差し替えのある session が受理されたら %s —— local は subagent だけが替わり main は pin のまま(loadEpisodes)", async (scope, outcome) => {
  t = await bootTidepool();
  const task = await registerWork(t, "swapped");
  await t.clock.advance(HOUR);
  const spawnedId = recordSpawn(task.id);
  const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5 };
  const swap = { from: "claude-fable-5-1", to: "claude-opus-4-8", scope, category: "cyber" };
  appendEvent(t.db, {
    taskId: task.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawnedId, output_closed: true, usage: { ...tokens, advisor: null, model_swaps: [swap], refusals: ["cyber"] } },
  });
  await completeViaMcp(t, task.id);
  await completeIntegrationReviews(t, task.id);

  const episodes = loadEpisodes(t.db);
  expect(episodes.find((e) => e.worker_spawned_event_id === spawnedId)?.outcome).toBe(outcome);
});
