import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload, listEvents } from "./events.js";
import {
  type ExecutionSettingRow,
  loadExecutionSettingTable,
  rowFor,
  type Tier,
} from "./execution-setting.js";
import { episodeMarkerKinds, type MarkerKind } from "./precedent.js";
import { BOARD_WORKER_ID, getTask, type Task } from "./tasks.js";
import { isAnthropicBoardCallBlocked } from "./throttle.js";

/** 「この結果に対する実行設定は適切だったか」の4値(CONTEXT.md「配分評価」)。
 *  `overpowered` は成功 episode からの唯一の下方向信号(ADR 0111 決定4)。 */
export const ALLOCATIONS = ["appropriate", "underpowered", "overpowered", "uncertain"] as const;
export type Allocation = (typeof ALLOCATIONS)[number];

/** Board call の構造化出力(spec #541「配分評価」)。 */
export interface AllocationJudgment {
  allocation: Allocation;
  cause: Cause;
  evidence: string;
}

/** Board call に渡す入力。**model 名を持つのは Board call だけ** —— review session
 *  はこれを見ない(ADR 0111 決定4)。`usage` / `actions` の null は「観測が無い」で
 *  あって「何もしなかった」ではない —— worker_exited の usage 欠測、Precedent の
 *  episode 行が無い session(codex は transcript を投影しない)がそれぞれに当たる。 */
export interface AllocationReviewInput {
  verdict: string | null;
  findings: string | null;
  setting: Pick<
    Extract<EventPayload, { kind: "worker_spawned" }>,
    "provider" | "model" | "effort" | "advisor" | "source"
  >;
  requested_tier: Tier | null;
  usage: Extract<EventPayload, { kind: "worker_exited" }>["usage"];
  actions: { advisor_consultations: number; compactions: number; commits: number } | null;
}

/** The Board call seam (draft / translation client と同型): `setting` は盤面が
 *  表から解決した Board call 自身の model / effort であり、`input.setting` (判定
 *  対象の worker が走った設定)とは別物。 */
export interface AllocationClient {
  judge(
    input: AllocationReviewInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AllocationJudgment>;
}

/** 入力の組み立て(ドメイン層の純関数、spec #541)。verdict は review の
 *  `task_completed.result`、findings は review の handoff doc、実行設定と出所は
 *  被レビュー task の最新 `worker_spawned`、usage はその session の `worker_exited`、
 *  行動列は Precedent のマーカー(相談 / compaction / commit)の計数。 */
export function buildAllocationReviewInput(data: {
  verdict: string | null;
  findings: string | null;
  requestedTier: Tier | null;
  spawned: Extract<EventPayload, { kind: "worker_spawned" }>;
  exited: Extract<EventPayload, { kind: "worker_exited" }> | undefined;
  markers: readonly MarkerKind[] | null;
}): AllocationReviewInput {
  const count = (kind: MarkerKind) => data.markers!.filter((m) => m === kind).length;
  return {
    verdict: data.verdict,
    findings: data.findings,
    setting: {
      provider: data.spawned.provider,
      model: data.spawned.model,
      effort: data.spawned.effort,
      advisor: data.spawned.advisor,
      source: data.spawned.source,
    },
    requested_tier: data.requestedTier,
    usage: data.exited?.usage ?? null,
    actions:
      data.markers === null
        ? null
        : { advisor_consultations: count("advisor"), compactions: count("compaction"), commits: count("commit") },
  };
}

/** 判定が得られなかったときの理由コード(issue #547 受け入れ基準: 空と区別する)。
 *  `no_session` = 被レビュー task に worker session の記録が無い、`throttled` =
 *  Anthropic の窓が閉じていて Board call を撃たなかった、`board_call_failed` =
 *  撃ったが答えが得られなかった(CLI の失敗・語彙の外の応答)。 */
export type AllocationUnevaluatedReason = "no_session" | "throttled" | "board_call_failed";

/** 盤面境界の1本(issue #547): 統合点レビューの完了を契機に入力を組み、Board call
 *  に問い、被レビュー task の episode へ注釈を1件だけ載せる。統合点レビュー以外の
 *  review(人間登録のルート review 等)には何もしない —— 注釈を載せる episode が
 *  無い。Board call の失敗は注釈の理由コードになるだけで、ここからは投げない。 */
export async function reviewAllocation(
  db: Db,
  client: AllocationClient,
  review: Task,
  now: Date,
): Promise<void> {
  if (review.type !== "review" || review.parent_id === null) return;
  const reviewEvents = listEvents(db, review.id);
  if (!reviewEvents.some((e) => e.payload.kind === "task_registered" && e.payload.integration_review)) return;
  const reviewed = getTask(db, review.parent_id)!;
  const reviewedEvents = listEvents(db, reviewed.id);
  const spawnedEvent = reviewedEvents.filter((e) => e.payload.kind === "worker_spawned").at(-1);
  const annotate = (
    outcome: AllocationJudgment | { unevaluated: AllocationUnevaluatedReason },
  ) =>
    appendEvent(db, {
      taskId: reviewed.id,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: {
        kind: "allocation_reviewed",
        review_task_id: review.id,
        worker_spawned_event_id: spawnedEvent?.id ?? null,
        ...outcome,
      },
      at: now,
    });
  if (!spawnedEvent || spawnedEvent.payload.kind !== "worker_spawned") {
    annotate({ unevaluated: "no_session" });
    return;
  }
  // Board call の Provider / ティアは盤面設定の固定値で、**selector を通らない**
  // (ADR 0111 決定4)—— 判定者が学習器に選ばれる輪をここで切る。model / effort は
  // 表の行から呼び出しごとに解決するので、#545 の編集が次の評価から効く
  const setting = rowFor(loadExecutionSettingTable(db), "anthropic", "frontier");
  if (isAnthropicBoardCallBlocked(db, setting.model)) {
    annotate({ unevaluated: "throttled" });
    return;
  }
  const completed = reviewEvents.filter((e) => e.payload.kind === "task_completed").at(-1)?.payload;
  const exited = reviewedEvents
    .map((e) => e.payload)
    .find((p) => p.kind === "worker_exited" && p.worker_spawned_event_id === spawnedEvent.id);
  const input = buildAllocationReviewInput({
    verdict: completed?.kind === "task_completed" ? completed.result : null,
    findings: review.handoff_doc,
    requestedTier: reviewed.tier,
    spawned: spawnedEvent.payload,
    exited: exited?.kind === "worker_exited" ? exited : undefined,
    markers: episodeMarkerKinds(db, spawnedEvent.id),
  });
  try {
    annotate(await client.judge(input, setting));
  } catch {
    annotate({ unevaluated: "board_call_failed" });
  }
}
