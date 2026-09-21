const WASH_MS = 1250;

const tabs = [
  { key: 'triage', label: 'Triage', icon: 'sunrise' },
  { key: 'board', label: 'Board', icon: 'columns-3' },
  { key: 'queue', label: 'Queue', icon: 'list-ordered' },
  { key: 'register', label: 'Register', icon: 'plus' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

// 盤面全体の停止の kind 語彙はサーバの leaf module が正本 (ADR 0133 決定3)。
// `import type` **文**にしないこと —— このファイルがモジュールになり、トップレベルが
// グローバルから消えて他の .tsx からの参照が全部壊れる。
type HaltKind = import('../src/halt-kind').HaltKind;
/** assignee 名 → アイコン(GET /api/registry/candidates、issue #52)。 */
type AppIcons = Record<string, string | undefined>;
/** サーバ応答の形の正本(ADR 0138)。`api()` がこの表のキーで引く。 */
type WireContract = import('../src/wire-contract').WireContract;
type AppBoardHalt = import('../src/wire-contract').BoardHalt;
/** キュー画面のスロット行 —— 停止・後始末・空きが同じ1本を書き換える。 */
interface AppSlot {
  color: string;
  line: string;
  meta: string;
  taskId: string | null;
}
type AppToastKind = NonNullable<import('../design-system/components/surfaces/Toast').ToastProps['kind']>;
/** 画面が出す一言。`detail` は JSX も来る(pause の IdChip)。 */
interface AppToast {
  kind: AppToastKind;
  msg: string;
  detail?: React.ReactNode;
  leaving?: boolean;
}
type AppData = ReturnType<typeof mapData>;
/** 画面が一言を出す口 —— App が配り、各ダイアログが呼ぶ。 */
type AppSay = (kind: AppToastKind, msg: string, detail?: React.ReactNode) => void;
/** レジストリ由来の候補(issue #52 の GET /api/registry/candidates)。 */
interface AppCandidates {
  assignees: string[];
  workspaces: string[];
}

/** api() が 4xx/5xx で投げるエラー。catch (e) は unknown なので、素の Error に
 *  プロパティを生やす形では呼び手が `status` を撃たれない(#749 User Story 6)——
 *  instanceof で開ける class にしてある。`detail` はサーバの JSON 本文そのもので、
 *  形は端点ごとに違う —— 読む箇所で契約のエラー行(例 'POST /api/tasks 422')に受ける。 */
class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** `api()` が受ける表のキー —— エラー応答の行('POST /api/tasks 422')は取得先ではないので外す。 */
type ApiKey = Exclude<keyof WireContract, `${string} ${string} ${string}`>;
/** キーの `:name` セグメントの名前 —— 'GET /api/tasks/:id' → 'id'。 */
type KeyParams<K> = K extends `${string}:${infer P}/${infer R}` ? P | KeyParams<R> : K extends `${string}:${infer P}` ? P : never;
/** `params` はキーの `:name` を埋め(動的セグメントを持つキーでは必須)、`query` は検索文字列になる。 */
type ApiOpts<K> = { query?: Record<string, string>; body?: unknown }
  & ([KeyParams<K>] extends [never] ? { params?: never } : { params: Record<KeyParams<K>, string> });

/** 契約のエラー行('METHOD /path STATUS')で ApiError の本文を読む —— その status の
 *  ApiError でなければ null。本文から契約型への変換は api() と同じくここ1点(ADR 0138 決定3)。 */
// biome-ignore lint/correctness/noUnusedVariables: read by webui/settings-screen.tsx — one concatenated bundle
function apiErrorDetail<K extends Exclude<keyof WireContract, ApiKey>>(err: unknown, key: K): WireContract[K] | null {
  return err instanceof ApiError && err.status === Number(key.split(' ')[2]) ? (err.detail as WireContract[K]) : null;
}

// 表のキー('METHOD /path')で引けば契約の型が返る —— unknown から契約型への変換は
// この overload の1点だけ(ADR 0138 決定3)。生のパスの形は表に載っていない端点のために残る。
function api<K extends ApiKey>(key: K, ...opts: [KeyParams<K>] extends [never] ? [ApiOpts<K>?] : [ApiOpts<K>]): Promise<WireContract[K]>;
function api(path: `/${string}`, body?: unknown, method?: string): Promise<unknown>;
async function api(pathOrKey: string, bodyOrOpts?: unknown, method = 'POST'): Promise<unknown> {
  let [verb, path, body] = [method, pathOrKey, bodyOrOpts];
  if (!pathOrKey.startsWith('/')) {
    const { params = {}, query, body: optsBody } = (bodyOrOpts ?? {}) as { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };
    [verb, path] = pathOrKey.split(' ') as [string, string];
    path = path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name]!));
    if (query) path += `?${new URLSearchParams(query)}`;
    body = optsBody;
  }
  const res = await fetch(path, {
    method: verb,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = typeof err === 'object' && err !== null && 'error' in err && typeof err.error === 'string' ? err.error : res.statusText;
    // the registration gate's 422 (issue #49) carries structure beyond the
    // message (missing / suggested_comment) — keep it for the caller
    throw new ApiError(message, res.status, err);
  }
  return res.json();
}

// ADR 0063 決定1: the caller-side pacer. All 3 toggle sites (question card,
// log skim, handoff) and the memory entries card route through this one
// `translateTarget` definition, so
// wrapping it here — not in the kit's `runTranslate` — is what makes "every
// switch passes through the same gate" true without touching the kit. The
// kit still fires N calls; this queues them to MAX_CONCURRENT_TRANSLATIONS.
const MAX_CONCURRENT_TRANSLATIONS = 2;
let translationsInFlight = 0;
const translationQueue: (() => void)[] = [];
// ADR 0063 決定4: a queued (not yet dispatched) call cancels on `signal` abort
// and is never sent — a dispatched one is past this gate and always runs to
// completion (its paid tokens shouldn't be thrown away). The listener is
// removed the instant a call dispatches, so aborting after dispatch is a
// no-op — exactly the "sent keeps running" half of the decision.
function paceTranslation(run: () => Promise<TpTranslation>, signal?: AbortSignal) {
  return new Promise<TpTranslation>((resolve, reject) => {
    const dispatch = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      translationsInFlight += 1;
      run().then(resolve, reject).finally(() => {
        translationsInFlight -= 1;
        const next = translationQueue.shift();
        if (next) next();
      });
    };
    const onAbort = () => {
      const i = translationQueue.indexOf(dispatch);
      if (i !== -1) translationQueue.splice(i, 1);
      reject(new DOMException('translation cancelled', 'AbortError'));
    };
    if (translationsInFlight < MAX_CONCURRENT_TRANSLATIONS) {
      dispatch();
    } else {
      if (signal) signal.addEventListener('abort', onAbort);
      translationQueue.push(dispatch);
    }
  });
}

// display-time translation (issue #47 / ADR 0015): the one seam behind every
// kit face's own `onTranslate` prop — { type: 'log_entry', event_id } |
// { type: 'question' | 'handoff', task_id }. The server resolves
// cached/throttled/translated; this call never throws on a throttled
// response (that's a 200), only on a genuine request/outage failure, which
// each toggle's own catch renders inline. `signal` (ADR 0063 決定4) is
// optional — only the log skim's fan-out passes one, to cancel unsent
// requests when its switch is toggled off.
const translateTarget: TpTranslateFn = (target, { signal } = {}) => paceTranslation(() => api('POST /api/translate', { body: target }), signal);

// Web Push (issue #14): applicationServerKey wants raw bytes, the server
// hands back the VAPID public key as URL-safe base64.
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return undefined;
  return navigator.serviceWorker.register('/sw.js');
}

// Subscribes this installed PWA to push, if the board has push configured at
// all (a null publicKey means no VAPID keys set — push stays off). Reusing
// an existing subscription rather than always minting a fresh one keeps a
// re-visit from silently orphaning the previous device registration.
async function subscribeToPush(registration: ServiceWorkerRegistration | undefined) {
  const { publicKey } = await api('GET /api/push/vapid-public-key');
  if (!publicKey || !registration) return null;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api('/api/push/subscribe', subscription.toJSON());
  return subscription;
}

// transient "just moved to the front" ids — presentation only, never persisted
const RECENT_FRONTS = new Set();
function markFront(id: string) {
  RECENT_FRONTS.add(id);
  setTimeout(() => RECENT_FRONTS.delete(id), 4000);
}

// An issue-backed task's title, live-expanded server-side (issue #49, ADR
// 0016's UI use-moment), carries issue_live_state: suffix the title so
// cached-but-old (stale) and never-fetched (unavailable) are visible at a
// glance. Ordinary tasks have no issue_live_state and pass through as-is.
function liveTitle(t: Pick<import('../src/wire-contract').QueueTask, 'title' | 'issue_live_state'>) {
  if (t.issue_live_state === 'stale') return `${t.title} (out of sync)`;
  if (t.issue_live_state === 'unavailable') return `${t.title} (unavailable)`;
  return t.title;
}

// Maps one raw question task into TpQuestionCard's shape — shared by the board's
// question list (mapData) and the push deep-link's single-question view.
function toQuestionCardShape(
  q: Pick<WireContract['GET /api/tasks/:id'], 'id' | 'parent_id' | 'registrant' | 'purpose' | 'question_items' | 'approval'>,
  icons: AppIcons,
): TpQuestion {
  // who issued the question — the board itself (issue #261) or an agent
  // (never human: a question only ever comes from a non-human registrant)
  // 盤面の行も task 詳細も registrant を必ず載せる(サーバ型の optional は内部の事情)
  const registrant = q.registrant!;
  const isBoard = registrant === 'tidepool';
  return {
    id: q.id, parent: q.parent_id,
    agent: registrant,
    agentIcon: isBoard ? undefined : icons[registrant],
    board: isBoard,
    context: q.purpose,
    // 1-4 items, each with its own title/detail/options (issue #30) — a
    // single-item bundle is the degenerate, most common case
    items: (q.question_items ?? []).map((item) => ({
      title: item.title, detail: item.detail,
      options: item.options.map((o: string) => ({ label: o, recommended: o === item.recommendation })),
    })),
    // 承認 question(決裁権外の子の登録)と、approve で親の risk が上がるかは
    // 盤面の `approval` 注釈が答える(issue #757)— ここは描画の形に写すだけ
    ...(q.approval && {
      kind: 'approval',
      ...(q.approval.raises_parent_risk && { note: `approving raises ${q.parent_id} risk (upward propagation)` }),
    }),
  };
}

// Map the server board + decision log into the shape the kit screens consume.
// `icons` is the registry's assignee name → icon map (issue #52's
// GET /api/registry/candidates); a name absent from it renders with
// AgentChip's initials fallback. `queueEnvelope` is GET /api/queue's
// { halts, tasks } (ADR 0068 決定6): rows and board-wide halts come from the
// same read at the same instant, so no gap between two fetches can make the
// rows and the slot line disagree.
function mapData(
  board: WireContract['GET /api/tasks'],
  log: WireContract['GET /api/log'],
  pause: WireContract['GET /api/pause'],
  icons: AppIcons,
  triage: WireContract['GET /api/triage'],
  queueEnvelope: WireContract['GET /api/queue'],
  yourTasks: WireContract['GET /api/your-tasks'],
) {
  // 盤面全体の停止は queue の envelope が順序つきで1回答える (ADR 0068 決定1) —
  // ブラウザは並べ替えず、先頭を読んで kind 別コピーに写すだけ
  const halts: AppBoardHalt[] = queueEnvelope.halts;
  const paused = halts.some((h) => h.kind === 'pause');
  // 資源単位の表示に要る完全な throttle(windows / fable 詳細)は /pause から —
  // halts の throttle entry と一部重複するが、把握して受け入れた重複である
  const throttle = pause.throttle;
  // 後始末は停止の列挙とは**並んで**運ばれる (ADR 0109 決定2) — 枠がまだ空いていない
  // 状態であって、盤面全体の停止ではない
  const teardown = queueEnvelope.teardown;
  const providerUsage = pause.providerUsage ?? queueEnvelope.providerUsage ?? [];
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const questions: TpTriageQuestion[] = board
    .filter((t) => t.status === 'todo' && t.type === 'question')
    .map((q) => ({
      ...toQuestionCardShape(q, icons),
      // 着地 question(purely-local の land question / PR の merge question)は
      // `landing` を持ち、その blocked_by が回答可否 — 一般 question は null
      // (ADR 0092 決定4)。判定は盤面側、triage-screen は描画だけ
      landing: q.landing ?? null,
    }));
  // newest first for the skim; unread is the server's cursor + authorship
  // decision. workspace grouping/fold (issue #44) is pure view derivation the
  // kit does itself from this flat, order-independent list — see triage-screen.tsx.
  // ADR 0085: the read model's own `objections` (every one ever raised) is
  // split here by whether it belongs to the currently open session — the
  // sole fact `session_id` carries — into commit-pending vs. already-bundled.
  const openSessionId = triage.session?.id ?? null;
  const logEntries: TpLogEntry[] = [...log.entries].reverse().map((e) => ({
    id: e.id, time: fmtTime(e.created_at), taskId: e.task_id, agent: e.worker_id,
    agentIcon: icons[e.worker_id], human: e.worker_id === 'human',
    kind: e.payload.kind === 'task_completed' ? 'completion' : 'decision',
    text: e.payload.kind === 'task_completed' ? (e.payload.result ?? '(no outcome recorded)') : e.payload.line,
    unread: e.unread,
    handoffPresent: e.payload.kind === 'task_completed' && !!e.payload.handoff_present,
    workspace: e.workspace ?? null,
    cause: e.cause ?? undefined,
    pendingObjections: e.objections.filter((o) => o.session_id === openSessionId).map((o) => o.comment),
    bundledObjections: e.objections.filter((o) => o.session_id !== openSessionId).map((o) => o.comment),
  }));
  // the queue is the todo order the slot walks, straight from /api/queue (ADR
  // 0068 決定6) — the server's own row set and its resource-scoped `skipped`,
  // no longer re-derived from the board here. derived-blocked rows keep their
  // sort_key position (the slot skips them until the children finish), so they
  // stay visible — hiding them would make the displayed order lie about where a
  // drag actually lands. held rows stay out, same as before.
  const queue: QueueScreenTask[] = queueEnvelope.tasks
    .filter((t) => t.status === 'todo' || t.status === 'blocked' || t.status === 'skipped')
    .map((t) => ({
      id: t.id, title: liveTitle(t), assignee: t.assignee ?? undefined,
      assigneeIcon: t.assignee ? icons[t.assignee] : undefined, risk: !!t.risk_flag,
      blocked: t.status === 'blocked',
      // 資源単位の停止だけが行に現れる — workspace / agent の quarantine と
      // fable 線(ADR 0068 決定4)。盤面全体の停止はスロット行が1回で言う
      skipped: t.status === 'skipped',
      frontInserted: RECENT_FRONTS.has(t.id), flash: RECENT_FRONTS.has(t.id),
    }));
  const openChildren: Record<string, number> = {};
  for (const t of board) {
    // cancelled never reaches here (server-side board filter, issue #35)
    if (t.parent_id && t.status !== 'done') {
      openChildren[t.parent_id] = (openChildren[t.parent_id] || 0) + 1;
    }
  }
  const cols: Record<BoardScreenColumn, BoardScreenTask[]> = { todo: [], in_progress: [], blocked: [], done: [] };
  for (const t of board) {
    const col = t.status as BoardScreenColumn;
    if (!cols[col]) continue; // e.g. held/skipped have no column of their own
    cols[col].push({
      id: t.id, title: liveTitle(t), type: t.type,
      assignee: t.assignee === 'human' ? 'you' : t.assignee ?? undefined,
      assigneeIcon: t.assignee ? icons[t.assignee] : undefined,
      human: t.assignee === 'human', risk: !!t.risk_flag, children: openChildren[t.id],
      // the card's raw column status + assignee (issue #129's Add-child
      // dialog gates on these client-side — a display convenience only, the
      // API's own assertHumanDecomposable is the real gate) — kept separate
      // from `assignee` above, which is resolved for display and would
      // misrepresent an unset assignee here
      status: col, rawAssignee: t.raw_assignee,
      // issue #130: the edit form hides content/workspace for an issue-backed
      // task (immutable — the source of truth is GitHub); a display cue only,
      // editTask on the server is the real gate
      githubIssueNumber: t.github_issue_number,
    });
  }
  // 後始末中の session の行は「走っている」ではない (issue #561 / ADR 0113 決定2) ——
  // 上限到達による中断では行が `in_progress` のまま残る。concurrency=1 なのでその行は
  // teardown の taskId そのもの。queue 画面の slot 状態も `data.running` 経由でここに従う
  const running = board.find((t) => t.status === 'in_progress' && t.id !== teardown?.taskId);
  const throttled = !!throttle?.throttled;
  // ADR 0030: which pace line is hit (session/week), and the fable line's own
  // per-task state — resets_at is now the catch-up ("resumes") instant, and a
  // fable-only excess shows here while the board itself keeps flowing
  const throttleWindows = throttle?.windows ?? { session: null, week: null, fable: null };
  const hitLines = (['session', 'week', 'fable'] as const).filter((w) => throttleWindows[w]?.throttled);
  const fableWindow = throttleWindows.fable;
  const fableThrottled = !!fableWindow?.throttled;
  const fableResumesAt =
    fableThrottled && fableWindow.resumeAt ? fmtTime(fableWindow.resumeAt) : null;
  const halt = (slot: AppSlot, kind: AppToastKind, msg: string, detail?: string) => ({ slot, toast: { kind, msg, detail } });
  // ADR 0068 決定1/決定7: the display priority now lives in the server's ordered
  // enumeration, not in a ternary chain here — this is a plain kind → copy map
  // over its head. A new board-wide halt adds one entry, not a new arm.
  const HALT_COPY = {
    triage: () => halt(
      { color: 'var(--sun-4)', line: 'triage in progress · nothing starts', meta: 'close triage session to resume', taskId: null },
      'warn', 'moved to front — pickup blocked', 'triage in progress — close the session to resume'),
    pause: () => halt(
      { color: 'var(--rock-4)', line: 'pickup paused — nothing starts until resumed', meta: 'poll idle', taskId: null },
      'warn', 'moved to front — pickup is paused', 'resume to run it'),
    containment: () => halt(
      { color: 'var(--coral-4)', line: 'worker containment unavailable · nothing starts', meta: 'see the repair question', taskId: null },
      'warn', 'moved to front — pickup blocked', 'worker containment is not established'),
    // ADR 0112 決定1: 盤面自身のコードが投げた後始末。想定どおり走っている後始末を
    // 報せる下の待ちの行と違い、これは止まっている
    failedTeardown: () => halt(
      { color: 'var(--coral-4)', line: 'board teardown failed · nothing starts', meta: 'see the repair question', taskId: null },
      'warn', 'moved to front — pickup blocked', "the board's own teardown failed"),
    registryReachability: () => halt(
      { color: 'var(--coral-4)', line: 'registry remote unreachable · nothing starts', meta: 'see the repair question', taskId: null },
      'warn', 'moved to front — pickup blocked', 'registry remote is unreachable'),
    // 再観測中は独立の kind ではなく throttle entry の属性 (ADR 0068 決定2) —
    // 「観測中」と「観測結果」は同じ主題なので、分岐はこの1つの腕の中に閉じる。
    // 鮮度(observedAt)と再開見込みは entry 自身が運ぶ
    throttle: (entry: AppBoardHalt) => {
      const observed = entry.observedAt ? fmtTime(entry.observedAt) : null;
      const resumes = entry.resumesAt ? fmtTime(entry.resumesAt) : null;
      if (entry.revalidating) {
        return halt(
          {
            color: 'var(--sun-4)', line: 'usage re-evaluation in progress · nothing starts', taskId: null,
            meta: observed ? `last observed ${observed}` : 'no observation yet',
          },
          'info', 'moved to front — usage is being re-evaluated', 'waiting for a fresh observation');
      }
      return halt(
        {
          color: 'var(--coral-4)', taskId: null,
          ...(entry.failClosed
            ? {
                line: 'usage check unavailable · nothing starts',
                meta: `fail-closed — check usage check logs${observed ? ` · observed ${observed}` : ''}`,
              }
            : {
                line: 'usage pace · nothing starts',
                // which line is hit (ADR 0030) — an old pre-window row (no
                // windows persisted yet) falls back to the plain resume text
                meta: `${hitLines.length ? `${hitLines.join(' + ')} line · ` : ''}resumes ${resumes}${observed ? ` · observed ${observed}` : ''}`,
              }),
        },
        'warn', 'moved to front — pickup blocked',
        entry.failClosed
          ? 'usage check unavailable — nothing starts until a fresh reading arrives'
          : `usage limit · resumes ${resumes}`);
    },
    // 門そのもの (ADR 0133 決定3 / #749 User Story 8): HALT_KINDS に1つ足して
    // ここを更新しないと typecheck が落ちる。これがあるので下の引きに `?.` は要らない
  } satisfies Record<HaltKind, (entry: AppBoardHalt) => { slot: AppSlot; toast: AppToast }>;
  const pickupHalt = halts[0] && HALT_COPY[halts[0].kind](halts[0]);
  // 後始末行は1本のまま、待っている理由だけが経路で変わる。経路を導くのはサーバ
  // (`teardown.settlement`、ADR 0113 決定3)で、ここは HALT_COPY と同じ値 → コピーの
  // 写像だけを持つ —— 行の status から導き直せば写しが2本になる
  const TEARDOWN_META: Record<import('../src/wire-contract').Teardown['settlement'], string> = {
    completed: "waiting for this session's processes to exit",
    interrupted: 'usage limit hit · task returns to the queue once processes exit',
    released: "task released · waiting for this session's processes to exit",
  };
  // taskId (real deployments only) is a full UUID — the Queue screen renders
  // it as its own truncated chip (title tooltip carries the full value), so
  // `line` stays free of raw ids for the busy and paused slot lines alike.
  // a running task always wins the slot line — throttle_state only refreshes
  // at pickup-decision time, so mid-run it may already be stale. Pause is the
  // one halt that still speaks over a running task, because what it has to say
  // is about that task's fate (issue #34): it finishes, nothing follows. これは
  // かつて QueueScreen 側の pausedSlot が持っていた分岐で、画面がサーバ順序
  // (ADR 0068 決定1)を上書きしないようこちらへ移した。
  const slot = running
    ? paused
      ? { color: 'var(--rock-4)', line: 'pickup paused · task finishes, nothing new starts', meta: 'poll idle', taskId: running.id }
      : { color: 'var(--tide-4)', line: liveTitle(running), meta: running.assignee ?? '', taskId: running.id }
    : pickupHalt
    ? pickupHalt.slot
    : teardown
    ? {
        // ADR 0109 決定2 / CONTEXT.md「後始末」: 枠を握っているのは task ではなく
        // session である。**停止ではない**ので HALT_COPY には居ない —— 人間から見た
        // 「タスクは done なのに次が始まらない」に、待ちの色で答える行がこれ
        color: 'var(--sun-4)', taskId: teardown.taskId,
        line: 'session teardown · nothing new starts',
        meta: `${TEARDOWN_META[teardown.settlement]} · since ${fmtTime(teardown.startedAt)}`,
      }
    : fableThrottled
    ? {
        // fable line only (ADR 0030): the board keeps flowing — fable-model
        // tasks alone wait for their catch-up
        color: 'var(--rock-3)', taskId: null,
        line: 'slot free — fable tasks paced',
        meta: fableResumesAt ? `fable line · resumes ${fableResumesAt}` : 'fable line',
      }
    : {
        color: 'var(--rock-3)', line: 'slot free — nothing running', taskId: null,
        // fable の観測状態を常時可視化 (ADR 0030): per-model 行の書式変更で
        // 観測が黙って落ちたとき、Max プランの人間がここで気づける
        meta: `concurrency=1 · fable ${fableWindow ? 'on pace' : 'not observed'}`,
      };
  return {
    questions, log: logEntries, queue, board: cols, icons,
    scratchpad: triage.scratchpad.map((line): TpScratchLine => ({ id: line.id, text: line.line })),
    // human 宛ての未決着タスクは /api/your-tasks が持つ (issue #301) — 実行キューと
    // 同じく行集合の出所はサーバ1箇所で、blocking(この行が塞いでいる親)も
    // ADR 0049 の述語をサーバが当てた答えをそのまま運ぶ
    humanTasks: yourTasks.map((t) => ({ id: t.id, title: liveTitle(t), blocking: t.blocking })),
    slot, pickupHalt, running: !!running, paused: !!paused,
    triageActive: halts.some((h) => h.kind === 'triage'),
    // Spend-down (ADR 0091) — window ごとの盤面状態応答から素通し
    spendDown: pause.spendDown ?? { session: null, week: null },
    providerUsage,
    throttled,
    throttleRevalidating: !!throttle?.revalidating,
    fableThrottled, fableResumesAt,
    lastLogId: log.entries.at(-1)?.id ?? null,
  };
}

async function fetchData() {
  const [board, log, pause, candidates, triage, queue, yourTasks] = await Promise.all([
    api('GET /api/tasks'),
    api('GET /api/log'),
    api('GET /api/pause'),
    api('GET /api/registry/candidates').catch(() => ({ icons: {} })),
    api('GET /api/triage'),
    api('GET /api/queue'),
    api('GET /api/your-tasks'),
  ]);
  return mapData(board, log, pause, candidates.icons, triage, queue, yourTasks);
}

// Full-screen tide wash overlay. Covers, holds a beat with a serif line, drains.
function TpTideWash({ label, emoji, duration = 1250 }: { label: string; emoji?: string; duration?: number }) {
  const dur = `${duration}ms`;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 60, overflow: 'hidden', pointerEvents: 'none' }} aria-hidden="true">
      <div className="tp-wash-water" style={{ position: 'absolute', inset: '-40px 0 0 0', animationDuration: dur }}>
        <div style={{ animation: `tp-bob ${dur} ease-in-out both` }}>
          <svg width="calc(100% + 36px)" height="40" viewBox="0 0 476 40" preserveAspectRatio="none" style={{ display: 'block' }}>
            <path d="M0 24 Q30 10 60 22 T120 22 T180 20 T240 24 T300 18 T360 22 T420 20 T476 22 L476 40 L0 40 Z" fill="var(--tide-4)" opacity="0.92"/>
            <path d="M0 30 Q40 18 80 28 T160 28 T240 30 T320 26 T400 30 T476 28 L476 40 L0 40 Z" fill="var(--tide-3)" opacity="0.5"/>
          </svg>
        </div>
        <div style={{ position: 'absolute', top: 39, left: 0, right: 0, bottom: -80, background: 'var(--tide-4)', opacity: 0.94 }}></div>
        <div className="tp-wash-label" style={{ position: 'absolute', top: '36%', left: 0, right: 0, textAlign: 'center', padding: '0 24px', animationDuration: dur }}>
          {emoji && <div style={{ fontSize: 44, marginBottom: 12 }}>{emoji}</div>}
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', lineHeight: 1.2, color: '#fff' }}>{label}</div>
        </div>
      </div>
    </div>
  );
}

// Every board dialog must portal to <body>: the DS Dialog is position:fixed,
// but a transformed ancestor (the tab-transition wrapper's animation) re-bases
// "fixed" onto the full scrollable page instead of the viewport, parking the
// dialog at the page middle. Rendering outside the app subtree pins it back to
// the viewport. One wrapper so the workaround (and its reason) lives once.
function PortalDialog(props: import('../design-system/components/surfaces/Dialog').DialogProps) {
  const { Dialog } = window.TidepoolDesignSystem_8a0ead;
  return ReactDOM.createPortal(<Dialog {...props} />, document.body);
}

// A push notification tapped outside quiet hours deep-links straight here
// (?question=<id>, issue #14) — TpSingleQuestion (design-synced,
// single-question-view.tsx) is the same screen the kit demo simulates a push
// into; answering it here POSTs to the real /api/tasks/:id/answer instead of
// touching mock data, so front-insert + the immediate poll fire for real.
function QuestionDeepLinkView({ questionId, onDone, onTranslate }: {
  questionId: string;
  onDone: (answeredTask: WireContract['GET /api/tasks/:id'] | null) => void;
  onTranslate?: TpTranslateFn;
}) {
  const { Button, Card } = window.TidepoolDesignSystem_8a0ead;
  const [q, setQ] = React.useState<TpQuestion | null | undefined>(undefined); // undefined = loading, null = gone
  const [rawTask, setRawTask] = React.useState<WireContract['GET /api/tasks/:id'] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [task, candidates] = await Promise.all([
        api('GET /api/tasks/:id', { params: { id: questionId } }).catch(() => null),
        api('GET /api/registry/candidates').catch(() => ({ icons: {} })),
      ]);
      if (cancelled) return;
      if (!task || task.type !== 'question' || task.status !== 'todo') return setQ(null);
      setRawTask(task);
      setQ(toQuestionCardShape(task, candidates.icons));
    })().catch(() => { if (!cancelled) setQ(null); });
    return () => { cancelled = true; };
  }, [questionId]);

  const answer = async (answers: string[]) => {
    if (busy) return; // guards the design component's button against a double-tap
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/tasks/${questionId}/answer`, { answers });
      onDone(rawTask);
    } catch (e) {
      setErr(String((e as Error).message || e));
      setBusy(false);
    }
  };

  if (q === undefined) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-page)' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', color: 'var(--tide-5)' }}>tidepool</span>
      </div>
    );
  }

  if (q === null) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 24, boxSizing: 'border-box', background: 'var(--surface-page)' }}>
        <Card style={{ textAlign: 'center', padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            This question is no longer available — it may already be answered.
          </div>
          <Button variant="primary" onClick={() => onDone(null)}>Open board</Button>
        </Card>
      </div>
    );
  }

  return (
    // TpSingleQuestion is `position: absolute; inset: 0` (same as the design
    // kit's own shell) — needs this positioned, width-capped ancestor so it
    // covers the 440px column instead of the full viewport.
    <div style={{ height: '100vh', position: 'relative', overflow: 'hidden', background: 'var(--surface-page)' }}>
      <TpSingleQuestion q={q} onAnswer={answer} onClose={() => onDone(null)} onTranslate={onTranslate} />
      {err && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 60, fontSize: 'var(--text-sm)', color: '#fff', background: 'var(--danger-fg, #c0392b)', borderRadius: 'var(--radius-md)', padding: '10px 16px' }}>
          {err}
        </div>
      )}
    </div>
  );
}

// issue #130: the chooser a board task-card tap opens for a plausibly-editable
// task — the three things a human can do to a registered task (add a child,
// edit its unconsumed fields, cancel it). The eligibility line (human-
// registered, unsettled, not in_progress) is enforced server-side on each
// action; this sheet only offers them, and each action surfaces the domain
// error as a toast if the line isn't met.
function TaskActionsDialog({ task, onAddChild, onEdit, onCancel, onClose }: {
  task: BoardScreenTask;
  onAddChild: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h1 style={{ fontSize: 'var(--text-lg)', margin: '0 0 2px' }}>{task.title}</h1>
      <p style={{ fontSize: 'var(--text-2xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', margin: '0 0 8px' }}>{task.id} · {task.type}</p>
      <Button variant="primary" size="lg" full onClick={onAddChild}>Add child</Button>
      <Button variant="secondary" size="lg" full onClick={onEdit}>Edit</Button>
      <Button variant="secondary" size="lg" full onClick={onCancel}>Cancel task</Button>
      <Button variant="ghost" size="lg" full onClick={onClose}>Close</Button>
    </div>
  );
}

// issue #130: edit a registered task's unconsumed fields. Fetches the full
// task first (the board card carries only display fields), pre-fills, and
// PATCHes only what the human changes. An issue-backed task hides its content
// and workspace (immutable — the source of truth is its GitHub issue); type
// and parent link are never shown (not editable). The server (editTask) is the
// real gate — this form just avoids offering the forbidden edits.
/** 編集できる欄だけを持つフォームの状態(type と parent link は編集不可)。 */
interface EditTaskFields {
  title: string;
  purpose: string;
  completion_criteria: string;
  assignee: string;
  workspace: string;
  risk_flag: boolean;
  review_flag: boolean;
}
function EditTaskDialog({ taskCard, onSaved, onClose, say }: {
  taskCard: BoardScreenTask;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
  say: AppSay;
}) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const [full, setFull] = React.useState<WireContract['GET /api/tasks/:id'] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [candidates, setCandidates] = React.useState<AppCandidates>({ assignees: [], workspaces: [] });
  const [fields, setFields] = React.useState<EditTaskFields | null>(null);
  React.useEffect(() => {
    api('GET /api/registry/candidates').then(setCandidates).catch(() => {});
    api('GET /api/tasks/:id', { params: { id: taskCard.id } }).then((t) => {
      setFull(t);
      setFields({
        title: t.title ?? '', purpose: t.purpose ?? '', completion_criteria: t.completion_criteria ?? '',
        assignee: t.assignee ?? '', workspace: t.workspace ?? '',
        risk_flag: !!t.risk_flag, review_flag: !!t.review_flag,
      });
    }).catch((err) => say('danger', 'could not load task', String((err as Error).message || err)));
  }, [taskCard.id]);
  if (!full || !fields) {
    return <div style={{ padding: '24px 16px', color: 'var(--text-muted)' }}>loading…</div>;
  }
  const issueBacked = full.github_issue_number != null;
  const set = (k: keyof EditTaskFields, v: string | boolean) => setFields((f) => ({ ...f!, [k]: v }) as EditTaskFields);
  const withPlaceholder = (label: string, names: string[]) => [{ value: '', label }, ...names.map((n) => ({ value: n, label: n }))];
  // only the fields that actually changed — an unchanged submission is a no-op
  // server-side, but sending a minimal patch keeps the intent clear
  const changed = () => {
    const out: Partial<EditTaskFields> = {};
    if (!issueBacked) {
      if (fields.title !== (full.title ?? '')) out.title = fields.title;
      if (fields.purpose !== (full.purpose ?? '')) out.purpose = fields.purpose;
      if (fields.completion_criteria !== (full.completion_criteria ?? '')) out.completion_criteria = fields.completion_criteria;
      if (fields.workspace !== (full.workspace ?? '')) out.workspace = fields.workspace;
    }
    if (fields.assignee !== (full.assignee ?? '')) out.assignee = fields.assignee;
    if (fields.risk_flag !== !!full.risk_flag) out.risk_flag = fields.risk_flag;
    if (fields.review_flag !== !!full.review_flag) out.review_flag = fields.review_flag;
    return out;
  };
  const submit = async () => {
    const patch = changed();
    if (Object.keys(patch).length === 0) { onClose(); return; }
    setBusy(true);
    try {
      await api(`/api/tasks/${taskCard.id}`, patch, 'PATCH');
      say('info', 'task edited', taskCard.id);
      await onSaved();
      onClose();
    } catch (err) {
      say('danger', 'edit failed', String((err as Error).message || err));
    }
    setBusy(false);
  };
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Edit</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        {issueBacked
          ? 'issue-backed — content and workspace stay on GitHub, only board-side fields are editable'
          : 'unconsumed fields only — type and parent link are not editable'}
      </p>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!issueBacked && (
          <React.Fragment>
            <Input label="Title" value={fields.title} onChange={(e) => set('title', (e.target as HTMLInputElement).value)} />
            <Input label="Purpose" multiline rows={2} value={fields.purpose} onChange={(e) => set('purpose', (e.target as HTMLInputElement).value)} />
            <Input label="Completion criteria" multiline rows={2} value={fields.completion_criteria} onChange={(e) => set('completion_criteria', (e.target as HTMLInputElement).value)} />
          </React.Fragment>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: issueBacked ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Select label="Assignee" options={withPlaceholder('(default agent)', candidates.assignees)} value={fields.assignee} onChange={(e) => set('assignee', (e.target as HTMLInputElement).value)} />
          {!issueBacked && (
            <Select label="Workspace" options={withPlaceholder('(default workspace)', candidates.workspaces)} value={fields.workspace} onChange={(e) => set('workspace', (e.target as HTMLInputElement).value)} />
          )}
        </div>
        <Checkbox label="risk flag — this task has irreversible external effects" checked={fields.risk_flag} onChange={() => set('risk_flag', !fields.risk_flag)} />
        <Checkbox label="review flag — request an on-completion review" checked={fields.review_flag} onChange={() => set('review_flag', !fields.review_flag)} />
        <Button variant="primary" size="lg" full disabled={busy} onClick={submit}>Save changes</Button>
        <Button variant="ghost" size="lg" full disabled={busy} onClick={onClose}>Cancel</Button>
      </Card>
    </div>
  );
}

// issue #130: the human's direct cancel (CONTEXT.md's Cancel). Optional reason;
// the target and its unfinished descendants go cancelled together (道連れ),
// enforced server-side. An open Tidepool question over the subtree gates it —
// the domain error surfaces as a toast.
function CancelTaskDialog({ task, onCancelled, onClose, say }: {
  task: BoardScreenTask;
  onCancelled: () => Promise<void> | void;
  onClose: () => void;
  say: AppSay;
}) {
  const { Button, Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/cancel`, reason.trim() ? { reason: reason.trim() } : {}, 'POST');
      say('info', 'task cancelled', task.id);
      await onCancelled();
      onClose();
    } catch (err) {
      say('danger', 'cancel failed', String((err as Error).message || err));
    }
    setBusy(false);
  };
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Cancel task</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        cancels "{task.title}" and its unfinished descendants — the record is kept, never erased
      </p>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Reason (optional)" multiline rows={2} value={reason} onChange={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="left blank, only the fact of the cancel is recorded" />
        <Button variant="primary" size="lg" full disabled={busy} onClick={submit}>Cancel this task</Button>
        <Button variant="ghost" size="lg" full disabled={busy} onClick={onClose}>Keep it</Button>
      </Card>
    </div>
  );
}

// The six handoff fields (src/tasks.ts's HANDOFF_FIELDS) under the labels this
// screen shows them by — the field names are the server's, the wording is not.
const HANDOFF_FIELDS = [
  ['outcome', 'outcome vs criteria'],
  ['deliverables', 'deliverable location'],
  ['decision_refs', 'key decision refs'],
  ['dead_ends', 'dead ends'],
  ['resume_context', 'context to resume'],
  ['known_issues', 'known issues (no task)'],
] as const;

// issue #13's handoff assist, wired by issue #301: completing a human task that
// blocks a parent. Free-text dump → the LLM drafts the six fields → the human
// edits and confirms. `missing` is advisory only — the server exempts human
// tasks from the handoff requirement, so an untouched, empty form still
// completes. The draft is optional in the other direction too: no draft client
// (or an unreachable one) is always a 503, and like the register gate's own
// dump → draft → confirm, that just leaves the fields blank to type into.
function CompleteHumanTaskDialog({ task, onCompleted, onClose, say }: {
  task: { id: string; title: string; blocking: string | null };
  onCompleted: () => Promise<void> | void;
  onClose: () => void;
  say: AppSay;
}) {
  const { Button, Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [dump, setDump] = React.useState('');
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [missing, setMissing] = React.useState<string[]>([]);
  const [drafting, setDrafting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const draft = async () => {
    setDrafting(true);
    try {
      const d = await api('POST /api/tasks/:id/complete/draft', { params: { id: task.id }, body: { dump: dump.trim() } });
      setFields(Object.fromEntries(HANDOFF_FIELDS.map(([f]) => [f, d[f] ?? ''])));
      setMissing(d.missing);
    } catch (err) {
      say('info', 'no draft — fill it in yourself', String((err as Error).message || err));
    }
    setDrafting(false);
  };
  const submit = async () => {
    setBusy(true);
    try {
      const handoff = Object.fromEntries(
        HANDOFF_FIELDS.map(([f]) => [f, (fields[f] ?? '').trim()]).filter(([, v]) => v),
      );
      await api(`/api/tasks/${task.id}/complete`, { handoff });
      say('success', 'task completed', task.id);
      await onCompleted();
      onClose();
    } catch (err) {
      say('danger', 'complete failed', String((err as Error).message || err));
    }
    setBusy(false);
  };
  return (
    // 6欄 + ダンプ欄はビューポートより高くなる。DS の Dialog は高さを縛らないので
    // この面自身が巻き取る — kit のモック(TpHandoffSheet)が持つ設計そのもの
    <div style={{ padding: '20px 16px', maxHeight: '70vh', overflowY: 'auto' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Complete task</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        "{task.title}" blocks {task.blocking} — the handoff is what that parent reads when it resumes
      </p>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 14 }}>
        <Input label="How did it go?" multiline rows={3} value={dump} onChange={(e) => setDump((e.target as HTMLInputElement).value)}
          placeholder="dump it — the LLM structures it into the six fields below" />
        <Button variant="secondary" size="lg" full disabled={!dump.trim() || drafting} onClick={draft}>
          {drafting ? 'Drafting…' : 'Draft handoff'}
        </Button>
      </Card>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* 警告は DS の hint(muted)でも error(coral)でもない — 埋まらなかった欄は
            強制されないので危険色は誇張になる。kit のモックと同じ sun-4 で言う */}
        {HANDOFF_FIELDS.map(([field, label]) => (
          <div key={field}>
            <Input label={label} multiline rows={2} value={fields[field] ?? ''}
              onChange={(e) => setFields((f) => ({ ...f, [field]: (e.target as HTMLInputElement).value }))} />
            {missing.includes(field) && (
              <span style={{ display: 'block', marginTop: 5, fontSize: 'var(--text-xs)', color: 'var(--sun-4)' }}>
                ⚠ the draft found nothing for this — optional
              </span>
            )}
          </div>
        ))}
        <Button variant="primary" size="lg" full disabled={busy} onClick={submit}>Done</Button>
        <Button variant="ghost" size="lg" full disabled={busy} onClick={onClose}>Not yet</Button>
      </Card>
    </div>
  );
}

function App() {
  const { Toast, Button, IdChip } = window.TidepoolDesignSystem_8a0ead;
  const [data, setData] = React.useState<AppData | null>(null);
  const [tab, setTabRaw] = React.useState('triage');
  const [tabDir, setTabDir] = React.useState('right');
  const [toast, setToast] = React.useState<AppToast | null>(null);
  const [wash, setWash] = React.useState<{ label: string; emoji?: string } | null>(null);
  // human decompose (issue #129): the board task an "Add child" dialog is
  // open for, or null when closed — set from a board task-card tap
  const [addChildParent, setAddChildParent] = React.useState<BoardScreenTask | null>(null);
  // issue #130: a board task-card tap opens an action chooser (add child /
  // edit / cancel) for a plausibly-eligible task; the edit and cancel dialogs
  // each track their own open task
  const [actionsTask, setActionsTask] = React.useState<BoardScreenTask | null>(null);
  const [editTaskCard, setEditTaskCard] = React.useState<BoardScreenTask | null>(null);
  const [cancelTaskCard, setCancelTaskCard] = React.useState<BoardScreenTask | null>(null);
  // issue #301: the your-tasks row whose completion dialog is open (a row that
  // blocks a parent), or null when closed
  const [completeHumanCard, setCompleteHumanCard] = React.useState<AppData['humanTasks'][number] | null>(null);
  const [deepLinkQuestionId, setDeepLinkQuestionId] = React.useState(
    () => new URLSearchParams(location.search).get('question'),
  );
  const [notifPermission, setNotifPermission] = React.useState(
    () => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'),
  );

  // Display-time translation is meaningless when the board already presents in
  // English (canonical text is English — CONTEXT.md's Display language), so an
  // English board shows no translation toggle at all. We read the board's
  // display language once at launch: English → withhold the onTranslate prop
  // from every kit face (prop absent = no toggle, the kit's own design). This
  // does not live-update on a settings save — a reload re-reads it, matching
  // the "read once at the root" design (issue #47 / #115). Fail open: if the
  // fetch fails we keep the toggle (consistent with the Japanese default).
  const [translationEnabled, setTranslationEnabled] = React.useState(true);
  React.useEffect(() => {
    api('GET /api/settings/display-language')
      .then(({ language }) => setTranslationEnabled(language !== 'English'))
      .catch(() => {});
  }, []);
  const onTranslateProp = translationEnabled ? translateTarget : undefined;

  const tabOrder = tabs.map((x) => x.key);
  const pointerDown = React.useRef(false);
  const tabRef = React.useRef(tab);
  tabRef.current = tab;

  // installed-PWA onboarding (issue #14): register unconditionally so an
  // already-granted permission (a returning visit) re-subscribes silently;
  // a fresh grant still needs the button below (iOS requires a user gesture).
  React.useEffect(() => {
    registerServiceWorker().then((reg) => {
      if (reg && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        subscribeToPush(reg).catch(() => {});
      }
    });
  }, []);

  // board timezone auto-report (issue #63 / ADR 0022): the browser is the
  // one source of truth for the human's wall clock — report it at launch
  // and only write back when it actually differs, so a stationary board
  // never sends a redundant POST on every load.
  React.useEffect(() => {
    api('GET /api/settings/timezone').then(({ tz }) => {
      const observed = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (observed && observed !== tz) return api('/api/settings/timezone', { tz: observed });
    }).catch(() => {});
  }, []);

  const enableNotifications = async () => {
    try {
      const permission = await Notification.requestPermission();
      setNotifPermission(permission);
      if (permission === 'granted') {
        const reg = await registerServiceWorker();
        await subscribeToPush(reg);
        say('success', 'notifications enabled', 'questions outside quiet hours arrive immediately');
      }
    } catch (err) {
      say('danger', 'failed to enable notifications', String((err as Error).message || err));
    }
  };

  const refreshFull = () => fetchData().then(setData).catch(() => {});

  // every tab entry takes a fresh snapshot; screens remount per tab (key)
  const applyTab = (next: string) => {
    setTabRaw((prev) => {
      if (next !== prev) setTabDir(tabOrder.indexOf(next) > tabOrder.indexOf(prev) ? 'right' : 'left');
      return next;
    });
    refreshFull();
  };
  // a tab switch unmounts the screen it leaves, so a screen holding an open
  // editor with unsaved changes gets to ask first (issue #204 決定4). The guard
  // returns true when it parked the switch behind its own dialog.
  const leaveGuard = React.useRef<((move: () => void) => boolean) | null>(null);
  const setTab = (next: string) => {
    // the guard runs the move itself when there is nothing to discard, so the
    // switch must not also be applied here — it only reports whether it parked
    if (leaveGuard.current) { leaveGuard.current(() => applyTab(next)); return; }
    applyTab(next);
  };

  React.useEffect(() => {
    refreshFull();
    const dn = () => { pointerDown.current = true; };
    const up = () => { pointerDown.current = false; };
    window.addEventListener('pointerdown', dn);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // background refresh — never mid-drag, and not over an in-flight triage:
    // triage state is keyed by stable entry/question ids, but the skim is a
    // morning snapshot and must not grow new lines under the reader
    const iv = setInterval(() => {
      if (pointerDown.current || tabRef.current === 'triage') return;
      refreshFull();
    }, 15000);
    return () => {
      clearInterval(iv);
      window.removeEventListener('pointerdown', dn);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  React.useEffect(() => { lucide.createIcons(); });

  const dismissToast = React.useCallback(() => {
    setToast((cur) => (cur && !cur.leaving ? { ...cur, leaving: true } : cur));
    setTimeout(() => setToast(null), 260);
  }, []);
  React.useEffect(() => {
    if (!toast || toast.leaving) return;
    const t = setTimeout(dismissToast, 3200);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);
  const say: AppSay = (kind, msg, detail) => setToast({ kind, msg, detail });

  // Cover the screen with the tide, apply the state change while covered, drain.
  const runWash = (label: string, emoji: string, apply: () => void) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
    setWash({ label, emoji });
    setTimeout(apply, WASH_MS * 0.4);
    setTimeout(() => setWash(null), WASH_MS + 50);
  };

  // a data refresh mid-triage must not shift the snapshot under the flow
  const refresh = async () => {
    const fresh = await fetchData();
    setData((d) => (tab === 'triage' && d
      ? { ...fresh, questions: d.questions, log: d.log, lastLogId: d.lastLogId }
      : fresh));
    return fresh;
  };

  // ADR 0058: only follow a JIT usage observation while the human is waiting
  // for this specific result. The false response clears the interval; the
  // ordinary 15s board refresh remains independent.
  React.useEffect(() => {
    if (!data?.throttleRevalidating) return;
    const iv = setInterval(() => {
      void refresh()
        .then((fresh) => {
          if (!fresh.throttleRevalidating) clearInterval(iv);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(iv);
  }, [data?.throttleRevalidating]);

  // S1 — the last tap in a bundle persists every item's answer atomically;
  // the unblocked parent is staged server-side (issue #30: `a` is one answer
  // per item, in item order)
  const answerNow = async (q: TpTriageQuestion, a: string[]) => {
    try {
      await api(`/api/tasks/${q.id}/answer`, { answers: a, triage: true });
    } catch (err) {
      say('danger', 'answer failed', String((err as Error).message || err));
      throw err;
    }
  };

  // S2 — the objection annotation lands on the log entry the moment it is raised
  const objectNow = async (entry: TpLogEntry, direction: string) => {
    try {
      await api('/api/triage/objection', { entry_id: entry.id, comment: direction });
    } catch (err) {
      say('danger', 'objection failed', String((err as Error).message || err));
      throw err;
    }
  };

  const scratchAdd = async (text: string) => {
    try {
      const l = await api('POST /api/triage/scratchpad', { body: { line: text } });
      return { id: l.id, text: l.line };
    } catch (err) {
      say('danger', 'scratchpad failed', String((err as Error).message || err));
      throw err;
    }
  };

  // an entry never displayed is unobserved — report each skimmed entry once
  const displayedReported = React.useRef(new Set<number>());
  const reportDisplayed = (entries: TpLogEntry[]) => {
    const ids = entries.map((e) => e.id)
      .filter((id) => typeof id === 'number' && !displayedReported.current.has(id));
    if (!ids.length) return;
    ids.forEach((id) => displayedReported.current.add(id));
    api('/api/triage/displayed', { entry_ids: ids }).catch(() => {
      ids.forEach((id) => displayedReported.current.delete(id));
    });
  };

  // S3 — the server's staged preview: this session's front-inserts on top
  const loadPreview = async () => {
    const { queue } = await api('GET /api/triage');
    return queue.map((t): QueueScreenTask => ({
      id: t.id, title: liveTitle(t), assignee: t.assignee ?? undefined,
      assigneeIcon: t.assignee ? data!.icons[t.assignee] : undefined, risk: !!t.risk_flag,
      blocked: t.status === 'blocked', frontInserted: t.front_inserted,
    }));
  };

  // S3 — 着地 question の回答可否は盤面が今この瞬間に答える(ADR 0092 決定4)。
  // triage の data は フロー1回分の凍結 snapshot なので、この面に来るまでに打った
  // 異議は snapshot の注釈には映らない — merge 判断に入るたびに読み直す。
  const loadLanding = async () => {
    const board = await api('GET /api/tasks');
    return Object.fromEntries(
      board.filter((t) => t.type === 'question' && t.landing).map((t) => [t.id, t.landing!]));
  };

  // Commit = close + cursor (ADR 0065 decision 2 / consequences): two calls,
  // composed client-side. /api/triage/close applies scratchpad dispositions
  // and closes an open session when there is one — only that first call can
  // fire the immediate poll. The read cursor is the second call, advanced
  // after: a failed close never marks the skimmed lines as read, and a
  // failed cursor advance never masquerades as a failed commit.
  const closeTriage = (body: { scratchpad?: { id: number; disposition: string }[]; close_only?: boolean }) =>
    api('POST /api/triage/close', { body });

  const commitTriage = async (
    answers: Record<string, string[]>,
    objections: Record<string, string[]>,
    scratch: { id: number; text: string; kind: string }[],
  ) => {
    let result;
    try {
      result = await closeTriage({
        // kit dispositions already speak the domain vocabulary
        scratchpad: scratch
          .filter((s) => typeof s.id === 'number')
          .map((s) => ({ id: s.id, disposition: s.kind })),
      });
    } catch (err) {
      refresh();
      say('danger', 'triage commit failed — nothing applied, cursor NOT advanced',
        String((err as Error).message || err));
      return;
    }
    for (const [qid, a] of Object.entries(answers)) {
      if (!a) continue;
      const q = data!.questions.find((x) => x.id === qid);
      if (q && q.parent) markFront(q.parent);
    }
    let cursorNote = '';
    try {
      if (data!.lastLogId != null) await api('/api/log/cursor', { last_read: data!.lastLogId });
    } catch {
      cursorNote = ' · read cursor NOT advanced (retry from the log)';
    }
    const answered = Object.values(answers).filter(Boolean).length;
    const repairTasks = new Set([...commitPendingObjectionKeys(data!.log, objections)]
      .map((k) => data!.log.find((e) => String(e.id) === String(k))?.taskId)
      .filter(Boolean)).size;
    const summary = [`${data!.log.filter((entry) => entry.unread).length} read`];
    if (answered) summary.push(`${answered} answered`);
    if (repairTasks) summary.push(`${repairTasks} repair`);
    if (scratch.length) summary.push(`${scratch.length} scratchpad applied`);
    let message;
    let outcomeNote = '';
    if (result.outcome === 'closed_now') {
      message = 'triage committed — session closed';
      outcomeNote = ' · immediate poll fired';
    } else if (result.outcome === 'already_closed_by_timeout') {
      const closed = new Date(result.closed_at!);
      const hhmm = `${String(closed.getHours()).padStart(2, '0')}:${String(closed.getMinutes()).padStart(2, '0')}`;
      message = 'triage committed — session already timed out';
      outcomeNote = ` · session closed at ${hhmm}; staged steering was already applied`;
    } else {
      message = 'triage committed — no session was open';
    }
    runWash('The tide is going out.', '🌊', () => {
      setTab('queue');
      say(cursorNote ? 'warn' : 'success', message,
        `${summary.join(' · ')}${outcomeNote}${cursorNote}`);
    });
  };

  // The board-wide halt banner is an escape hatch, not the end of the triage
  // flow (ADR 0065 decision 8): it makes the close call alone — no scratchpad
  // dispositions, no cursor advance. Unlike commitTriage's two-call close +
  // cursor, the banner is close only.
  const closeTriageSession = async () => {
    try {
      const result = await closeTriage({ close_only: true });
      await refresh();
      if (result.outcome === 'closed_now') {
        say('success', 'triage session closed', 'pickup resumed · immediate poll fired');
      } else {
        say('info', 'triage session was already closed', 'pickup was not stopped');
      }
    } catch (err) {
      say('danger', 'failed to close triage session', String((err as Error).message || err));
    }
  };

  // One endpoint, two meanings the server itself distinguishes (issue #82
  // follow-up): a todo already at the head, moved to the head again, is an
  // explicit "run now" (immediate-poll trigger); promoting a different task
  // is pure reordering and fires nothing on its own. The button's color
  // already told the human which one they clicked (queue-screen.tsx); the
  // toast just has to describe honestly what actually happened rather than
  // always claiming success (#79's lesson, ADR 0028).
  const moveFront = async (id: string) => {
    // the *pickable* head, the same predicate the server fires on (issue
    // #299) — not `queue[0]`, which can be a row the slot could never take.
    // held / question / human rows never reach `data.queue` at all (mapData
    // above), so what is left to skip here is blocked and skipped.
    const wasHead = data!.queue.find((r) => !r.blocked && !r.skipped)?.id === id;
    try {
      await api(`/api/tasks/${id}/move`, { after: null });
      markFront(id);
      const fresh = await refresh();
      if (!wasHead) {
        say('info', 'moved to front', 'reordered only — press ↑ again to run it now');
      } else if (fresh.pickupHalt) {
        const { kind, msg, detail } = fresh.pickupHalt.toast;
        say(kind, msg, detail);
      } else {
        say('success', 'moved to front — immediate poll fired', id);
      }
    } catch (err) {
      say('danger', 'move failed', String((err as Error).message || err));
    }
  };

  // Your tasks' Done (issue #13's two doors, wired here by issue #301). Which
  // door opens is the row's own `blocking`, answered server-side: a task that
  // holds nobody up closes in one tap with no doc at all (the human exemption
  // in completeTask), one that blocks a parent opens the handoff dialog first —
  // the parent picks that doc up when it resumes. Unblocking the parent and the
  // immediate poll are the server's job; the browser only refetches.
  const doneHuman = async (id: string) => {
    const task = data!.humanTasks.find((t) => t.id === id);
    if (task?.blocking) { setCompleteHumanCard(task); return; }
    try {
      await api(`/api/tasks/${id}/complete`, {});
      say('success', 'task completed', id);
      await refreshFull();
    } catch (err) {
      say('danger', 'complete failed', String((err as Error).message || err));
    }
  };

  // Pause (issue #34) — the human's own steering channel, never exposed via
  // MCP. Resuming fires an immediate poll server-side; pausing fires nothing.
  // The pause toast detail mirrors the queue slot line's own busy/free split
  // (explorations/Pause Pickup.html's PausePickupApp.togglePause): a running
  // task finishes before anything new starts, an empty slot just stays empty.
  const togglePause = async () => {
    const next = !data!.paused;
    try {
      await api('/api/pause', { paused: next });
      await refresh();
      say(next ? 'info' : 'success', next ? 'pickup paused' : 'pickup resumed',
        next
          ? (data!.slot?.taskId
              ? <>
                  <IdChip id={data!.slot.taskId} style={{ display: 'inline-block', verticalAlign: 'bottom' }} />
                  {' finishes · nothing new starts'}
                </>
              : 'nothing starts until resumed')
          : 'immediate poll fired');
    } catch (err) {
      say('danger', 'pause toggle failed', String((err as Error).message || err));
    }
  };

  // Spend-down (ADR 0091) — pause と同格の盤面状態。有効化は
  // サーバー側が即時 poll を発火する(残りを今すぐ燃やす操作なので)。
  const setSpendDown = async (window: string, active: boolean) => {
    try {
      await api('/api/spend-down', { window, active });
      await refresh();
      say(active ? 'warn' : 'info',
        active ? `spend-down armed · ${window}` : `spend-down cancelled · ${window}`,
        active
          ? 'pace line off — burns to the 100% cap, expires at the window reset'
          : 'pace line back on');
    } catch (err) {
      say('danger', 'spend-down failed', String((err as Error).message || err));
    }
  };

  const reorder = async (next: QueueScreenTask[], movedId: string, pos: number) => {
    try {
      const idx = next.findIndex((t) => t.id === movedId);
      const after = idx <= 0 ? null : next[idx - 1]!.id;
      setData((d) => ({ ...d!, queue: next })); // optimistic: the rows already sit in the new order
      await api(`/api/tasks/${movedId}/move`, { after });
      await refresh();
      say('info', 'queue reordered', `${movedId} → position ${pos}`);
    } catch (err) {
      await refresh();
      say('danger', 'reorder failed', String((err as Error).message || err));
    }
  };

  // a completion entry unfolds its handoff doc in place — the log's link back
  // to the deliverable (issue #5). a failed fetch surfaces in the expansion
  // via the kit's catch, not as a silent no-op.
  const loadHandoff = async (entry: TpLogEntry) => {
    const task = await api('GET /api/tasks/:id', { params: { id: entry.taskId } });
    return task.handoff_doc ?? '(no handoff doc)';
  };

  const register = async (fields: RegisterScreenFields) => {
    try {
      const t = await api('POST /api/tasks', { body: fields });
      runWash('Into the pool.', '🫧', () => {
        setTab('queue');
        say('info', 'registered — appended to queue tail', t.id);
      });
    } catch (err) {
      // a gate rejection (422, issue #49) renders inline in the register
      // screen — a toast would bury the suggested comment it carries
      if (!(err instanceof ApiError) || err.status !== 422) say('danger', 'registration failed', String((err as Error).message || err));
      throw err;
    }
  };

  // issue #129/#130: a board task-card tap opens the action chooser (add child
  // / edit / cancel) only for a task the client can already tell is plausibly
  // eligible — done and another worker's in-progress task are cheap, always-
  // correct exclusions from the board's own derived `status`/`assignee`
  // (CONTEXT.md's Decompose/Edit/Cancel share the same first two conditions);
  // the remaining conditions (no agent-decomposed child yet for add-child;
  // human-registered for edit/cancel) need event history the board payload
  // doesn't carry, so they're left to the API's own gates to reject on submit.
  // An ineligible tap keeps the plain info toast this used to always show.
  const openTask = (t: BoardScreenTask) => {
    const settled = t.status === 'done';
    const othersInProgress = t.status === 'in_progress' && t.rawAssignee !== 'human';
    if (settled || othersInProgress) {
      say('info', t.title, `${t.id} · ${t.type}`);
      return;
    }
    setActionsTask(t);
  };

  // human decompose (issue #129): adding a child stays on the current tab
  // (it's a dialog, not a screen switch) — refresh the board so the new
  // child (or, on a risk/protected-workspace conversion, the approval
  // question it produced instead — same status code, humanDecomposeTask's
  // own union) shows up at once.
  const addChild = async (fields: RegisterScreenFields) => {
    try {
      const t = await api('POST /api/tasks', { body: fields });
      say(
        'info',
        t.type === 'question' ? 'sent for approval' : 'child added — appended to queue tail',
        t.id,
      );
      await refreshFull();
    } catch (err) {
      say('danger', 'add child failed', String((err as Error).message || err));
      throw err;
    }
  };

  if (deepLinkQuestionId) {
    return (
      <QuestionDeepLinkView
        questionId={deepLinkQuestionId}
        onTranslate={onTranslateProp}
        onDone={(answeredTask) => {
          if (answeredTask && answeredTask.parent_id) markFront(answeredTask.parent_id);
          history.replaceState(null, '', location.pathname);
          setDeepLinkQuestionId(null);
          refreshFull();
        }}
      />
    );
  }

  if (!data) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-page)' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', color: 'var(--tide-5)' }}>tidepool</span>
      </div>
    );
  }

  const unreadCount = data.log.filter((l) => l.unread).length;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--surface-page)', boxShadow: '0 0 40px rgba(23,33,30,0.12)', position: 'relative', overflow: 'hidden' }}>
      {wash && <TpTideWash label={wash.label} emoji={wash.emoji} duration={WASH_MS} />}
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 10px', borderBottom: '1px solid var(--border-hairline)', position: 'sticky', top: 0, background: 'var(--surface-page)', zIndex: 10 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 22, color: 'var(--tide-5)' }}>tidepool</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: data.paused ? 'var(--rock-4)' : 'var(--text-muted)' }}>
          {data.paused ? 'pickup paused · ' : ''}{data.questions.length} questions · {unreadCount} new log · queue {data.queue.length}
        </span>
      </header>

      {data.triageActive && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--sun-2)', background: 'var(--sun-1)' }}>
          <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
            triage in progress — pickup is stopped
          </span>
          <Button variant="secondary" onClick={closeTriageSession}>close triage session</Button>
        </div>
      )}

      {notifPermission === 'default' && 'serviceWorker' in navigator && 'PushManager' in window && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--rock-2)' }}>
          <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Enable notifications to get questions outside quiet hours the moment they're asked.
          </span>
          <Button variant="secondary" onClick={enableNotifications}>Enable</Button>
        </div>
      )}

      <main className="tp-scroll" style={{ flex: 1, minHeight: 0, overflowY: tab === 'board' ? 'hidden' : 'auto', paddingBottom: tab === 'board' ? 56 : 76, boxSizing: 'border-box' }}>
        <div key={tab} className={tabDir === 'right' ? 'tp-tab-right' : 'tp-tab-left'} style={tab === 'board' ? { height: '100%' } : { minHeight: '100%' }}>
        {tab === 'triage' && (data.questions.length || unreadCount || data.scratchpad.length || data.triageActive
          ? <TriageScreen data={data} onCommit={commitTriage} loadHandoff={loadHandoff}
              onAnswer={answerNow} onObject={objectNow} onScratchAdd={scratchAdd} onDisplayed={reportDisplayed} loadPreview={loadPreview} loadLanding={loadLanding}
              onTranslate={onTranslateProp} />
          : <div style={{ padding: '64px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>🐚</div>
              <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', color: 'var(--tide-5)', marginBottom: 8 }}>Low tide. Go enjoy your coffee.</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>the pool refills as tasks come in.</div>
            </div>)}
        {tab === 'board' && <BoardScreen data={data} onOpenTask={openTask} />}
        {tab === 'queue' && <QueueScreen data={data} slotState={data.running ? 'busy' : (data.throttled ? 'limit' : 'free')} paused={data.paused} onTogglePause={togglePause} spendDown={data.spendDown} onSpendDown={setSpendDown} onFront={moveFront} onDoneHuman={doneHuman} onReorder={reorder} />}
        {tab === 'register' && <RegisterScreen onRegister={register} />}
        {tab === 'settings' && <SettingsScreen say={say} registerLeaveGuard={(fn: ((move: () => void) => boolean) | null) => { leaveGuard.current = fn; }} />}
        </div>
      </main>

      {toast && (
        <div style={{ position: 'fixed', bottom: 86, left: '50%', transform: 'translateX(-50%)', zIndex: 50, width: 'calc(100% - 32px)', maxWidth: 408 }}>
          <div className={toast.leaving ? 'tp-toast-out' : 'tp-toast-in'}>
            <Toast kind={toast.kind} detail={toast.detail} onDismiss={dismissToast}>{toast.msg}</Toast>
          </div>
        </div>
      )}

      {/* human decompose (issue #129): a board task-card tap opens this
          instead of building a separate tree-registration screen (CONTEXT.md's
          Decompose point 2) — the line itself (unsettled / not in-progress
          unless it's the human's own / no agent-decomposed child yet) is
          enforced server-side; a task outside it just surfaces the domain
          error as a toast on submit. */}
      <PortalDialog open={!!addChildParent} onClose={() => setAddChildParent(null)}>
        {addChildParent && (
          <RegisterScreen parentTask={addChildParent} onRegister={addChild} onClose={() => setAddChildParent(null)} />
        )}
      </PortalDialog>

      {/* issue #130: the action chooser and the edit/cancel dialogs. Each
          action's real gate is server-side (editTask / cancelTaskDirectly) —
          these surfaces only offer the actions and toast the domain error when
          the task is outside the scope line. */}
      <PortalDialog open={!!actionsTask} onClose={() => setActionsTask(null)}>
        {actionsTask && (
          <TaskActionsDialog
            task={actionsTask}
            onAddChild={() => { setAddChildParent(actionsTask); setActionsTask(null); }}
            onEdit={() => { setEditTaskCard(actionsTask); setActionsTask(null); }}
            onCancel={() => { setCancelTaskCard(actionsTask); setActionsTask(null); }}
            onClose={() => setActionsTask(null)}
          />
        )}
      </PortalDialog>
      <PortalDialog open={!!editTaskCard} onClose={() => setEditTaskCard(null)}>
        {editTaskCard && (
          <EditTaskDialog taskCard={editTaskCard} say={say} onSaved={refreshFull} onClose={() => setEditTaskCard(null)} />
        )}
      </PortalDialog>
      <PortalDialog open={!!cancelTaskCard} onClose={() => setCancelTaskCard(null)}>
        {cancelTaskCard && (
          <CancelTaskDialog task={cancelTaskCard} say={say} onCancelled={refreshFull} onClose={() => setCancelTaskCard(null)} />
        )}
      </PortalDialog>
      <PortalDialog open={!!completeHumanCard} onClose={() => setCompleteHumanCard(null)}>
        {completeHumanCard && (
          <CompleteHumanTaskDialog task={completeHumanCard} say={say} onCompleted={refreshFull} onClose={() => setCompleteHumanCard(null)} />
        )}
      </PortalDialog>

      <nav style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 440, display: 'flex', background: 'var(--surface-card)', borderTop: '1px solid var(--border-hairline)', zIndex: 20 }}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                padding: '10px 0 12px', minHeight: 56, background: 'none', border: 'none', cursor: 'pointer',
                color: active ? 'var(--tide-4)' : 'var(--text-muted)',
                borderTop: `2px solid ${active ? 'var(--tide-4)' : 'transparent'}`, marginTop: -1,
              }}>
              <i data-lucide={t.icon} style={{ width: 20, height: 20 }}></i>
              <span style={{ fontSize: 'var(--text-2xs)', fontFamily: 'var(--font-mono)' }}>{t.label.toLowerCase()}</span>
              {t.key === 'triage' && (data.questions.length + unreadCount) > 0 && !active && (
                <span style={{ position: 'absolute', transform: 'translate(16px, -2px)', minWidth: 15, height: 15, borderRadius: 999, background: 'var(--tide-4)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px', padding: '0 3px' }}>{data.questions.length + unreadCount}</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
// Wait for the DS bundle before mounting — a slow bundle load must not white-screen the page.
(function mountWhenReady(tries) {
  if (window.TidepoolDesignSystem_8a0ead) {
    // @types/react-dom は createRoot を react-dom/client 側に置くが、public/vendor の
    // UMD グローバルは持っている(ADR 0055)
    (ReactDOM as unknown as { createRoot(el: Element): { render(node: React.ReactNode): void } })
      .createRoot(document.getElementById('root')!).render(<App />);
  } else if (tries > 0) {
    setTimeout(() => mountWhenReady(tries - 1), 100);
  } else {
    document.getElementById('root')!.innerHTML = '<p style="padding:24px;font-family:monospace;font-size:12px;color:#5c6b66">_ds_bundle.js failed to load — recompile the design system.</p>';
  }
})(50);
