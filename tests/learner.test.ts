import { afterEach, expect, it } from "vitest";
import { appendEvent, type EventPayload } from "../src/events.js";
import type { ExecutionSetting } from "../src/execution-setting.js";
import { aggregateCells, type Episode, episodeOutcome, recommend } from "../src/learner.js";
import {
  bootTidepool,
  completeIntegrationReviews,
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
function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    cell: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: null },
    workspace: "tidepool",
    agent: "tako",
    tier: "standard",
    priority: null,
    interview_kind: null,
    outcome: "accepted",
    cost_usd: null,
    duration_ms: null,
    ...overrides,
  };
}

/** 盤面全体の episode 列から、この workspace 向けの推薦を1回引く。 */
function recommendFor(episodes: Episode[], candidates: ExecutionSetting[], workspace = "tidepool", priority: "quality" | "cost" = "quality") {
  return recommend({
    candidates,
    board: aggregateCells(episodes),
    workspace: aggregateCells(episodes.filter((e) => e.workspace === workspace)),
    priority,
  });
}

it("データの無いセルでは推薦が表(selector の先頭)と一致し、出所は prior(AC1)", () => {
  expect(recommendFor([], [opus, sol])).toEqual({ recommended: opus, source: "prior" });
  expect(recommendFor([], [sol, opus])).toEqual({ recommended: sol, source: "prior" });
});

it("観測された具体 id は表の alias 行に当たり、受理されなかった行は表の並びより下がる —— 出所は data", () => {
  const rejected = episode({ cell: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: null }, outcome: "rejected" });
  expect(recommendFor([rejected], [opus, sol])).toEqual({ recommended: sol, source: "data" });
});

it("受理1件では表の並びを追い越さない —— 表の行は受理1件分の疑似観測で、少データでも表より悪くならない(ADR 0110 決定4)", () => {
  const accepted = episode({ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null } });
  expect(recommendFor([accepted], [opus, sol])).toEqual({ recommended: opus, source: "data" });
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

it("outcome は受理 = 統合点レビューがすべて完了、負 = capability の帰責か underpowered × capability の配分評価、それ以外は数えない(ADR 0115 決定5)", () => {
  const facts = { accepted: false, causes: [] as const, allocation: null };
  expect(episodeOutcome({ ...facts, accepted: true })).toBe("accepted");
  expect(episodeOutcome(facts)).toBe("excluded");
  expect(episodeOutcome({ ...facts, accepted: true, causes: ["capability"] })).toBe("rejected");
  expect(episodeOutcome({ ...facts, causes: ["preference", "requirement_change", "environment", "uncertain"] })).toBe("excluded");
  expect(episodeOutcome({ ...facts, allocation: { allocation: "underpowered", cause: "capability" } })).toBe("rejected");
  expect(episodeOutcome({ ...facts, accepted: true, allocation: { allocation: "underpowered", cause: "environment" } })).toBe("accepted");
  expect(episodeOutcome({ ...facts, accepted: true, allocation: { allocation: "overpowered", cause: "capability" } })).toBe("accepted");
});

it("advisor pin ありの episode は advisor 無しのセルに合流しない —— 相談回数ではなく pin がセルを割る(AC4)", () => {
  const opusWithAdvisor = candidate("anthropic", "opus", "fable");
  // pin あり・相談0回で受理されなかった session。pin が同じセルだけが下がる
  const pinnedRejected = episode({
    cell: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", advisor: "fable" },
    outcome: "rejected",
  });
  expect(recommendFor([pinnedRejected], [opus, sol])).toEqual({ recommended: opus, source: "prior" });
  expect(recommendFor([pinnedRejected], [opusWithAdvisor, sol])).toEqual({ recommended: sol, source: "data" });
});

/* ------------------------------------------------------------------ *
 * 盤面境界: pickup ごとの shadow 行(選択には介入しない)。
 * shadow 行の読み手(routing meta-review)はまだ無く読取面が無いので、行の有無だけは
 * SQL で言う —— 読取面が生えたらそちらへ写す(ADR 0107 決定2 の例外として申し送り)。
 * ------------------------------------------------------------------ */

let t: Tidepool;
afterEach(() => t?.stop());

const shadowRows = (t: Tidepool) =>
  t.db.prepare("SELECT task_id, cell_recommended, cell_actual, source FROM learner_shadow ORDER BY id").all();

it("work task の pickup ごとに shadow 行が1件記録され、selector の選択は変わらない —— review task では学習器を参照せず行も無い", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
  const work = await registerWork(t, "learned");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings).toEqual([opus]);
  const cell = JSON.stringify({ provider: "anthropic", model: "opus", effort: "high", advisor: null });
  expect(shadowRows(t)).toEqual([{ task_id: work.id, cell_recommended: cell, cell_actual: cell, source: "prior" }]);

  // 完了で統合点レビュー(review task)が生まれ、次の poll で pickup される
  await completeViaMcp(t, work.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.type)).toEqual(["work", "review"]);
  expect(shadowRows(t)).toHaveLength(1);
});

it("観測が効くと shadow 行は selector と乖離しうるが、選択は変わらない —— capability と帰責された session の行が下がり、出所は data", async () => {
  t = await bootTidepool({ taskExecutionCandidates: () => [opus, sol] });
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

  const later = await registerWork(t, "later");
  await t.clock.advance(HOUR);

  expect(t.worker.startedSettings.at(-1)).toEqual(opus);
  expect(shadowRows(t).at(-1)).toEqual({
    task_id: later.id,
    cell_recommended: JSON.stringify({ provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null }),
    cell_actual: JSON.stringify({ provider: "anthropic", model: "opus", effort: "high", advisor: null }),
    source: "data",
  });
});
