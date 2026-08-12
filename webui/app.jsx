const WASH_MS = 1250;

const tabs = [
  { key: 'triage', label: 'Triage', icon: 'sunrise' },
  { key: 'board', label: 'Board', icon: 'columns-3' },
  { key: 'queue', label: 'Queue', icon: 'list-ordered' },
  { key: 'register', label: 'Register', icon: 'plus' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(typeof err.error === 'string' ? err.error : res.statusText);
    // the registration gate's 422 (issue #49) carries structure beyond the
    // message (missing / suggested_comment) — keep it for the caller
    e.status = res.status;
    e.detail = err;
    throw e;
  }
  return res.json();
}

// ADR 0063 決定1: the caller-side pacer. All 3 toggle sites (question card,
// log skim, handoff) route through this one `translateTarget` definition, so
// wrapping it here — not in the kit's `runTranslate` — is what makes "every
// switch passes through the same gate" true without touching the kit. The
// kit still fires N calls; this queues them to MAX_CONCURRENT_TRANSLATIONS.
const MAX_CONCURRENT_TRANSLATIONS = 2;
let translationsInFlight = 0;
const translationQueue = [];
// ADR 0063 決定4: a queued (not yet dispatched) call cancels on `signal` abort
// and is never sent — a dispatched one is past this gate and always runs to
// completion (its paid tokens shouldn't be thrown away). The listener is
// removed the instant a call dispatches, so aborting after dispatch is a
// no-op — exactly the "sent keeps running" half of the decision.
function paceTranslation(run, signal) {
  return new Promise((resolve, reject) => {
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
const translateTarget = (target, { signal } = {}) => paceTranslation(() => api('/api/translate', target), signal);

// Web Push (issue #14): applicationServerKey wants raw bytes, the server
// hands back the VAPID public key as URL-safe base64.
function urlBase64ToUint8Array(base64String) {
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
async function subscribeToPush(registration) {
  const { publicKey } = await fetch('/api/push/vapid-public-key').then((r) => r.json());
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
function markFront(id) {
  RECENT_FRONTS.add(id);
  setTimeout(() => RECENT_FRONTS.delete(id), 4000);
}

// An issue-backed task's title, live-expanded server-side (issue #49, ADR
// 0016's UI use-moment), carries issue_live_state: suffix the title so
// cached-but-old (stale) and never-fetched (unavailable) are visible at a
// glance. Ordinary tasks have no issue_live_state and pass through as-is.
function liveTitle(t) {
  if (t.issue_live_state === 'stale') return `${t.title} (out of sync)`;
  if (t.issue_live_state === 'unavailable') return `${t.title} (unavailable)`;
  return t.title;
}

// Map the server board + decision log into the shape the kit screens consume.
// `icons` is the registry's assignee name → icon map (issue #52's
// GET /api/registry/candidates); a name absent from it renders with
// AgentChip's initials fallback.
function mapData(board, log, pause, icons = {}, triage = {}) {
  const paused = pause.paused;
  const throttle = pause.throttle;
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const questions = board
    .filter((t) => t.status === 'todo' && t.type === 'question')
    .map((q) => {
      // who issued the question — the board itself (issue #261) or an agent
      // (never human: a question only ever comes from a non-human registrant)
      const isBoard = q.registrant === 'tidepool';
      return {
        id: q.id, parent: q.parent_id,
        agent: q.registrant,
        agentIcon: isBoard ? undefined : icons[q.registrant],
        board: isBoard,
        context: q.purpose,
        // 1-4 items, each with its own title/detail/options (issue #30) — a
        // single-item bundle is the degenerate, most common case
        items: (q.question_items ?? []).map((item) => ({
          title: item.title, detail: item.detail,
          options: item.options.map((o) => ({ label: o, recommended: o === item.recommendation })),
        })),
      };
    });
  // newest first for the skim; unread is the server's cursor + authorship
  // decision. workspace grouping/fold (issue #44) is pure view derivation the
  // kit does itself from this flat, order-independent list — see triage-screen.jsx.
  const logEntries = [...log.entries].reverse().map((e) => ({
    id: e.id, time: fmtTime(e.created_at), taskId: e.task_id, agent: e.worker_id,
    agentIcon: icons[e.worker_id], human: e.worker_id === 'human',
    kind: e.kind === 'task_completed' ? 'completion' : 'decision',
    text: e.kind === 'task_completed' ? (e.payload.result ?? '(no outcome recorded)') : e.payload.line,
    unread: e.unread,
    handoffPresent: e.kind === 'task_completed' && !!e.payload.handoff_present,
    workspace: e.workspace ?? null,
  }));
  // the queue is the todo order the slot walks. derived-blocked rows keep
  // their sort_key position (the slot skips them until the children finish),
  // so they stay visible — hiding them would make the displayed order lie
  // about where a drag actually lands. questions stay out: they never enter
  // the slot and are answered in triage.
  const queue = board
    .filter((t) => (t.status === 'todo' || t.status === 'blocked') && t.type !== 'question')
    .map((t) => ({
      id: t.id, title: liveTitle(t), assignee: t.assignee ?? undefined,
      assigneeIcon: t.assignee ? icons[t.assignee] : undefined, risk: !!t.risk_flag,
      blocked: t.status === 'blocked',
      frontInserted: RECENT_FRONTS.has(t.id), flash: RECENT_FRONTS.has(t.id),
    }));
  const openChildren = {};
  for (const t of board) {
    // cancelled never reaches here (server-side board filter, issue #35)
    if (t.parent_id && t.status !== 'done') {
      openChildren[t.parent_id] = (openChildren[t.parent_id] || 0) + 1;
    }
  }
  const cols = { todo: [], in_progress: [], blocked: [], done: [] };
  for (const t of board) {
    if (!cols[t.status]) continue; // e.g. held/skipped have no column of their own
    cols[t.status].push({
      id: t.id, title: liveTitle(t), type: t.type,
      assignee: t.assignee === 'human' ? 'you' : t.assignee ?? undefined,
      assigneeIcon: t.assignee ? icons[t.assignee] : undefined,
      human: t.assignee === 'human', risk: !!t.risk_flag, children: openChildren[t.id],
      // the card's raw column status + assignee (issue #129's Add-child
      // dialog gates on these client-side — a display convenience only, the
      // API's own assertHumanDecomposable is the real gate) — kept separate
      // from `assignee` above, which is resolved for display and would
      // misrepresent an unset assignee here
      status: t.status, rawAssignee: t.raw_assignee,
      // issue #130: the edit form hides content/workspace for an issue-backed
      // task (immutable — the source of truth is GitHub); a display cue only,
      // editTask on the server is the real gate
      githubIssueNumber: t.github_issue_number,
    });
  }
  const running = board.find((t) => t.status === 'in_progress');
  const throttled = !!throttle?.throttled;
  // resets_at null while throttled is the fail-closed case (#79's lesson):
  // usage itself could not be observed, not merely "over threshold" — the
  // slot must say so rather than showing a bogus/absent resume time
  const throttleFailClosed = throttled && !throttle.resumesAt;
  const throttleResumesAt = throttled && !throttleFailClosed ? fmtTime(throttle.resumesAt) : null;
  // ADR 0030: which pace line is hit (session/week), and the fable line's own
  // per-task state — resets_at is now the catch-up ("resumes") instant, and a
  // fable-only excess shows here while the board itself keeps flowing
  const throttleWindows = throttle?.windows ?? { session: null, week: null, fable: null };
  const hitLines = ['session', 'week', 'fable'].filter((w) => throttleWindows[w]?.throttled);
  const fableWindow = throttleWindows.fable;
  const fableThrottled = !!fableWindow?.throttled;
  const fableResumesAt =
    fableThrottled && fableWindow.resumeAt ? fmtTime(fableWindow.resumeAt) : null;
  const throttleObservedAt = throttle?.observedAt ? fmtTime(throttle.observedAt) : null;
  const halt = (slot, kind, msg, detail) => ({ slot, toast: { kind, msg, detail } });
  const pickupHalt = pause.triageActive
    ? halt(
        { color: 'var(--sun-4)', line: 'triage in progress · nothing starts', meta: 'close triage session to resume', taskId: null },
        'warn', 'moved to front — pickup blocked', 'triage in progress — close the session to resume')
    : paused
    ? halt(
        { color: 'var(--tide-4)', line: 'pickup paused — nothing starts until resumed', meta: '', taskId: null },
        'warn', 'moved to front — pickup is paused', 'resume to run it')
    : pause.containmentBlocked
    ? halt(
        { color: 'var(--coral-4)', line: 'worker containment unavailable · nothing starts', meta: 'see the repair question', taskId: null },
        'warn', 'moved to front — pickup blocked', 'worker containment is not established')
    : pause.registryReachabilityBlocked
    ? halt(
        { color: 'var(--coral-4)', line: 'registry remote unreachable · nothing starts', meta: 'see the repair question', taskId: null },
        'warn', 'moved to front — pickup blocked', 'registry remote is unreachable')
    : throttle?.revalidating
    ? halt(
        {
          color: 'var(--sun-4)', line: 'usage re-evaluation in progress · nothing starts', taskId: null,
          meta: throttleObservedAt ? `last observed ${throttleObservedAt}` : 'no observation yet',
        },
        'info', 'moved to front — usage is being re-evaluated', 'waiting for a fresh observation')
    : throttled
    ? halt(
        {
          color: 'var(--coral-4)', taskId: null,
          ...(throttleFailClosed
            ? {
                line: 'usage check unavailable · nothing starts',
                meta: `fail-closed — check usage check logs${throttleObservedAt ? ` · observed ${throttleObservedAt}` : ''}`,
              }
            : {
                line: 'usage pace · nothing starts',
                // which line is hit (ADR 0030) — an old pre-window row (no
                // windows persisted yet) falls back to the plain resume text
                meta: `${hitLines.length ? `${hitLines.join(' + ')} line · ` : ''}resumes ${throttleResumesAt}${throttleObservedAt ? ` · observed ${throttleObservedAt}` : ''}`,
              }),
        },
        'warn', 'moved to front — pickup blocked',
        throttleFailClosed
          ? 'usage check unavailable — nothing starts until a fresh reading arrives'
          : `usage limit · resumes ${throttleResumesAt}`)
    : null;
  // taskId (real deployments only) is a full UUID — the Queue screen renders
  // it as its own truncated chip (title tooltip carries the full value), so
  // `line` stays free of raw ids for the busy and paused slot lines alike.
  // a running task always wins the slot line — throttle_state only refreshes
  // at pickup-decision time, so mid-run it may already be stale.
  const slot = running
    ? { color: 'var(--tide-4)', line: liveTitle(running), meta: running.assignee ?? '', taskId: running.id }
    : pickupHalt
    ? pickupHalt.slot
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
    scratchpad: (triage.scratchpad ?? []).map((line) => ({ id: line.id, text: line.line })),
    // empty until their domain slices exist: human tasks / agent registry /
    // out-of-authority approval questions — the kit sections render empty
    humanTasks: [], agents: [],
    slot, pickupHalt, running: !!running, paused: !!paused,
    triageActive: !!pause.triageActive,
    containmentBlocked: !!pause.containmentBlocked,
    registryReachabilityBlocked: !!pause.registryReachabilityBlocked,
    // Spend-down (ADR 0030 / issue #128) — pause と同じ盤面状態応答から素通し
    spendDown: pause.spendDown ?? null,
    throttled, throttleFailClosed, throttleResumesAt,
    throttleRevalidating: !!throttle?.revalidating,
    fableThrottled, fableResumesAt,
    lastLogId: log.entries.length ? log.entries[log.entries.length - 1].id : null,
  };
}

async function fetchData() {
  const [board, log, pause, candidates, triage] = await Promise.all([
    fetch('/api/tasks').then((r) => r.json()),
    fetch('/api/log').then((r) => r.json()),
    fetch('/api/pause').then((r) => r.json()),
    fetch('/api/registry/candidates').then((r) => r.json()).catch(() => ({ icons: {} })),
    fetch('/api/triage').then((r) => r.json()),
  ]);
  return mapData(board, log, pause, candidates.icons, triage);
}

// Full-screen tide wash overlay. Covers, holds a beat with a serif line, drains.
function TpTideWash({ label, emoji, duration = 1250 }) {
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

// Registration — wired to POST /api/tasks. Two content sources:
// manual (this screen's own brain-dump → LLM-draft → edit flow, issue #65)
// and the issue-backed source (issue #49): the board stores only a reference
// (workspace + issue number) and the registration gate may reject with a
// suggested issue comment — shown inline here for the human to approve
// (posting it is the approval; the board never posts on its own).
// parentTask (issue #129, human decompose): when set, this screen registers
// a child of parentTask instead of a root task — same dump → draft → edit →
// submit flow (CONTEXT.md's Decompose point 2: "登録画面に木モードは作らない
// — ルート登録 + 子追加の合成で足りる", no separate tree-registration mode),
// with the type/source pickers and issue-backed path dropped (a decompose
// child is always type work, never issue-backed — decomposeTask's own
// ChildSpec has no such fields either) and one field added: a required
// free-text reason for the split, which lands as a decision-log entry
// (CONTEXT.md's Decompose point 5) and steers the child's own AI
// draft as context (point 4).
function RegisterScreen({ onRegister, parentTask, onClose }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const childMode = !!parentTask;
  const [source, setSource] = React.useState('manual');
  const [type, setType] = React.useState('work');
  const [title, setTitle] = React.useState('');
  const [purpose, setPurpose] = React.useState('');
  const [criteria, setCriteria] = React.useState('');
  const [assignee, setAssignee] = React.useState('');
  const [workspace, setWorkspace] = React.useState('');
  const [risk, setRisk] = React.useState(false);
  const [review, setReview] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [issueNumber, setIssueNumber] = React.useState('');
  const [gate, setGate] = React.useState(null); // { missing, suggested_comment }
  const [busy, setBusy] = React.useState(false);
  // brain dump → LLM draft (issue #12, wired here by issue #65): dump stays
  // its own field so a redraft never has to fight stale content-field values
  const [dump, setDump] = React.useState('');
  const [drafted, setDrafted] = React.useState(false);
  const [plainFormActive, setPlainFormActive] = React.useState(false);
  const [draftBusy, setDraftBusy] = React.useState(false);
  // registry-sourced assignee/workspace candidates (issue #12/#65) — fetched
  // once per screen visit; RegisterScreen remounts fresh each tab entry (the
  // shell's key={tab}), so this never goes stale within a sitting
  const [candidates, setCandidates] = React.useState({ assignees: [], workspaces: [] });
  React.useEffect(() => {
    fetch('/api/registry/candidates').then((r) => r.json()).then(setCandidates).catch(() => {});
  }, []);
  const issueMode = !childMode && source === 'github issue';
  // the parent_id/decompose_reason pair every childMode request (draft and
  // submit alike) carries — one shared shape so the two call sites can't
  // drift apart
  const childExtras = () =>
    childMode
      ? { parent_id: parentTask.id, decompose_reason: reason.trim() }
      : {};
  // the issue-number picker's open-issue list (issue #67): one fetch per
  // workspace selection, no cache/paging — the board-side rationale is the
  // human's own operation frequency (one Select change = one API call).
  // `truncated` comes from the server (which owns the `--limit` it asked
  // `gh` for) rather than the UI comparing issues.length against a
  // hardcoded 100 of its own.
  const [issues, setIssues] = React.useState([]);
  const [issuesFailed, setIssuesFailed] = React.useState(false);
  const [truncated, setTruncated] = React.useState(false);
  React.useEffect(() => {
    setIssues([]); setIssuesFailed(false); setTruncated(false);
    if (!issueMode || !workspace.trim()) return;
    api(`/api/github-issues?workspace=${encodeURIComponent(workspace.trim())}`, undefined, 'GET')
      .then((d) => { setIssues(d.issues); setTruncated(d.truncated); })
      .catch(() => setIssuesFailed(true));
  }, [issueMode, workspace]);
  // pending dumps (issue #61) — triage's `register` disposition lands here.
  // Picking one flows its line into the brain dump the same as typing it by
  // hand; the row itself is consumed only by a successful registration built
  // from it, or an explicit discard — never by merely selecting or backing out.
  const [pendingDumps, setPendingDumps] = React.useState([]);
  const [selectedDumpId, setSelectedDumpId] = React.useState(null);
  const refreshPendingDumps = () =>
    fetch('/api/pending-dumps').then((r) => r.json()).then(setPendingDumps).catch(() => {});
  React.useEffect(() => { refreshPendingDumps(); }, []);
  const pickPendingDump = (d) => {
    resetContent();
    setSelectedDumpId(d.id);
    setDump(d.line);
  };
  const discardPendingDump = async (id) => {
    if (id === selectedDumpId) { setSelectedDumpId(null); }
    try {
      await api(`/api/pending-dumps/${id}`, {}, 'DELETE');
    } catch {
      return;
    }
    refreshPendingDumps();
  };
  const issueListHintStyle = { fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' };
  // the Input doubles as the list's filter (issue #67): a number or a
  // title substring narrows the rows, tapping a row confirms the number
  const filteredIssues = issueNumber.trim()
    ? issues.filter((i) =>
        String(i.number).includes(issueNumber.trim()) ||
        i.title.toLowerCase().includes(issueNumber.trim().toLowerCase()))
    : issues;
  const ok = issueMode
    ? workspace.trim() && /^[0-9]+$/.test(issueNumber.trim())
    : title.trim() && purpose.trim() && criteria.trim() && (!childMode || reason.trim());
  const fields = () =>
    issueMode
      ? { type: 'work', workspace: workspace.trim(), github_issue_number: Number(issueNumber.trim()) }
      : {
          // a decompose child is always type work (decomposeTask's own
          // ChildSpec has no type field) — the type picker is dropped in
          // childMode below, so `type` state never leaves its 'work' default
          type, title: title.trim(), purpose: purpose.trim(), completion_criteria: criteria.trim(),
          risk_flag: risk, review_flag: review,
          // unset assignee/workspace resolve to the board's defaults at
          // execution time (CONTEXT.md) — omit rather than send '' so an
          // unknown-workspace 400 never fires on a field the human left blank
          ...(assignee ? { assignee } : {}),
          ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
          ...childExtras(),
        };
  const resetContent = () => {
    setDump(''); setDrafted(false); setPlainFormActive(false);
    setType('work'); setTitle(''); setPurpose(''); setCriteria('');
    setAssignee(''); setWorkspace(''); setIssueNumber(''); setReason('');
    setRisk(false); setReview(false);
    // backing out of a pending dump's content leaves the row itself alone —
    // it is unconsumed and stays listed, pickable again later
    setSelectedDumpId(null);
  };
  const submitFields = async (f) => {
    setBusy(true);
    setGate(null);
    try {
      await onRegister(f);
      // the pending dump this registration was built from is consumed the
      // moment registration succeeds — same delete an explicit discard uses
      if (selectedDumpId != null) {
        const consumedId = selectedDumpId;
        setSelectedDumpId(null);
        api(`/api/pending-dumps/${consumedId}`, {}, 'DELETE').then(refreshPendingDumps).catch(() => {});
      }
      resetContent();
      // a root registration stays on the screen for the next dump; a child
      // add is a one-shot dialog action — close it once it lands
      if (childMode) onClose();
    } catch (err) {
      // a gate rejection carries the fix; anything else the toast reported.
      // The inspected reference is burned into the gate state so a later
      // edit of the form fields can't repoint the approved comment (or the
      // retry) at a different issue than the one that was inspected.
      if (err.status === 422 && err.detail) {
        setGate({
          ...err.detail,
          workspace: f.workspace,
          github_issue_number: f.github_issue_number,
        });
      }
    }
    setBusy(false);
  };
  const submit = () => submitFields(fields());
  const approveComment = async () => {
    setBusy(true);
    try {
      await api('/api/issue-comments', {
        workspace: gate.workspace,
        github_issue_number: gate.github_issue_number,
        body: gate.suggested_comment,
      });
    } catch {
      setBusy(false);
      return; // posting failed — keep the gate view so the human can retry
    }
    setBusy(false);
    // the comment is now part of the issue thread — re-register the same
    // inspected reference so the gate re-reads it, comment included
    await submitFields({
      type: 'work',
      workspace: gate.workspace,
      github_issue_number: gate.github_issue_number,
    });
  };
  const draftFields = async () => {
    setDraftBusy(true);
    try {
      const d = await api('/api/tasks/draft', { dump: dump.trim(), ...childExtras() });
      setTitle(d.title); setPurpose(d.purpose); setCriteria(d.completion_criteria);
      setAssignee(d.assignee ?? ''); setWorkspace(d.workspace ?? '');
      setRisk(!!d.risk_flag); setReview(!!d.review_flag);
      setDrafted(true);
    } catch {
      // the draft client is unset or unreachable (always a 503 — api.ts's
      // own posture) — never blocks registration, only drops to the plain
      // form with blank fields (issue #12 AC3 / issue #65 AC3)
      setPlainFormActive(true);
    }
    setDraftBusy(false);
  };
  const togglePlainForm = () => {
    const next = !plainFormActive;
    resetContent();
    setPlainFormActive(next);
  };
  // prepends a "choose one"/default placeholder to a registry-candidate list
  const withPlaceholder = (value, label, names) => [
    { value, label },
    ...names.map((n) => ({ value: n, label: n })),
  ];
  const assigneeOptions = withPlaceholder('', '(default agent)', candidates.assignees);
  // manual content's workspace is optional (unset → the board's default at
  // execution time); an issue reference's workspace is required — it fixes
  // *which* issue the reference means (CONTEXT.md), so its placeholder reads
  // as a prompt to choose, never as an implicit default
  const workspaceOptions = withPlaceholder('', '(default workspace)', candidates.workspaces);
  const issueWorkspaceOptions = withPlaceholder('', 'select workspace…', candidates.workspaces);
  const primaryAction = issueMode || plainFormActive || drafted
    ? {
        label: childMode ? 'Add child — appends to queue tail' : 'Register — appends to queue tail',
        disabled: !ok || busy,
        onClick: submit,
      }
    : { label: draftBusy ? 'Drafting…' : 'Draft fields', disabled: !dump.trim() || draftBusy, onClick: draftFields };
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>{childMode ? 'Add child' : 'Register'}</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        {childMode
          ? `splitting "${parentTask.title}" — appears as a child, same dump → draft → edit flow`
          : issueMode
            ? "reference a GitHub issue — its title/purpose/completion criteria stay live on GitHub"
            : plainFormActive
              ? 'the LLM is unreachable — fill the fields yourself'
              : 'dump it — the LLM drafts the fields, you confirm'}
      </p>
      {childMode && (
        <Card style={{ marginBottom: 14 }}>
          <Input
            label="Reason for splitting this"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why this work is being split"
          />
        </Card>
      )}
      {!issueMode && !childMode && pendingDumps.length > 0 && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            pending dump{pendingDumps.length > 1 ? 's' : ''} — sent here from scratchpad triage, awaiting writeup
          </span>
          {pendingDumps.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-body)',
                fontWeight: d.id === selectedDumpId ? 600 : 400,
              }}>{d.line}</span>
              <Button variant={d.id === selectedDumpId ? 'primary' : 'secondary'} size="sm" onClick={() => pickPendingDump(d)}>Use</Button>
              <Button variant="ghost" size="sm" onClick={() => discardPendingDump(d.id)}>Discard</Button>
            </div>
          ))}
        </Card>
      )}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!childMode && (
          <Select label="Source" options={['manual', 'github issue']} value={source} onChange={(e) => {
            setSource(e.target.value); setGate(null);
            // switching away from the pending-dump's own manual content: a
            // later registration (e.g. an unrelated issue reference) must not
            // consume a dump it was never built from
            setSelectedDumpId(null);
          }} />
        )}
        {issueMode && (
          <React.Fragment>
            <Select label="Workspace" options={issueWorkspaceOptions} value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
            <Input label="Issue number" value={issueNumber} onChange={(e) => setIssueNumber(e.target.value)} placeholder="content stays on GitHub; the board keeps only this reference" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {!workspace.trim() && (
                <span style={issueListHintStyle}>select a workspace to browse its open issues</span>
              )}
              {workspace.trim() && issuesFailed && (
                <span style={issueListHintStyle}>couldn't fetch open issues — type the number directly</span>
              )}
              {workspace.trim() && !issuesFailed && filteredIssues.map((i) => (
                <div key={i.number} onClick={() => setIssueNumber(String(i.number))}
                  style={{
                    display: 'flex', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                    fontSize: 'var(--text-sm)', color: 'var(--text-body)',
                    background: String(i.number) === issueNumber.trim() ? 'var(--surface-sunken, rgba(0,0,0,0.06))' : 'transparent',
                  }}>
                  <span style={{ color: 'var(--text-muted)' }}>#{i.number}</span>
                  <span>{i.title}</span>
                </div>
              ))}
              {workspace.trim() && !issuesFailed && truncated && (
                <span style={issueListHintStyle}>older issues exist — type the number directly</span>
              )}
            </div>
          </React.Fragment>
        )}
        {!issueMode && !plainFormActive && !drafted && (
          <Input multiline rows={4} placeholder="what needs doing, in your own words — sloppy is fine here, sloppy completion criteria are not" value={dump} onChange={(e) => setDump(e.target.value)} />
        )}
        {!issueMode && (plainFormActive || drafted) && (
          <React.Fragment>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: drafted ? 'var(--tide-4)' : 'var(--sun-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {drafted ? 'drafted — edit freely' : 'plain form — same fields, no draft'}
            </span>
            <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Input label="Purpose" multiline rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="state prerequisites here — the agent verifies and escalates cheaply" />
            <Input label="Completion criteria" multiline rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="sloppy completion criteria are the expensive kind" />
            {/* a decompose child is always type work (decomposeTask's own ChildSpec has no type field) */}
            {!childMode && (
              <Select label="Type" options={['work', 'review']} value={type} onChange={(e) => setType(e.target.value)} />
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Select label="Assignee" options={assigneeOptions} value={assignee} onChange={(e) => setAssignee(e.target.value)} />
              <Select label="Workspace" options={workspaceOptions} value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
            </div>
            <Checkbox label="risk flag — this task has irreversible external effects" checked={risk} onChange={() => setRisk(!risk)} />
            <Checkbox label="review flag — request an on-completion review" checked={review} onChange={() => setReview(!review)} />
          </React.Fragment>
        )}
        <Button variant="primary" size="lg" full disabled={primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</Button>
        {childMode && (
          <Button variant="ghost" size="lg" full disabled={busy} onClick={onClose}>Cancel</Button>
        )}
      </Card>
      {!issueMode && (
        <button onClick={togglePlainForm}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: '10px 0 0', display: 'block' }}>
          {plainFormActive ? '← back to brain dump' : 'LLM unavailable? use the plain form'}
        </button>
      )}
      {gate && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14, borderColor: 'var(--coral-3, var(--rock-3))' }}>
          <div style={{ fontWeight: 600 }}>the issue fails the registration gate</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{gate.missing}</div>
          {gate.suggested_comment && (
            <React.Fragment>
              <div style={{ fontSize: 'var(--text-sm)' }}>suggested comment — posting it to the issue is your approval:</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--text-sm)', background: 'var(--surface-sunken, rgba(0,0,0,0.06))', borderRadius: 8, padding: 10, margin: 0 }}>{gate.suggested_comment}</pre>
              <Button variant="primary" full disabled={busy} onClick={approveComment}>Approve — post to issue &amp; retry</Button>
            </React.Fragment>
          )}
        </Card>
      )}
    </div>
  );
}

// The client-side mirror of the server's REGISTRY_NAME_PATTERN gate, shared by
// the workspace / agent / profile create forms — the name becomes a directory
// or a file name in the registry, so the three share one rule. It drives the
// disabled state only; the server's assertValid*Name stays the authority.
function registryNameOk(name) {
  const v = name.trim();
  return /^[A-Za-z0-9._-]+$/.test(v) && !['.', '..'].includes(v);
}

// Every board dialog must portal to <body>: the DS Dialog is position:fixed,
// but a transformed ancestor (the tab-transition wrapper's animation) re-bases
// "fixed" onto the full scrollable page instead of the viewport, parking the
// dialog at the page middle. Rendering outside the app subtree pins it back to
// the viewport. One wrapper so the workaround (and its reason) lives once.
function PortalDialog(props) {
  const { Dialog } = window.TidepoolDesignSystem_8a0ead;
  return ReactDOM.createPortal(<Dialog {...props} />, document.body);
}

// The head of a record card (issue #204): identity on the left, Edit on the
// right while viewing. At most one card on the settings surface is in edit mode
// at a time, so the button asks the screen for that slot rather than flipping
// local state.
function RecordCardHead({ children, editing, onEdit }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
      {children}
      {!editing && (
        <div style={{ marginLeft: 'auto' }}>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        </div>
      )}
    </div>
  );
}

// Every edit and create form on the settings surface ends the same way (issue
// #204 決定6): Save always present but inert until the draft is both changed
// and sendable, Cancel always available so an opened card is never a trap.
function EditActions({ dirty = true, ok = true, busy, saveLabel, onSave, onCancel }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <Button variant="primary" size="lg" full disabled={busy || !dirty || !ok} onClick={onSave}>
        {busy ? 'Working…' : saveLabel}
      </Button>
      <Button variant="ghost" size="lg" full disabled={busy} onClick={onCancel}>Cancel</Button>
    </React.Fragment>
  );
}

// Keeps the screen's single edit slot informed of this card's draft state, so
// anything that would leave it — another card, a back, a tab switch — can ask
// before discarding (issue #204 決定4).
function useDirtySignal(edit, open, dirty) {
  React.useEffect(() => { if (open) edit.setDirty(dirty); }, [open, dirty]);
}

// Free-entry-only chip list for review_allowed_commands (ADR 0061 / issue
// #265) — unlike SkillListInput/ProfileListInput there is no candidate list:
// the board has no visibility into what commands exist on a host, so this is
// SkillListInput's free-entry half with the picker dropped. Grammar
// (assertValidReviewAllowedCommands) is re-checked server-side before write;
// this stays a plain free-text add, same split as the skills picker.
function ReviewCommandsInput({ values, onChange }) {
  const { Input, Button, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState('');
  const addFree = () => {
    const v = free.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setFree('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Review allowed commands
      </span>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        command prefixes a review session in this workspace may run beyond the read-only default. Empty means review stays read-only (confirmed on save if non-empty).
      </p>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color="tide" mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Input value={free} mono onChange={(e) => { setFree(e.target.value); }}
            placeholder='command prefix — e.g. "npm test"' />
        </div>
        <Button variant="secondary" disabled={!free.trim()} onClick={addFree}>Add</Button>
      </div>
    </div>
  );
}

// The purely-local → remote-backed door (ADR 0066 決定2/8, issue #285). No
// confirmation step: publish is not one of ADR 0061's dangerous values — it
// widens nothing an agent may do — and the destination being a URL the human
// types every time is itself the shape of consent. The board creates nothing
// on GitHub: the repository is one the human prepared and invited the bot to.
function PublishWorkspace({ ws, say, onPublished }) {
  const { Button, Input } = window.TidepoolDesignSystem_8a0ead;
  const [repo, setRepo] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/workspaces/${encodeURIComponent(ws.name)}/publish`, { repo: repo.trim() });
      setRepo('');
      say('success', 'workspace published — every branch is on the remote', ws.name);
      await onPublished();
    } catch (err) {
      // a failed publish leaves no trace (the board rolls its own `remote add`
      // back), so "fix the cause and press it again" is honest — the refusal's
      // message already carries the one-line repair when it is an access one
      say('danger', 'publish failed — nothing landed, safe to retry', String(err.message || err));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Publish</span>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        give this purely-local workspace a remote source of truth — every branch is pushed to an
        empty repository you created and invited the bot to. The board creates nothing on GitHub.
      </p>
      <Input value={repo} onChange={(e) => setRepo(e.target.value)}
        placeholder="the destination repository URL — must be empty" />
      <Button variant="secondary" size="sm" disabled={busy || !repo.trim()} onClick={submit}>
        Publish — pushes every branch, then commits to the registry
      </Button>
    </div>
  );
}

// One workspace as a record card (issue #57 phase 3, restructured by #204):
// read-only until Edit, then notes + protection as a single draft — the Switch
// no longer PATCHes the moment it is touched. path/repo/branch re-point the
// entry at a different checkout, which stays a manual registry edit, so they
// are shown but never editable here.
function WorkspaceRecord({ ws, say, onChanged, edit }) {
  const { Card, FieldRow, Input, Switch, Tag } = window.TidepoolDesignSystem_8a0ead;
  // ADR 0066 決定2: publish は編集ではなく状態遷移なので、Edit の下書きには入らない
  // — purely-local な workspace だけがこの扉を持ち、registry clone 自身は持たない
  // (サーバ側も RegistrySelfPublishError で拒む)
  const publishable = !ws.repo && !ws.registrySelf;
  const id = `workspace:${ws.name}`;
  const open = edit.isOpen(id);
  const [notes, setNotes] = React.useState(ws.notes ?? '');
  const [prot, setProt] = React.useState(!!ws.protected);
  const [cmds, setCmds] = React.useState(ws.review_allowed_commands ?? []);
  const origin = ws.repo ?? ws.path;
  const dirty = notes.trim() !== (ws.notes ?? '')
    || prot !== !!ws.protected
    || !sameStrings(cmds, ws.review_allowed_commands ?? []);
  useDirtySignal(edit, open, dirty);
  const { busy, save: submit, dialog } = useWorkspaceSave(say, async () => { edit.close(); await onChanged(); });

  const startEdit = () => edit.open(id, () => {
    setNotes(ws.notes ?? ''); setProt(!!ws.protected); setCmds(ws.review_allowed_commands ?? []);
  });
  // ADR 0061 決定2: notes never carries a confirmation, so it travels every
  // save; protected/review_allowed_commands only join the body when they
  // actually changed — an untouched field must stay absent for the door's
  // pure-payload danger judgment to see only what the human actually edited
  const save = () => {
    const body = { notes: notes.trim() };
    if (prot !== !!ws.protected) body.protected = prot;
    if (!sameStrings(cmds, ws.review_allowed_commands ?? [])) body.review_allowed_commands = cmds;
    submit(`/api/workspaces/${encodeURIComponent(ws.name)}`, 'PATCH', body, 'updated', ws.name);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={startEdit}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{ws.name}</span>
        {ws.registrySelf && <Tag color="tide" mono>registry</Tag>}
        {ws.protected && <Tag color="sun">protected</Tag>}
      </RecordCardHead>
      {ws.registrySelf && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          the board's own registry clone — protection stays on
        </div>
      )}
      {!open && (
        <React.Fragment>
          <FieldRow label={ws.repo ? 'repository' : 'path'} kind={origin ? 'mono' : 'unset'}
            value={origin ? `${origin}${ws.branch ? ` · ${ws.branch}` : ''}` : ''}
            unsetLabel="not recorded on the entry" />
          <FieldRow label="notes" kind={ws.notes ? 'text' : 'unset'} value={ws.notes ?? ''} unsetLabel="—" />
          <FieldRow label="protected" kind="bool" checked={!!ws.protected}
            onLabel="changes here always need human approval" offLabel="not protected" />
          <FieldRow label="review allowed commands" kind={(ws.review_allowed_commands ?? []).length ? 'tags' : 'unset'}
            tags={ws.review_allowed_commands ?? []} unsetLabel="no extra commands allowed — review stays read-only" />
          {publishable && <PublishWorkspace ws={ws} say={say} onPublished={onChanged} />}
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="setup hints for humans — e.g. run npm install before first use" />
          {/* the board's own registry clone never offers the off position —
              the server refuses it too (ADR 0013), this just keeps the UI honest */}
          <Switch label="protected — changes here always need human approval" checked={prot}
            disabled={busy || (ws.registrySelf && !!ws.protected)} onChange={(next) => setProt(next)} />
          <ReviewCommandsInput values={cmds} onChange={setCmds} />
          <EditActions dirty={dirty} busy={busy} saveLabel="Save — commits to the registry"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
      {dialog}
    </Card>
  );
}

// Default icon picker rows (issue #72): sea life first, then land animals —
// the fixed order is the worldview convention (CONTEXT.md's "tidepool
// dweller" naming), not cosmetic, so it must never be reordered or trimmed.
const AGENT_ICON_SEA = ['🐙', '🦀', '🦐', '🦞', '🦑', '🦪', '🐚', '🐡', '🐠', '🐟', '🐬', '🐳', '🦈', '🦭', '🐢', '🪼', '🪸'];
const AGENT_ICON_LAND = ['🦦', '🐕', '🐈', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦅', '🐴', '🦋', '🐝'];

// A grid of the default icons plus a free-input escape hatch (issue #72's AC:
// "加えて任意の絵文字の自由入力欄") — #52's loader already enforces the
// single-Twemoji-grapheme shape server-side, so this stays a plain text
// field rather than duplicating that check in the browser.
function AgentIconPicker({ value, onChange }) {
  const { Input } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Icon
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[...AGENT_ICON_SEA, ...AGENT_ICON_LAND].map((emoji) => (
          <button key={emoji} type="button" onClick={() => onChange(emoji)}
            style={{
              width: 32, height: 32, padding: 0, borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: value === emoji ? '2px solid var(--tide-4)' : '1px solid var(--rock-3)',
              background: value === emoji ? 'var(--tide-1)' : 'none',
            }}>
            {emoji}
          </button>
        ))}
      </div>
      <Input label="Custom icon" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
        placeholder="paste any single emoji, or pick one above" />
    </div>
  );
}

// The agent fields an edit or a creation resubmits (agent-create.ts's
// UpdateAgentInput), pulled off a record as one draft. `name` is absent on
// purpose: it is the file name, offered at creation and never editable
// afterwards (parent issue #54).
function agentDraftOf(agent) {
  return {
    icon: agent.icon ?? '', description: agent.description ?? '',
    systemPrompt: agent.systemPrompt ?? '', authority: agent.authority ?? '',
    model: agent.model ?? '', effort: agent.effort ?? '', advisor: agent.advisor ?? '',
    // GET /api/agents already returns skills (ADR 0025)
    skills: agent.skills ?? [],
  };
}

// ADR 0025 決定7 / issue #106: the default agent (tako) is ["@workspace"], so a
// new agent starts there too — a visible field, not a hidden default: the
// author sees it and edits it before creating.
const NEW_AGENT_DRAFT = {
  icon: '', description: '', systemPrompt: '', authority: '',
  model: '', effort: '', advisor: '', skills: ['@workspace'],
};

// The API body those fields make. The optional ones drop out when blank, so a
// cleared field round-trips to absent rather than to an empty string.
function agentBody(d) {
  return {
    authority: d.authority,
    description: d.description.trim(),
    icon: d.icon.trim() || undefined,
    model: d.model.trim() || undefined,
    effort: d.effort.trim() || undefined,
    advisor: d.advisor.trim() || undefined,
    skills: d.skills,
    systemPrompt: d.systemPrompt,
  };
}

// Whether the draft differs from what it was primed with. The skills
// comparison is order-sensitive (sameStrings, matching the server's no-op
// detection) — a reorder is a real edit.
function agentDraftDirty(d, base) {
  return d.icon !== base.icon
    || d.description.trim() !== base.description
    || d.systemPrompt !== base.systemPrompt
    || d.authority !== base.authority
    || d.model.trim() !== base.model
    || d.effort.trim() !== base.effort
    || d.advisor.trim() !== base.advisor
    || !sameStrings(d.skills, base.skills);
}

// Those fields as controls, shared by the record card and the create form so
// the two never drift — the agent analogue of ProfileFields.
function AgentFields({ draft, set, authorityOptions, hostSkills, hostSkillsDegraded }) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <AgentIconPicker value={draft.icon} onChange={(v) => set('icon', v)} />
      <Input label="Description" value={draft.description} onChange={(e) => set('description', e.target.value)}
        placeholder="when a delegating agent should pick this one" />
      <Input label="Specialty — persona, perspective, or this agent's own steps (optional; the worker protocol itself is injected separately, not written here)"
        multiline rows={4} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Select label="Authority" options={authorityOptions} value={draft.authority} onChange={(e) => set('authority', e.target.value)} />
        <Input label="Model" value={draft.model} onChange={(e) => set('model', e.target.value)} placeholder="adapter default if empty" />
      </div>
      <Input label="Effort" value={draft.effort} onChange={(e) => set('effort', e.target.value)} placeholder="adapter default if empty" />
      <Input label="Advisor model" value={draft.advisor} onChange={(e) => set('advisor', e.target.value)} placeholder="no advisor if empty" />
      <SkillListInput candidates={hostSkills} degraded={hostSkillsDegraded} values={draft.skills} onChange={(v) => set('skills', v)} />
    </React.Fragment>
  );
}

// One agent as a record card (issue #72, restructured by #204),
// WorkspaceRecord's twin: read-only until Edit, and then the draft above,
// prefilled from the GET /api/agents list. `name` is shown via AgentChip only —
// renaming isn't offered here at all (it's the file name, parent issue #54).
function AgentRecord({ agent, authorityProfiles, hostSkills, hostSkillsDegraded, say, onChanged, edit }) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const { AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const id = `agent:${agent.name}`;
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(() => agentDraftOf(agent));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const [busy, setBusy] = React.useState(false);

  const dirty = agentDraftDirty(draft, agentDraftOf(agent));
  const ok = !!draft.description.trim() && !!draft.authority;
  useDirtySignal(edit, open, dirty);

  const startEdit = () => edit.open(id, () => setDraft(agentDraftOf(agent)));

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/agents/${encodeURIComponent(agent.name)}`, agentBody(draft), 'PATCH');
      say('success', 'agent updated — committed to the registry', agent.name);
      edit.close();
      await onChanged();
    } catch (err) {
      say('danger', 'agent update failed', String(err.message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={startEdit}>
        {/* while editing, the chip previews the draft icon — picking one
            confirms itself immediately, as it did on the flat surface */}
        <AgentChip name={agent.name} icon={open ? draft.icon : (agent.icon ?? '')} />
      </RecordCardHead>
      {!open && (
        <React.Fragment>
          <FieldRow label="description" kind={agent.description ? 'text' : 'unset'} value={agent.description ?? ''} unsetLabel="—" />
          <FieldRow label="specialty" kind={agent.systemPrompt ? 'text' : 'unset'} value={agent.systemPrompt ?? ''}
            unsetLabel="no specialty — worker protocol only" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="authority" kind={agent.authority ? 'mono' : 'unset'} value={agent.authority ?? ''} unsetLabel="—" />
            <FieldRow label="model" kind={agent.model ? 'mono' : 'unset'} value={agent.model ?? ''} unsetLabel="adapter default" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="effort" kind={agent.effort ? 'mono' : 'unset'} value={agent.effort ?? ''} unsetLabel="adapter default" />
            <FieldRow label="advisor model" kind={agent.advisor ? 'mono' : 'unset'} value={agent.advisor ?? ''} unsetLabel="no advisor" />
          </div>
          <FieldRow label="skills" kind={(agent.skills ?? []).length ? 'tags' : 'unset'} tags={agent.skills ?? []}
            scheme="skills" wildcardHint="every skill" unsetLabel="no skills allowed" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <AgentFields draft={draft} set={set} authorityOptions={authorityProfiles}
            hostSkills={hostSkills} hostSkillsDegraded={hostSkillsDegraded} />
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save changes — commits to the registry"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// The server's machine reason codes (profile-create.ts's dangerousValues,
// workspace-create.ts's dangerousWorkspaceValues) rendered as prose for the
// confirmation dialog (issue #78, generalized to workspaces by ADR 0061 決定1).
// The board never decides on its own what counts as dangerous — it only
// translates the codes the 409 hands back, so the danger definition stays
// single-sourced on the server (ADR 0027). An unrecognized code (server added
// a reason the WebUI hasn't caught up to) falls back to the raw string rather
// than being dropped — see DANGEROUS_REASON_LABEL[r] ?? r below.
const DANGEROUS_REASON_LABEL = {
  merge_auto_if_ci_green:
    'Merge is auto_if_ci_green — a PR under this authority merges unattended once CI is green, with no human in the loop.',
  assignable_to_wildcard:
    'Assignable-to carries the wildcard "*" — an agent with this authority may delegate to any agent.',
  allowed_workspaces_wildcard:
    'Allowed-workspaces carries the wildcard "*" — this authority reaches every workspace on the board.',
  unprotect:
    'Protection is being removed — tasks targeting this workspace stop converting to approval questions, and its PRs follow the merge dial without waiting for a human.',
  review_allowed_commands_set:
    'Review-allowed commands is non-empty — review sessions in this workspace gain Bash access to those command prefixes, beyond the read-only default.',
};

// The merge dial (registry.ts): absent means no automatic merge decision, so an
// unset value is the safe default. auto_if_ci_green is the dangerous one.
const MERGE_OPTIONS = [
  { value: '', label: 'no automatic merge decision (default)' },
  { value: 'escalate', label: 'escalate — always ask a human before merging' },
  { value: 'auto_if_ci_green', label: 'auto_if_ci_green — merge unattended once CI is green' },
];

// Order-sensitive content equality — the profile save payload's arrays compare
// by contents, not reference (mirrors profile-create.ts's sameStringArray so
// the edit card's dirty flag and the server's no-op detection agree).
function sameStrings(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// The four profile fields as the API wants them: arrays always present (the
// registry schema requires them), merge omitted when unset so a round-trip
// leaves it undefined rather than sending an invalid empty enum.
function profileBody(guidance, assignableTo, allowedWorkspaces, merge) {
  return {
    guidance,
    assignable_to: assignableTo,
    allowed_workspaces: allowedWorkspaces,
    merge: merge || undefined,
  };
}

// A list field for a profile's assignable_to / allowed_workspaces (issue #78):
// picks from the registry's existing agents / workspaces rather than free text,
// so a value can't be a typo for a name that doesn't exist. Selected entries
// render as removable Tags; the wildcard "*" rides as its own option — it is
// exactly what the server flags as dangerous, so it stays selectable and the
// judgment is left to the save-time dialog. Values already on the profile are
// shown even when absent from `candidates` (an entry can outlive the agent or
// workspace it named) — the picker only constrains what you can newly add.
function ProfileListInput({ label, hint, candidates, wildcardHint, values, onChange }) {
  const { Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  // the wildcard is an addable option too — the placeholder must count it, or
  // it reads "no more to add" while `*` still sits selectable below
  const addable = candidates.filter((c) => !values.includes(c));
  const wildcardAddable = !values.includes('*');
  const options = [
    { value: '', label: addable.length || wildcardAddable ? 'add…' : 'no more to add' },
    ...addable.map((c) => ({ value: c, label: c })),
    ...(wildcardAddable ? [{ value: '*', label: `* — ${wildcardHint}` }] : []),
  ];
  const pick = (e) => { if (e.target.value) onChange([...values, e.target.value]); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </span>
      {hint && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</p>}
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color={v === '*' ? 'sun' : 'tide'} mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      {/* value is pinned to '' so the control always shows the placeholder and
          snaps back after each pick — it is an add-picker, not a bound field */}
      <Select value="" options={options} onChange={pick} />
    </div>
  );
}

// The skills allowlist picker's client-side grammar gate (issue #106 / ADR
// 0025): mirrors just two of assertValidSkillAllowlist's rules — "* only when
// alone" and "@ entries are only @workspace/@host" — plus empty/duplicate UX
// guards. Everything else (a bare individual name, a "plugin名:*" glob, a
// workspace-specific name) is deliberately let through: free entry's whole
// point is adding references the picker can't enumerate (an allowlist is a
// reference, not a claim of stock — ADR 0023). The server's
// assertValidSkillAllowlist stays the authority; this only spares the round
// trip on the two mistakes that are obvious at input time. Returns an error
// string, or null when the entry may be added.
function skillAddError(entry, existing) {
  const v = entry.trim();
  if (!v) return 'empty skill name';
  if (existing.includes(v)) return 'already added';
  if (v === '*') {
    return existing.length > 0 ? '"*" must be the only entry — remove the others first' : null;
  }
  if (existing.includes('*')) return 'remove "*" first — it must be the only entry';
  if (v.startsWith('@') && v !== '@workspace' && v !== '@host') {
    return 'an @ entry may only be @workspace or @host';
  }
  return null;
}

// The agent skills allowlist picker (issue #106 / ADR 0025), ProfileListInput's
// sibling: selected entries render as removable Tags; a Select adds a scope word
// (@workspace/@host) or an enumerated @host skill; a free-entry field adds
// anything the picker can't offer (a workspace-specific name, a "plugin名:*"
// glob). `candidates` is the enumerated @host set from GET /api/skills; the
// scope words and the "*" wildcard are this component's own additions. When the
// enumeration degraded, `degraded` shows a one-line note — the scope words and
// free entry still work, so the picker never hard-fails.
function SkillListInput({ candidates, degraded, values, onChange }) {
  const { Input, Button, Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState('');
  const [freeError, setFreeError] = React.useState(null);
  // scope words first, then the enumerated @host skills, then the bare wildcard
  // — offer only entries the grammar would currently accept (this drops "*"
  // once anything else is selected, drops everything once "*" is, and hides
  // already-selected entries), so the Select can add without its own gate
  const offerable = ['@workspace', '@host', ...candidates, '*'].filter(
    (c) => skillAddError(c, values) === null,
  );
  const options = [
    { value: '', label: offerable.length ? 'add a scope or skill…' : 'no more to add' },
    ...offerable.map((c) => ({ value: c, label: c === '*' ? '* — every skill' : c })),
  ];
  const pick = (e) => { if (e.target.value) onChange([...values, e.target.value]); };
  const addFree = () => {
    const err = skillAddError(free, values);
    if (err) { setFreeError(err); return; }
    onChange([...values, free.trim()]);
    setFree(''); setFreeError(null);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Skills
      </span>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        which skills this agent may use — a scope (@workspace / @host), an enumerated host skill, "plugin-name:*", or "*" for all. Free entry adds a workspace-specific name the picker can't list.
      </p>
      {degraded && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          host skill list unavailable — scope words and free entry still work.
        </p>
      )}
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color={v === '*' ? 'sun' : v.startsWith('@') ? 'grass' : 'tide'} mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      {/* value pinned to '' so the control snaps back after each pick */}
      <Select value="" options={options} onChange={pick} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Input value={free} mono error={freeError || undefined}
            onChange={(e) => { setFree(e.target.value); setFreeError(null); }}
            placeholder='free entry — e.g. a workspace skill name or "plugin-name:*"' />
        </div>
        <Button variant="secondary" disabled={!free.trim()} onClick={addFree}>Add</Button>
      </div>
    </div>
  );
}

// The four editable profile fields, shared by the edit card and the create
// form so the two never drift (the profile analogue of the duplication the
// agent card and its create form carry field-by-field).
function ProfileFields({ agentNames, workspaceNames, guidance, setGuidance, assignableTo, setAssignableTo, allowedWorkspaces, setAllowedWorkspaces, merge, setMerge }) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <Input label="Guidance — prose injected into the agent's system prompt at spawn"
        multiline rows={4} value={guidance} onChange={(e) => setGuidance(e.target.value)}
        placeholder="how an agent carrying this authority should act" />
      <ProfileListInput label="Assignable to"
        hint={'who this authority may delegate to — a registered agent or the human, or "*" for any (confirmed on save)'}
        candidates={agentNames.includes('human') ? agentNames : [...agentNames, 'human']}
        wildcardHint="any agent"
        values={assignableTo} onChange={setAssignableTo} />
      <ProfileListInput label="Allowed workspaces"
        hint={'which workspaces this authority may act in — pick a registered workspace, or "*" for every one (confirmed on save)'}
        candidates={workspaceNames} wildcardHint="every workspace"
        values={allowedWorkspaces} onChange={setAllowedWorkspaces} />
      <Select label="Merge authority" options={MERGE_OPTIONS} value={merge} onChange={(e) => setMerge(e.target.value)} />
    </React.Fragment>
  );
}

// The two-phase dangerous-value save (issue #78, #55 phase 3; generalized to
// workspaces by ADR 0061 決定1), shared by every door that can carry a
// dangerous value. The first attempt omits the confirm flag; when the payload
// grants broad power the server answers 409 confirm_required with the machine
// reason codes (issue #77). We surface those in a dialog and, once the human
// accepts, resend the very same body with the flag set. The board makes no
// pre-judgment of danger — the 409 is the only trigger. `confirmKey` is the
// flag name the door reads (`confirmDangerous` for profiles, `confirm` for
// workspaces — ADR 0061 決定1 kept the workspace door's existing flag name
// rather than adding a second boolean). Returns the busy flag, the save
// entrypoint, and the dialog element the caller renders inline.
function useDangerousSave(say, onDone, { noun, confirmKey, dialogTitle, dialogLead }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(null); // { reasons, resend } | null while safe
  const save = async (path, method, body, verb, name) => {
    const attempt = async (confirmed) => {
      setBusy(true);
      try {
        await api(path, confirmed ? { ...body, [confirmKey]: true } : body, method);
        setConfirm(null);
        say('success', `${noun} ${verb} — committed to the registry`, name);
        await onDone();
      } catch (err) {
        // the #77 confirmation 409 is distinguished from any other failure
        // (bad input, a push that never landed — ADR 0052 決定1) by its
        // confirm_required flag — only that one opens the dialog for a resend
        if (err.status === 409 && err.detail?.confirm_required) {
          setConfirm({ reasons: err.detail.dangerous_values ?? [], resend: () => attempt(true) });
        } else {
          setConfirm(null);
          say('danger', `${noun} ${verb} failed`, String(err.message || err));
        }
      }
      setBusy(false);
    };
    await attempt(false);
  };
  const dialog = (
    <PortalDialog open={!!confirm} title={dialogTitle} onClose={() => setConfirm(null)}
      footer={
        <React.Fragment>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => confirm && confirm.resend()}>Save anyway</Button>
        </React.Fragment>
      }>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--text-sm)' }}>{dialogLead}</p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(confirm?.reasons ?? []).map((r) => (
          <li key={r}>{DANGEROUS_REASON_LABEL[r] ?? r}</li>
        ))}
      </ul>
    </PortalDialog>
  );
  return { busy, save, dialog };
}

function useProfileSave(say, onDone) {
  return useDangerousSave(say, onDone, {
    noun: 'profile', confirmKey: 'confirmDangerous',
    dialogTitle: 'Save a profile with broad power?',
    dialogLead: 'This profile grants broad power. Review before saving:',
  });
}

// The workspace twin of useProfileSave (ADR 0061 決定1). Replaces the old
// client-side pre-confirm (issue #57's "off→on asks before sending") — that
// path never actually hit the server's 409 (src/api.ts's comment on the
// confirm_required branch used to say as much), and it recomputed danger
// itself, which is exactly the single-source-on-the-server posture ADR 0027
// and DANGEROUS_REASON_LABEL's own comment rule out. Every dangerous save now
// round-trips through the same 409 the direct API gets.
function useWorkspaceSave(say, onDone) {
  return useDangerousSave(say, onDone, {
    noun: 'workspace', confirmKey: 'confirm',
    dialogTitle: 'Save a change that widens what agents may do?',
    dialogLead: 'This change widens what agents may do here. Review before saving:',
  });
}

// One authority profile as a record card (issue #78, restructured by #204),
// AgentRecord's twin: read-only until Edit, then the four editable fields
// prefilled from GET /api/profiles. `name` is the file name
// (authority/<name>.yaml), not renameable here, same as agents. No delete: an
// agent referencing this profile would break at spawn (parent issue #55).
function ProfileRecord({ profile, agentNames, agentIcons, workspaceNames, say, onChanged, edit }) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const id = `profile:${profile.name}`;
  const open = edit.isOpen(id);
  const [guidance, setGuidance] = React.useState(profile.guidance ?? '');
  const [assignableTo, setAssignableTo] = React.useState(profile.assignable_to ?? []);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState(profile.allowed_workspaces ?? []);
  const [merge, setMerge] = React.useState(profile.merge ?? '');
  const { busy, save, dialog } = useProfileSave(say, async () => { edit.close(); await onChanged(); });

  const dirty =
    guidance !== (profile.guidance ?? '') ||
    !sameStrings(assignableTo, profile.assignable_to ?? []) ||
    !sameStrings(allowedWorkspaces, profile.allowed_workspaces ?? []) ||
    (merge || '') !== (profile.merge ?? '');
  useDirtySignal(edit, open, dirty);

  const startEdit = () => edit.open(id, () => {
    setGuidance(profile.guidance ?? '');
    setAssignableTo(profile.assignable_to ?? []);
    setAllowedWorkspaces(profile.allowed_workspaces ?? []);
    setMerge(profile.merge ?? '');
  });

  const submit = () => save(
    `/api/profiles/${encodeURIComponent(profile.name)}`, 'PATCH',
    profileBody(guidance, assignableTo, allowedWorkspaces, merge), 'updated', profile.name,
  );

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={startEdit}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{profile.name}</span>
      </RecordCardHead>
      {!open && (
        <React.Fragment>
          <FieldRow label="guidance" kind={profile.guidance ? 'text' : 'unset'} value={profile.guidance ?? ''} unsetLabel="—" />
          <FieldRow label="assignable to" kind={(profile.assignable_to ?? []).length ? 'tags' : 'unset'}
            tags={profile.assignable_to ?? []} agentIcons={agentIcons} wildcardHint="any agent"
            unsetLabel="nobody — this authority can't be delegated" />
          <FieldRow label="allowed workspaces" kind={(profile.allowed_workspaces ?? []).length ? 'tags' : 'unset'}
            tags={profile.allowed_workspaces ?? []} wildcardHint="every workspace"
            unsetLabel="no workspace — this authority can't act anywhere" />
          <FieldRow label="merge authority" kind={profile.merge ? 'mono' : 'unset'} value={profile.merge ?? ''}
            unsetLabel="no automatic merge decision" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <ProfileFields
            agentNames={agentNames} workspaceNames={workspaceNames}
            guidance={guidance} setGuidance={setGuidance}
            assignableTo={assignableTo} setAssignableTo={setAssignableTo}
            allowedWorkspaces={allowedWorkspaces} setAllowedWorkspaces={setAllowedWorkspaces}
            merge={merge} setMerge={setMerge} />
          <EditActions dirty={dirty} busy={busy} saveLabel="Save changes — commits to the registry"
            onSave={submit} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
      {dialog}
    </Card>
  );
}

// The footnote under a settings screen — where its edits actually land.
const settingsFootnote = { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' };

// The mono-caps label a settings card wears in place of a heading.
const settingsCardLabel = {
  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

// Display language (issue #46) as a record card: the one board setting both the
// draft prompt's language instruction and a later display-time-translation
// feature read — a plain board-wide setting, not gated on the registry like the
// workspaces/agents/profiles sections.
function DisplayLanguageCard({ language, options, say, onSaved, edit }) {
  const { Card, FieldRow, Select } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:language';
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(language);
  const [busy, setBusy] = React.useState(false);
  const dirty = draft !== language;
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      // the select can only hold a canonical value, so POST sends it verbatim —
      // no trimming/normalization here (that lives at the write boundary)
      const { language: saved } = await api('/api/settings/display-language', { language: draft });
      say('success', 'display language saved', saved);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'display language save failed', String(err.message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(language))}>
        <span style={settingsCardLabel}>display language</span>
      </RecordCardHead>
      {!open && <FieldRow label="language" kind={language ? 'mono' : 'unset'} value={language} unsetLabel="unset" />}
      {open && (
        <React.Fragment>
          {/* options come straight from GET (display-language.ts's canonical
              list) — the UI never hardcodes the language list, so a board that
              adds a language needs no WebUI change (issue #115) */}
          <Select label="Language" options={options} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <EditActions dirty={dirty} ok={!!draft} busy={busy} saveLabel="Save display language"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Quiet hours (issue #64) as a record card: start/end only — tz is shown but is
// only ever changed via POST /api/settings/timezone (ADR 0022), which this card
// never calls.
function QuietHoursCard({ start, end, tz, say, onSaved, edit }) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:quiet-hours';
  const open = edit.isOpen(id);
  const [draftStart, setDraftStart] = React.useState(start);
  const [draftEnd, setDraftEnd] = React.useState(end);
  const [busy, setBusy] = React.useState(false);
  const dirty = draftStart !== start || draftEnd !== end;
  const ok = !!draftStart.trim() && !!draftEnd.trim();
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('/api/settings/quiet-hours', { start: draftStart, end: draftEnd });
      say('success', 'quiet hours saved', `${saved.start}–${saved.end}`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'quiet hours save failed', String(err.message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => { setDraftStart(start); setDraftEnd(end); })}>
        <span style={settingsCardLabel}>quiet hours</span>
      </RecordCardHead>
      {!open && (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="start" kind="mono" value={start} />
            <FieldRow label="end" kind="mono" value={end} />
          </div>
          <FieldRow label="timezone" kind={tz ? 'mono' : 'unset'} value={tz} unsetLabel="unset" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Start" mono value={draftStart} onChange={(e) => setDraftStart(e.target.value)} placeholder="HH:MM" />
            <Input label="End" mono value={draftEnd} onChange={(e) => setDraftEnd(e.target.value)} placeholder="HH:MM" />
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            start after end wraps past midnight (e.g. 23:00–07:00) — that's valid, not an error.
            timezone: {tz || 'unset'} — change it from the timezone setting, not here.
          </p>
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save quiet hours"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Pace offsets (issue #126 / ADR 0030) as a record card: the human's reserved
// share (pt) per usage window — the board runs this far behind the elapsed-time
// pace.
function PaceOffsetsCard({ offsets, say, onSaved, edit }) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:pace-offsets';
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(offsets);
  const [busy, setBusy] = React.useState(false);
  const keys = ['session', 'week', 'fable'];
  const dirty = keys.some((k) => String(draft[k]) !== String(offsets[k]));
  // the API rejects non-integers / out-of-range at the entry (ADR 0030) — the
  // form mirrors that check so the button only enables on a sendable value
  const validOffset = (v) => /^\d{1,3}$/.test(String(v).trim()) && Number(v) <= 100;
  const ok = keys.every((k) => validOffset(draft[k]));
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('/api/settings/pace-offsets', {
        session: Number(draft.session), week: Number(draft.week), fable: Number(draft.fable),
      });
      say('success', 'pace offsets saved', `session ${saved.session}pt · week ${saved.week}pt · fable ${saved.fable}pt`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'pace offsets save failed', String(err.message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(offsets))}>
        <span style={settingsCardLabel}>pace offsets</span>
      </RecordCardHead>
      {!open && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {keys.map((k) => (
            <FieldRow key={k} label={k} kind="mono" value={`${offsets[k]} pt`} />
          ))}
        </div>
      )}
      {open && (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Input label="Session" mono value={String(draft.session)} onChange={(e) => setDraft({ ...draft, session: e.target.value })} placeholder="20" />
            <Input label="Week" mono value={String(draft.week)} onChange={(e) => setDraft({ ...draft, week: e.target.value })} placeholder="10" />
            <Input label="Fable" mono value={String(draft.fable)} onChange={(e) => setDraft({ ...draft, fable: e.target.value })} placeholder="10" />
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            your reserved share of each usage window, in points (0–100). the board stays this far
            behind the elapsed-time pace, leaving that slice of the budget for your own sessions.
          </p>
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save pace offsets"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// The workspace create form (issue #57 phase 3), behind Add on the Workspaces
// screen (#204 決定7) — it takes the same single edit slot a record card does,
// and saves and cancels by the same rules.
function NewWorkspaceForm({ say, onCreated, edit }) {
  const { Card, Checkbox, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [mode, setMode] = React.useState('clone');
  const [name, setName] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const [path, setPath] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [prot, setProt] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ok = registryNameOk(name) && (mode === 'clone' ? !!repo.trim() : mode === 'register' ? !!path.trim() : true);
  const dirty = mode !== 'clone' || !!name.trim() || !!repo.trim() || !!path.trim() || !!notes.trim() || prot;
  useDirtySignal(edit, true, dirty);

  const submit = async () => {
    setBusy(true);
    try {
      await api('/api/workspaces', {
        mode, name: name.trim(),
        ...(mode === 'clone' ? { repo: repo.trim() } : {}),
        ...(mode === 'register' ? { path: path.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(prot ? { protected: true } : {}),
      });
      say('success', 'workspace added — committed to the registry', name.trim());
      edit.close();
      await onCreated();
    } catch (err) {
      // creation is idempotent server-side — a failed attempt leaves only
      // orphans the registry never saw, so "just press it again" is honest
      say('danger', 'workspace creation failed — safe to retry as-is', String(err.message || err));
    }
    setBusy(false);
  };
  const modeOptions = [
    { value: 'clone', label: 'clone a repository' },
    { value: 'create', label: 'create a new local checkout' },
    { value: 'register', label: 'register an existing path' },
  ];
  const modeHint = {
    clone: 'clones into the workspaces directory — the entry stays host-independent',
    create: 'creates a fresh, purely-local git checkout — nothing touches GitHub',
    register: 'points at a checkout already on this host — the one mode that records a path',
  }[mode];

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>add a workspace</span>
      <Select label="Mode" options={modeOptions} value={mode} onChange={(e) => setMode(e.target.value)} />
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{modeHint}</p>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — safe as a directory and a repo name" />
      {mode === 'clone' && (
        <Input label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)}
          placeholder="anything git clone accepts — recorded on the entry" />
      )}
      {mode === 'register' && (
        <Input label="Path" value={path} onChange={(e) => setPath(e.target.value)}
          placeholder="an existing checkout on this host" />
      )}
      <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="setup hints for humans — optional" />
      <Checkbox label="protected — changes here always need human approval" checked={prot} onChange={() => setProt(!prot)} />
      <EditActions ok={ok} busy={busy} saveLabel="Add workspace — commits to the registry"
        onSave={submit} onCancel={() => edit.close()} />
    </Card>
  );
}

// The agent create form (issue #72), NewWorkspaceForm's twin. `name` is its own
// field — it becomes agents/<name>.md and is never editable afterwards; the
// rest is the same draft the record card edits.
function NewAgentForm({ authorityProfiles, hostSkills, hostSkillsDegraded, say, onCreated, edit }) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState('');
  const [draft, setDraft] = React.useState(() => ({ ...NEW_AGENT_DRAFT }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const [busy, setBusy] = React.useState(false);
  const ok = registryNameOk(name) && !!draft.description.trim() && !!draft.authority;
  const dirty = !!name.trim() || agentDraftDirty(draft, NEW_AGENT_DRAFT);
  useDirtySignal(edit, true, dirty);
  // creation offers the empty placeholder the edit form doesn't: a new agent
  // starts without an authority, an existing one always has one
  const authorityCreateOptions = [
    { value: '', label: 'select authority…' },
    ...authorityProfiles.map((n) => ({ value: n, label: n })),
  ];

  const submit = async () => {
    setBusy(true);
    try {
      await api('/api/agents', { name: name.trim(), ...agentBody(draft) });
      say('success', 'agent added — committed to the registry', name.trim());
      edit.close();
      await onCreated();
    } catch (err) {
      // creation is idempotent server-side, same posture as workspace creation
      say('danger', 'agent creation failed — safe to retry as-is', String(err.message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>add an agent</span>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — becomes agents/<name>.md, not renameable later" />
      <AgentFields draft={draft} set={set} authorityOptions={authorityCreateOptions}
        hostSkills={hostSkills} hostSkillsDegraded={hostSkillsDegraded} />
      <EditActions ok={ok} busy={busy} saveLabel="Add agent — commits to the registry"
        onSave={submit} onCancel={() => edit.close()} />
    </Card>
  );
}

// The authority profile create form (issue #55 phase 3) — the 409
// confirm_required round trip rides on useProfileSave, same as the edit card.
function NewProfileForm({ agentNames, workspaceNames, say, onCreated, edit }) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState('');
  const [guidance, setGuidance] = React.useState('');
  const [assignableTo, setAssignableTo] = React.useState([]);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState([]);
  const [merge, setMerge] = React.useState('');
  const { busy, save, dialog } = useProfileSave(say, async () => { edit.close(); await onCreated(); });
  const dirty = !!name.trim() || !!guidance.trim() || assignableTo.length > 0
    || allowedWorkspaces.length > 0 || !!merge;
  useDirtySignal(edit, true, dirty);

  const submit = () => save(
    '/api/profiles', 'POST',
    { name: name.trim(), ...profileBody(guidance, assignableTo, allowedWorkspaces, merge) },
    'created', name.trim(),
  );

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>add an authority profile</span>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — becomes authority/<name>.yaml, not renameable later" />
      <ProfileFields
        agentNames={agentNames} workspaceNames={workspaceNames}
        guidance={guidance} setGuidance={setGuidance}
        assignableTo={assignableTo} setAssignableTo={setAssignableTo}
        allowedWorkspaces={allowedWorkspaces} setAllowedWorkspaces={setAllowedWorkspaces}
        merge={merge} setMerge={setMerge} />
      <EditActions ok={registryNameOk(name)} busy={busy} saveLabel="Add authority profile — commits to the registry"
        onSave={submit} onCancel={() => edit.close()} />
      {dialog}
    </Card>
  );
}

// Settings — the board's admin surface (issue #57 phase 3), restructured by
// #204 into a drilldown: an index of four sections, then a section, then one
// record that opens read-only. Board (display language #46, quiet hours #64,
// pace offsets #126) is the SQLite-backed half; workspaces, agents (#72) and
// authority profiles (#55) are the registry-backed half.
function SettingsScreen({ say, registerLeaveGuard }) {
  const { Button, Card, NavRow, ScreenHeader } = window.TidepoolDesignSystem_8a0ead;

  // The three board-wide preferences (display language #46, quiet hours #64,
  // pace offsets #126 / ADR 0030) are loaded here and saved by their own cards
  // on the Board screen — this level only holds the values the index summarises.
  const [displayLanguage, setDisplayLanguage] = React.useState('');
  // options come straight from GET (display-language.ts's canonical list) —
  // the UI never hardcodes the language list, so a board that adds a language
  // needs no WebUI change (issue #115).
  const [displayLanguageOptions, setDisplayLanguageOptions] = React.useState([]);
  const [displayLanguageLoaded, setDisplayLanguageLoaded] = React.useState(false);
  const loadDisplayLanguage = async () => {
    const { language, options } = await api('/api/settings/display-language', undefined, 'GET');
    setDisplayLanguage(language);
    setDisplayLanguageOptions(options);
    setDisplayLanguageLoaded(true);
  };
  React.useEffect(() => { loadDisplayLanguage(); }, []);

  // quiet hours: start/end are editable; tz is shown but only ever changed via
  // POST /api/settings/timezone (ADR 0022), which this screen never calls.
  const [quietHoursStart, setQuietHoursStart] = React.useState('');
  const [quietHoursEnd, setQuietHoursEnd] = React.useState('');
  const [quietHoursTz, setQuietHoursTz] = React.useState('');
  const [quietHoursLoaded, setQuietHoursLoaded] = React.useState(false);
  const loadQuietHours = async () => {
    const { start, end, tz } = await api('/api/settings/quiet-hours', undefined, 'GET');
    setQuietHoursStart(start);
    setQuietHoursEnd(end);
    setQuietHoursTz(tz);
    setQuietHoursLoaded(true);
  };
  React.useEffect(() => { loadQuietHours(); }, []);

  const [paceOffsets, setPaceOffsets] = React.useState(null); // null → still loading
  const loadPaceOffsets = async () => {
    setPaceOffsets(await api('/api/settings/pace-offsets', undefined, 'GET'));
  };
  React.useEffect(() => { loadPaceOffsets(); }, []);


  const [workspaces, setWorkspaces] = React.useState(null); // null → still loading
  const [unavailable, setUnavailable] = React.useState(false); // 503 — no registry configured
  const load = async () => {
    try {
      setWorkspaces(await api('/api/workspaces', undefined, 'GET'));
    } catch {
      // 503 (no registry configured) and transport failures read the same:
      // there is nothing to administer from here
      setUnavailable(true);
      setWorkspaces([]);
    }
  };
  React.useEffect(() => { load(); }, []);

  const [agents, setAgents] = React.useState(null); // null → still loading
  const [authorityProfiles, setAuthorityProfiles] = React.useState([]);
  const [agentsUnavailable, setAgentsUnavailable] = React.useState(false);
  const loadAgents = async () => {
    try {
      const res = await api('/api/agents', undefined, 'GET');
      setAgents(res.agents);
      setAuthorityProfiles(res.authorityProfiles);
    } catch {
      setAgentsUnavailable(true);
      setAgents([]);
    }
  };
  React.useEffect(() => { loadAgents(); }, []);

  const [profiles, setProfiles] = React.useState(null); // null → still loading
  const [profilesUnavailable, setProfilesUnavailable] = React.useState(false);
  const loadProfiles = async () => {
    try {
      const res = await api('/api/profiles', undefined, 'GET');
      setProfiles(res.profiles);
    } catch {
      setProfilesUnavailable(true);
      setProfiles([]);
    }
  };
  React.useEffect(() => { loadProfiles(); }, []);

  // the skills picker's candidate source (issue #106): the host's enumerated
  // @host skills, loaded once for both the create form and every AgentCard.
  // Degrades to an empty list — the picker still works on scope words + free
  // entry, so a failed enumeration never blocks editing an agent's skills.
  const [hostSkills, setHostSkills] = React.useState([]);
  const [hostSkillsDegraded, setHostSkillsDegraded] = React.useState(false);
  const loadSkills = async () => {
    try {
      const res = await api('/api/skills', undefined, 'GET');
      setHostSkills(res.skills ?? []);
      setHostSkillsDegraded(!!res.degraded);
    } catch {
      setHostSkills([]);
      setHostSkillsDegraded(true);
    }
  };
  React.useEffect(() => { loadSkills(); }, []);
  // a created or edited profile must reach the agent Authority dropdown too —
  // that list rides on GET /api/agents (a separate load), so a profile change
  // refreshes both, else the #55 completion path (create profile → referencing
  // agent can spawn) needs a manual page reload
  const refreshAfterProfile = async () => { await loadProfiles(); await loadAgents(); };
  // the profile pickers offer the registry's current agents / workspaces so an
  // assignable_to / allowed_workspaces entry can't name something that doesn't
  // exist — the same lists the cards above already render, reused here
  const agentNames = (agents ?? []).map((a) => a.name);
  const workspaceNames = (workspaces ?? []).map((w) => w.name);

  // name → icon, for rendering an assignable_to entry as the agent's own chip
  const agentIcons = {};
  (agents ?? []).forEach((a) => { if (a.icon) agentIcons[a.name] = a.icon; });

  // --- drilldown navigation (issue #204) ----------------------------------
  // stack: [] the index · ['board'] · ['<section>'] · ['<section>', '<name>'].
  // A record is addressed by name, not by list position: the lists reload on
  // every commit, and an index would silently re-point at a different entry.
  const [stack, setStack] = React.useState([]);
  // at most one card — record or create form — is in edit mode across the whole
  // surface (決定4): `editing` holds its id, `dirty` whether it has unsaved work
  const [editing, setEditing] = React.useState(null);
  const [dirty, setDirty] = React.useState(false);
  const [pending, setPending] = React.useState(null); // a move parked behind the discard dialog
  // read inside `guard`, which the tab guard below keeps across renders
  const unsaved = React.useRef(false);
  unsaved.current = editing !== null && dirty;

  // Runs `move` now, or parks it behind the discard dialog when the open card
  // has unsaved changes. Returns true when it parked it — the tab guard reads
  // that to hold the tab switch until the human answers.
  const guard = (move) => {
    if (unsaved.current) { setPending({ move }); return true; }
    move();
    return false;
  };
  const closeEdit = () => { setEditing(null); setDirty(false); };
  // the one edit slot, handed to every card that can enter edit mode
  const edit = {
    isOpen: (id) => editing === id,
    // `prime` fills the card's draft from the record. It runs with the open,
    // not before it, so a parked open (another card holds unsaved work) primes
    // only once the human has answered the discard dialog.
    open: (id, prime) => guard(() => { if (prime) prime(); setEditing(id); setDirty(false); }),
    // `close` is the deliberate discard behind Cancel and the exit after a
    // successful save; `requestClose` is for a control that merely folds the
    // card away (the Add toggle), which must not drop a draft silently
    close: closeEdit,
    requestClose: () => guard(closeEdit),
    setDirty,
  };
  const go = (next) => guard(() => { setStack(next); closeEdit(); });

  // a tab switch unmounts this screen, so it has to ask too (決定4)
  React.useEffect(() => {
    registerLeaveGuard((move) => guard(move));
    return () => registerLeaveGuard(null);
  }, []);

  // The three registry-backed sections, in one shape so the index, the list
  // level and the record level all read a section the same way — including
  // which card it renders, so no level re-tests which section it is in.
  const SECTIONS = {
    workspaces: {
      title: 'Workspaces', singular: 'workspace', note: 'where tasks run',
      items: workspaces, unavailable,
      footnote: 'edits commit to the registry',
      indexSummary: (items) => `${items.length} · ${items.filter((w) => w.protected).length} protected`,
      rowIdentity: (w) => ({ label: w.name }),
      rowSummary: (w) => w.repo || w.path || '—',
      record: (rec) => <WorkspaceRecord ws={rec} say={say} onChanged={load} edit={edit} />,
      createForm: () => <NewWorkspaceForm say={say} onCreated={load} edit={edit} />,
    },
    agents: {
      title: 'Agents', singular: 'agent', note: 'who does the work',
      items: agents, unavailable: agentsUnavailable,
      footnote: 'edits commit to agents/<name>.md in the registry',
      indexSummary: (items) => `${items.length} agents`,
      rowIdentity: (a) => ({ agentName: a.name, agentIcon: a.icon ?? '' }),
      rowSummary: (a) => a.authority,
      record: (rec) => (
        <AgentRecord agent={rec} authorityProfiles={authorityProfiles} hostSkills={hostSkills}
          hostSkillsDegraded={hostSkillsDegraded} say={say} onChanged={loadAgents} edit={edit} />
      ),
      createForm: () => (
        <NewAgentForm authorityProfiles={authorityProfiles} hostSkills={hostSkills}
          hostSkillsDegraded={hostSkillsDegraded} say={say} onCreated={loadAgents} edit={edit} />
      ),
    },
    profiles: {
      title: 'Authority Profiles', singular: 'authority profile',
      note: 'what the work is allowed to do',
      items: profiles, unavailable: profilesUnavailable,
      footnote: 'edits commit to authority/<name>.yaml in the registry',
      indexSummary: (items) => `${items.length} profiles`,
      rowIdentity: (p) => ({ label: p.name }),
      rowSummary: (p) => (p.assignable_to ?? []).join(', ') || '—',
      record: (rec) => (
        <ProfileRecord profile={rec} agentNames={agentNames} agentIcons={agentIcons}
          workspaceNames={workspaceNames} say={say} onChanged={refreshAfterProfile} edit={edit} />
      ),
      createForm: () => (
        <NewProfileForm agentNames={agentNames} workspaceNames={workspaceNames}
          say={say} onCreated={refreshAfterProfile} edit={edit} />
      ),
    },
  };
  // one cascade for "unreachable / still loading / here is the count", read by
  // the index (which counts its own way per section) and by each section header
  const sectionSummary = (s, count = (items) => `${items.length} registered`) =>
    s.unavailable ? 'no registry configured'
      : s.items === null ? 'loading…'
        : count(s.items);

  const sectionKey = stack[0];
  const recordName = stack[1];
  const sec = SECTIONS[sectionKey];
  const addId = `new:${sectionKey}`;
  const adding = editing === addId;

  let body;

  if (stack.length === 0) {
    // --- level 1: the index. Each row states its section's current state, so
    // the whole surface reads without opening anything.
    const rows = [
      {
        key: 'board', label: 'Board',
        summary: displayLanguageLoaded && quietHoursLoaded
          ? `${displayLanguage} · ${quietHoursStart}–${quietHoursEnd}`
          : 'loading…',
      },
      ...Object.keys(SECTIONS).map((key) => ({
        key, label: SECTIONS[key].title,
        summary: sectionSummary(SECTIONS[key], SECTIONS[key].indexSummary),
        alert: SECTIONS[key].unavailable,
      })),
    ];
    body = (
      <React.Fragment>
        {/* the top of the stack keeps the screen-title shape every other tab
            uses; the levels below it wear ScreenHeader, whose h1 is the same
            size and inherits the same base.css heading treatment */}
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Settings</h1>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            the board's preferences, and the registry it works from
          </p>
        </div>
        <Card padding="0" style={{ overflow: 'hidden' }}>
          {rows.map((r, i) => (
            <NavRow key={r.key} label={r.label} summary={r.summary}
              testId={`settings-section-${r.key}`}
              summaryTone={r.alert ? 'alert' : 'muted'}
              divider={i > 0} first={i === 0} last={i === rows.length - 1}
              onClick={() => go([r.key])} />
          ))}
        </Card>
      </React.Fragment>
    );
  } else if (sectionKey === 'board') {
    // --- level 2 (board): the SQLite-backed preferences, one card each
    body = (
      <React.Fragment>
        <ScreenHeader title="Board" backLabel="Settings" meta="board-wide preferences" onBack={() => go([])} />
        {displayLanguageLoaded && (
          <DisplayLanguageCard language={displayLanguage} options={displayLanguageOptions}
            say={say} onSaved={loadDisplayLanguage} edit={edit} />
        )}
        {quietHoursLoaded && (
          <QuietHoursCard start={quietHoursStart} end={quietHoursEnd} tz={quietHoursTz}
            say={say} onSaved={loadQuietHours} edit={edit} />
        )}
        {paceOffsets && (
          <PaceOffsetsCard offsets={paceOffsets} say={say} onSaved={loadPaceOffsets} edit={edit} />
        )}
        {(!displayLanguageLoaded || !quietHoursLoaded || !paceOffsets) && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>loading…</Card>
        )}
        <p style={settingsFootnote}>applies to every task the board picks up</p>
      </React.Fragment>
    );
  } else if (!sec) {
    body = <ScreenHeader title="Settings" backLabel="Settings" onBack={() => go([])} />;
  } else if (recordName === undefined) {
    // --- level 2 (a registry section): the names, with the create form behind Add
    body = (
      <React.Fragment>
        <ScreenHeader title={sec.title} backLabel="Settings" meta={sectionSummary(sec)} onBack={() => go([])}>
          {!sec.unavailable && sec.items && (
            <Button variant="ghost" size="sm" onClick={() => (adding ? edit.requestClose() : edit.open(addId))}>
              {adding ? 'Close' : 'Add'}
            </Button>
          )}
        </ScreenHeader>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>{sec.note}</p>
        {sec.unavailable && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            no registry configured on this board — {sec.title.toLowerCase()} need one
          </Card>
        )}
        {adding && sec.createForm()}
        {!sec.unavailable && sec.items === null && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>loading…</Card>
        )}
        {!sec.unavailable && sec.items && sec.items.length === 0 && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            none registered yet — Add is above
          </Card>
        )}
        {!sec.unavailable && sec.items && sec.items.length > 0 && (
          <Card padding="0" style={{ overflow: 'hidden' }}>
            {sec.items.map((it, i) => (
              <NavRow key={it.name} {...sec.rowIdentity(it)} summary={sec.rowSummary(it)}
                testId={`settings-record-${sectionKey}-${it.name}`}
                divider={i > 0} first={i === 0} last={i === sec.items.length - 1}
                onClick={() => go([sectionKey, it.name])} />
            ))}
          </Card>
        )}
        <p style={settingsFootnote}>{sec.footnote}</p>
      </React.Fragment>
    );
  } else {
    // --- level 3: one record, read-only until Edit
    const items = sec.items ?? [];
    const idx = items.findIndex((x) => x.name === recordName);
    const rec = idx === -1 ? null : items[idx];
    body = (
      <React.Fragment>
        <ScreenHeader title={recordName} backLabel={sec.title}
          meta={rec ? `${sec.singular} · ${idx + 1} of ${items.length}` : sec.singular}
          onBack={() => go([sectionKey])} />
        {!rec && sec.items === null && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>loading…</Card>
        )}
        {!rec && sec.items !== null && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            no longer in the registry — it may have been removed outside the board
          </Card>
        )}
        {rec && sec.record(rec)}
        <p style={settingsFootnote}>{sec.footnote}</p>
      </React.Fragment>
    );
  }

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {body}
      <PortalDialog open={!!pending} title="Discard unsaved changes?" onClose={() => setPending(null)}
        footer={
          <React.Fragment>
            <Button variant="secondary" onClick={() => setPending(null)}>Keep editing</Button>
            <Button variant="danger" onClick={() => { const p = pending; setPending(null); closeEdit(); p.move(); }}>
              Discard
            </Button>
          </React.Fragment>
        }>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          The card you're editing has changes that were never saved. Leaving now drops them.
        </p>
      </PortalDialog>
    </div>
  );
}

// Maps one raw task + its optional parent into TpQuestionCard's shape —
// the single-task equivalent of mapData()'s `questions` mapping above.
function toQuestionCardShape(task, parentTask) {
  return {
    id: task.id, parent: task.parent_id,
    agent: parentTask?.assignee ?? '—',
    context: task.purpose,
    items: (task.question_items ?? []).map((item) => ({
      title: item.title, detail: item.detail,
      options: item.options.map((o) => ({ label: o, recommended: o === item.recommendation })),
    })),
  };
}

// A push notification tapped outside quiet hours deep-links straight here
// (?question=<id>, issue #14) — TpSingleQuestion (design-synced,
// single-question-view.jsx) is the same screen the kit demo simulates a push
// into; answering it here POSTs to the real /api/tasks/:id/answer instead of
// touching mock data, so front-insert + the immediate poll fire for real.
function QuestionDeepLinkView({ questionId, onDone, onTranslate }) {
  const { Button, Card } = window.TidepoolDesignSystem_8a0ead;
  const [q, setQ] = React.useState(undefined); // undefined = loading, null = gone
  const [rawTask, setRawTask] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/tasks/${questionId}`);
      const task = res.ok ? await res.json() : null;
      if (!task || task.type !== 'question' || task.status !== 'todo') {
        if (!cancelled) setQ(null);
        return;
      }
      const parentTask = task.parent_id
        ? await fetch(`/api/tasks/${task.parent_id}`).then((r) => (r.ok ? r.json() : null))
        : null;
      if (cancelled) return;
      setRawTask(task);
      setQ(toQuestionCardShape(task, parentTask));
    })().catch(() => { if (!cancelled) setQ(null); });
    return () => { cancelled = true; };
  }, [questionId]);

  const answer = async (answers) => {
    if (busy) return; // guards the design component's button against a double-tap
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/tasks/${questionId}/answer`, { answers });
      onDone(rawTask);
    } catch (e) {
      setErr(String(e.message || e));
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
function TaskActionsDialog({ task, onAddChild, onEdit, onCancel, onClose }) {
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
function EditTaskDialog({ taskCard, onSaved, onClose, say }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const [full, setFull] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [candidates, setCandidates] = React.useState({ assignees: [], workspaces: [] });
  const [fields, setFields] = React.useState(null);
  React.useEffect(() => {
    fetch('/api/registry/candidates').then((r) => r.json()).then(setCandidates).catch(() => {});
    api(`/api/tasks/${taskCard.id}`, undefined, 'GET').then((t) => {
      setFull(t);
      setFields({
        title: t.title ?? '', purpose: t.purpose ?? '', completion_criteria: t.completion_criteria ?? '',
        assignee: t.assignee ?? '', workspace: t.workspace ?? '',
        risk_flag: !!t.risk_flag, review_flag: !!t.review_flag,
      });
    }).catch((err) => say('danger', 'could not load task', String(err.message || err)));
  }, [taskCard.id]);
  if (!full || !fields) {
    return <div style={{ padding: '24px 16px', color: 'var(--text-muted)' }}>loading…</div>;
  }
  const issueBacked = full.github_issue_number != null;
  const set = (k, v) => setFields((f) => ({ ...f, [k]: v }));
  const withPlaceholder = (label, names) => [{ value: '', label }, ...names.map((n) => ({ value: n, label: n }))];
  // only the fields that actually changed — an unchanged submission is a no-op
  // server-side, but sending a minimal patch keeps the intent clear
  const changed = () => {
    const out = {};
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
      say('danger', 'edit failed', String(err.message || err));
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
            <Input label="Title" value={fields.title} onChange={(e) => set('title', e.target.value)} />
            <Input label="Purpose" multiline rows={2} value={fields.purpose} onChange={(e) => set('purpose', e.target.value)} />
            <Input label="Completion criteria" multiline rows={2} value={fields.completion_criteria} onChange={(e) => set('completion_criteria', e.target.value)} />
          </React.Fragment>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: issueBacked ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Select label="Assignee" options={withPlaceholder('(default agent)', candidates.assignees)} value={fields.assignee} onChange={(e) => set('assignee', e.target.value)} />
          {!issueBacked && (
            <Select label="Workspace" options={withPlaceholder('(default workspace)', candidates.workspaces)} value={fields.workspace} onChange={(e) => set('workspace', e.target.value)} />
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
function CancelTaskDialog({ task, onCancelled, onClose, say }) {
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
      say('danger', 'cancel failed', String(err.message || err));
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
        <Input label="Reason (optional)" multiline rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="left blank, only the fact of the cancel is recorded" />
        <Button variant="primary" size="lg" full disabled={busy} onClick={submit}>Cancel this task</Button>
        <Button variant="ghost" size="lg" full disabled={busy} onClick={onClose}>Keep it</Button>
      </Card>
    </div>
  );
}

function App() {
  const { Toast, Button, IdChip } = window.TidepoolDesignSystem_8a0ead;
  const [data, setData] = React.useState(null);
  const [tab, setTabRaw] = React.useState('triage');
  const [tabDir, setTabDir] = React.useState('right');
  const [toast, setToast] = React.useState(null);
  const [wash, setWash] = React.useState(null);
  // human decompose (issue #129): the board task an "Add child" dialog is
  // open for, or null when closed — set from a board task-card tap
  const [addChildParent, setAddChildParent] = React.useState(null);
  // issue #130: a board task-card tap opens an action chooser (add child /
  // edit / cancel) for a plausibly-eligible task; the edit and cancel dialogs
  // each track their own open task
  const [actionsTask, setActionsTask] = React.useState(null);
  const [editTaskCard, setEditTaskCard] = React.useState(null);
  const [cancelTaskCard, setCancelTaskCard] = React.useState(null);
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
    api('/api/settings/display-language', undefined, 'GET')
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
    fetch('/api/settings/timezone').then((r) => r.json()).then(({ tz }) => {
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
      say('danger', 'failed to enable notifications', String(err.message || err));
    }
  };

  const refreshFull = () => fetchData().then(setData).catch(() => {});

  // every tab entry takes a fresh snapshot; screens remount per tab (key)
  const applyTab = (next) => {
    setTabRaw((prev) => {
      if (next !== prev) setTabDir(tabOrder.indexOf(next) > tabOrder.indexOf(prev) ? 'right' : 'left');
      return next;
    });
    refreshFull();
  };
  // a tab switch unmounts the screen it leaves, so a screen holding an open
  // editor with unsaved changes gets to ask first (issue #204 決定4). The guard
  // returns true when it parked the switch behind its own dialog.
  const leaveGuard = React.useRef(null);
  const setTab = (next) => {
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
  const say = (kind, msg, detail) => setToast({ kind, msg, detail });

  // Cover the screen with the tide, apply the state change while covered, drain.
  const runWash = (label, emoji, apply) => {
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
  const answerNow = async (q, a) => {
    try {
      await api(`/api/tasks/${q.id}/answer`, { answers: a, triage: true });
    } catch (err) {
      say('danger', 'answer failed', String(err.message || err));
      throw err;
    }
  };

  // S2 — the objection annotation lands on the log entry the moment it is raised
  const objectNow = async (entry, direction) => {
    try {
      await api('/api/triage/objection', { entry_id: entry.id, comment: direction });
    } catch (err) {
      say('danger', 'objection failed', String(err.message || err));
      throw err;
    }
  };

  const scratchAdd = async (text) => {
    try {
      const l = await api('/api/triage/scratchpad', { line: text });
      return { id: l.id, text: l.line };
    } catch (err) {
      say('danger', 'scratchpad failed', String(err.message || err));
      throw err;
    }
  };

  // an entry never displayed is unobserved — report each skimmed entry once
  const displayedReported = React.useRef(new Set());
  const reportDisplayed = (entries) => {
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
    const res = await fetch('/api/triage');
    if (!res.ok) throw new Error(res.statusText);
    const { queue } = await res.json();
    return (queue ?? []).map((t) => ({
      id: t.id, title: liveTitle(t), assignee: t.assignee ?? undefined,
      assigneeIcon: t.assignee ? data.icons[t.assignee] : undefined, risk: !!t.risk_flag,
      blocked: t.status === 'blocked', frontInserted: t.front_inserted,
    }));
  };

  // Triage commit applies scratchpad dispositions and closes an open session
  // when there is one. Only that last case fires the immediate poll. The read
  // cursor advances after — a failed commit never marks the skimmed lines as
  // read, and a failed cursor advance never masquerades as a failed commit.
  const commitTriage = async (answers, objections, scratch) => {
    let result;
    try {
      result = await api('/api/triage/commit', {
        // kit dispositions already speak the domain vocabulary
        scratchpad: scratch
          .filter((s) => typeof s.id === 'number')
          .map((s) => ({ id: s.id, disposition: s.kind })),
      });
    } catch (err) {
      refresh();
      say('danger', 'triage commit failed — nothing applied, cursor NOT advanced',
        String(err.message || err));
      return;
    }
    for (const [qid, a] of Object.entries(answers)) {
      if (!a) continue;
      const q = data.questions.find((x) => x.id === qid);
      if (q && q.parent) markFront(q.parent);
    }
    let cursorNote = '';
    try {
      if (data.lastLogId != null) await api('/api/log/cursor', { last_read: data.lastLogId });
    } catch {
      cursorNote = ' · read cursor NOT advanced (retry from the log)';
    }
    const answered = Object.values(answers).filter(Boolean).length;
    const repairTasks = new Set(Object.keys(objections)
      .map((k) => data.log.find((e) => String(e.id) === String(k))?.taskId)
      .filter(Boolean)).size;
    const summary = [`${data.log.filter((entry) => entry.unread).length} read`];
    if (answered) summary.push(`${answered} answered`);
    if (repairTasks) summary.push(`${repairTasks} repair`);
    if (scratch.length) summary.push(`${scratch.length} scratchpad applied`);
    let message;
    let outcomeNote = '';
    if (result.outcome === 'closed_now') {
      message = 'triage committed — session closed';
      outcomeNote = ' · immediate poll fired';
    } else if (result.outcome === 'already_closed_by_timeout') {
      const closed = new Date(result.closed_at);
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
  // flow: it closes the server session but never dispositions scratchpad lines
  // or advances the decision-log cursor.
  const closeTriageSession = async () => {
    try {
      const result = await api('/api/triage/commit', { close_only: true });
      await refresh();
      if (result.outcome === 'closed_now') {
        say('success', 'triage session closed', 'pickup resumed · immediate poll fired');
      } else {
        say('info', 'triage session was already closed', 'pickup was not stopped');
      }
    } catch (err) {
      say('danger', 'failed to close triage session', String(err.message || err));
    }
  };

  // One endpoint, two meanings the server itself distinguishes (issue #82
  // follow-up): a todo already at the head, moved to the head again, is an
  // explicit "run now" (immediate-poll trigger); promoting a different task
  // is pure reordering and fires nothing on its own. The button's color
  // already told the human which one they clicked (queue-screen.jsx); the
  // toast just has to describe honestly what actually happened rather than
  // always claiming success (#79's lesson, ADR 0028).
  const moveFront = async (id) => {
    const wasHead = data.queue[0]?.id === id;
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
      say('danger', 'move failed', String(err.message || err));
    }
  };

  // Pause (issue #34) — the human's own steering channel, never exposed via
  // MCP. Resuming fires an immediate poll server-side; pausing fires nothing.
  // The pause toast detail mirrors the queue slot line's own busy/free split
  // (explorations/Pause Pickup.html's PausePickupApp.togglePause): a running
  // task finishes before anything new starts, an empty slot just stays empty.
  const togglePause = async () => {
    const next = !data.paused;
    try {
      await api('/api/pause', { paused: next });
      await refresh();
      say(next ? 'info' : 'success', next ? 'pickup paused' : 'pickup resumed',
        next
          ? (data.slot?.taskId
              ? <>
                  <IdChip id={data.slot.taskId} style={{ display: 'inline-block', verticalAlign: 'bottom' }} />
                  {' finishes · nothing new starts'}
                </>
              : 'nothing starts until resumed')
          : 'immediate poll fired');
    } catch (err) {
      say('danger', 'pause toggle failed', String(err.message || err));
    }
  };

  // Spend-down (ADR 0030 / issue #128) — pause と同格の盤面状態。有効化は
  // サーバー側が即時 poll を発火する(残りを今すぐ燃やす操作なので)。
  const setSpendDown = async (window) => {
    try {
      await api('/api/spend-down', { window });
      await refresh();
      say(window ? 'warn' : 'info',
        window ? `spend-down armed · ${window}` : 'spend-down cancelled',
        window
          ? 'pace line off — burns to the 100% cap, expires at the window reset'
          : 'pace line back on');
    } catch (err) {
      say('danger', 'spend-down failed', String(err.message || err));
    }
  };

  const reorder = async (next, movedId, pos) => {
    try {
      const idx = next.findIndex((t) => t.id === movedId);
      const after = idx <= 0 ? null : next[idx - 1].id;
      setData((d) => ({ ...d, queue: next })); // optimistic: the rows already sit in the new order
      await api(`/api/tasks/${movedId}/move`, { after });
      await refresh();
      say('info', 'queue reordered', `${movedId} → position ${pos}`);
    } catch (err) {
      await refresh();
      say('danger', 'reorder failed', String(err.message || err));
    }
  };

  // a completion entry unfolds its handoff doc in place — the log's link back
  // to the deliverable (issue #5). a failed fetch surfaces in the expansion
  // via the kit's catch, not as a silent no-op.
  const loadHandoff = async (entry) => {
    const res = await fetch(`/api/tasks/${entry.taskId}`);
    if (!res.ok) throw new Error(res.statusText);
    const task = await res.json();
    return task.handoff_doc ?? '(no handoff doc)';
  };

  const register = async (fields) => {
    try {
      const t = await api('/api/tasks', fields);
      runWash('Into the pool.', '🫧', () => {
        setTab('queue');
        say('info', 'registered — appended to queue tail', t.id);
      });
    } catch (err) {
      // a gate rejection (422, issue #49) renders inline in the register
      // screen — a toast would bury the suggested comment it carries
      if (err.status !== 422) say('danger', 'registration failed', String(err.message || err));
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
  const openTask = (t) => {
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
  const addChild = async (fields) => {
    try {
      const t = await api('/api/tasks', fields);
      say(
        'info',
        t.type === 'question' ? 'sent for approval' : 'child added — appended to queue tail',
        t.id,
      );
      await refreshFull();
    } catch (err) {
      say('danger', 'add child failed', String(err.message || err));
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
        {tab === 'triage' && (data.questions.length || unreadCount || data.scratchpad.length
          ? <TriageScreen data={data} onCommit={commitTriage} onReorderQueue={reorder} onFront={moveFront} loadHandoff={loadHandoff}
              onAnswer={answerNow} onObject={objectNow} onScratchAdd={scratchAdd} onDisplayed={reportDisplayed} loadPreview={loadPreview}
              onTranslate={onTranslateProp} />
          : <div style={{ padding: '64px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>🐚</div>
              <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', color: 'var(--tide-5)', marginBottom: 8 }}>Low tide. Go enjoy your coffee.</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>the pool refills as tasks come in.</div>
            </div>)}
        {tab === 'board' && <BoardScreen data={data} onOpenTask={openTask} />}
        {tab === 'queue' && <QueueScreen data={data} slotState={data.running ? 'busy' : (data.throttled ? 'limit' : 'free')} paused={data.paused} onTogglePause={togglePause} spendDown={data.spendDown} onSpendDown={setSpendDown} onFront={moveFront} onDoneHuman={() => {}} onReorder={reorder} />}
        {tab === 'register' && <RegisterScreen onRegister={register} />}
        {tab === 'settings' && <SettingsScreen say={say} registerLeaveGuard={(fn) => { leaveGuard.current = fn; }} />}
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
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  } else if (tries > 0) {
    setTimeout(() => mountWhenReady(tries - 1), 100);
  } else {
    document.getElementById('root').innerHTML = '<p style="padding:24px;font-family:monospace;font-size:12px;color:#5c6b66">_ds_bundle.js failed to load — recompile the design system.</p>';
  }
})(50);
