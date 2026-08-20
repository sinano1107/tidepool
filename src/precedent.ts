import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { type EventRow, getEvent, listEvents } from "./events.js";
import { parseStreamLine, readInitVersion } from "./stream-json.js";

/** Precedent(前例)の投影 — 盤面の記録(events + worker transcript)から
 *  Episode を決定論的に組む(ADR 0083 決定8 / 追記 / 追記 2、issue #356)。
 *  LLM は使わない。意味付けは meta-review の仕事であって、ここの仕事ではない。 */

/** どの tool のどの引数を行動行に写すか、1箇所の表(issue #356 Key interfaces)。
 *  ここに無い tool は**名前だけ**の行になる — それは欠測ではなく「引数を抽出
 *  しない」という決定である。`Task` と `Agent` は同じ subagent 起動の綴り違い
 *  (実 CLI は `Agent`、init の `tools` には `Task` が残る — ADR 0083 追記 2)。 */
const TOOL_ARG_FIELD: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
  Bash: "command",
  Task: "description",
  Agent: "description",
};

/** `system` 行の subtype → 構造マーカー。`compact_boundary` は**想定の綴り**で、
 *  実物は #386 のフィクスチャにも Pi の worker-logs にも無い。外れていても
 *  未知行カウンタに出るので黙って壊れない(ADR 0083 追記 2 が版の下限による
 *  quarantine を退けたのと同じ理由 — 綴りは門ではなく観測で扱う)。 */
const STRUCTURAL_MARKER_SUBTYPE: Record<string, MarkerKind | undefined> = {
  compact_boundary: "compaction",
  vcs_state_changed: "commit",
};

/** 「知っていて捨てる」行 — 解釈しないと決めた既知の行種(ADR 0083 追記 2 決定6)。
 *  抽出表と同じ1箇所に置く(issue #356 Key interfaces)。 */
const IGNORED_TYPES = new Set(["rate_limit_event"]);
const IGNORED_SYSTEM_SUBTYPES = new Set([
  "thinking_tokens",
  "task_started",
  "task_progress",
  "task_updated",
]);
/** 解釈する行種。`result` の subtype は結末の種別であって行の形ではないので
 *  type だけで見る。 */
const INTERPRETED_TYPES = new Set(["assistant", "user", "result"]);
const INTERPRETED_SYSTEM_SUBTYPES = new Set([
  "init",
  "task_notification",
  ...Object.keys(STRUCTURAL_MARKER_SUBTYPE),
]);

export interface EpisodeAction {
  /** 行動列の中の位置(0 始まり)。マーカーはこの位置を指す。 */
  index: number;
  tool: string;
  /** `TOOL_ARG_FIELD` で抽出した引数。null は「この tool は引数を抽出しない」。 */
  args: string | null;
  /** tool_result の `is_error === true` だけが失敗。欠落は成功(実測)。 */
  failed: boolean;
  /** transcript 行への参照。派生は薄く、原文は transcript が正本(ADR 0083 追記)。 */
  transcriptUuid: string;
  toolUseId: string;
  /** `parent_tool_use_id` 非 null = subagent が出した行動(#386 で実測)。 */
  subagent: boolean;
  /** subagent 起動行(`Agent` / `Task`)にだけ付く、その subagent 自身の消費
   *  ——`task_notification` 行が `tool_use_id` で結んで運ぶ(ADR 0083 追記 2 決定4)。
   *  **合算外の観測**である: 「合算は親スレッドのみ」の線は変えず、session 単位の
   *  消費は `worker_exited.usage` を正本として読む。行動行がトークン欄を持たない
   *  のは、assistant 行の `usage` が message 開始時のスナップショットで行動単位の
   *  消費ではないため(追記 2、実測)。 */
  subagentUsage: SubagentUsage | null;
}

/** `task_notification` が運ぶ subagent 自身の消費。CLI の綴りをそのまま持つ —
 *  盤面が別名を与えると、綴りが変わったことが観測できなくなる。 */
export interface SubagentUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

/** 構造マーカーは3つだけ(ADR 0083 追記 2 決定5)。subagent の lifecycle は
 *  行動行の `subagent` フラグで既に表現されるので重ねない。advisor 相談は
 *  マーカーだけ — 結果は暗号化されていて抽出するものが無く、行動行にも載せると
 *  二重になる。`decision` は構造ではなく判断のマーカー。 */
export type MarkerKind = "decision" | "compaction" | "commit" | "advisor";

/** transcript に結べなかった `decision_logged` が持つ欠測理由。「空 = 何も
 *  しなかった」と区別するために理由コードで明示する(ADR 0083 追記 2)。
 *  ヒューリスティック結合は作らないので、結合は完全一致の1種類しかない。 */
export type DecisionMissingReason =
  /** transcript の `log_decision` の tool_result が event id を1つも写して
   *  いない = スライス A(#384)より前の盤面が書いた記録。 */
  | "no_event_id"
  /** event id は写っているが、この decision の id はその中に無い。 */
  | "unmatched";

export interface EpisodeMarker {
  kind: MarkerKind;
  /** 行動列内の位置 = そのマーカーより前にあった行動の数。
   *  `actions.slice(0, position)` が「ここまでにやったこと」。
   *  null は結べなかった decision(位置を持たない)。 */
  position: number | null;
  /** `decision` マーカーが指す `decision_logged` の event id。他の種別では null。 */
  eventId: number | null;
  missingReason: DecisionMissingReason | null;
  /** 根拠になった transcript 行。decision では event id を写した tool_result の行。 */
  transcriptUuid: string | null;
}

/** 行の解釈の3値(ADR 0083 追記 2 決定6)。rate limit や thinking token の通知の
 *  ような「知っていて捨てる」行を未知に混ぜると、形式変更の信号が常時のノイズに
 *  埋もれる。 */
export interface EpisodeLineStats {
  total: number;
  interpreted: number;
  ignored: number;
  unknown: number;
  /** 未知の内訳。`type`、subtype があれば `type/subtype`。壊れた行は
   *  `unparseable`。増減が投影器の変更か CLI の変更かは、これと
   *  `claudeCodeVersion` の対で見分ける。 */
  unknownKinds: Record<string, number>;
}

export interface Episode {
  /** 同一性キー — この session を開いた `worker_spawned` の event id。 */
  workerSpawnedEventId: number;
  taskId: string;
  actions: EpisodeAction[];
  markers: EpisodeMarker[];
  /** 版1: 当時の agent 定義(ADR 0001 の厳密な agent 版)。 */
  registryCommit: string | null;
  definitionVersion: string | null;
  /** 版2: この投影器の版。派生は作り直せるので、読み方が変われば版を上げる。 */
  extractorVersion: string;
  /** 版3: transcript を書いた CLI の版(init 行)。 */
  claudeCodeVersion: string | null;
  /** session 単位の outcome のうち、exit の時点で確定しているもの。あとから
   *  届く事実(PR merge、異議、表示済み)は投影に焼かず読み出し時に結ぶ。 */
  completed: { result: string | null; handoffPresent: boolean } | null;
  exitCode: number | null;
  signal: string | null;
  /** session 単位の消費の正本への参照(`worker_exited.usage`)。行動行にも
   *  Episode にもトークンは写さない(ADR 0083 追記 2)。 */
  workerExitedEventId: number | null;
  lines: EpisodeLineStats;
  /** tool 呼び出し 0 件かつ未知行あり = この transcript は読めていない。
   *  session 単位で「無かったこと」にしないための fail-closed の印。 */
  unrecognizedFormat: boolean;
}

export interface ProjectEpisodeInput {
  transcriptLines: string[];
  events: EventRow[];
  workerSpawnedEventId: number;
  extractorVersion: string;
}

/** `task_notification.usage` を、3欄すべて数であるときだけ読む。欠けていれば
 *  「観測できなかった」= null で、0 とは区別する。 */
function readSubagentUsage(value: unknown): SubagentUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const { total_tokens, tool_uses, duration_ms } = value as Record<string, unknown>;
  if (typeof total_tokens !== "number") return null;
  if (typeof tool_uses !== "number" || typeof duration_ms !== "number") return null;
  return { total_tokens, tool_uses, duration_ms };
}

/** 未知行の内訳キー。subtype があれば `type/subtype`。 */
const lineKey = (parsed: Record<string, unknown>): string =>
  parsed.subtype == null ? String(parsed.type) : `${String(parsed.type)}/${String(parsed.subtype)}`;

/** 純関数。DB もファイルシステムも触らない。フィクスチャ2本から Episode を
 *  組めることが受け入れの中心(issue #356)。 */
export function projectEpisode(input: ProjectEpisodeInput): Episode {
  const spawned = input.events.find((e) => e.id === input.workerSpawnedEventId);
  if (!spawned || spawned.payload.kind !== "worker_spawned") {
    throw new Error(`no worker_spawned event ${input.workerSpawnedEventId}`);
  }
  const actions: EpisodeAction[] = [];
  const markers: EpisodeMarker[] = [];
  const byToolUseId = new Map<string, EpisodeAction>();
  /** tool_result に写った event id → その `log_decision` 行動の位置。 */
  const loggedAt = new Map<number, { position: number; transcriptUuid: string }>();
  const lines: EpisodeLineStats = {
    total: 0,
    interpreted: 0,
    ignored: 0,
    unknown: 0,
    unknownKinds: {},
  };
  let claudeCodeVersion: string | null = null;

  for (const line of input.transcriptLines) {
    // 行の切れ目そのもの(末尾改行が生む空文字を含む)は行ではない
    if (!line.trim()) continue;
    lines.total += 1;
    const parsed = parseStreamLine(line);
    if (parsed === null) {
      lines.unknown += 1;
      lines.unknownKinds.unparseable = (lines.unknownKinds.unparseable ?? 0) + 1;
      continue;
    }
    const type = String(parsed.type);
    const subtype = parsed.subtype == null ? null : String(parsed.subtype);
    const known =
      type === "system"
        ? (subtype !== null && INTERPRETED_SYSTEM_SUBTYPES.has(subtype)) ||
          (subtype !== null && IGNORED_SYSTEM_SUBTYPES.has(subtype))
        : INTERPRETED_TYPES.has(type) || IGNORED_TYPES.has(type);
    if (!known) {
      // 未知の行は数えて残す — fail-closed は行単位で、session 単位で
      // 「無かったこと」にはしない(issue #356 完了基準5)
      lines.unknown += 1;
      const key = lineKey(parsed);
      lines.unknownKinds[key] = (lines.unknownKinds[key] ?? 0) + 1;
      continue;
    }
    const ignored =
      type === "system" ? IGNORED_SYSTEM_SUBTYPES.has(subtype ?? "") : IGNORED_TYPES.has(type);
    if (ignored) {
      lines.ignored += 1;
      continue;
    }
    lines.interpreted += 1;

    claudeCodeVersion = readInitVersion(parsed) ?? claudeCodeVersion;
    const structural = subtype === null ? undefined : STRUCTURAL_MARKER_SUBTYPE[subtype];
    if (type === "system" && structural) {
      markers.push({
        kind: structural,
        position: actions.length,
        eventId: null,
        missingReason: null,
        transcriptUuid: typeof parsed.uuid === "string" ? parsed.uuid : "",
      });
      continue;
    }
    if (type === "system" && subtype === "task_notification") {
      const action = byToolUseId.get(String(parsed.tool_use_id));
      if (action) action.subagentUsage = readSubagentUsage(parsed.usage);
      continue;
    }
    const content = (parsed.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const {
        type: blockType,
        name,
        id,
        input: toolInput,
        tool_use_id,
        is_error,
      } = block as Record<string, unknown>;
      // advisor 相談はマーカーだけ(ADR 0083 追記 2 決定5)。server tool なので
      // 普通の tool_use ブロックと同じ行に並ぶが、行動行にすると3マーカーと
      // 二重になり、結果は暗号化されていて抽出するものも無い。
      if (blockType === "server_tool_use" && name === "advisor") {
        markers.push({
          kind: "advisor",
          position: actions.length,
          eventId: null,
          missingReason: null,
          transcriptUuid: typeof parsed.uuid === "string" ? parsed.uuid : "",
        });
      }
      if (blockType === "tool_use" && typeof name === "string" && typeof id === "string") {
        const field = TOOL_ARG_FIELD[name];
        const value = field ? (toolInput as Record<string, unknown> | undefined)?.[field] : null;
        const action: EpisodeAction = {
          index: actions.length,
          tool: name,
          args: typeof value === "string" ? value : null,
          failed: false,
          transcriptUuid: typeof parsed.uuid === "string" ? parsed.uuid : "",
          toolUseId: id,
          subagent: parsed.parent_tool_use_id != null,
          subagentUsage: null,
        };
        actions.push(action);
        byToolUseId.set(id, action);
      }
      if (blockType === "tool_result" && typeof tool_use_id === "string") {
        const action = byToolUseId.get(tool_use_id);
        if (!action) continue;
        action.failed = is_error === true;
        const eventId = readLoggedEventId(action.tool, (block as Record<string, unknown>).content);
        if (eventId !== null) {
          loggedAt.set(eventId, {
            position: action.index,
            transcriptUuid: typeof parsed.uuid === "string" ? parsed.uuid : "",
          });
        }
      }
    }
  }

  const exited = findExited(input);
  const exitPayload = exited?.payload.kind === "worker_exited" ? exited.payload : null;
  const completed = input.events.find(
    (e) =>
      e.kind === "task_completed" &&
      e.task_id === spawned.task_id &&
      e.id > spawned.id &&
      e.id <= (exited?.id ?? Number.POSITIVE_INFINITY),
  );
  markers.push(...decisionMarkers(input, spawned, exited, loggedAt));
  // 位置順。結べなかった decision(position null)は末尾に残る — 消さないことが
  // 「空 = 何もしなかった」との区別そのもの。
  markers.sort(
    (a, b) => (a.position ?? Number.POSITIVE_INFINITY) - (b.position ?? Number.POSITIVE_INFINITY),
  );
  return {
    workerSpawnedEventId: input.workerSpawnedEventId,
    taskId: spawned.task_id,
    actions,
    markers,
    registryCommit: spawned.payload.registry_commit,
    definitionVersion: spawned.payload.definition_version,
    extractorVersion: input.extractorVersion,
    claudeCodeVersion,
    completed:
      completed?.payload.kind === "task_completed"
        ? { result: completed.payload.result, handoffPresent: completed.payload.handoff_present }
        : null,
    exitCode: exitPayload?.exit_code ?? null,
    signal: exitPayload?.signal ?? null,
    workerExitedEventId: exited?.id ?? null,
    lines,
    unrecognizedFormat: actions.length === 0 && lines.unknown > 0,
  };
}

/** この spawn を閉じた `worker_exited`(issue #379 が置いたポインタで引く)。 */
const findExited = (input: ProjectEpisodeInput): EventRow | undefined =>
  input.events.find(
    (e) =>
      e.payload.kind === "worker_exited" &&
      e.payload.worker_spawned_event_id === input.workerSpawnedEventId,
  );

/** この session の `decision_logged` を、盤面が発行した event id の**完全一致**で
 *  行動列に結ぶ(ADR 0083 追記 2 — ヒューリスティック結合は作らない)。出現順や
 *  文言では結ばない: フィクスチャの events 6 と 7 は文言が完全に同一である。 */
function decisionMarkers(
  input: ProjectEpisodeInput,
  spawned: EventRow,
  exited: EventRow | undefined,
  loggedAt: Map<number, { position: number; transcriptUuid: string }>,
): EpisodeMarker[] {
  // 1タスクに複数の worker session がありうる(retry / 統合復帰 / quarantine
  // 復帰 — issue #379)ので、この spawn ~ exit の窓に入る decision だけを見る。
  // 窓で切らないと、同じタスクの前の session の判断が全部この Episode の
  // `unmatched` として湧く。
  const end = exited?.id ?? Number.POSITIVE_INFINITY;
  return input.events
    .filter(
      (e) =>
        e.kind === "decision_logged" &&
        e.task_id === spawned.task_id &&
        e.id > spawned.id &&
        e.id <= end,
    )
    .map((e) => {
      const hit = loggedAt.get(e.id);
      return {
        kind: "decision" as const,
        position: hit?.position ?? null,
        eventId: e.id,
        missingReason: hit ? null : loggedAt.size === 0 ? "no_event_id" : "unmatched",
        transcriptUuid: hit?.transcriptUuid ?? null,
      };
    });
}

/** `log_decision` の tool_result に写った盤面発行の event id(スライス A / #384)。
 *  応答は text ブロックの中の JSON 文字列という二重の包みで届くので、そこまで
 *  剥がす。tool 名で絞るのは、他の verb の応答に `event_id` が生えたときに
 *  黙って decision として結ばれないようにするため。 */
function readLoggedEventId(tool: string, content: unknown): number | null {
  if (!/__log_decision$/.test(tool) || !Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, text } = block as Record<string, unknown>;
    if (type !== "text" || typeof text !== "string") continue;
    try {
      const body = JSON.parse(text) as { event_id?: unknown };
      if (typeof body.event_id === "number") return body.event_id;
    } catch {
      // 応答が JSON でない = 結合キーは写っていない
    }
  }
  return null;
}

/** 投影器の版(ADR 0083 追記 2 決定7)。読み方を変えたらここを上げる — 派生表は
 *  記録から何度でも作り直せるので、古い版の Episode を消す必要はない。 */
export const EXTRACTOR_VERSION = "1";

/** 1つの worker session を投影して派生表に書く。同じ session を同じ投影器の版で
 *  二度書くことはない(`UNIQUE (worker_spawned_event_id, extractor_version)`)—
 *  戻り値は書いた episode の id、既にあるか投影できなかったときは null。 */
export function projectAndPersist(
  db: Db,
  opts: { workerSpawnedEventId: number; transcriptPath: string; extractorVersion?: string },
): number | null {
  const extractorVersion = opts.extractorVersion ?? EXTRACTOR_VERSION;
  const spawned = getEvent(db, opts.workerSpawnedEventId);
  if (!spawned || spawned.payload.kind !== "worker_spawned") return null;
  const episode = projectEpisode({
    transcriptLines: readFileSync(opts.transcriptPath, "utf8").split("\n"),
    // 投影器の入力は既存の task 単位の read API そのまま(issue #356 の
    // 「events 側の read API を新設しない」)
    events: listEvents(db, spawned.task_id),
    workerSpawnedEventId: opts.workerSpawnedEventId,
    extractorVersion,
  });
  const workspace = (
    db.prepare("SELECT workspace FROM tasks WHERE id = ?").get(spawned.task_id) as
      | { workspace: string | null }
      | undefined
  )?.workspace;
  // episode 行だけが入って行動行が入らない状態になると、冪等キーだけ埋まって
  // 投影のやり直しが永久に塞がれる — 3表は1つのトランザクションで書く
  return db.transaction(() => {
    const { changes, lastInsertRowid } = db
      .prepare(
        `INSERT INTO episodes (worker_spawned_event_id, extractor_version, task_id, workspace, agent,
           registry_commit, definition_version, claude_code_version, completed_handoff, completed_result,
           exit_code, signal, worker_exited_event_id, lines, unrecognized_format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (worker_spawned_event_id, extractor_version) DO NOTHING`,
      )
      .run(
        episode.workerSpawnedEventId,
        extractorVersion,
        episode.taskId,
        workspace ?? null,
        spawned.worker_id,
        episode.registryCommit,
        episode.definitionVersion,
        episode.claudeCodeVersion,
        episode.completed ? Number(episode.completed.handoffPresent) : null,
        episode.completed?.result ?? null,
        episode.exitCode,
        episode.signal,
        episode.workerExitedEventId,
        JSON.stringify(episode.lines),
        Number(episode.unrecognizedFormat),
      );
    if (changes === 0) return null;
    const episodeId = Number(lastInsertRowid);
    const insertAction = db.prepare(
      `INSERT INTO episode_actions (episode_id, idx, tool, args, failed, transcript_uuid, tool_use_id,
         subagent, subagent_usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of episode.actions) {
      insertAction.run(
        episodeId,
        a.index,
        a.tool,
        a.args,
        Number(a.failed),
        a.transcriptUuid,
        a.toolUseId,
        Number(a.subagent),
        a.subagentUsage ? JSON.stringify(a.subagentUsage) : null,
      );
    }
    const insertMarker = db.prepare(
      `INSERT INTO episode_markers (episode_id, seq, kind, position, event_id, missing_reason, transcript_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    episode.markers.forEach((m, seq) => {
      insertMarker.run(episodeId, seq, m.kind, m.position, m.eventId, m.missingReason, m.transcriptUuid);
    });
    return episodeId;
  })();
}

/** 読み出し時に結ぶ outcome を持つマーカー。表示済み・異議は投影のあとに届く
 *  ので派生表には焼かない(ADR 0083 決定7: 正の信号は「表示済み・異議なし」から
 *  機械導出する — 分母は Displayed)。 */
export interface StoredMarker extends EpisodeMarker {
  /** decision の文言。transcript と events が正本なので、読み出し時に引く。 */
  line: string | null;
  displayed: boolean;
  objections: string[];
}

export interface StoredEpisode extends Omit<Episode, "markers"> {
  id: number;
  workspace: string | null;
  agent: string;
  markers: StoredMarker[];
  /** 盤面が merge した / merge 済みと観測した PR(ADR 0079 決定4)。投影のあとに
   *  届く事実なので読み出し時に結ぶ。 */
  prMerged: number | null;
}

/** Precedent の内部読み口(issue #356 完了基準4)— (workspace, agent) で Episode を
 *  時系列に返す。「ある decision までの行動」は保存時の決定ではなく、マーカーの
 *  `position` で `actions` を切る読み出し時のスライスである(ADR 0083 追記)。 */
export function listEpisodes(
  db: Db,
  filter: { workspace?: string; agent?: string; extractorVersion?: string },
): StoredEpisode[] {
  const where: string[] = ["extractor_version = ?"];
  const params: unknown[] = [filter.extractorVersion ?? EXTRACTOR_VERSION];
  if (filter.workspace !== undefined) {
    where.push("workspace = ?");
    params.push(filter.workspace);
  }
  if (filter.agent !== undefined) {
    where.push("agent = ?");
    params.push(filter.agent);
  }
  // 時系列 = session を開いた worker_spawned の event id 順(events は append-only)
  const rows = db
    .prepare(
      `SELECT * FROM episodes WHERE ${where.join(" AND ")} ORDER BY worker_spawned_event_id`,
    )
    .all(...params) as EpisodeRow[];
  if (rows.length === 0) return [];

  const actionRows = db
    .prepare(
      `SELECT * FROM episode_actions WHERE episode_id IN (${rows.map(() => "?").join(", ")}) ORDER BY episode_id, idx`,
    )
    .all(...rows.map((r) => r.id)) as ActionRow[];
  const markerRows = db
    .prepare(
      `SELECT * FROM episode_markers WHERE episode_id IN (${rows.map(() => "?").join(", ")}) ORDER BY episode_id, seq`,
    )
    .all(...rows.map((r) => r.id)) as MarkerRow[];
  const decisions = decisionOutcomes(db, markerRows);

  return rows.map((row) => ({
    id: row.id,
    workerSpawnedEventId: row.worker_spawned_event_id,
    taskId: row.task_id,
    workspace: row.workspace,
    agent: row.agent,
    registryCommit: row.registry_commit,
    definitionVersion: row.definition_version,
    extractorVersion: row.extractor_version,
    claudeCodeVersion: row.claude_code_version,
    completed:
      row.completed_handoff === null
        ? null
        : { result: row.completed_result, handoffPresent: row.completed_handoff === 1 },
    exitCode: row.exit_code,
    signal: row.signal,
    workerExitedEventId: row.worker_exited_event_id,
    lines: JSON.parse(row.lines) as EpisodeLineStats,
    unrecognizedFormat: row.unrecognized_format === 1,
    prMerged: readMergedPr(db, row.task_id),
    actions: actionRows
      .filter((a) => a.episode_id === row.id)
      .map((a) => ({
        index: a.idx,
        tool: a.tool,
        args: a.args,
        failed: a.failed === 1,
        transcriptUuid: a.transcript_uuid,
        toolUseId: a.tool_use_id,
        subagent: a.subagent === 1,
        subagentUsage: a.subagent_usage ? (JSON.parse(a.subagent_usage) as SubagentUsage) : null,
      })),
    markers: markerRows
      .filter((m) => m.episode_id === row.id)
      .map((m) => ({
        kind: m.kind,
        position: m.position,
        eventId: m.event_id,
        missingReason: m.missing_reason,
        transcriptUuid: m.transcript_uuid,
        ...(decisions.get(m.event_id ?? -1) ?? { line: null, displayed: false, objections: [] }),
      })),
  }));
}

/** decision マーカーの outcome — 表示済み(異議の分母)と異議の本文。`listLog` と
 *  同じ形で `entry_id` で引く: エントリを指す id であって task_id ではないので、
 *  同じタスクかどうかは仮定しない。 */
function decisionOutcomes(
  db: Db,
  markerRows: MarkerRow[],
): Map<number, { line: string | null; displayed: boolean; objections: string[] }> {
  const ids = [...new Set(markerRows.map((m) => m.event_id).filter((id) => id !== null))];
  const out = new Map<number, { line: string | null; displayed: boolean; objections: string[] }>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  for (const id of ids) out.set(id, { line: null, displayed: false, objections: [] });
  for (const row of db
    .prepare(`SELECT id, json_extract(payload, '$.line') AS line FROM events WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: number; line: string | null }>) {
    const entry = out.get(row.id);
    if (entry) entry.line = row.line;
  }
  for (const row of db
    .prepare(
      `SELECT kind, json_extract(payload, '$.entry_id') AS entry_id,
              json_extract(payload, '$.comment') AS comment
         FROM events
        WHERE kind IN ('objection_raised', 'log_entry_displayed')
          AND json_extract(payload, '$.entry_id') IN (${placeholders})
        ORDER BY id`,
    )
    .all(...ids) as Array<{ kind: string; entry_id: number; comment: string | null }>) {
    const entry = out.get(row.entry_id);
    if (!entry) continue;
    if (row.kind === "log_entry_displayed") entry.displayed = true;
    else if (row.comment !== null) entry.objections.push(row.comment);
  }
  return out;
}

/** この Episode のタスクの PR が merge されたか。盤面が merge した場合と、
 *  merge 済みだと観測した場合の両方(ADR 0079 決定4)。 */
function readMergedPr(db: Db, taskId: string): number | null {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.pr_number') AS pr_number FROM events
        WHERE task_id = ? AND kind IN ('pr_merged', 'pr_merge_observed') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { pr_number: number } | undefined;
  return row?.pr_number ?? null;
}

interface EpisodeRow {
  id: number;
  worker_spawned_event_id: number;
  extractor_version: string;
  task_id: string;
  workspace: string | null;
  agent: string;
  registry_commit: string | null;
  definition_version: string | null;
  claude_code_version: string | null;
  completed_handoff: number | null;
  completed_result: string | null;
  exit_code: number | null;
  signal: string | null;
  worker_exited_event_id: number | null;
  lines: string;
  unrecognized_format: number;
}

interface ActionRow {
  episode_id: number;
  idx: number;
  tool: string;
  args: string | null;
  failed: number;
  transcript_uuid: string;
  tool_use_id: string;
  subagent: number;
  subagent_usage: string | null;
}

interface MarkerRow {
  episode_id: number;
  seq: number;
  kind: MarkerKind;
  position: number | null;
  event_id: number | null;
  missing_reason: DecisionMissingReason | null;
  transcript_uuid: string | null;
}

/** `<taskId>.<worker_spawned event id>.stream.jsonl`(issue #379)。Episode の
 *  同一性キーはファイル名から取るので、この形でない transcript は走査しない。 */
const SESSION_TRANSCRIPT = /^[^.]+\.(\d+)\.stream\.jsonl$/;

/** worker-logs を全部走査して投影する明示の backfill。冪等 — 同じ session を
 *  同じ投影器の版で二度は作らない。
 *
 *  event id をファイル名に持たない旧形式(`<taskId>.stream.jsonl`)は投影せず、
 *  数えて報告するだけ(ADR 0083 追記 2): 対象になる記録はスライス A(#384)より
 *  前に開発用の盤面が書いた transcript だけで、同一性キーが無い以上ヒューリス
 *  ティックで結ぶしかなく、その線は撤回されている。 */
export function backfillEpisodes(db: Db, logDir: string): { projected: number; skipped: number } {
  let projected = 0;
  let skipped = 0;
  for (const name of readdirSync(logDir).sort()) {
    if (!name.endsWith(".stream.jsonl")) continue;
    const match = SESSION_TRANSCRIPT.exec(name);
    if (!match) {
      skipped += 1;
      continue;
    }
    const id = projectAndPersist(db, {
      workerSpawnedEventId: Number(match[1]),
      transcriptPath: join(logDir, name),
    });
    if (id !== null) projected += 1;
  }
  return { projected, skipped };
}
