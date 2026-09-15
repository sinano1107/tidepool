import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload, getEvent, listEvents, taskDecisionLog } from "./events.js";
import { type ExecutionSettingRow, loadExecutionSettingTable, rowFor } from "./execution-setting.js";
import { buildMemoryInjection, createBehaviorCandidate, memoryScope } from "./memory.js";
import { BOARD_WORKER_ID, DomainError, getRegistrant, getTask, HUMAN_WORKER_ID, listChildren, type Task } from "./tasks.js";
import { isAnthropicBoardCallBlocked } from "./throttle.js";
import { type DecisionLogEntry, listObjectedEntries, objectedEntryText } from "./triage.js";

/** Board call に渡す入力(ADR 0115 決定2): 異議されたエントリ本文・その steering 列・
 *  当時の decision log(異議されたタスクの decision_logged と完了エントリ)。agent
 *  定義本文・model 名・価格は渡さない —— 判断に要らず、配分評価の線と同じ。
 *  `entry_id` は Fake が entry ごとに応答を引く鍵で、model に意味は無い。
 *  `rca_findings` は第2回(#575)だけが足す: RCA 子(self / auditor)の decision log と
 *  完了 result を並べたもの。 */
export interface AttributionInput {
  entry_id: number;
  entry: string;
  steering: string[];
  decision_log: string[];
  rca_findings?: string[];
}

/** 帰責の構造化出力 —— 保存する値は `cause` 1つ、evidence は散文(ADR 0115 決定1)。 */
export interface AttributionJudgment {
  cause: Cause;
  evidence: string;
}

/** The Board call seam for attribution (draft / translation / allocation client と
 *  同型): `setting` は盤面が表から解決した Board call 自身の model / effort。 */
export interface AttributionClient {
  judge(
    input: AttributionInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
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
  draft(input: BehaviorDraftInput, setting: Pick<ExecutionSettingRow, "model" | "effort">): Promise<BehaviorDraft>;
}

/** 帰責と起草の Board call が扉から受け取るもの(各扉の deps がそのまま満たす)。 */
export interface BoardCallDeps {
  attributionClient?: AttributionClient;
  behaviorDraftClient?: BehaviorDraftClient;
  workspace?: { name: string };
}

const uncertain = (evidence: string): AttributionJudgment => ({ cause: "uncertain", evidence });

/** Board call を撃てるか。Provider / ティアは盤面設定の固定値(ADR 0111 決定4 と同じ枠)で、
 *  client 未設定・表の行の欠落・窓の閉鎖は「撃てなかった」として理由を返す。 */
function boardCallSetting<C>(
  db: Db,
  client: C | undefined,
): { client: C; setting: Pick<ExecutionSettingRow, "model" | "effort"> } | { unavailable: string } {
  if (!client) return { unavailable: "Board call not made: no client is configured" };
  let setting: Pick<ExecutionSettingRow, "model" | "effort">;
  try {
    setting = rowFor(loadExecutionSettingTable(db), "anthropic", "frontier");
  } catch (err) {
    return { unavailable: `Board call not made: ${message(err)}` };
  }
  if (isAnthropicBoardCallBlocked(db, setting.model)) {
    return { unavailable: "Board call not made: the Anthropic window is closed (throttled)" };
  }
  return { client, setting };
}

/** commit の前半(spec #563「commit の流れ」): open session の異議されたエントリを
 *  1度だけ集め、Board call を並列に問う。transaction の外で待ち、結果の map を持って
 *  従来の transaction に入る。撃てない・失敗した entry は `uncertain` + 理由の
 *  evidence に倒れ、ここからは投げない —— 帰責の障害は commit を止めない(決定2)。 */
export async function attributeObjections(
  db: Db,
  client: AttributionClient | undefined,
  sessionId: number,
): Promise<Map<number, AttributionJudgment>> {
  const objected = listObjectedEntries(db, sessionId);
  const judgments = new Map<number, AttributionJudgment>();
  if (objected.length === 0) return judgments;
  const call = boardCallSetting(db, client);
  if ("unavailable" in call) {
    for (const o of objected) judgments.set(o.entry.id, uncertain(call.unavailable));
    return judgments;
  }
  await Promise.all(
    objected.map(async (o) => {
      const input: AttributionInput = {
        entry_id: o.entry.id,
        entry: objectedEntryText(o.entry),
        steering: o.comments,
        decision_log: decisionLogText(db, o.entry.task_id),
      };
      try {
        judgments.set(o.entry.id, await call.client.judge(input, call.setting));
      } catch (err) {
        judgments.set(o.entry.id, uncertain(`Board call failed: ${message(err)}`));
      }
    }),
  );
  return judgments;
}

/** 帰責の第2回(ADR 0115 決定2 / issue #575): `settled` が異議されたタスクの RCA 子
 *  (self / auditor —— `registerRcaReview` が付ける `rca (` の題)で、それを最後にその
 *  タスクの RCA 子がすべて決着(完了 / 取り消し)したとき、初回が `uncertain` のままの
 *  entry ごとに1度だけ Board call を回し、RCA の findings を証拠にした cause を同じ entry
 *  への新しい event(round = after_rca)として追記する。
 *
 *  1度だけ、の門は2つ —— 決着したのが RCA 子自身で、それで全部が揃ったこと(後から同じ
 *  タスクの統合 review が決着しても撃たない)、そして entry の最新の注釈が `initial` で
 *  あること。撃てない・失敗した entry も初回と同じく `uncertain` + 理由の evidence で
 *  after_rca を追記するので、後日の新しい RCA 群の決着でも門は開かない(第3回は無い)。
 *  祖先の cancel / abandon に巻き込まれて RCA 子が決着した場合は撃たない(扉には根が渡る)
 *  —— 何も調べずに取り消された RCA の findings は空で、問い直す証拠が無いため。
 *  settlement の書き込みと同じ tick で呼ぶ: Board call の await より前はすべて同期なので、
 *  2つの扉が同時に「全部揃った」を見ることは無い。 */
export async function attributeAfterRca(
  db: Db,
  deps: BoardCallDeps,
  settled: Task,
  now: Date,
): Promise<void> {
  if (settled.type !== "review" || settled.parent_id === null) return;
  const objectedId = settled.parent_id;
  // ponytail: RCA 子の目印は題の接頭辞だけ —— task_registered に構造化された印が無い
  const rca = listChildren(db, objectedId).filter((c) => c.type === "review" && c.title.startsWith("rca ("));
  if (!rca.some((r) => r.id === settled.id) || rca.some((r) => r.status !== "done" && r.status !== "cancelled")) {
    return;
  }
  // 最新の帰責が entry ごとに有効(spec #563): 初回の uncertain だけが第2回の対象
  const latest = new Map<number, { id: number } & Extract<EventPayload, { kind: "objection_attributed" }>>();
  for (const e of listEvents(db, objectedId)) {
    if (e.payload.kind === "objection_attributed") latest.set(e.payload.entry_id, { id: e.id, ...e.payload });
  }
  const pending = [...latest.values()].filter((e) => e.cause === "uncertain" && e.round === "initial");
  if (pending.length === 0) return;
  const record = (initial: (typeof pending)[number], judgment: AttributionJudgment) => {
    const payload = {
      kind: "objection_attributed" as const,
      entry_id: initial.entry_id,
      objection_event_ids: initial.objection_event_ids,
      ...judgment,
      round: "after_rca" as const,
    };
    return { id: appendEvent(db, { taskId: objectedId, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now }), ...payload };
  };
  const call = boardCallSetting(db, deps.attributionClient);
  if ("unavailable" in call) {
    for (const initial of pending) record(initial, uncertain(call.unavailable));
    return;
  }
  const rcaFindings = rca.flatMap((r) => decisionLogText(db, r.id));
  await Promise.all(
    pending.map(async (initial) => {
      let judgment: AttributionJudgment;
      // 当時の decision log = 初回の注釈より前に書かれた entry
      const input = { ...objectionInput(db, initial), rca_findings: rcaFindings };
      try {
        judgment = await call.client.judge(input, call.setting);
      } catch (err) {
        judgment = uncertain(`Board call failed: ${message(err)}`);
      }
      // 第2回の確定は起草の契機(ADR 0120 決定1(b)(c))
      await draftBehaviorCandidate(db, deps, record(initial, judgment), now, input);
    }),
  );
}

/** commit が書いた初回の帰責(`since` より後の event)ごとに起草を fire-and-forget する。境で切るのは、
 *  commit が束ねなかった entry の古い帰責から二度起草しないため。 */
export function draftAfterCommit(db: Db, deps: BoardCallDeps, since: number, now: Date): void {
  const rows = db.prepare("SELECT id FROM events WHERE kind = 'objection_attributed' AND id > ? ORDER BY id").all(since) as { id: number }[];
  for (const { id } of rows) {
    const payload = getEvent(db, id)!.payload;
    if (payload.kind !== "objection_attributed") continue;
    void draftBehaviorCandidate(db, deps, { id, ...payload }, now).catch((err) =>
      console.error(`[memory-draft] ${payload.entry_id}: ${String(err)}`),
    );
  }
}

/** 帰責の入力を注釈 event から組む: 異議エントリ本文・steering 列・その注釈より前の decision log。 */
function objectionInput(
  db: Db,
  attribution: { id: number; entry_id: number; objection_event_ids: number[] },
): AttributionInput {
  const entry = getEvent(db, attribution.entry_id) as DecisionLogEntry;
  return {
    entry_id: entry.id,
    entry: objectedEntryText(entry),
    steering: attribution.objection_event_ids.map((id) => {
      const p = getEvent(db, id)?.payload;
      return p?.kind === "objection_raised" ? p.comment : "";
    }),
    decision_log: decisionLogText(db, entry.task_id, attribution.id),
  };
}

/** 帰責が起草に向くエントリから Board call で Behavior candidate を起草する(ADR 0120 決定1(b)(c) /
 *  issue #617): 初回は `preference` だけ、第2回は学習向きの cause すべて。人間エントリと起草 client の
 *  無い盤面は何もしない。宛先は cause から導出し(ADR 0115 決定4)、Board call の `addressee` は
 *  `preference` だけが読む。撃てない・失敗は `memory_draft_failed` に畳み、ここからは投げない ——
 *  帰責の transaction の後に走り、commit も settlement も止めない。 */
export async function draftBehaviorCandidate(
  db: Db,
  deps: BoardCallDeps,
  attribution: { id: number } & Extract<EventPayload, { kind: "objection_attributed" }>,
  now: Date,
  input: AttributionInput = objectionInput(db, attribution),
): Promise<void> {
  const { cause, round, entry_id } = attribution;
  const drafts = round === "initial" ? cause === "preference" : LEARNING_CAUSES.includes(cause);
  const entry = getEvent(db, entry_id) as DecisionLogEntry;
  if (!deps.behaviorDraftClient || !drafts || isHumanEntry(entry)) return;
  const taskId = entry.task_id;
  try {
    const task = getTask(db, taskId)!;
    // preference の宛先は Board call が選ぶ。他の cause は導出(登録者が agent でなければここで失敗)
    const derived =
      cause === "preference" ? null : learningTarget(cause, entry.worker_id, getRegistrant(db, taskId), cause === "missing_information" ? "behavior" : undefined);
    const scope = memoryScope(deps, task);
    const call = boardCallSetting(db, deps.behaviorDraftClient);
    if ("unavailable" in call) throw new Error(call.unavailable);
    const index = buildMemoryInjection(db, task, scope, entry.worker_id).section;
    const { addressee, ...draft } = await call.client.draft({ ...input, index }, call.setting);
    createBehaviorCandidate(
      db,
      {
        ...draft,
        scope,
        addressee: derived?.kind === "behavior" ? derived.addressee : addressee === "all" ? null : entry.worker_id,
        source: { event_id: attribution.id },
        author: { activity: "board", name: BOARD_WORKER_ID },
      },
      "board",
      now,
    );
  } catch (err) {
    appendEvent(db, {
      taskId,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "memory_draft_failed", entry_id, round, reason: message(err) },
      at: now,
    });
  }
}

/** そのタスクの decision log を人間が読んだ本文の列に(`before` を渡せばその event id
 *  より前のものだけ = 当時の log)。 */
function decisionLogText(db: Db, taskId: string, before = Number.POSITIVE_INFINITY): string[] {
  return (taskDecisionLog(db, taskId) as DecisionLogEntry[])
    .filter((e) => e.id < before)
    .map(objectedEntryText);
}

/** entry への最新の帰責(同じ entry への追記は最新が有効 —— spec #563)。無ければ undefined。 */
export function latestAttribution(
  db: Db,
  entry: { id: number; task_id: string },
): ({ id: number } & Extract<EventPayload, { kind: "objection_attributed" }>) | undefined {
  let latest: ReturnType<typeof latestAttribution>;
  for (const e of listEvents(db, entry.task_id)) {
    if (e.payload.kind === "objection_attributed" && e.payload.entry_id === entry.id) latest = { id: e.id, ...e.payload };
  }
  return latest;
}

/** 人間が書いたエントリか —— 宛先となる agent を持たない(self RCA も立たない)。 */
export const isHumanEntry = (entry: { worker_id: string }) => entry.worker_id === HUMAN_WORKER_ID;

const LEARNING_CAUSES: readonly Cause[] = ["capability", "preference", "task_ambiguity", "missing_information"];

/** 学習の行き先を cause から導出する(ADR 0115 決定4)。`as` は `missing_information` だけが
 *  要り、Knowledge は宛先を持たない。Behavior の宛先が agent に落ちなければ DomainError。 */
export function learningTarget(
  cause: Cause,
  entryWorker: string,
  registrant: string,
  as?: "behavior" | "knowledge",
): { kind: "behavior"; addressee: string } | { kind: "knowledge" } {
  if (!LEARNING_CAUSES.includes(cause)) throw new DomainError(`the entry's cause is ${cause}: nothing to learn from it`);
  if ((cause === "missing_information") !== (as !== undefined)) {
    throw new DomainError('as ("behavior" or "knowledge") is required for a missing_information entry and only for it');
  }
  const toRegistrant = () => {
    // 盤面(BOARD_WORKER_ID)も agent ではない —— 宛先にしても注入はどこにも一致しない
    if (registrant === HUMAN_WORKER_ID || registrant === BOARD_WORKER_ID) {
      throw new DomainError("the task was not registered by an agent: there is no agent to address a behavior to");
    }
    return { kind: "behavior" as const, addressee: registrant };
  };
  switch (cause) {
    case "capability":
    case "preference":
      return { kind: "behavior", addressee: entryWorker };
    case "task_ambiguity":
      return toRegistrant();
    case "missing_information":
      return as === "knowledge" ? { kind: "knowledge" } : toRegistrant();
    default:
      throw new DomainError(`the entry's cause is ${cause}: nothing to learn from it`);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
