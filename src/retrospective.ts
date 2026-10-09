import { z } from "zod";
import { type AllocationClient, type AllocationJudgment, type AllocationTarget, allocationInput, allocationTargets } from "./allocation-review.js";
import type { Cause } from "./cause.js";
import { quarantineBoardCallRefusal } from "./cli-auth.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import {
  type Attribution,
  appendEvent,
  bundleName,
  currentAttributions,
  type DecisionLogEntry,
  type EventPayload,
  getEvent,
  isDecisionLogEntry,
  latestEventOfTask,
  listEvents,
  objectionBundles,
  sessionSpawnOf,
  sessionWindow,
  taskDecisionLog,
} from "./events.js";
import { type ExecutionSettingRow, readExecutionSettings } from "./execution-setting.js";
import { buildMemoryInjection, createBehaviorCandidate, listMemoryEntries, memoryScope, recordKnowledge, requireDecision } from "./memory.js";
import type { ProcessContainers } from "./process-container.js";
import { isSettled } from "./task-status.js";
import { getTask, getTextAuthor, listChildren, type Task } from "./tasks.js";
import { boardCallRow } from "./throttle.js";
import { entryObjections, listObjectedEntries, objectedEntryText, objectionsById, requireLogEntry } from "./triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID, isNonAgentWorkerId } from "./worker-id.js";

/** Board call に渡す入力(ADR 0115 決定2): 異議されたエントリ本文・その steering 列・
 *  当時の decision log(異議されたタスクの decision_logged と完了エントリ)。agent
 *  定義本文・model 名・価格は渡さない —— 判断に要らず、配分評価の線と同じ。
 *  `entry_id` は Fake が entry ごとに応答を引く鍵で、model に意味は無い。
 *  `rca_findings` は第2回(#575)だけが足す: その異議群を覆う RCA 子(self / auditor、ADR 0171 決定2)の decision log と
 *  完了 result を並べたもの。`memory_read` は worker がその decision の前に読んだ記憶(ADR 0166 決定2)。 */
export interface AttributionInput {
  entry_id: number;
  entry: string;
  steering: string[];
  decision_log: string[];
  memory_read: Array<{ id: number; kind: string; title: string; text: string }>;
  rca_findings?: string[];
}

/** 帰責の構造化出力 —— 保存する値は `cause` と、`memory` のときだけ誤った entry の id 列(ADR 0115 決定1 / ADR 0166 決定3)。
 *  evidence は散文。client の出力は門(`gate`)を通してから event に載る。 */
export interface AttributionJudgment {
  cause: Cause;
  evidence: string;
  entries?: number[];
}

/** 門を通った判定 —— `objection_attributed` に載る形。 */
export type GatedJudgment = Pick<Extract<EventPayload, { kind: "objection_attributed" }>, "cause" | "evidence" | "entries">;

/** The Board call seam for attribution (draft / translation / allocation client と
 *  同型): `setting` は盤面が表から解決した Board call 自身の model / effort。 */
export interface AttributionClient {
  judge(
    input: AttributionInput,
    setting: Pick<ExecutionSettingRow, "provider" | "model" | "effort">,
  ): Promise<AttributionJudgment>;
}

/** Behavior candidate 起草の Board call に渡す入力(ADR 0120 決定1(b)(c)): 帰責と同じ材料に、
 *  workspace の定義つき INDEX(spawn 注入と同じ節。見える approved が無ければ null)を足す。 */
export interface BehaviorDraftInput extends AttributionInput {
  index: string | null;
}

/** 起草の構造化出力。宛先 `worker` / `all` は `preference` のときだけ読まれる。 */
export interface BehaviorDraft {
  path: string;
  title: string;
  text: string;
  addressee: "worker" | "all";
}

/** Behavior candidate 起草の Board call の seam(issue #617)。AttributionClient と同型。 */
export interface BehaviorDraftClient {
  draft(input: BehaviorDraftInput, setting: Pick<ExecutionSettingRow, "provider" | "model" | "effort">): Promise<BehaviorDraft>;
}

/** 振り返り Board call(帰責・起草・配分評価)が受け取るもの。合成 root が一度だけ組み、scheduler(poll の sweep)と triage close に
 *  同じ束を渡す(ADR 0169 / ADR 0172)。欄は必須で値に `undefined` を許す —— 扉の deps を丸ごと渡す取り違えを型で落とすため。 */
export interface RetrospectiveCallDeps {
  /** 配分評価の Board call(ADR 0111 決定4 / ADR 0172)。sweep だけが撃つ。undefined → 撃てなかった扱いで何も書かない。 */
  allocationClient: AllocationClient | undefined;
  /** 帰責の Board call(ADR 0115 / issue #574・#575)。undefined → commit は異議を未帰責のまま RCA に倒し(ADR 0168)、第2回も撃たない。 */
  attributionClient: AttributionClient | undefined;
  /** Behavior candidate 起草の Board call(ADR 0120 / issue #617)。sweep が帰責の後に撃つ。undefined → 何も起草しない。 */
  behaviorDraftClient: BehaviorDraftClient | undefined;
  /** 起草の scope が null の workspace で継ぐ盤面の既定(issue #617)。 */
  workspace: { name: string } | undefined;
  /** 容器の前提(ADR 0136 決定7)。不成立なら撃てなかった扱い。undefined → 前提を検査しない盤面。 */
  containers: Pick<ProcessContainers, "preflight"> | undefined;
  /** 起草の宛先の agent が registry にいるか(ADR 0173 決定4)。undefined → registry の無い盤面で、照合せずに起草する。 */
  agentRegistered: ((name: string) => boolean) | undefined;
}

const uncertain = (evidence: string): GatedJudgment => ({ cause: "uncertain", evidence, entries: null });

/** 帰責の門(ADR 0166 決定3): `memory` は読んだ集合の内側の entry を1つ以上名指すときだけ、他の cause は entries を
 *  持たないときだけ通す。通らない判定は `uncertain` + 理由の判断に倒す(投げない)。 */
function gate({ entries, ...judgment }: AttributionJudgment, read: AttributionInput["memory_read"]): GatedJudgment {
  if (judgment.cause !== "memory") {
    return entries === undefined ? { ...judgment, entries: null } : uncertain(`${judgment.cause} attribution rejected: entries are only for cause memory`);
  }
  if (!entries?.length) return uncertain("memory attribution rejected: it names no entry");
  const unread = entries.filter((id) => !read.some((r) => r.id === id));
  if (unread.length > 0) return uncertain(`memory attribution rejected: entry ${unread.join(", ")} was not read before the decision`);
  return { ...judgment, entries };
}

/** Board call を撃てるか。Provider は盤面設定の固定値(ADR 0111 決定4 と同じ枠)、ティアは
 *  振り返り Board call 3用途が共有する盤面設定(ADR 0111 追記4、issue #914)で、
 *  client 未設定・表の行の欠落・窓の閉鎖・容器の前提の不成立は「撃てなかった」として理由を返す。 */
function boardCallSetting<C>(
  db: Db,
  client: C | undefined,
  containers?: RetrospectiveCallDeps["containers"],
): { client: C; setting: ExecutionSettingRow } | { unavailable: string } {
  if (!client) return { unavailable: "Board call not made: no client is configured" };
  let setting: ExecutionSettingRow;
  try {
    setting = boardCallRow(db, readExecutionSettings(db).judgementTier);
  } catch (err) {
    return { unavailable: `Board call not made: ${message(err)}` };
  }
  const preflight = containers?.preflight();
  if (preflight && !preflight.available) return { unavailable: `Board call not made: ${preflight.reason}` };
  return { client, setting };
}

/** 撃ち直しの盤面の定数(ADR 0164 決定4・5): 撃って3回失敗したら打ち切り、撃って失敗してから1時間は撃たない。 */
const MAX_FIRED_FAILURES = 3;
const REFIRE_INTERVAL_MS = 60 * 60 * 1000;

/** 撃っている最中の呼び出しの鍵(ADR 0164 決定1)。盤面(db)ごとに1つ —— 1 process に盤面が
 *  複数立つテストで event id が重ならないように。再起動で消えてよい(呼び出しも殺される、ADR 0136)。 */
const firingKeys = new WeakMap<Db, Set<string>>();

/** 同じ鍵の呼び出しを同時に1本までにする。鍵は同期で取る —— 呼び手が同じ tick で読んだ「結果が無い」と重ならないように。 */
async function singleFlight(db: Db, key: string, fire: () => Promise<void>): Promise<void> {
  let keys = firingKeys.get(db);
  if (!keys) firingKeys.set(db, (keys = new Set()));
  if (keys.has(key)) return;
  keys.add(key);
  try {
    await fire();
  } finally {
    keys.delete(key);
  }
}

/** 撃ち直しの種別ごとの失敗 event の kind と、撃ち直しの対象を指す欄(起草は帰責、第2回は異議群(ADR 0170 決定4)、配分評価は review の完了)。 */
const REFIRE = {
  draft: { failed: "memory_draft_failed", target: "attribution_event_id" },
  second_round: { failed: "objection_attribution_failed", target: "objection_event_id" },
  allocation: { failed: "allocation_review_failed", target: "review_completed_event_id" },
} as const;
/** 打ち切りの行を指す鍵: 種別と対象(起草は帰責 event の id、第2回は異議群の最初の異議 event の id、配分評価は review の task_completed event の id)。 */
export const refireKeySchema = z.object({ refire: z.enum(["draft", "second_round", "allocation"]), target: z.number().int().positive() });
export type RefireKey = z.infer<typeof refireKeySchema>;

/** 対象の失敗の数え(ADR 0164 決定5): 直近の Retry より後の失敗 event の数・最後の失敗、Dismiss の有無。
 *  Retry との前後は id で見る。帰責の初回の失敗は数えない —— 撃ち直すのは第2回だけ(ADR 0168 決定1)。 */
function refireFailures(db: Db, { refire, target }: RefireKey): { n: number; last: string | null; last_id: number | null; dismissed: number } {
  const marks = "json_extract(payload, '$.refire') = @refire AND json_extract(payload, '$.target') = @target";
  return db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last, MAX(id) AS last_id,
              EXISTS (SELECT 1 FROM events WHERE kind = 'refire_dismissed' AND ${marks}) AS dismissed
         FROM events WHERE kind = @failed AND json_extract(payload, @path) = @target
          AND NOT (kind = 'objection_attribution_failed' AND json_extract(payload, '$.round') = 'initial')
          AND id > COALESCE((SELECT MAX(id) FROM events WHERE kind = 'refire_retried' AND ${marks}), 0)`,
    )
    .get({ refire, target, failed: REFIRE[refire].failed, path: `$.${REFIRE[refire].target}` }) as ReturnType<typeof refireFailures>;
}

/** 撃ってよいか(ADR 0164 決定4・5): Dismiss が無く、直近の Retry 以降の失敗が3件未満で、最後の失敗から1時間以上経っている。 */
function refireDue(db: Db, key: RefireKey, now: Date): boolean {
  const { n, last, dismissed } = refireFailures(db, key);
  return !dismissed && n < MAX_FIRED_FAILURES && (last === null || now.getTime() - Date.parse(last) >= REFIRE_INTERVAL_MS);
}

/** commit の前半(spec #563「commit の流れ」): open session の異議されたエントリを
 *  1度だけ集め、Board call を並列に問う。transaction の外で待ち、結果の map を持って
 *  従来の transaction に入る。撃てなかった・撃って失敗した entry は map に載らず(判断ではない)、
 *  失敗だけが `objection_attribution_failed`(round = initial)に残る(行の拒否と 401 は Quarantine に回し失敗に数えない、ADR 0202・0205)。初回は撃ち直さない ——
 *  その entry は未帰責のまま RCA に倒れ、第2回が拾う(ADR 0168 決定1・2)。ここからは投げない ——
 *  帰責の障害は commit を止めない。 */
export async function attributeObjections(
  db: Db,
  deps: RetrospectiveCallDeps,
  sessionId: number,
  now: Date,
): Promise<Map<number, GatedJudgment>> {
  const objected = listObjectedEntries(db, sessionId);
  const judgments = new Map<number, GatedJudgment>();
  if (objected.length === 0) return judgments;
  const call = boardCallSetting(db, deps.attributionClient, deps.containers);
  if ("unavailable" in call) return judgments;
  await Promise.all(
    objected.map(async (o) => {
      const input: AttributionInput = {
        entry_id: o.entry.id,
        entry: objectedEntryText(o.entry),
        steering: o.comments,
        decision_log: decisionLogText(db, o.entry.task_id),
        memory_read: memoryRead(db, o.entry),
      };
      try {
        judgments.set(o.entry.id, gate(await call.client.judge(input, call.setting), input.memory_read));
      } catch (err) {
        if (quarantineBoardCallRefusal(db, err, "attribution", o.entry.task_id, now)) return;
        const payload = {
          kind: "objection_attribution_failed" as const,
          entry_id: o.entry.id,
          objection_event_id: bundleName(o),
          round: "initial" as const,
          reason: `Board call failed: ${message(err)}`,
        };
        appendEvent(db, { taskId: o.entry.task_id, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
      }
    }),
  );
  return judgments;
}

/** 異議された task の子の登録 event のうち、その子が異議群を覆うもの(ADR 0171 決定1): `task_registered` の
 *  `objection_event_ids` が異議群の名前(最初の異議 id)を含む。 */
const COVERING_CHILD = `FROM events e JOIN tasks t ON t.id = e.task_id
  WHERE e.kind = 'task_registered' AND t.parent_id = @objectedId AND t.type = @type
    AND EXISTS (SELECT 1 FROM json_each(e.payload, '$.objection_event_ids') WHERE value = @bundle)`;

/** 異議群を覆う RCA 子(self / auditor、ADR 0171 決定2)。 */
const rcaChildren = (db: Db, objectedId: string, bundle: number) => {
  const covering = new Set(db.prepare(`SELECT e.task_id ${COVERING_CHILD}`).pluck().all({ objectedId, type: "review", bundle }));
  return listChildren(db, objectedId).filter((c) => covering.has(c.id));
};

const settledAll = (tasks: Task[]) => tasks.every((r) => isSettled(r.status));

/** 第2回の出所: 入力を組む異議群と、「当時の decision log」の切れ目になる event の `id`。 */
type SecondRoundSource = Pick<Attribution, "id" | "entry_id" | "objection_event_ids">;

/** 異議群を束ねた commit が立てた修理子の `task_registered`(ADR 0171 決定2)。初回の帰責 event が書かれるはずだった位置 ——
 *  同じ transaction の中にある。束ねた異議群には必ず修理子がある(task は消えず、`bundleObjections` が飛ばすのは task の無い異議だけ)。 */
const repairRegistered = (db: Db, objectedId: string, bundle: number) =>
  db.prepare(`SELECT MIN(e.id) ${COVERING_CHILD}`).pluck().get({ objectedId, type: "work", bundle }) as number;

/** 異議群ごとの帰責の状態(ADR 0168 決定3 / ADR 0170 決定1)。第2回を待つ(`awaiting`)のは、帰責が初回の `uncertain` の
 *  異議群と未帰責の異議群 —— 後者の出所はその異議群で、当時の decision log は修理子の登録で切る。それ以外は確定
 *  (`confirmed`、同じ異議群では after_rca が有効)。前の異議群の状態は後の異議群があっても落とさない。 */
// ponytail: poll の sweep のたびに全帰責と全異議を読む。帰責が数万に育ったら結果の不在を SQL 1本に寄せる
function attributionStates(db: Db): Array<{ task_id: string } & ({ awaiting: SecondRoundSource } | { confirmed: Attribution })> {
  return [...objectionBundles(db).values()].flat().map(({ task_id, entry_id, objection_event_ids, attribution }) => {
    if (!attribution) return { task_id, awaiting: { id: repairRegistered(db, task_id, bundleName({ objection_event_ids })), entry_id, objection_event_ids } };
    return attribution.round === "initial" && attribution.cause === "uncertain" ? { task_id, awaiting: attribution } : { task_id, confirmed: attribution };
  });
}

/** 帰責の第2回を1異議群ぶん撃つ: RCA の findings を証拠にした判断(`uncertain` も判断として)を
 *  その異議群を名指す新しい event(round = after_rca)として追記し、起草へ進む(ADR 0120 決定1(b)(c))。
 *  撃てなかったら何も書かず、撃って失敗したら `objection_attribution_failed` だけを残す(ADR 0164 決定3・6。行の拒否と 401 は除く、ADR 0202・0205)。 */
async function attributeSecondRound(db: Db, deps: RetrospectiveCallDeps, objectedId: string, source: SecondRoundSource, now: Date): Promise<void> {
  await singleFlight(db, `after_rca:${bundleName(source)}`, async () => {
    if (!refireDue(db, { refire: "second_round", target: bundleName(source) }, now)) return;
    const call = boardCallSetting(db, deps.attributionClient, deps.containers);
    if ("unavailable" in call) return;
    const input = secondRoundInput(db, objectedId, source);
    let judgment: GatedJudgment;
    try {
      judgment = gate(await call.client.judge(input, call.setting), input.memory_read);
    } catch (err) {
      if (quarantineBoardCallRefusal(db, err, "attribution", objectedId, now)) return;
      const payload = {
        kind: "objection_attribution_failed" as const,
        entry_id: source.entry_id,
        objection_event_id: bundleName(source),
        round: "after_rca" as const,
        reason: `Board call failed: ${message(err)}`,
      };
      appendEvent(db, { taskId: objectedId, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
      return;
    }
    const payload = {
      kind: "objection_attributed" as const,
      entry_id: source.entry_id,
      objection_event_ids: source.objection_event_ids,
      ...judgment,
      round: "after_rca" as const,
    };
    const id = appendEvent(db, { taskId: objectedId, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
    await draftBehaviorCandidate(db, deps, { id, ...payload }, now);
  });
}

/** 第2回の入力: 当時の decision log は異議群の初回の帰責(未帰責なら覆う修理子の登録)より前で切り、
 *  覆う RCA 子の decision log と完了 result を足す。起草の撃ち直しも同じ出所から組む。 */
function secondRoundInput(db: Db, objectedId: string, attribution: SecondRoundSource): AttributionInput {
  const initial = listEvents(db, objectedId).find((e) =>
    e.payload.kind === "objection_attributed" && e.payload.round === "initial" &&
    e.payload.entry_id === attribution.entry_id && bundleName(e.payload) === bundleName(attribution),
  );
  return {
    ...objectionInput(db, { ...attribution, id: initial?.id ?? repairRegistered(db, objectedId, bundleName(attribution)) }),
    rca_findings: rcaChildren(db, objectedId, bundleName(attribution)).flatMap((r) => decisionLogText(db, r.id)),
  };
}

const fireAndForget = (fired: Promise<void>, target: string) => void fired.catch((err) => console.error(`[retrospective] ${target}: ${String(err)}`));

/** 配分評価を1 review ぶん撃つ(ADR 0172): 判断が返れば注釈を被レビュー task に載せ、撃てなかったら何も書かず、
 *  撃って失敗したら `allocation_review_failed` だけを残す(行の拒否と 401 は除く、ADR 0202・0205)。入力が組めないのは撃って失敗したのではないので投げる。 */
async function reviewAllocation(db: Db, deps: RetrospectiveCallDeps, target: AllocationTarget, now: Date): Promise<void> {
  await singleFlight(db, `allocation:${target.completed_event_id}`, async () => {
    if (!refireDue(db, { refire: "allocation", target: target.completed_event_id }, now)) return;
    const call = boardCallSetting(db, deps.allocationClient, deps.containers);
    if ("unavailable" in call) return;
    const input = allocationInput(db, target);
    const { review_task_id, reviewed_task_id } = target;
    const record = (payload: Extract<EventPayload, { kind: "allocation_reviewed" | "allocation_review_failed" }>) => appendEvent(db, { taskId: reviewed_task_id, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
    let judgment: AllocationJudgment;
    try {
      judgment = await call.client.judge(input, call.setting);
    } catch (err) {
      if (quarantineBoardCallRefusal(db, err, "allocation review", reviewed_task_id, now)) return;
      record({ kind: "allocation_review_failed", review_completed_event_id: target.completed_event_id, review_task_id, reviewed_task_id, reason: message(err) });
      return;
    }
    const { provider, model, effort } = call.setting;
    record({ kind: "allocation_reviewed", review_task_id, worker_spawned_event_id: target.spawned_event_id, judge: { provider, model, effort }, ...judgment });
  });
}

/** sweep の対象(ADR 0164 決定1): 異議群ごとの帰責の状態のうち、あるべき結果が無いもの —— 第2回を待つ異議群
 *  (初回の `uncertain` と未帰責、ADR 0168 決定3)で、その異議群を覆う RCA 子(ADR 0171 決定2)がすべて決着したものは第2回、確定した異議群は
 *  その帰責を出所とする candidate が無いもの の起草(後の異議群があっても外さない、ADR 0170 決定1)—— と、
 *  注釈の無い統合点レビューの配分評価(ADR 0172 決定1)。sweep と打ち切りの一覧が同じ集合を読む。 */
type RefireTarget = { task_id: string } & (
  | { refire: "second_round"; source: SecondRoundSource }
  | { refire: "draft"; attribution: Attribution }
  | { refire: "allocation"; allocation: AllocationTarget }
);
function refireTargets(db: Db): RefireTarget[] {
  const drafted = new Set(
    (db.prepare("SELECT CAST(source_ref AS INTEGER) AS id FROM memory_entries WHERE source_kind = 'event'").all() as { id: number }[]).map((r) => r.id),
  );
  return attributionStates(db).flatMap((state): RefireTarget[] => {
    if ("awaiting" in state) {
      const rca = rcaChildren(db, state.task_id, bundleName(state.awaiting));
      return rca.length > 0 && settledAll(rca) ? [{ task_id: state.task_id, refire: "second_round", source: state.awaiting }] : [];
    }
    return drafted.has(state.confirmed.id) ? [] : [{ task_id: state.task_id, refire: "draft", attribution: state.confirmed }];
  }).concat(allocationTargets(db).map((a) => ({ task_id: a.reviewed_task_id, refire: "allocation", allocation: a })));
}

/** sweep(ADR 0164 決定1・4): 第2回の帰責・起草・配分評価を撃つ唯一の契機(ADR 0169 決定1 / ADR 0172 決定1)。pickup の poll が同期で呼び、
 *  対象を fire-and-forget で撃つ —— 1回目も撃ち直しもここから出る。
 *  起草の規則・回数・間隔・in-flight・撃てるか は撃つ側(`draftBehaviorCandidate` / `attributeSecondRound`)が見る。
 *  初回の帰責は撃ち直さない(ADR 0168 決定1)。 */
export function refireRetrospectiveCalls(db: Db, deps: RetrospectiveCallDeps, now: Date): void {
  for (const target of refireTargets(db)) {
    if (target.refire === "second_round") {
      fireAndForget(attributeSecondRound(db, deps, target.task_id, target.source, now), `entry ${target.source.entry_id}`);
    } else if (target.refire === "draft") {
      fireAndForget(draftBehaviorCandidate(db, deps, target.attribution, now), `entry ${target.attribution.entry_id}`);
    } else {
      fireAndForget(reviewAllocation(db, deps, target.allocation, now), `allocation review ${target.allocation.review_task_id}`);
    }
  }
}

type Titled = { id: string; title: string };
/** 打ち切りの行: 配分評価は review と被レビュー task、起草と第2回は異議された entry とその帰責。 */
type HaltedRefire = { target: number; task: Titled; last_failure: { reason: string; at: string } } & (
  | { refire: "allocation"; review: Titled }
  | { refire: "draft" | "second_round"; entry: { id: number; text: string }; cause: Cause | null; round: "initial" | "after_rca" }
);

/** 撃ち直しを打ち切った振り返り Board call(ADR 0164 決定5 / ADR 0172 決定3): 撃ち直しの対象のうち、直近の Retry 以降に撃って
 *  3回失敗し Dismiss が無いもの。行が閉じるのは撃ち直しの成功(対象から外れる)と Dismiss だけ。 */
export function listHaltedRefires(db: Db): HaltedRefire[] {
  const current = currentAttributions(db);
  const titled = (id: string) => ({ id, title: getTask(db, id)!.title });
  return refireTargets(db).flatMap((t): HaltedRefire[] => {
    const target = t.refire === "draft" ? t.attribution.id : t.refire === "second_round" ? bundleName(t.source) : t.allocation.completed_event_id;
    const { n, last_id, dismissed } = refireFailures(db, { refire: t.refire, target });
    if (dismissed || n < MAX_FIRED_FAILURES) return [];
    const failure = getEvent(db, last_id!)!;
    const payload = failure.payload as Extract<EventPayload, { kind: (typeof REFIRE)[keyof typeof REFIRE]["failed"] }>;
    const last_failure = { reason: payload.reason, at: failure.created_at };
    if (t.refire === "allocation") return [{ refire: t.refire, target, review: titled(t.allocation.review_task_id), task: titled(t.task_id), last_failure }];
    const { entry_id, round } = payload as Extract<EventPayload, { kind: "memory_draft_failed" | "objection_attribution_failed" }>;
    const entry = getEvent(db, entry_id) as DecisionLogEntry;
    return [
      {
        refire: t.refire,
        target,
        entry: { id: entry_id, text: objectedEntryText(entry) },
        task: titled(t.task_id),
        // 最後の異議群が未帰責の entry は cause が空(ADR 0168 決定3 / ADR 0170 決定2)
        cause: current.get(entry_id)?.cause ?? null,
        round,
        last_failure,
      },
    ];
  });
}

/** 打ち切りの行への人間の Retry(もう3回撃つ)/ Dismiss(二度と撃たない)。追記だけの event で、打ち切りでない対象は DomainError。 */
export function markHaltedRefire(db: Db, kind: "refire_retried" | "refire_dismissed", key: RefireKey, origin: "webui" | "mcp", now: Date): number {
  const row = listHaltedRefires(db).find((r) => r.refire === key.refire && r.target === key.target);
  if (!row) throw new DomainError(`no halted ${key.refire} refire for target ${key.target}`);
  return appendEvent(db, { taskId: row.task.id, workerId: HUMAN_WORKER_ID, origin, payload: { kind, ...key }, at: now });
}

/** 帰責の入力を注釈 event から組む: 異議エントリ本文・steering 列・その注釈より前の decision log。 */
function objectionInput(
  db: Db,
  attribution: { id: number; entry_id: number; objection_event_ids: number[] },
): AttributionInput {
  const entry = requireLogEntry(db, attribution.entry_id);
  return {
    entry_id: entry.id,
    entry: objectedEntryText(entry),
    steering: objectionsById(db, entry.id, attribution.objection_event_ids).map((o) => o.comment),
    decision_log: decisionLogText(db, entry.task_id, attribution.id),
    memory_read: memoryRead(db, entry),
  };
}

/** 異議された entry を含む worker session で、その entry より前に read_memory が返した記憶(ADR 0166 決定2)。
 *  event 順で組み、transcript には依らない —— Precedent の entries_read より広くてよい(issue #1045)。 */
function memoryRead(db: Db, entry: DecisionLogEntry): AttributionInput["memory_read"] {
  const events = listEvents(db, entry.task_id);
  const spawned = sessionSpawnOf(events, entry);
  if (!spawned) return [];
  const { inSession } = sessionWindow(events, spawned);
  const ids = new Set(
    events.flatMap((e) => (e.payload.kind === "memory_pulled" && e.payload.verb === "read_memory" && e.id < entry.id && inSession(e) ? e.payload.returned_ids : [])),
  );
  // ponytail: 数件の id を引くのに記憶の全件を読む。記憶が数万に育って commit が重くなったら id で引く読み口を足す
  const byId = new Map(listMemoryEntries(db, {}).map((m) => [m.id, m]));
  return [...ids].map((id) => {
    const { kind, title, text } = byId.get(id)!;
    return { id, kind, title, text };
  });
}

/** 帰責が起草に向くエントリから Board call で Behavior candidate を起草する(ADR 0120 決定1(b)(c) /
 *  issue #617): 初回は `preference` だけ、第2回は学習向きの cause すべて(入力に RCA の findings を足す)。
 *  人間エントリ・起草 client の無い盤面・宛先の agent がいない起草(文面の書き手が人間か盤面の
 *  `task_ambiguity` / `missing_information`、ADR 0164 決定2)・workspace の無い task は何もしない。宛先は cause から導出し
 *  (ADR 0115 決定4)、Board call の `addressee` は `preference` だけが読む。撃てなかったら何も書かず、
 *  撃って失敗したら `memory_draft_failed` を残す(ADR 0164 決定3。行の拒否と 401 は除く、ADR 0202・0205)。poll の sweep が fire-and-forget で撃つ
 *  (第2回は帰責の追記の直後、ADR 0169)ので poll を止めない。 */
async function draftBehaviorCandidate(db: Db, deps: RetrospectiveCallDeps, attribution: Attribution, now: Date): Promise<void> {
  const { cause, round, entry_id } = attribution;
  const drafts = round === "initial" ? cause === "preference" : LEARNING_CAUSES.includes(cause);
  const entry = requireLogEntry(db, entry_id);
  if (!deps.behaviorDraftClient || !drafts || isHumanEntry(entry)) return;
  const taskId = entry.task_id;
  // preference の宛先は Board call が選ぶ。他の cause は導出し、文面の書き手が agent でなければ起草しない
  let derived: ReturnType<typeof learningTarget> | null = null;
  if (cause !== "preference") {
    try {
      derived = learningTarget(cause, entry.worker_id, getTextAuthor(db, taskId), cause === "missing_information" ? "behavior" : undefined);
    } catch {
      return;
    }
  }
  // 宛先の agent が registry から消えていれば学ぶ相手がいない —— 文面の書き手が人間のときと同じく起草しない(ADR 0173 決定4)。
  // preference の宛先は Board call が選ぶが、学ぶのは entry の worker
  const learner = derived ? (derived.kind === "behavior" ? derived.addressee : null) : entry.worker_id;
  if (learner !== null && deps.agentRegistered && !deps.agentRegistered(learner)) return;
  const task = getTask(db, taskId)!;
  let scope: string;
  try {
    scope = memoryScope(deps, task);
  } catch {
    return; // workspace の無い task は Memory の置き場が無く、何度撃っても同じ —— 宛先の無い起草と同じく何も残さない
  }
  await singleFlight(db, `draft:${attribution.id}`, async () => {
    if (!refireDue(db, { refire: "draft", target: attribution.id }, now)) return;
    // 入力が組めない帰責(出所の異議が壊れている)は撃って失敗したのではないので、失敗 event に畳まず投げる
    const input = round === "initial" ? objectionInput(db, attribution) : secondRoundInput(db, taskId, attribution);
    const call = boardCallSetting(db, deps.behaviorDraftClient, deps.containers);
    if ("unavailable" in call) return;
    // INDEX は撃つ時点のもの(ADR 0164 決定4)。関連 leaf は spawn 時の view で引き、ここでは訳さない(ADR 0175 決定6)
    const query = latestEventOfTask(db, taskId, "memory_injected")?.payload.query;
    const index = buildMemoryInjection(db, task, scope, entry.worker_id, query).section;
    let draft: BehaviorDraft;
    try {
      draft = await call.client.draft({ ...input, index }, call.setting);
    } catch (err) {
      if (quarantineBoardCallRefusal(db, err, "memory draft", taskId, now)) return;
      appendEvent(db, {
        taskId,
        workerId: BOARD_WORKER_ID,
        origin: "board",
        payload: { kind: "memory_draft_failed", entry_id, round, attribution_event_id: attribution.id, reason: message(err) },
        at: now,
      });
      return;
    }
    const { addressee, ...fields } = draft;
    createBehaviorCandidate(
      db,
      {
        ...fields,
        scope,
        addressee: derived?.kind === "behavior" ? derived.addressee : addressee === "all" ? null : entry.worker_id,
        source: { event_id: attribution.id },
        author: { activity: "board", name: BOARD_WORKER_ID },
      },
      "board",
      now,
    );
  });
}

/** そのタスクの decision log を人間が読んだ本文の列に(`before` を渡せばその event id
 *  より前のものだけ = 当時の log)。 */
function decisionLogText(db: Db, taskId: string, before = Number.POSITIVE_INFINITY): string[] {
  return taskDecisionLog(db, taskId)
    .filter((e) => e.id < before)
    .map(objectedEntryText);
}

/** 人間が書いたエントリか —— 宛先となる agent を持たない(self RCA も立たない)。 */
const isHumanEntry = (entry: { worker_id: string }) => entry.worker_id === HUMAN_WORKER_ID;

const LEARNING_CAUSES: readonly Cause[] = ["capability", "preference", "task_ambiguity", "missing_information"];

/** 学習の行き先を cause から導出する(ADR 0115 決定4)。`as` は `missing_information` だけが
 *  要り、Knowledge は宛先を持たない。Behavior の宛先が agent に落ちなければ DomainError。 */
function learningTarget(
  cause: Cause,
  entryWorker: string,
  textAuthor: string,
  as?: "behavior" | "knowledge",
): { kind: "behavior"; addressee: string } | { kind: "knowledge" } {
  if (!LEARNING_CAUSES.includes(cause)) throw new DomainError(`the entry's cause is ${cause}: nothing to learn from it`);
  if ((cause === "missing_information") !== (as !== undefined)) {
    throw new DomainError('as ("behavior" or "knowledge") is required for a missing_information entry and only for it');
  }
  const toTextAuthor = () => {
    // 盤面(BOARD_WORKER_ID)も agent ではない —— 宛先にしても注入はどこにも一致しない
    if (isNonAgentWorkerId(textAuthor)) {
      throw new DomainError("the task's text was not written by an agent: there is no agent to address a behavior to");
    }
    return { kind: "behavior" as const, addressee: textAuthor };
  };
  switch (cause) {
    case "capability":
    case "preference":
      return { kind: "behavior", addressee: entryWorker };
    case "task_ambiguity":
      return toTextAuthor();
    case "missing_information":
      return as === "knowledge" ? { kind: "knowledge" } : toTextAuthor();
    default:
      throw new DomainError(`the entry's cause is ${cause}: nothing to learn from it`);
  }
}

/** RCA の起草 verb `propose_from_objection`(spec #615 B / issue #1077): 異議エントリへの所見を記憶にする。
 *  門は列を足さず構造で引き(ADR 0120 決定1(a))、kind と宛先はその review が材料にした異議群の判定(ADR 0171 決定3)の
 *  cause から導く(ADR 0115 決定4)。材料に無い entry(同じ task で別 session に異議されたもの)は拒む。 */
export function proposeFromObjection(
  db: Db,
  reviewId: string,
  input: { entry_id: number; path: string; title: string; text: string; as?: "behavior" | "knowledge"; based_on_decision?: number },
  board: { workspace?: { name: string } },
  author: string,
  now: Date,
): { entry_id: number; event_id: number } {
  const { entry_id, as, based_on_decision, ...fields } = input;
  const task = getTask(db, reviewId);
  if (task?.type !== "review" || task.parent_id === null) {
    throw new DomainError("propose_from_objection is only for a review of an objected task");
  }
  const entry = getEvent(db, entry_id);
  if (!isDecisionLogEntry(entry) || entry.task_id !== task.parent_id) {
    throw new DomainError(`entry ${entry_id} is not a decision-log entry of your parent task`);
  }
  if (entryObjections(db, [entry_id]).length === 0) throw new DomainError(`entry ${entry_id} carries no objection`);
  if (isHumanEntry(entry)) throw new DomainError(`entry ${entry_id} was written by a human`);
  const material = latestEventOfTask(db, reviewId, "task_registered")!.payload.objection_event_ids ?? [];
  const bundle = objectionBundles(db, [entry_id]).get(entry_id)?.find((b) => material.includes(bundleName(b)));
  if (!bundle) throw new DomainError(`entry ${entry_id} is not in this review's material`);
  const { attribution } = bundle;
  // 覆う異議群が未帰責なら uncertain と同じに読む(ADR 0168 決定3)—— learningTarget が拒否する
  const target = learningTarget(attribution?.cause ?? "uncertain", entry.worker_id, getTextAuthor(db, entry.task_id), as);
  if ((target.kind === "knowledge") !== (based_on_decision !== undefined)) {
    throw new DomainError("based_on_decision is required for a knowledge entry and only for it");
  }
  const entryInput = {
    ...fields,
    scope: memoryScope(board, getTask(db, task.parent_id)!),
    source: { event_id: based_on_decision === undefined ? attribution!.id : requireDecision(db, based_on_decision, reviewId) },
    author: { activity: "rca" as const, name: author },
  };
  return target.kind === "knowledge"
    ? recordKnowledge(db, entryInput, "worker", now)
    : createBehaviorCandidate(db, { ...entryInput, addressee: target.addressee }, "worker", now);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
