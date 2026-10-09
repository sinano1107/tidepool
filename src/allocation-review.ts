import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { type EventPayload, getEvent, listEvents } from "./events.js";
import type { ExecutionSettingRow } from "./execution-setting.js";
import { episodeMarkerKinds, type MarkerKind } from "./precedent.js";
import { getTask } from "./tasks.js";
import { type Tier, tierNameOf } from "./tier.js";

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
 *  はこれを見ない(ADR 0111 決定4)。`usage` の null は worker_exited の usage 欠測、`actions` の null は Precedent の
 *  episode 行が無い session と Codex の session —— どちらも「観測が無い」であって「何もしなかった」ではない。Codex の Episode は構造マーカーを持たない
 *  (compaction は stdout に出ず、commit の item も advisor も無い)ので、空の列を 0 回にしない(ADR 0083 追記10)。 */
export interface AllocationReviewInput {
  verdict: string | null;
  findings: string | null;
  setting: Pick<
    Extract<EventPayload, { kind: "worker_spawned" }>,
    "provider" | "model" | "effort" | "advisor" | "source"
  >;
  tier: Tier;
  usage: Extract<EventPayload, { kind: "worker_exited" }>["usage"];
  actions: { advisor_consultations: number; compactions: number; commits: number } | null;
}

/** The Board call seam (draft / translation client と同型): `setting` は盤面が
 *  表から解決した Board call 自身の model / effort であり、`input.setting` (判定
 *  対象の worker が走った設定)とは別物。 */
export interface AllocationClient {
  judge(
    input: AllocationReviewInput,
    setting: Pick<ExecutionSettingRow, "provider" | "model" | "effort">,
  ): Promise<AllocationJudgment>;
}

/** 入力の組み立て(ドメイン層の純関数、spec #541)。verdict は review の
 *  `task_completed.result`、findings は review の handoff doc、実行設定と出所は
 *  被レビュー task の対象 `worker_spawned`、走った段はその `tier_id` の名前、usage はその session の `worker_exited`、
 *  行動列は Precedent のマーカー(相談 / compaction / commit)の計数。 */
export function buildAllocationReviewInput(data: {
  verdict: string | null;
  findings: string | null;
  tier: Tier;
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
    tier: data.tier,
    usage: data.exited?.usage ?? null,
    // 観測できないかどうかはマーカーの有無ではなく Harness で決める(ADR 0083 追記10)
    actions:
      data.markers === null || data.spawned.harness === "codex"
        ? null
        : { advisor_consultations: count("advisor"), compactions: count("compaction"), commits: count("commit") },
  };
}

/** 配分評価の sweep の対象(ADR 0172 決定1): 統合点レビューの `task_completed`(書き手は問わない)のうち、被レビュー task に
 *  その完了より前の `worker_spawned` があり、その review を指す `allocation_reviewed` がまだ無いもの。評価する session は
 *  完了より前の最新の spawn に固定する —— 撃ち直しの時点で再 spawn されていても同じ session を問う。 */
export interface AllocationTarget {
  completed_event_id: number;
  review_task_id: string;
  reviewed_task_id: string;
  spawned_event_id: number;
}
// ponytail: poll の sweep のたびに全 review 完了と全注釈を json_extract で走査する。event が数万に育ったら索引か結果の不在の表に寄せる
export function allocationTargets(db: Db): AllocationTarget[] {
  return (
    db
      .prepare(
        `SELECT c.id AS completed_event_id, c.task_id AS review_task_id, t.parent_id AS reviewed_task_id,
                (SELECT MAX(s.id) FROM events s WHERE s.task_id = t.parent_id AND s.kind = 'worker_spawned' AND s.id < c.id) AS spawned_event_id
           FROM events c JOIN tasks t ON t.id = c.task_id
          WHERE c.kind = 'task_completed'
            AND EXISTS (SELECT 1 FROM events r WHERE r.task_id = c.task_id AND r.kind = 'task_registered' AND json_extract(r.payload, '$.integration_review') = 1)
            AND NOT EXISTS (SELECT 1 FROM events a WHERE a.kind = 'allocation_reviewed' AND json_extract(a.payload, '$.review_task_id') = c.task_id)
          ORDER BY c.id`,
      )
      .all() as Array<Omit<AllocationTarget, "spawned_event_id"> & { spawned_event_id: number | null }>
  ).filter((r): r is AllocationTarget => r.spawned_event_id !== null);
}

/** 対象1件の入力: verdict は review の完了 event の result、findings は review の handoff doc、実行設定は固定した session の
 *  spawn、走った段はその id の名前(消した段も含む)、usage はその session の `worker_exited`、行動列はその session の Precedent のマーカー。 */
export function allocationInput(db: Db, target: AllocationTarget): AllocationReviewInput {
  const spawned = getEvent(db, target.spawned_event_id)!.payload as Extract<EventPayload, { kind: "worker_spawned" }>;
  const exited = listEvents(db, target.reviewed_task_id)
    .map((e) => e.payload)
    .find(
      (p): p is Extract<EventPayload, { kind: "worker_exited" }> =>
        p.kind === "worker_exited" && p.worker_spawned_event_id === target.spawned_event_id,
    );
  return buildAllocationReviewInput({
    verdict: (getEvent(db, target.completed_event_id)!.payload as Extract<EventPayload, { kind: "task_completed" }>).result,
    findings: getTask(db, target.review_task_id)!.handoff_doc,
    tier: tierNameOf(db, spawned.tier_id),
    spawned,
    exited,
    markers: episodeMarkerKinds(db, target.spawned_event_id),
  });
}
