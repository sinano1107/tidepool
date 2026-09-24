import Database from "better-sqlite3";
import { SEED_EXECUTION_SETTINGS } from "./execution-setting.js";

export type Db = Database.Database;

/** Memory の FTS5 tokenizer と、TS 側の前処理(CJK bigram + 語の先頭・末尾の . - _ 落とし)の版
 *  (spec #586 B、実測は #357 / #606、順序は #610)。
 *  どちらかを変えたら、boot の ensureMemoryIndex が索引を作り直す。 */
export const MEMORY_FTS_TOKENIZER = "unicode61 tokenchars '_-.'";
export const MEMORY_PREPROCESS_VERSION = "cjk-bigram-5";
// Shared between the fresh-board CREATE and the memory index rebuild (memory.ts).
export const MEMORY_FTS_DDL = `CREATE VIRTUAL TABLE memory_fts USING fts5(text, title, path, original, tokenize = "${MEMORY_FTS_TOKENIZER}")`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // 種の表で初期化するのは表を作ったときだけ —— 空かどうかで判定すると、運用者が
  // settings から全行を消した表が再オープンで生え直す(#545)
  const seedExecutionSettings = !db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_settings'")
    .get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      type                TEXT NOT NULL CHECK (type IN ('work', 'question', 'review')),
      -- 'blocked' is not a stored status: it is derived from unfinished children
      status              TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
      assignee            TEXT,
      -- where this task runs (issue #11): a registry workspace name, or null
      -- to inherit the board's default. First-class per CONTEXT.md; resolved
      -- against the registry fresh at every use — pickup, release, watchdog,
      -- restart (issue #26 / ADR 0009) — never pinned to a path.
      workspace           TEXT,
      -- null only for an issue-backed task (issue #49, ADR 0016): its content
      -- is never snapshotted at registration, only resolved live from the
      -- referenced GitHub issue at each use. The CHECK below enforces the
      -- exclusive-or with github_issue_number below.
      title               TEXT,
      purpose             TEXT,
      completion_criteria TEXT,
      risk_flag           INTEGER NOT NULL DEFAULT 0,
      review_flag         INTEGER NOT NULL DEFAULT 0,
      review_by           TEXT,
      review_tier         TEXT,
      parent_id           TEXT REFERENCES tasks(id),
      -- Immutable provenance: the decision-log event this decomposed child
      -- rests on. Null for tasks outside a decomposition decision.
      based_on_decision   INTEGER,
      -- 前提の破綻の射影(ADR 0121 / issue #631): 宣言が開いている間だけ、破綻した分解判断の
      -- event id を持つ。閉じたら null。
      premise_breach_decision INTEGER,
      sort_key            REAL NOT NULL,
      handoff_doc         TEXT,
      -- the PR opened for this task's completed work (issue #11), or null —
      -- no workspace/github configured, or nothing to hand off. Set once by
      -- recordPrOpened, never by the MCP layer directly.
      pr_number           INTEGER,
      -- question-only fields (issue #30): 1-4 question items (JSON array of
      -- {title, detail?, options, recommendation} — the common context lives
      -- on purpose), and the human's answers once given, one per item, in
      -- item order. A single-item question is the degenerate case of the
      -- same shape, not a second one.
      question_items           TEXT,
      question_answer          TEXT,
      -- the reject-reason steering channel (issue #40): optional, one per
      -- submission (not per item) — recorded alongside question_answer so a
      -- resumed parent's get_current_task can carry both
      question_answer_comment  TEXT,
      -- system-internal only (ADR 0006 / 0048): the sole item's option that
      -- triggers decision-scoped abandon instead of ordinary unblock-to-head.
      -- Never set via MCP or JSON API; only failure-question registration does.
      question_cancel_option  TEXT,
      -- system-internal only (issue #11): a pending-child approval question's
      -- would-be child, JSON-encoded, materialized only if the human answers
      -- "approve". Never set via MCP or the JSON API — only decomposeTask sets this.
      question_pending_child  TEXT,
      -- system-internal only (issue #11): the PR number a merge-decision
      -- question stands in for. Never set via MCP or the JSON API — only
      -- recordPrOpened's escalate branch sets this.
      question_pending_merge_pr INTEGER,
      -- system-internal only (ADR 0053): the completed work task whose
      -- purely-local task branch awaits a human merge/hold decision.
      question_pending_local_merge_task_id TEXT,
      -- system-internal only (issue #66): the completed work task whose PR
      -- promotion failed. submitAnswer retries it synchronously on
      -- "retry"; never set through MCP or the JSON API.
      question_pending_pr_promotion_task_id TEXT,
      -- board-internal only (ADR 0120 決定4 / issue #620): 提案を運ぶ question の種別つき提案(JSON)と pin。
      -- 盤面の提案 verb だけが書き、この列を持つ question は親を塞がない付帯子。
      question_proposal TEXT,
      -- system-internal only (ADR 0137 決定2): the Quarantine kind a
      -- Confirmation question stands in for, and the value it is keyed on — a
      -- workspace name, agent name, Provider, Harness, or the id of the task
      -- whose teardown threw; NULL for a board-wide kind that names nothing.
      -- Set only by the Quarantine module's registration; never via MCP or the
      -- JSON API.
      question_quarantine_kind TEXT,
      question_quarantine_value TEXT,
      -- system-internal only (ADR 0075): the configured expiry epoch for
      -- which this advance warning was created. It never halts pickup.
      question_cli_auth_expiry_warning INTEGER,
      -- issue-backed task reference (issue #49, ADR 0016): the GitHub issue
      -- number this task is a live reference to, or null for an ordinary
      -- task. workspace (already above) doubles as the repo half of the
      -- reference for such a task.
      github_issue_number INTEGER,
      -- the task's execution request (ADR 0110 決定2, CONTEXT.md「要求」): the
      -- required quality tier and the priority that orders that tier's candidates (ADR 0114),
      -- either null for "unstated". Null is the *absence* of a request, and
      -- is distinguished in the record from "the board default was chosen" —
      -- the latter shows up as worker_spawned.source.tier, never here.
      -- Deliberately no CHECK: the enum is stated once in the domain
      -- (registerTask / decomposeTask throw DomainError, ADR 0110 決定2).
      -- Constraints (provider限定・予算) are deliberately NOT columns
      -- here: those live on the workspace and the board settings.
      tier                TEXT,
      priority            TEXT,
      -- board-internal only (ADR 0120 決定2 / issue #618): この task が主題 X の周期 meta-review であること。
      -- 盤面の登録関数だけが書き、MCP / JSON API からは書けない。
      meta_review_subject TEXT CHECK (meta_review_subject IN ('memory', 'routing')),
      created_at          TEXT NOT NULL,
      -- ADR 0109 決定5: 後始末の未了は再起動をまたぐ事実である。最終 verb が着地した
      -- 時刻を持ち、後始末が完走した時点で null に戻る —— in-memory の callback は
      -- 盤面の crash を越えないので、起動時に拾うにはこの1列が要る。
      teardown_started_at TEXT,
      -- exactly one content source, exclusively (issue #49, ADR 0016): an
      -- ordinary task carries all three content fields and no
      -- github_issue_number; an issue-backed task carries a
      -- github_issue_number and none of the three — content is never
      -- snapshotted alongside a live reference. Domain code
      -- (assertGithubRef) rejects the same cases before they'd ever reach
      -- this CHECK, but it stays as the DB's own backstop.
      CHECK (
        (github_issue_number IS NOT NULL AND title IS NULL AND purpose IS NULL AND completion_criteria IS NULL)
        OR (github_issue_number IS NULL AND title IS NOT NULL AND purpose IS NOT NULL AND completion_criteria IS NOT NULL)
      )
    );

    -- The database is the audit record's final backstop, so its route vocabulary is
    -- constrained here as well as by EventOrigin in TypeScript.
    -- task_id is NULL for board-scoped events (BOARD_SCOPED_KINDS in events.ts) — a settings change
    -- or a memory entry belongs to no task but still carries its route.
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT REFERENCES tasks(id),
      worker_id  TEXT NOT NULL,
      origin     TEXT NOT NULL DEFAULT 'webui' CHECK (origin IN ('webui', 'mcp', 'worker', 'board')),
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- the human's read position in the decision log (the log itself is the
    -- events table, never its own entity): one row, the last-read event id
    CREATE TABLE IF NOT EXISTS log_cursor (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      last_read INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO log_cursor (id, last_read) VALUES (1, 0);

    -- the morning triage session (issue #6): while one is open (committed_at
    -- IS NULL) pickup pauses and queue application is staged until commit
    CREATE TABLE IF NOT EXISTS triage_sessions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at       TEXT NOT NULL,
      -- refreshed on every answer/objection/scratchpad touch; the watchdog
      -- closes a session left alone past the timeout
      last_activity_at TEXT NOT NULL,
      committed_at     TEXT,
      closed_by        TEXT CHECK (closed_by IN ('commit', 'timeout')),
      timeout_notified INTEGER NOT NULL DEFAULT 0 CHECK (timeout_notified IN (0, 1))
    );

    -- queue applications staged by an open triage session: tasks this session
    -- will move to the queue head when it commits (e.g. parents unblocked by
    -- an answer). id preserves answer order for the commit-time application.
    CREATE TABLE IF NOT EXISTS triage_front_inserts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES triage_sessions(id),
      task_id    TEXT NOT NULL REFERENCES tasks(id)
    );

    -- the triage scratchpad: irritation lines jotted anywhere in the flow,
    -- durable at once, dispositioned (meta-review / task / discard) at commit
    CREATE TABLE IF NOT EXISTS triage_scratchpad (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      line TEXT NOT NULL
    );

    -- pending dumps (issue #61): scratchpad lines dispositioned \`register\`
    -- land here — the Register screen's pending dump (仕上げ待ち) queue, 1
    -- line = 1 row, no auto-merge. Consumed by either a successful
    -- registration built from the line or an explicit discard; until then
    -- the line is never lost. Durable across restart, same as
    -- triage_scratchpad — no session linkage, just a plain table.
    CREATE TABLE IF NOT EXISTS pending_dumps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      line       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- ADR 0064 決定6: ref_snapshot は pickup の瞬間に撮った全 ref の写像
    -- (for-each-ref のソート済み出力 = refname 順の "値 refname"。値は
    -- objectname だが、symref の行だけは指し先 "symref=<refname>" である ——
    -- ADR 0081)。slot 解放時にこれと現在を比べ、
    -- タスクブランチ以外が1つでも動いていれば quarantine する。worker が書けない
    -- 場所であることが要件なので git の ref ではなくここに置く。
    CREATE TABLE IF NOT EXISTS workspace_state (
      name         TEXT PRIMARY KEY,
      ref_snapshot TEXT
    );

    -- ADR 0098: a Provider probe is one observation with zero or more
    -- account/model windows.  model is stored as the empty string so the
    -- compound key stays unique for the account-wide window in SQLite.
    CREATE TABLE IF NOT EXISTS provider_usage_observations (
      provider     TEXT PRIMARY KEY CHECK (provider IN ('anthropic', 'moonshot', 'openai')),
      status       TEXT NOT NULL CHECK (status IN ('observed', 'unauthorized', 'unobservable', 'absent')),
      plan         TEXT,
      cli_version  TEXT,
      reason       TEXT,
      observed_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS provider_usage_windows (
      provider       TEXT NOT NULL REFERENCES provider_usage_observations(provider) ON DELETE CASCADE,
      window         TEXT NOT NULL,
      model          TEXT NOT NULL DEFAULT '',
      used_percent   INTEGER,
      duration_ms    INTEGER,
      resets_at      TEXT,
      throttled      INTEGER NOT NULL,
      resumes_at     TEXT,
      PRIMARY KEY (provider, window, model)
    );
    -- ADR 0110 決定3 / ADR 0114 決定2: 実行設定の表 —— モデル分類の行(この model は
    -- この provider のこのティアの品質を満たす)と、既定 effort・価格(USD per MTok)。
    -- 同じ provider × ティアに複数行を許す。配布物の種(execution-setting.ts の
    -- SEED_EXECUTION_SETTINGS)から**一度だけ**初期化し、以後は DB が正本で、
    -- 消した行も再オープンで戻らない(settings タブと管理MCP が編集する、#545)。
    -- model が alias(anthropic)か具体 id(openai)か
    -- の判別子は持たない —— どちらも CLI に渡す文字列である。
    CREATE TABLE IF NOT EXISTS execution_settings (
      provider  TEXT NOT NULL CHECK (provider IN ('anthropic', 'moonshot', 'openai')),
      model     TEXT NOT NULL,
      tier      TEXT NOT NULL CHECK (tier IN ('economy', 'standard', 'frontier')),
      effort    TEXT NOT NULL,
      price_in  REAL NOT NULL CHECK (price_in >= 0),
      price_out REAL NOT NULL CHECK (price_out >= 0),
      PRIMARY KEY (provider, model)
    );

    -- ADR 0110 決定3 / 決定5 の盤面設定側(1行): 「上位ティアの行を advisor に
    -- 使ってよい」(Fable の usage-credits 同意も org の availableModels も盤面
    -- からは読めないので、立つまでは advisor を main と同一に倒す)、Provider
    -- 順位(JSON 配列、PROVIDER_VALUES の順列)、優先順位の既定(ADR 0114 決定1)。
    -- 行が無い / 列が NULL = 未設定 = コードの既定(false / 宣言順 / quality)。
    -- settings タブと管理MCP が書く(#545)。
    CREATE TABLE IF NOT EXISTS execution_defaults (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      frontier_advisor INTEGER NOT NULL DEFAULT 0,
      provider_rank    TEXT,
      priority         TEXT CHECK (priority IN ('quality', 'cost'))
    );

    CREATE TABLE IF NOT EXISTS provider_pace_offsets (
      provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'moonshot', 'openai')),
      window   TEXT NOT NULL,
      offset   INTEGER NOT NULL,
      PRIMARY KEY (provider, window)
    );

    -- Pause (issue #34): a single, board-wide, human-only toggle for new-task
    -- pickup — one row, with no auto-resume (CONTEXT.md's Pause: clearing it
    -- is purely manual). No row means never paused.
    CREATE TABLE IF NOT EXISTS pause_state (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL
    );

    -- Spend-down (ADR 0091 / 0143): one independently expiring row per armed
    -- Provider window. No row for a window means its pace line remains in force.
    -- The known (provider, window) pairs live in src/spend-down.ts.
    CREATE TABLE IF NOT EXISTS spend_down_state (
      provider     TEXT NOT NULL,
      window       TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      PRIMARY KEY (provider, window)
    );

    -- Web Push subscriptions (issue #14): one row per installed PWA that
    -- opted into push. endpoint is the browser's own dedup key (a fresh
    -- subscribe from the same install replaces its old keys).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh   TEXT NOT NULL,
      auth     TEXT NOT NULL
    );

    -- which question tasks have already reached the human via push (issue
    -- #14), individually or folded into a morning digest — a row here means
    -- "no longer pending notification", regardless of how it was delivered.
    CREATE TABLE IF NOT EXISTS question_notifications (
      task_id     TEXT PRIMARY KEY REFERENCES tasks(id),
      notified_at TEXT NOT NULL
    );

    -- which agent-registered human-assignee tasks have already reached the
    -- human via push (issue #116) — the exact twin of question_notifications
    -- above: a human child registered by an agent's decompose blocks its
    -- parent the same way a question does, so it is a notification target of
    -- equal urgency (CONTEXT.md's Quiet hours / Digest). A row here means "no
    -- longer pending notification", however delivered (individual or digest).
    -- Kept a separate table from question_notifications, not a shared one,
    -- because the two notification streams are counted separately in the
    -- morning digest ("N questions · K your tasks · M new log").
    CREATE TABLE IF NOT EXISTS human_task_notifications (
      task_id     TEXT PRIMARY KEY REFERENCES tasks(id),
      notified_at TEXT NOT NULL
    );

    -- the morning digest's read position in the events table (issue #14) —
    -- separate from log_cursor (the human's own read/unread position in the
    -- decision-log UI): this one tracks what the digest has already reported.
    CREATE TABLE IF NOT EXISTS digest_cursor (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_reported INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO digest_cursor (id, last_reported) VALUES (1, 0);

    -- quiet hours config (issue #14): one row, "HH:MM" bounds read against
    -- tz's wall clock (issue #63 / ADR 0022) — tz is the one board timezone
    -- (CONTEXT.md's Timezone), not a quiet-hours-specific setting; it lives
    -- here because quiet hours is the one feature that reads it today.
    -- No row means never configured — callers fall back to the 23:00–07:00
    -- Asia/Tokyo default rather than reading this table directly.
    CREATE TABLE IF NOT EXISTS quiet_hours (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      start TEXT NOT NULL,
      end   TEXT NOT NULL,
      tz    TEXT NOT NULL DEFAULT 'Asia/Tokyo'
    );

    -- the one board display language (issue #46): read by two consumers —
    -- the draft prompt's language instruction (this issue) and, later, a
    -- separate display-time-translation feature (not implemented here).
    -- Named after that shared role, not after either consumer, so neither
    -- reads a name that implies it belongs to the other.
    -- No row means never configured — callers fall back to the Japanese
    -- default rather than reading this table directly.
    CREATE TABLE IF NOT EXISTS display_language (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      language TEXT NOT NULL DEFAULT 'Japanese'
    );

    -- display-time translation cache (issue #47 / ADR 0015): keyed by a hash
    -- of the source fragment (not an event id) so every translation target —
    -- decision-log line, completion report, question purpose/item, handoff
    -- doc section — shares one lookup shape regardless of whether its source
    -- lives on an events row or a tasks row. Log entries are immutable
    -- (CONTEXT.md: 記録は不滅・不変) so a cache hit never needs invalidating.
    CREATE TABLE IF NOT EXISTS translation_cache (
      source_hash           TEXT NOT NULL,
      language              TEXT NOT NULL,
      translated            TEXT NOT NULL,
      input_tokens          INTEGER NOT NULL,
      output_tokens         INTEGER NOT NULL,
      cache_read_tokens     INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      estimated_cost_usd    REAL NOT NULL,
      created_at            TEXT NOT NULL,
      PRIMARY KEY (source_hash, language)
    );

    -- the merge dial's auto_if_ci_green queue (issue #11): a completed
    -- low-risk task's just-opened PR, awaiting the CI poll to merge it
    -- unattended. Removed once resolved (merged, or converted to an
    -- escalation question on CI failure) — a risky task never lands here at
    -- all (it asks immediately instead, same as the escalate dial).
    CREATE TABLE IF NOT EXISTS pending_auto_merges (
      task_id   TEXT PRIMARY KEY REFERENCES tasks(id),
      pr_number INTEGER NOT NULL
    );

    -- Precedent(前例)の派生索引 — 盤面の記録(events + worker transcript)から
    -- 投影した Episode(ADR 0083 決定8 / 追記 2、issue #356)。記録が正本なので
    -- この3表は何度でも作り直せ、削除・修正は投影のやり直しでしかない。
    -- 同一性キーは worker session を開いた worker_spawned の event id で、
    -- 投影器の版と対で一意 — 版を上げれば同じ session を読み直せる。
    CREATE TABLE IF NOT EXISTS episodes (
      id                      INTEGER PRIMARY KEY,
      worker_spawned_event_id INTEGER NOT NULL,
      extractor_version       TEXT NOT NULL,
      task_id                 TEXT NOT NULL REFERENCES tasks(id),
      -- 引き口 (workspace, agent) の2列。workspace は tasks 行、agent は
      -- worker_spawned の worker_id(実際に起こされた agent — ADR 0012)。
      workspace               TEXT,
      agent                   TEXT NOT NULL,
      registry_commit         TEXT,
      definition_version      TEXT,
      -- transcript を書いた CLI の版(init 行)。未知行の増減が投影器の変更か
      -- CLI の変更かを分ける唯一の手がかり(ADR 0083 追記 2 決定7)。
      claude_code_version     TEXT,
      -- 完了の outcome。null = この session では完了していない(handoff の
      -- 有無と result の有無は別なので、完了したかどうかは handoff 列で見る)。
      completed_handoff       INTEGER,
      completed_result        TEXT,
      exit_code               INTEGER,
      signal                  TEXT,
      -- session 単位の消費の正本への参照。トークンは写さない(ADR 0083 追記 2)。
      worker_exited_event_id  INTEGER,
      -- 欠測統計3値 + 未知の内訳(JSON)。内訳は可変キーの集計なので1列。
      lines                   TEXT NOT NULL,
      unrecognized_format     INTEGER NOT NULL DEFAULT 0 CHECK (unrecognized_format IN (0, 1)),
      UNIQUE (worker_spawned_event_id, extractor_version)
    );

    -- 行動列: tool 呼び出し1回 = 1行。トークン欄を持たないのは、assistant 行の
    -- usage が message 開始時のスナップショットであって行動単位の消費ではない
    -- ため(ADR 0083 追記 2、実測)。本文は写さず transcript 行を参照する。
    CREATE TABLE IF NOT EXISTS episode_actions (
      episode_id      INTEGER NOT NULL REFERENCES episodes(id),
      idx             INTEGER NOT NULL,
      tool            TEXT NOT NULL,
      -- 抽出表に載っていない tool は null = 「引数を抽出しない」であって欠測ではない
      args            TEXT,
      failed          INTEGER NOT NULL CHECK (failed IN (0, 1)),
      transcript_uuid TEXT NOT NULL,
      tool_use_id     TEXT NOT NULL,
      subagent        INTEGER NOT NULL CHECK (subagent IN (0, 1)),
      -- subagent 起動行にだけ付く、その subagent 自身の消費(合算外の観測)
      subagent_usage  TEXT,
      PRIMARY KEY (episode_id, idx)
    );

    -- 行動列の中に位置を持つ注釈。decision は軸ではなくマーカーで(ADR 0083 追記)、
    -- 構造マーカーは compaction / commit / advisor の3つ(追記 2 決定5)。memory は
    -- pull event の id を完全一致で結ぶ記憶の機械記録(決定10 / spec #586 D)。
    -- position が null = 結べなかった decision — 消さずに欠測理由を持って残る。
    CREATE TABLE IF NOT EXISTS episode_markers (
      episode_id      INTEGER NOT NULL REFERENCES episodes(id),
      seq             INTEGER NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('decision', 'compaction', 'commit', 'advisor', 'memory')),
      position        INTEGER,
      event_id        INTEGER,
      missing_reason  TEXT CHECK (missing_reason IN ('no_event_id', 'unmatched')),
      transcript_uuid TEXT,
      PRIMARY KEY (episode_id, seq)
    );

    -- 学習器の shadow 行(ADR 0110 決定4 / spec #541): work task の pickup ごとに
    -- 「学習器ならこう選ぶ / selector が実際に選んだ / 出所」を1行。選択には
    -- 介入せず、routing meta-review が乖離を読むための記録である。セルは
    -- 実行設定の形 (provider, model, effort, advisor) の JSON —— spawn 前に書く
    -- ので worker_spawned の id は持てず、task_id と時刻で session に並ぶ。
    -- source: selector の出所 {tier, provider}(worker_spawned.source と同じ綴り ——
    -- spawn に辿り着かなかった pickup でも読めるようここにも持つ)。
    -- basis: prior = 候補のどれにもデータが無く表そのまま / data = 観測が効いた。
    -- event_watermark: 書いた時点の events の最大 id。同じ task の次の worker_spawned(id がこれより大きい最初のもの)が
    -- この pickup の session で、meta-review の watermark とも同じ軸で比べられる(時刻は Clock の同時刻で並ばない)。
    CREATE TABLE IF NOT EXISTS learner_shadow (
      id               INTEGER PRIMARY KEY,
      task_id          TEXT NOT NULL REFERENCES tasks(id),
      cell_recommended TEXT NOT NULL,
      cell_actual      TEXT NOT NULL,
      source           TEXT NOT NULL,
      basis            TEXT NOT NULL CHECK (basis IN ('prior', 'data')),
      event_watermark  INTEGER NOT NULL,
      created_at       TEXT NOT NULL
    );

    -- Memory のエントリ(ADR 0083 / spec #586 A)。正本は memory_entry_created /
    -- memory_entry_invalidated の events で、この表はそれと同じ transaction で
    -- 維持する投影(memory.ts)。id = 作成 event の id。削除は無く、無効化は
    -- 理由コード(cause.ts の語彙の3つ + superseded / path_moved)と後継 id の列。
    -- version = 承認 event の id(Knowledge は作成 event の id、candidate は NULL)。
    -- 時刻・回数・重みの列は持たない(時刻は events)。
    CREATE TABLE IF NOT EXISTS memory_entries (
      id                  INTEGER PRIMARY KEY,
      kind                TEXT NOT NULL CHECK (kind IN ('knowledge', 'behavior', 'definition')),
      state               TEXT NOT NULL CHECK (state IN ('candidate', 'approved')),
      scope               TEXT,
      path                TEXT NOT NULL,
      title               TEXT NOT NULL,
      text                TEXT NOT NULL,
      original_title      TEXT,
      original_text       TEXT,
      original_language   TEXT,
      addressee           TEXT,
      source_kind         TEXT NOT NULL CHECK (source_kind IN ('event', 'commit', 'decision')),
      source_ref          TEXT NOT NULL,
      author_activity     TEXT NOT NULL CHECK (author_activity IN ('worker_verb', 'human', 'rca', 'meta_review', 'board')),
      author              TEXT NOT NULL,
      version             INTEGER,
      invalidation_reason TEXT CHECK (invalidation_reason IN ('superseded', 'path_moved', 'capability', 'environment', 'requirement_change', 'rejected')),
      successor_id        INTEGER REFERENCES memory_entries(id)
    );

    -- Memory の全文索引(spec #586 B)。rowid = エントリ id。CJK bigram の前処理を
    -- 通した文字列を持つので external-content にはできず、エントリ表と同じ
    -- transaction で書く投影(memory.ts)。
    ${MEMORY_FTS_DDL.replace("CREATE VIRTUAL TABLE", "CREATE VIRTUAL TABLE IF NOT EXISTS")};

    -- 索引の版(tokenizer id + 前処理の版)。1行。boot で今の版と照合し、違えば
    -- events から索引を作り直す(memory.ts の ensureMemoryIndex)。
    CREATE TABLE IF NOT EXISTS memory_index_version (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      tokenizer          TEXT NOT NULL,
      preprocess_version TEXT NOT NULL
    );
    INSERT OR IGNORE INTO memory_index_version (id, tokenizer, preprocess_version)
      VALUES (1, '${MEMORY_FTS_TOKENIZER.replaceAll("'", "''")}', '${MEMORY_PREPROCESS_VERSION}');

    -- Memory の盤面設定(1行、spec #586 C / issue #592): spawn 注入のトークン上限。
    -- 行が無い / NULL = 未設定 = コードの既定(2,000)。settings タブと管理MCP が書く。
    CREATE TABLE IF NOT EXISTS memory_defaults (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      injection_token_cap INTEGER CHECK (injection_token_cap > 0)
    );

    -- 周期 meta-review の盤面設定(1行、issue #618 / #924): 全主題に共通の間隔の下限(日)。
    -- 行が無い / NULL = 未設定 = コードの既定(7)。settings タブと管理MCP が書く。
    CREATE TABLE IF NOT EXISTS meta_review_defaults (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      period_days INTEGER CHECK (period_days > 0)
    );

    -- append-only is enforced by structure, not convention
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `);
  // 種の表からの初期化は**一度だけ**(ADR 0110 決定3: 以後は DB が正本)。
  // 行ごとの INSERT OR IGNORE にしないのは、運用者が消した行が再オープンの
  // たびに生え直すのが「正本は DB」と矛盾するためである。
  if (seedExecutionSettings) {
    const insert = db.prepare(
      "INSERT INTO execution_settings (provider, tier, model, effort, price_in, price_out) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of SEED_EXECUTION_SETTINGS) {
      insert.run(row.provider, row.tier, row.model, row.effort, row.price_in, row.price_out);
    }
  }
  return db;
}
