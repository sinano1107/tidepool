import { z } from "zod";
import { type AllocationClient, type AllocationJudgment, type AllocationTarget, allocationInput, allocationTargets } from "./allocation-review.js";
import { type BoardCallAnswer, type BoardCallSetting, recordedAnswer } from "./board-call-usage.js";
import { type AgentDefinitionThen, agentDefinitionThen } from "./board-prose.js";
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
  type EventOrigin,
  type EventPayload,
  type EventRow,
  type EventRowOf,
  getEvent,
  isDecisionLogEntry,
  latestEventOfTask,
  listEvents,
  listEventsOfKinds,
  objectionBundles,
  sessionSpawnOf,
  sessionWindow,
  taskDecisionLog,
} from "./events.js";
import { type ExecutionSettingRow, readExecutionSettings } from "./execution-setting.js";
import { createBehaviorCandidate, listMemoryEntries, memoryIndex, memoryScope, recordKnowledge, requireDecision } from "./memory.js";
import { listEpisodes, readPulls } from "./precedent.js";
import type { ProcessContainers } from "./process-container.js";
import { normalizeText, whyBlank } from "./required-text.js";
import { isSettled } from "./task-status.js";
import { finishTask, getTask, getTextAuthor, type HandoffDoc, humanStopReason, isRca, lineageSubjectOf, listChildren, repairChildren, resolvedStopReason, type Task } from "./tasks.js";
import { boardCallRow } from "./throttle.js";
import { entryObjections, listObjectedEntries, objectedEntryText, objectionsById, RCA_CAUSES, registerRcaReview, requireLogEntry } from "./triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID, isNonAgentWorkerId } from "./worker-id.js";

/** Board call に渡す入力(ADR 0115 決定2): 異議されたエントリ本文・その steering 列・
 *  当時の decision log(異議されたタスクの decision_logged と完了エントリ)。agent
 *  定義本文・model 名・価格は渡さない —— 判断に要らず、配分評価の線と同じ。
 *  `entry_id` は Fake が entry ごとに応答を引く鍵で、model に意味は無い。
 *  `rca_findings` は第2回(#575)だけが足す: その異議群を覆う RCA 子(self / auditor、ADR 0171 決定2)の decision log と
 *  完了 result を並べたもの。`memory_read` は worker がその decision の前に読んだ記憶(ADR 0166 決定2)。
 *  `human_stop` は同じ session の人間の停止と生で解いた理由。decision log の切れ目では切らない(ADR 0308)。
 *  `written` は記憶の書き込みの行だけが持つ: 書いたエントリの本文、無効化なら落とした本文(ADR 0252 決定4)。
 *  `agent_definition` は異議された entry の session の agent 定義の当時版の束で、引けなければ null(ADR 0291 決定2)。 */
export interface AttributionInput {
  entry_id: number;
  entry: string;
  steering: string[];
  decision_log: string[];
  memory_read: Array<{ id: number; kind: string; title: string; text: string }>;
  agent_definition: AgentDefinitionThen | null;
  human_stop?: { reason: string };
  written?: AttributionInput["memory_read"];
  rca_findings?: string[];
}

/** 停止の帰責の Board call に渡す入力(ADR 0310 決定2): 異議の入力の兄弟で、entry と steering を持たない。`human_stop` は人間の証言
 *  (history と同じ読み口)、`decision_log` は止められた session の窓の判断ログ全体(切れ目無し)、`memory_read` / `agent_definition` は
 *  異議と同じ数え方(停止より前の pull)。`actions` は Episode の行動列と判断の行の位置の印で、Episode が無い・読めない session は null。
 *  `rca_findings` は第2回だけが足す: その停止を材料にした RCA 子(self / auditor)の decision log と完了 result(ADR 0310 決定4)。 */
export interface StopAttributionInput {
  human_stop: { reason: string };
  decision_log: string[];
  memory_read: AttributionInput["memory_read"];
  agent_definition: AgentDefinitionThen | null;
  actions: {
    calls: Array<{ index: number; tool: string; args: string | null; failed: boolean }>;
    decisions: Array<{ position: number | null; line: string | null }>;
  } | null;
  rca_findings?: string[];
}

/** 帰責の構造化出力 —— 保存する値は `cause` と、`memory` のときだけ誤った entry の id 列(ADR 0115 決定1 / ADR 0166 決定3)。
 *  evidence は散文。client の出力は門(`gate`)を通してから event に載る。 */
export interface AttributionJudgment {
  cause: Cause;
  evidence: string;
  wrong_memory_entries?: number[];
}

/** 門を通った判定 —— `objection_attributed` に載る形。 */
export type GatedJudgment = Pick<Extract<EventPayload, { kind: "objection_attributed" }>, "cause" | "evidence" | "wrong_memory_entries">;

/** 初回の判定と、その入力が読んだ decision log の最後の entry の id(#1572)。commit の transaction が欄に載せるかを決める。 */
export type InitialJudgment = GatedJudgment & { decision_log_through?: number };

/** The Board call seam for attribution (draft / translation / allocation client と
 *  同型): `setting` は盤面が表から解決した Board call 自身の model / effort。 */
export interface AttributionClient {
  judge(
    input: AttributionInput,
    setting: BoardCallSetting,
  ): Promise<BoardCallAnswer<AttributionJudgment>>;
  /** 停止の帰責(ADR 0310)。 */
  judgeStop(input: StopAttributionInput, setting: BoardCallSetting): Promise<BoardCallAnswer<AttributionJudgment>>;
}

/** Behavior candidate 起草の Board call に渡す入力(ADR 0120 決定1(b)(c)): 帰責と同じ材料に、
 *  workspace の定義つき INDEX(spawn 注入と同じ節。見える approved が無ければ null)を足す。 */
export interface BehaviorDraftInput extends AttributionInput {
  index: string | null;
}

/** 停止の帰責からの起草に渡す入力(ADR 0310 決定4): 停止の判事と同じ欄(第2回なら rca_findings つき)に INDEX を足す。 */
export interface StopBehaviorDraftInput extends StopAttributionInput {
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
  draft(input: BehaviorDraftInput, setting: BoardCallSetting): Promise<BoardCallAnswer<BehaviorDraft>>;
  /** 停止の帰責からの起草(ADR 0310 決定4)。 */
  draftFromStop(input: StopBehaviorDraftInput, setting: BoardCallSetting): Promise<BoardCallAnswer<BehaviorDraft>>;
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
  /** 帰責の入力の当時版を引く registry clone(ADR 0291 決定2)。undefined → registry の無い盤面で、当時版の欄は null。 */
  registryDir: string | undefined;
}

const uncertain = (evidence: string): GatedJudgment => ({ cause: "uncertain", evidence, wrong_memory_entries: null });

/** 帰責の門(ADR 0166 決定3): `memory` は読んだ集合の内側の entry を1つ以上名指すときだけ、他の cause は wrong_memory_entries を
 *  持たないときだけ通す。`agent_definition` は入力に当時版があったときだけ通す(ADR 0291 決定2)。
 *  通らない判定は `uncertain` + 理由の判断に倒す(投げない)。 */
function gate({ wrong_memory_entries, ...judgment }: AttributionJudgment, input: Pick<AttributionInput, "memory_read" | "agent_definition">): GatedJudgment {
  if (judgment.cause === "agent_definition" && input.agent_definition === null) {
    return uncertain("agent_definition attribution rejected: no definition version was resolved for the session");
  }
  if (judgment.cause !== "memory") {
    return wrong_memory_entries === undefined ? { ...judgment, wrong_memory_entries: null } : uncertain(`${judgment.cause} attribution rejected: wrong_memory_entries are only for cause memory`);
  }
  if (!wrong_memory_entries?.length) return uncertain("memory attribution rejected: it names no entry");
  const unread = wrong_memory_entries.filter((id) => !input.memory_read.some((r) => r.id === id));
  if (unread.length > 0) return uncertain(`memory attribution rejected: entry ${unread.join(", ")} was not read before the decision`);
  return { ...judgment, wrong_memory_entries };
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

/** 撃ち直しの種別ごとの失敗 event の kind と、撃ち直しの対象を指す欄(起草は帰責、第2回は異議群(ADR 0170 決定4)、配分評価は review の完了、
 *  停止の帰責は停止(ADR 0310 決定3))。 */
const REFIRE = {
  draft: { failed: "memory_draft_failed", target: "attribution_event_id" },
  second_round: { failed: "objection_attribution_failed", target: "objection_event_id" },
  allocation: { failed: "allocation_review_failed", target: "review_completed_event_id" },
  stop_attribution: { failed: "stop_attribution_failed", target: "stop_event_id" },
} as const;
/** 打ち切りの行を指す鍵: 種別と対象(起草は帰責 event の id、第2回は異議群の最初の異議 event の id、配分評価は review の task_completed event の id、
 *  停止の帰責は停止 event の id)。 */
export const refireKeySchema = z.object({ refire: z.enum(["draft", "second_round", "allocation", "stop_attribution"]), target: z.number().int().positive() });
export type RefireKey = z.infer<typeof refireKeySchema>;

/** 対象の失敗の数え(ADR 0164 決定5): 直近の Retry より後の失敗 event の数・最後の失敗、Dismiss の有無。
 *  Retry との前後は id で見る。帰責の初回の失敗は数えない —— 撃ち直すのは第2回だけ(ADR 0168 決定1)。停止の帰責は初回も撃ち直すので、
 *  その停止の判定より前の失敗(初回の失敗)を第2回に数えない(ADR 0310 決定4)。 */
function refireFailures(db: Db, { refire, target }: RefireKey): { n: number; last: string | null; last_id: number | null; dismissed: number } {
  const marks = "json_extract(payload, '$.refire') = @refire AND json_extract(payload, '$.target') = @target";
  return db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last, MAX(id) AS last_id,
              EXISTS (SELECT 1 FROM events WHERE kind = 'refire_dismissed' AND ${marks}) AS dismissed
         FROM events WHERE kind = @failed AND json_extract(payload, @path) = @target
          AND NOT (kind = 'objection_attribution_failed' AND json_extract(payload, '$.round') = 'initial')
          AND NOT (kind = 'stop_attribution_failed' AND id < COALESCE((SELECT MAX(id) FROM events WHERE kind = 'stop_attributed' AND json_extract(payload, '$.stop_event_id') = @target), 0))
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
 *  判定には入力を組んだときに読んだ decision log の切れ目を添える(#1572)。
 *  失敗だけが `objection_attribution_failed`(round = initial)に残る(行の拒否と 401 は Quarantine に回し失敗に数えない、ADR 0202・0205)。初回は撃ち直さない ——
 *  その entry は未帰責のまま RCA に倒れ、第2回が拾う(ADR 0168 決定1・2)。ここからは投げない ——
 *  帰責の障害は commit を止めない。 */
export async function attributeObjections(
  db: Db,
  deps: RetrospectiveCallDeps,
  sessionId: number,
  now: Date,
): Promise<Map<number, InitialJudgment>> {
  const objected = listObjectedEntries(db, sessionId);
  const judgments = new Map<number, InitialJudgment>();
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
        ...sessionReads(db, deps.registryDir, o.entry),
        ...writtenBodies(db, o.entry),
        ...sessionHumanStop(db, o.entry),
      };
      const through = taskDecisionLog(db, o.entry.task_id).at(-1)!.id;
      try {
        const judgment = await recordedAnswer(db, "attribution", now, call.client.judge(input, call.setting));
        judgments.set(o.entry.id, { ...gate(judgment, input), decision_log_through: through });
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
 *  `opened_on_event_ids` が異議群の名前(最初の異議 id)を含む。 */
const COVERING_CHILD = `FROM events e JOIN tasks t ON t.id = e.task_id
  WHERE e.kind = 'task_registered' AND t.parent_id = @objectedId
    AND EXISTS (SELECT 1 FROM json_each(e.payload, '$.opened_on_event_ids') WHERE value = @bundle)`;

/** 異議群を覆う RCA 子(self / auditor、ADR 0171 決定2)。 */
const rcaChildren = (db: Db, objectedId: string, bundle: number) => {
  const covering = new Set(db.prepare(`SELECT e.task_id ${COVERING_CHILD}`).pluck().all({ objectedId, bundle }));
  return listChildren(db, objectedId).filter((c) => c.type === "review" && covering.has(c.id));
};

const settledAll = (tasks: Task[]) => tasks.every((r) => isSettled(r.status));

/** 第2回の出所: 入力を組む異議群。「当時の decision log」の切れ目はその異議群の記録から引く —— 初回の判定が読んだ範囲、
 *  未帰責なら覆う子の最初の登録(`secondRoundInput`、#1572)。 */
type SecondRoundSource = Pick<Attribution, "entry_id" | "objection_event_ids">;

/** 異議群を束ねた commit が立てた最初の子(修理子、無ければ RCA)の `task_registered`(ADR 0171 決定2)。未帰責の異議群の当時の
 *  decision log の切れ目 —— 初回の帰責 event が書かれるはずだった同じ transaction の中にある。修理子が行の種類で2本(work /
 *  memory_repair)立っても、どちらも同じ transaction の登録なので切れ目は変わらない(ADR 0272 決定2)。未帰責の異議群には必ず RCA
 *  が立つ(work の修理子は Interview の root と成果が捨てられた task の判断の行には立たない、ADR 0268 決定3 / ADR 0271 決定1)。 */
const bundleRegistered = (db: Db, objectedId: string, bundle: number) =>
  db.prepare(`SELECT MIN(e.id) ${COVERING_CHILD}`).pluck().get({ objectedId, bundle }) as number;

/** 異議群ごとの帰責の状態(ADR 0168 決定3 / ADR 0170 決定1)。第2回を待つ(`awaiting`)のは、帰責が初回の `uncertain` の
 *  異議群と未帰責の異議群 —— 後者の出所はその異議群。それ以外は確定
 *  (`confirmed`、同じ異議群では after_rca が有効)。前の異議群の状態は後の異議群があっても落とさない。 */
// ponytail: poll の sweep のたびに全帰責と全異議を読む。帰責が数万に育ったら結果の不在を SQL 1本に寄せる
function attributionStates(db: Db): Array<{ task_id: string } & ({ awaiting: SecondRoundSource } | { confirmed: Attribution })> {
  return [...objectionBundles(db).values()].flat().map(({ task_id, entry_id, objection_event_ids, attribution }) => {
    if (!attribution) return { task_id, awaiting: { entry_id, objection_event_ids } };
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
    const input = secondRoundInput(db, deps.registryDir, objectedId, source);
    let judgment: GatedJudgment;
    try {
      judgment = gate(await recordedAnswer(db, "attribution", now, call.client.judge(input, call.setting)), input);
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

/** 第2回の入力: 当時の decision log は異議群の初回の判定が読んだ範囲(未帰責なら覆う子の登録より前)で切り、
 *  覆う RCA 子の decision log と完了 result を足す。起草の撃ち直しも同じ出所から組む。 */
function secondRoundInput(db: Db, registryDir: string | undefined, objectedId: string, attribution: SecondRoundSource): AttributionInput {
  const [initial] = listEvents(db, objectedId).flatMap((e) =>
    e.payload.kind === "objection_attributed" && e.payload.round === "initial" &&
    e.payload.entry_id === attribution.entry_id && bundleName(e.payload) === bundleName(attribution) ? [{ ...e.payload, id: e.id }] : [],
  );
  return {
    ...objectionInput(db, registryDir, attribution, initial ? readCut(initial) : bundleRegistered(db, objectedId, bundleName(attribution))),
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
      judgment = await recordedAnswer(db, "allocation_review", now, call.client.judge(input, call.setting));
    } catch (err) {
      if (quarantineBoardCallRefusal(db, err, "allocation_review", reviewed_task_id, now)) return;
      record({ kind: "allocation_review_failed", review_completed_event_id: target.completed_event_id, review_task_id, reviewed_task_id, reason: message(err) });
      return;
    }
    const { provider, model, effort } = call.setting;
    record({ kind: "allocation_reviewed", review_task_id, worker_spawned_event_id: target.spawned_event_id, judge: { provider, model, effort }, ...judgment });
  });
}

/** 停止の帰責を1停止ぶん撃つ(ADR 0310 決定1〜4): 判断(`uncertain` も判断として)を門に通して `stop_attributed` として止められた
 *  task に追記し、起草へ進む。判定が既にある停止(初回の uncertain)には第2回として RCA の所見つきで撃ち、`round: "after_rca"` で書く(RCA は立てない)。
 *  撃てなかったら何も書かず、撃って失敗したら `stop_attribution_failed` だけを残す(行の拒否と 401 は除く、ADR 0202・0205)。 */
async function attributeStop(db: Db, deps: RetrospectiveCallDeps, target: StopTarget, now: Date): Promise<void> {
  const { task_id, stop, session } = target;
  const second = target.judgments.length > 0;
  await singleFlight(db, `stop:${stop.id}`, async () => {
    if (!refireDue(db, { refire: "stop_attribution", target: stop.id }, now)) return;
    const call = boardCallSetting(db, deps.attributionClient, deps.containers);
    if ("unavailable" in call) return;
    const input = stopInput(db, deps.registryDir, target, second);
    const record = (payload: Extract<EventPayload, { kind: "stop_attributed" | "stop_attribution_failed" }>) =>
      appendEvent(db, { taskId: task_id, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
    let judgment: GatedJudgment;
    try {
      judgment = gate(await recordedAnswer(db, "attribution", now, call.client.judgeStop(input, call.setting)), input);
    } catch (err) {
      if (quarantineBoardCallRefusal(db, err, "attribution", task_id, now)) return;
      record({ kind: "stop_attribution_failed", stop_event_id: stop.id, reason: `Board call failed: ${message(err)}` });
      return;
    }
    const judged = db.transaction(() => {
      const id = record({ kind: "stop_attributed", stop_event_id: stop.id, ...judgment, ...(second && { round: "after_rca" as const }) });
      if (!second && RCA_CAUSES.includes(judgment.cause)) registerStopRcas(db, task_id, stop.id, session.spawned.worker_id, input.human_stop.reason, now);
      return getEvent(db, id) as EventRowOf<"stop_attributed">;
    })();
    await draftStopBehaviorCandidate(db, deps, target, judged, now);
  });
}

/** 停止を材料にした RCA(ADR 0310 決定4): self(session の worker、human なら立てない)と auditor を止められた task の付帯子に。
 *  材料 id は停止 event 1つ、purpose は停止の事実と理由だけ(行動列は get_current_task が注入する)。修理子は立てない。 */
function registerStopRcas(db: Db, taskId: string, stopId: number, worker: string, reason: string, now: Date): void {
  const { title } = getTask(db, taskId)!;
  const purpose = `the human stopped the session ${worker} ran on "${title}":\n\n> stop ${stopId}: ${reason}`;
  if (worker !== HUMAN_WORKER_ID) registerRcaReview(db, taskId, { title: `rca (self): ${title}`, purpose, opened_on_event_ids: [stopId], assignee: worker }, now);
  registerRcaReview(db, taskId, { title: `rca (auditor): ${title}`, purpose, opened_on_event_ids: [stopId] }, now);
}

/** 停止の帰責の入力: 止められた session の窓の判断ログ全体・読んだもの・行動列(ADR 0310 決定2)。第2回は停止を材料にした RCA 子の
 *  decision log と完了 result を足す(ADR 0310 決定4)。起草も同じ入力を組む。 */
function stopInput(db: Db, registryDir: string | undefined, { task_id, stop, session }: StopTarget, afterRca: boolean): StopAttributionInput {
  return {
    human_stop: { reason: humanStopReason(db, stop.payload) },
    decision_log: session.events.filter(isDecisionLogEntry).filter(session.inSession).map(objectedEntryText),
    ...readsIn(db, registryDir, stop, session),
    actions: sessionActions(db, session.spawned.id),
    ...(afterRca && { rca_findings: rcaChildren(db, task_id, stop.id).flatMap((r) => decisionLogText(db, r.id)) }),
  };
}

/** session の行動列: Episode の行動の index・tool 名・引数・失敗の印と、判断の行の位置の印。Episode が無い・読めない session は null。 */
function sessionActions(db: Db, spawnedId: number): StopAttributionInput["actions"] {
  const [episode] = listEpisodes(db, { workerSpawnedEventId: spawnedId });
  if (!episode || episode.unrecognizedFormat) return null;
  return {
    calls: episode.actions.map(({ index, tool, args, failed }) => ({ index, tool, args, failed })),
    decisions: episode.markers.flatMap(({ kind, position, line }) => (kind === "decision" ? [{ position, line }] : [])),
  };
}

/** 1つの worker session: その task の event・開いた spawn・窓の判定。 */
type Session = { events: EventRow[]; spawned: EventRow; inSession: (e: Pick<EventRow, "id" | "task_id">) => boolean };

/** 帰責の扉が開いた停止と、その判定(古い順、無ければ空)。 */
type StopTarget = { task_id: string; stop: EventRowOf<"session_stopped_by_human">; session: Session; judgments: EventRowOf<"stop_attributed">[] };

/** 停止の帰責の扉が開いた停止(ADR 0310 決定1・3・6): 人間の停止のうち、理由が解けていて、その session が閉じていて(spawn の
 *  worker_exited 観測済み)、停止承認付き cancel の出口でなく(その cancel は同じ transaction で停止より前に task_cancelled_directly を書く)、
 *  受験者の task でないもの。 */
// ponytail: poll の sweep のたびに停止のある task の全 event を読む。停止が数千に育ったら判定の確定を SQL で先に絞る
function stopTargets(db: Db): StopTarget[] {
  return listEventsOfKinds(db, ["session_stopped_by_human"]).flatMap((stop): StopTarget[] => {
    const task_id = stop.task_id!;
    if (getTask(db, task_id)?.interview_target_id != null || resolvedStopReason(db, stop.payload) === undefined) return [];
    const events = listEvents(db, task_id);
    const spawned = sessionSpawnOf(events, stop);
    if (!spawned) return [];
    const { exited, inSession } = sessionWindow(events, spawned);
    if (!exited) return [];
    if (events.some(({ id, kind }) => kind === "task_cancelled_directly" && spawned.id < id && id < stop.id)) return [];
    const judgments = events.filter((e): e is EventRowOf<"stop_attributed"> => e.payload.kind === "stop_attributed" && e.payload.stop_event_id === stop.id);
    return [{ task_id, stop, session: { events, spawned, inSession }, judgments }];
  });
}

/** sweep の対象(ADR 0164 決定1): 異議群ごとの帰責の状態のうち、あるべき結果が無いもの —— 第2回を待つ異議群
 *  (初回の `uncertain` と未帰責、ADR 0168 決定3)で、その異議群を覆う RCA 子(ADR 0171 決定2)がすべて決着したものは第2回、確定した異議群は
 *  その帰責を出所とする candidate が無いもの の起草(後の異議群があっても外さない、ADR 0170 決定1)—— と、
 *  注釈の無い統合点レビューの配分評価(ADR 0172 決定1)。sweep と打ち切りの一覧が同じ集合を読む。 */
type RefireTarget = { task_id: string } & (
  | { refire: "second_round"; source: SecondRoundSource }
  | { refire: "draft"; attribution: Attribution }
  | ({ refire: "draft"; judgment: EventRowOf<"stop_attributed"> } & StopTarget)
  | { refire: "allocation"; allocation: AllocationTarget }
  | ({ refire: "stop_attribution" } & StopTarget)
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
  })
    .concat(allocationTargets(db).map((a) => ({ task_id: a.reviewed_task_id, refire: "allocation", allocation: a })))
    .concat(
      stopTargets(db).flatMap((t): RefireTarget[] => {
        const judgment = t.judgments.at(-1);
        if (!judgment) return [{ refire: "stop_attribution", ...t }];
        // 初回の uncertain は停止を材料にした RCA 子が全部決着したら第2回(第2回の uncertain は最終値、ADR 0164)
        if (judgment.payload.round === undefined && judgment.payload.cause === "uncertain") {
          const rca = rcaChildren(db, t.task_id, t.stop.id);
          return rca.length > 0 && settledAll(rca) ? [{ refire: "stop_attribution", ...t }] : [];
        }
        return drafted.has(judgment.id) ? [] : [{ refire: "draft", judgment, ...t }];
      }),
    );
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
      if ("attribution" in target) fireAndForget(draftBehaviorCandidate(db, deps, target.attribution, now), `entry ${target.attribution.entry_id}`);
      else fireAndForget(draftStopBehaviorCandidate(db, deps, target, target.judgment, now), `stop ${target.stop.id}`);
    } else if (target.refire === "stop_attribution") {
      fireAndForget(attributeStop(db, deps, target, now), `stop ${target.stop.id}`);
    } else {
      fireAndForget(reviewAllocation(db, deps, target.allocation, now), `allocation review ${target.allocation.review_task_id}`);
    }
  }
}

type Titled = { id: string; title: string };
/** 打ち切りの行: 配分評価は review と被レビュー task、起草と第2回は異議された entry とその帰責、停止の帰責と停止からの起草は停止の理由
 *  (entry を持たない。起草はその判定の cause と round も)。 */
type HaltedRefire = { target: number; task: Titled; last_failure: { reason: string; at: string } } & (
  | { refire: "allocation"; review: Titled }
  | { refire: "stop_attribution"; stop: { reason: string } }
  | { refire: "draft"; stop: { reason: string }; cause: Cause; round: "initial" | "after_rca" }
  | { refire: "draft" | "second_round"; entry: { id: number; text: string }; cause: Cause | null; round: "initial" | "after_rca" }
);

/** 撃ち直しを打ち切った振り返り Board call(ADR 0164 決定5 / ADR 0172 決定3): 撃ち直しの対象のうち、直近の Retry 以降に撃って
 *  3回失敗し Dismiss が無いもの。行が閉じるのは撃ち直しの成功(対象から外れる)と Dismiss だけ。 */
export function listHaltedRefires(db: Db): HaltedRefire[] {
  const current = currentAttributions(db);
  const titled = (id: string) => ({ id, title: getTask(db, id)!.title });
  return refireTargets(db).flatMap((t): HaltedRefire[] => {
    const target =
      t.refire === "draft"
        ? "attribution" in t ? t.attribution.id : t.judgment.id
        : t.refire === "second_round" ? bundleName(t.source) : t.refire === "stop_attribution" ? t.stop.id : t.allocation.completed_event_id;
    const { n, last_id, dismissed } = refireFailures(db, { refire: t.refire, target });
    if (dismissed || n < MAX_FIRED_FAILURES) return [];
    const failure = getEvent(db, last_id!)!;
    const payload = failure.payload as Extract<EventPayload, { kind: (typeof REFIRE)[keyof typeof REFIRE]["failed"] }>;
    const last_failure = { reason: payload.reason, at: failure.created_at };
    if (t.refire === "allocation") return [{ refire: t.refire, target, review: titled(t.allocation.review_task_id), task: titled(t.task_id), last_failure }];
    if ("stop" in t) {
      const stop = { reason: humanStopReason(db, t.stop.payload) };
      if (t.refire === "stop_attribution") return [{ refire: t.refire, target, stop, task: titled(t.task_id), last_failure }];
      return [{ refire: t.refire, target, stop, cause: t.judgment.payload.cause, round: t.judgment.payload.round ?? "initial", task: titled(t.task_id), last_failure }];
    }
    const { entry_id, round } = payload as Extract<EventPayload, { kind: "memory_draft_failed" | "objection_attribution_failed" } & { entry_id: number }>;
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

/** 帰責の入力を異議群から組む: 異議エントリ本文・steering 列・`before`(event id)より前の decision log。 */
function objectionInput(db: Db, registryDir: string | undefined, attribution: SecondRoundSource, before: number): AttributionInput {
  const entry = requireLogEntry(db, attribution.entry_id);
  return {
    entry_id: entry.id,
    entry: objectedEntryText(entry),
    steering: objectionsById(db, entry.id, attribution.objection_event_ids).map((o) => o.comment),
    decision_log: decisionLogText(db, entry.task_id, before),
    ...sessionReads(db, registryDir, entry),
    ...writtenBodies(db, entry),
    ...sessionHumanStop(db, entry),
  };
}

/** 人間の証言は decision log の切れ目で切らず、異議された entry と同じ session から生で読む(ADR 0308)。 */
function sessionHumanStop(db: Db, entry: DecisionLogEntry): Pick<AttributionInput, "human_stop"> {
  const events = listEvents(db, entry.task_id);
  const spawned = sessionSpawnOf(events, entry);
  if (!spawned) return {};
  const { inSession } = sessionWindow(events, spawned);
  const stop = events.find((e) => e.kind === "session_stopped_by_human" && inSession(e))?.payload;
  return stop?.kind === "session_stopped_by_human" ? { human_stop: { reason: humanStopReason(db, stop) } } : {};
}

/** 異議された entry を含む worker session が読んだもの(`readsIn`)。entry が session の窓の外なら何も読んでいない。 */
function sessionReads(db: Db, registryDir: string | undefined, entry: DecisionLogEntry): Pick<AttributionInput, "memory_read" | "agent_definition"> {
  const events = listEvents(db, entry.task_id);
  const spawned = sessionSpawnOf(events, entry);
  if (!spawned) return { memory_read: [], agent_definition: null };
  return readsIn(db, registryDir, entry, { events, spawned, inSession: sessionWindow(events, spawned).inSession });
}

/** `anchor`(異議された entry か人間の停止)の session が読んだもの —— spawn の当時版(ADR 0291 決定2)と読んだ記憶。読んだ記憶は、anchor より前の
 *  pull が read に数える記憶(ADR 0166 決定2、数え方は readPulls)と、その spawn で注入された Definition(ADR 0291 決定6)。
 *  event 順で組み、transcript には依らない —— Precedent の entries_read より広くてよい(issue #1045)。 */
function readsIn(db: Db, registryDir: string | undefined, anchor: Pick<EventRow, "id">, { events, spawned, inSession }: Session): Pick<AttributionInput, "memory_read" | "agent_definition"> {
  const pulls = events.flatMap((e) => (e.payload.kind === "memory_pulled" && e.id < anchor.id && inSession(e) ? [e.payload] : []));
  const pulled = readPulls(events, spawned.id, pulls);
  const injected = events.flatMap(({ payload: p }) => (p.kind === "memory_injected" && p.worker_spawned_event_id === spawned.id ? p.entries.map((e) => e.id) : []));
  return {
    memory_read: memoryBodies(db, [...new Set([...injected, ...pulled])]).filter((m) => m.kind === "definition" || pulled.includes(m.id)),
    agent_definition: registryDir === undefined ? null : agentDefinitionThen(db, registryDir, spawned),
  };
}

/** 記憶の書き込みの行(memory_written)が作った・無効化したエントリの本文。他の行は欄を持たない。 */
function writtenBodies(db: Db, entry: DecisionLogEntry): Pick<AttributionInput, "written"> {
  return entry.payload.kind === "memory_written" ? { written: memoryBodies(db, [...entry.payload.created, ...entry.payload.invalidated]) } : {};
}

function memoryBodies(db: Db, ids: number[]): AttributionInput["memory_read"] {
  // ponytail: 数件の id を引くのに記憶の全件を読む。記憶が数万に育って commit が重くなったら id で引く読み口を足す
  const byId = new Map(listMemoryEntries(db, {}).map((m) => [m.id, m]));
  return ids.map((id) => {
    const { kind, title, text } = byId.get(id)!;
    return { id, kind, title, text };
  });
}

/** 帰責が起草に向くエントリから Board call で Behavior candidate を起草する(ADR 0120 決定1(b)(c) /
 *  issue #617): 初回は `preference` だけ、第2回は学習向きの cause すべて(入力に RCA の findings を足す)。
 *  人間エントリ・起草 client の無い盤面・宛先の agent がいない起草(文面の書き手が人間か盤面の
 *  `task_ambiguity` / `missing_information`、ADR 0164 決定2)・workspace の無い task は何もしない。主題つきの task の行は scope null
 *  (盤面全体)に起草し、INDEX もその視界で組む(ADR 0279 決定1)。宛先は cause から導出し
 *  (ADR 0115 決定4)、Board call の `addressee` は `preference` だけが読む。撃てなかったら何も書かず、
 *  撃って失敗したら —— 書き込みが一木の門(ADR 0178)に当たったときも —— `memory_draft_failed` を残す(ADR 0164 決定3。行の拒否と 401 は除く、ADR 0202・0205)。poll の sweep が fire-and-forget で撃つ
 *  (第2回は帰責の追記の直後、ADR 0169)ので poll を止めない。 */
async function draftBehaviorCandidate(db: Db, deps: RetrospectiveCallDeps, attribution: Attribution, now: Date): Promise<void> {
  const entry = requireLogEntry(db, attribution.entry_id);
  await draftCandidate(db, deps, {
    attribution,
    taskId: entry.task_id,
    worker: entry.worker_id,
    material: { entry_id: entry.id },
    prepare: () => {
      const input = attribution.round === "initial" ? objectionInput(db, deps.registryDir, attribution, readCut(attribution)) : secondRoundInput(db, deps.registryDir, entry.task_id, attribution);
      return (client, index, setting) => client.draft({ ...input, index }, setting);
    },
  }, now);
}

/** 停止の帰責から Behavior candidate を起草する(ADR 0310 決定4): 異議と同じ規則で、学ぶのは止められた session の worker、入力は停止の判事と同じ欄
 *  (第2回の判定なら RCA の所見つき)。失敗 event は停止を `stop_event_id` で指す。 */
async function draftStopBehaviorCandidate(db: Db, deps: RetrospectiveCallDeps, target: StopTarget, judgment: EventRowOf<"stop_attributed">, now: Date): Promise<void> {
  const { cause, round = "initial" } = judgment.payload;
  await draftCandidate(db, deps, {
    attribution: { id: judgment.id, cause, round },
    taskId: target.task_id,
    worker: target.session.spawned.worker_id,
    material: { stop_event_id: target.stop.id },
    prepare: () => {
      const input = stopInput(db, deps.registryDir, target, round === "after_rca");
      return (client, index, setting) => client.draftFromStop({ ...input, index }, setting);
    },
  }, now);
}

/** 起草の出所: 帰責 event、学ぶ worker とその task、失敗 event が指す材料、入力を組んで(組めなければ投げる)起草 client を撃つ口。 */
type DraftSource = {
  attribution: { id: number; cause: Cause; round: "initial" | "after_rca" };
  taskId: string;
  worker: string;
  material: { entry_id: number } | { stop_event_id: number };
  prepare: () => (client: BehaviorDraftClient, index: string | null, setting: BoardCallSetting) => Promise<BoardCallAnswer<BehaviorDraft>>;
};

async function draftCandidate(db: Db, deps: RetrospectiveCallDeps, { attribution, taskId, worker, material, prepare }: DraftSource, now: Date): Promise<void> {
  const { cause, round } = attribution;
  const drafts = round === "initial" ? cause === "preference" : LEARNING_CAUSES.includes(cause);
  if (!deps.behaviorDraftClient || !drafts || worker === HUMAN_WORKER_ID) return;
  // preference の宛先は Board call が選ぶ。他の cause は導出し、文面の書き手が agent でなければ起草しない
  let derived: ReturnType<typeof learningTarget> | null = null;
  if (cause !== "preference") {
    try {
      derived = learningTarget(cause, worker, getTextAuthor(db, taskId), cause === "missing_information" ? "behavior" : undefined);
    } catch {
      return;
    }
  }
  // 宛先の agent が registry から消えていれば学ぶ相手がいない —— 文面の書き手が人間のときと同じく起草しない(ADR 0173 決定4)。
  // preference の宛先は Board call が選ぶが、学ぶのは行の(停止なら session の)worker
  const learner = derived ? (derived.kind === "behavior" ? derived.addressee : null) : worker;
  if (learner !== null && deps.agentRegistered && !deps.agentRegistered(learner)) return;
  const task = getTask(db, taskId)!;
  let scope: string | null;
  try {
    scope = learnedScope(db, deps, task);
  } catch {
    return; // workspace の無い task は Memory の置き場が無く、何度撃っても同じ —— 宛先の無い起草と同じく何も残さない
  }
  await singleFlight(db, `draft:${attribution.id}`, async () => {
    if (!refireDue(db, { refire: "draft", target: attribution.id }, now)) return;
    // 入力が組めない帰責(出所の異議が壊れている)は撃って失敗したのではないので、失敗 event に畳まず投げる
    const fire = prepare();
    const call = boardCallSetting(db, deps.behaviorDraftClient, deps.containers);
    if ("unavailable" in call) return;
    // INDEX は撃つ時点のもの(ADR 0164 決定4)。関連 leaf は spawn 時の view で引き、ここでは訳さない(ADR 0175 決定6)
    const query = latestEventOfTask(db, taskId, "memory_injected")?.payload.query;
    const index = memoryIndex(db, task, scope, worker, query).section;
    try {
      const { addressee, ...fields } = await recordedAnswer(db, "behavior_draft", now, fire(call.client, index, call.setting));
      createBehaviorCandidate(
        db,
        {
          ...fields,
          scope,
          addressee: derived?.kind === "behavior" ? derived.addressee : addressee === "all" ? null : worker,
          source: { event_id: attribution.id },
          author: { activity: "board", name: BOARD_WORKER_ID },
        },
        "board",
        now,
      );
    } catch (err) {
      if (quarantineBoardCallRefusal(db, err, "behavior_draft", taskId, now)) return;
      appendEvent(db, {
        taskId,
        workerId: BOARD_WORKER_ID,
        origin: "board",
        payload: { kind: "memory_draft_failed", ...material, round, attribution_event_id: attribution.id, reason: message(err) },
        at: now,
      });
    }
  });
}

/** 行から学んだ記憶の置き場(起草と propose_from_material が共有): 行の主題を持つ task(meta-review とその系譜)の行は盤面全体(null)、
 *  他は task の workspace(memoryScope —— 解決できなければ投げる)。meta-review は workspace を持たない仕事で、子はそれを継ぐ(ADR 0279 決定1 / ADR 0283 決定1)。 */
const learnedScope = (db: Db, board: { workspace?: { name: string } }, task: Task): string | null =>
  lineageSubjectOf(db, task.id) === null ? memoryScope(board, task) : null;

/** 初回の帰責の判定が読んだ decision log の切れ目(この event id より前、#1572)。 */
const readCut = (initial: Attribution) => (initial.decision_log_through === undefined ? initial.id : initial.decision_log_through + 1);

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

/** RCA の起草 verb `propose_from_material`(spec #615 B / issue #1077): 異議エントリへの所見を記憶にする。
 *  門は列を足さず構造で引き(ADR 0120 決定1(a))、kind と宛先はその review が材料にした異議群の判定(ADR 0171 決定3)の
 *  cause から導く(ADR 0115 決定4)。材料に無い entry(同じ task で別 session に異議されたもの)は拒む。材料が停止の RCA は
 *  その停止の id を material_id に指し、停止の帰責から導く(ADR 0310 決定4、`learnedFrom`)。
 *  書いた記憶とエントリを結ぶ記録を呼んだ RCA に、店の書き込みと同じ transaction で残す(ADR 0280 決定1)。 */
export function proposeFromMaterial(
  db: Db,
  reviewId: string,
  input: { material_id: number; path: string; title: string; text: string; as?: "behavior" | "knowledge"; based_on_decision?: number },
  board: { workspace?: { name: string } },
  author: string,
  now: Date,
): { entry_id: number; event_id: number } {
  const { material_id, as, based_on_decision, ...fields } = input;
  const task = getTask(db, reviewId);
  if (task?.type !== "review" || task.parent_id === null) {
    throw new DomainError("propose_from_material is only for a review of an objected or stopped task");
  }
  const { worker, attribution } = learnedFrom(db, task, material_id);
  // 覆う異議群が未帰責なら uncertain と同じに読む(ADR 0168 決定3)—— learningTarget が拒否する
  const target = learningTarget(attribution?.cause ?? "uncertain", worker, getTextAuthor(db, task.parent_id), as);
  if ((target.kind === "knowledge") !== (based_on_decision !== undefined)) {
    throw new DomainError("based_on_decision is required for a knowledge entry and only for it");
  }
  const entryInput = {
    ...fields,
    scope: learnedScope(db, board, getTask(db, task.parent_id)!),
    source: { event_id: based_on_decision === undefined ? attribution!.id : requireDecision(db, based_on_decision, reviewId) },
    author: { activity: "rca" as const, name: author },
  };
  return db.transaction(() => {
    const written =
      target.kind === "knowledge"
        ? recordKnowledge(db, entryInput, "worker", now, reviewId)
        : createBehaviorCandidate(db, { ...entryInput, addressee: target.addressee }, "worker", now);
    // 記憶の id は店の作成 event の id(Knowledge の event_id は書き込みの行の id)
    const payload = { kind: "proposed_from_material" as const, material_id, memory_event_id: written.entry_id };
    appendEvent(db, { taskId: reviewId, workerId: author, origin: "worker", payload, at: now });
    return written;
  })();
}

/** 起草の出所(propose_from_material): 材料の停止ならその session の worker と、その停止の最新の帰責(ADR 0310 決定4 —— 後の判定が有効)。
 *  他は異議されたエントリの書き手と、review の材料の異議群の帰責(ADR 0171 決定3)。材料に無い id・人間の書いたものは拒む。 */
function learnedFrom(db: Db, review: Task, material_id: number): { worker: string; attribution: { id: number; cause: Cause } | undefined } {
  const stop = materialStop(db, review.id);
  if (stop) {
    if (material_id !== stop.id) throw new DomainError(`id ${material_id} is not the stop this review was opened on`);
    const { events, spawned } = stoppedSession(db, stop);
    const worker = spawned.worker_id;
    if (worker === HUMAN_WORKER_ID) throw new DomainError(`stop ${material_id} stopped a session a human ran`);
    const judged = events.flatMap(({ id, payload: p }) => (p.kind === "stop_attributed" && p.stop_event_id === stop.id ? [{ id, cause: p.cause }] : [])).at(-1);
    return { worker, attribution: judged };
  }
  const entry = getEvent(db, material_id);
  if (!isDecisionLogEntry(entry) || entry.task_id !== review.parent_id) {
    throw new DomainError(`entry ${material_id} is not a decision-log entry of your parent task`);
  }
  if (entryObjections(db, [material_id]).length === 0) throw new DomainError(`entry ${material_id} carries no objection`);
  if (isHumanEntry(entry)) throw new DomainError(`entry ${material_id} was written by a human`);
  const opened = latestEventOfTask(db, review.id, "task_registered")!.payload.opened_on_event_ids ?? [];
  const bundle = objectionBundles(db, [material_id]).get(material_id)?.find((b) => opened.includes(bundleName(b)));
  if (!bundle) throw new DomainError(`entry ${material_id} is not in this review's material`);
  return { worker: entry.worker_id, attribution: bundle.attribution };
}

/** 材料が停止の RCA のその停止(ADR 0310 決定4): 登録の opened_on_event_ids が指す event が停止なら。材料が異議の RCA・RCA でない task は undefined。 */
export function materialStop(db: Db, reviewId: string): EventRowOf<"session_stopped_by_human"> | undefined {
  const [id] = latestEventOfTask(db, reviewId, "task_registered")?.payload.opened_on_event_ids ?? [];
  const event = id === undefined ? undefined : getEvent(db, id);
  return event?.payload.kind === "session_stopped_by_human" ? (event as EventRowOf<"session_stopped_by_human">) : undefined;
}

/** 材料が停止の RCA の get_current_task に注入する、止められた session の行動列(ADR 0310 決定2・4、判事と同じ形)。他の task には欄ごと無い。 */
export function stopMaterialActions(db: Db, reviewId: string): { actions: StopAttributionInput["actions"] } | undefined {
  const stop = materialStop(db, reviewId);
  return stop && { actions: sessionActions(db, stoppedSession(db, stop).spawned.id) };
}

/** 停止した session: 止められた task の event と、その停止を覆う spawn(停止は必ず spawn の後に書かれる)。 */
function stoppedSession(db: Db, stop: EventRowOf<"session_stopped_by_human">): { events: EventRow[]; spawned: EventRow } {
  const events = listEvents(db, stop.task_id!);
  return { events, spawned: sessionSpawnOf(events, stop)! };
}

/** RCA の材料: 停止ならその停止 event、異議なら登録の異議 id が指すエントリ(ADR 0278 決定5)。 */
function rcaMaterial(db: Db, reviewId: string, stop: EventRowOf<"session_stopped_by_human"> | undefined): Set<number> {
  if (stop) return new Set([stop.id]);
  return new Set(
    (latestEventOfTask(db, reviewId, "task_registered")!.payload.opened_on_event_ids ?? []).flatMap((id) => {
      const objection = getEvent(db, id)?.payload;
      return objection?.kind === "objection_raised" ? [objection.entry_id] : [];
    }),
  );
}

/** RCA の完了(ADR 0278 決定2〜5 / ADR 0280): 材料の各エントリはちょうど1つの所見に入り、足りない・重なる・材料に無いエントリは
 *  名指して拒み何も記録しない。所見ごとの行為は記録から列挙する —— この RCA の起草の記録のうち所見の material と交わるものの記憶と、
 *  この RCA の修理子(子は全所見に載る RCA 単位の近似、#2279)。行為の無い所見だけが no_proposal を要し、行為のある所見への
 *  no_proposal は受け取って何もしない。所見1つが型つきの判断ログ1行で、文は盤面が組み、完了と同じ transaction で書く。
 *  行と拒否文は id を材料の種類で名指す(異議の RCA は entries、停止の RCA は stop)。 */
export function completeRca(
  db: Db,
  review: Task,
  { findings, handoff }: { findings: Array<{ material: number[]; root_cause: string; no_proposal?: true }>; handoff?: Partial<HandoffDoc> },
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  if (!isRca(db, review.id)) throw new DomainError("only an RCA completes with complete_rca");
  const stop = materialStop(db, review.id);
  const noun = stop ? "stop" : "entries";
  if (findings.some((f) => f.material.length === 0)) throw new DomainError(`a finding names no ${noun}`);
  if (findings.some((f) => whyBlank(f.root_cause))) throw new DomainError("every finding requires a root_cause");
  const reviewMaterial = rcaMaterial(db, review.id, stop);
  const given = findings.flatMap((f) => f.material);
  const ids = (list: number[]) => [...new Set(list)].join(", ");
  const unknown = given.filter((id) => !reviewMaterial.has(id));
  const repeated = given.filter((id, i) => given.indexOf(id) !== i);
  const missing = [...reviewMaterial].filter((id) => !given.includes(id));
  const drafted = listEvents(db, review.id).flatMap(({ payload }) => (payload.kind === "proposed_from_material" ? [payload] : []));
  const repairs = repairChildren(db, review.id);
  const judged = findings.map(({ material, root_cause, no_proposal }) => {
    const memories = drafted
      .filter((d) => material.includes(d.material_id))
      .flatMap(({ memory_event_id: id }) => {
        const created = getEvent(db, id)?.payload;
        return created?.kind === "memory_entry_created" ? [{ id, kind: created.entry.kind }] : [];
      });
    const acts = [...memories.map(({ id, kind }) => `${kind === "behavior" ? "behavior candidate" : kind} #${id}`), ...repairs.map(({ id }) => `repair ${id}`)];
    // 行為のある所見への no_proposal は受け取って載せない(ADR 0278 決定3)
    const judgment = { kind: "rca" as const, material, root_cause: normalizeText(root_cause), memories, repairs, ...(!acts.length && no_proposal && { no_proposal }) };
    const named = `${noun} ${material.join(", ")}`;
    const line = acts.length ? `${named} → ${acts.join(", ")} — ${judgment.root_cause}` : `no_proposal: ${named} — ${judgment.root_cause}`;
    return { judgment, line, unjustified: !acts.length && !no_proposal };
  });
  const unjustified = judged.flatMap((j) => (j.unjustified ? j.judgment.material : []));
  const refusals = [
    unknown.length > 0 && `not in this RCA's material: ${noun} ${ids(unknown)}`,
    repeated.length > 0 && `named more than once: ${noun} ${ids(repeated)}`,
    missing.length > 0 && `in no finding: ${noun} ${ids(missing)}`,
    unjustified.length > 0 && `no act and no no_proposal: ${noun} ${ids(unjustified)} — draft from them, file a repair, or pass no_proposal: true`,
  ].filter(Boolean);
  if (refusals.length > 0) throw new DomainError(refusals.join("; "));
  return db.transaction(() => {
    for (const { judgment, line } of judged) {
      appendEvent(db, { taskId: review.id, workerId, origin, payload: { kind: "decision_logged", line, judgment }, at: now });
    }
    return finishTask(db, review, handoff, workerId, now, origin);
  })();
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
