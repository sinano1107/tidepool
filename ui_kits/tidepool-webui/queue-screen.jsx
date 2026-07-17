// TODO queue — ordering + manual intervention live here, plus "your tasks" (human list)

// Reorderable queue list — pointer-driven drag & drop with tidal FLIP animations.
// Reused by QueueScreen and the triage queue-check step.
function TpQueueList({ tasks, baseIndex = 0, onReorder, onFront, skipReason, gap = 6 }) {
  const { QueueItem } = window.TidepoolDesignSystem_8a0ead;
  const itemEls = React.useRef(new Map());
  const lastTops = React.useRef(new Map());
  const skipFlip = React.useRef(false);
  const drag = React.useRef(null);
  const [draggingId, setDraggingId] = React.useState(null);
  const orderKey = tasks.map((t) => t.id).join('|');
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const setRef = (id) => (el) => { if (el) itemEls.current.set(id, el); else itemEls.current.delete(id); };
  const clearStyles = (el) => { el.style.transition = ''; el.style.transform = ''; el.style.zIndex = ''; el.style.filter = ''; el.style.pointerEvents = ''; };

  // FLIP on order change — animates move-to-front, front-inserts, drag commits.
  React.useLayoutEffect(() => {
    const tops = new Map();
    tasks.forEach((t) => {
      const el = itemEls.current.get(t.id);
      if (el) tops.set(t.id, el.getBoundingClientRect().top);
    });
    if (skipFlip.current) {
      // visuals already match final order (drag transforms) — clear silently
      itemEls.current.forEach(clearStyles);
      skipFlip.current = false;
    } else if (!reduced()) {
      tasks.forEach((t) => {
        const el = itemEls.current.get(t.id);
        const last = lastTops.current.get(t.id);
        if (!el || last === undefined) return;
        const dy = last - tops.get(t.id);
        if (Math.abs(dy) < 1) return;
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
        el.getBoundingClientRect();
        el.style.transition = 'transform 420ms var(--ease-tidal)';
        el.style.transform = '';
        el.addEventListener('transitionend', () => clearStyles(el), { once: true });
      });
    }
    lastTops.current = tops;
  }, [orderKey]);

  const applyShifts = (d) => {
    tasks.forEach((t, j) => {
      if (j === d.index) return;
      const el = itemEls.current.get(t.id);
      if (!el) return;
      const off = j > d.index && j <= d.projected ? -d.shift : j < d.index && j >= d.projected ? d.shift : 0;
      el.style.transition = 'transform 260ms var(--ease-tidal)';
      el.style.transform = off ? `translateY(${off}px)` : '';
    });
  };

  const onPointerDown = (e, index, id) => {
    if (!onReorder || e.target.closest('button') || e.button > 0 || drag.current) return;
    const el = itemEls.current.get(id);
    if (!el) return;
    e.preventDefault();
    const d = { id, index, projected: index, startY: e.clientY, shift: el.getBoundingClientRect().height + gap };
    drag.current = d;
    setDraggingId(id);
    el.style.zIndex = 5;
    el.style.transition = 'none';
    el.style.filter = 'drop-shadow(0 6px 14px rgba(23,33,30,0.22))';
    // rows sliding under the cursor mid-drag must not take hover
    itemEls.current.forEach((other, oid) => { if (oid !== id) other.style.pointerEvents = 'none'; });

    const onMove = (ev) => {
      const dy = ev.clientY - d.startY;
      el.style.transform = `translateY(${dy}px) scale(1.02)`;
      const p = Math.max(0, Math.min(tasks.length - 1, Math.round(d.index + dy / d.shift)));
      if (p !== d.projected) { d.projected = p; applyShifts(d); }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const settle = (d.projected - d.index) * d.shift;
      el.style.transition = 'transform 300ms var(--ease-tidal), filter 300ms var(--ease-tidal)';
      el.style.transform = settle ? `translateY(${settle}px)` : '';
      el.style.filter = '';
      setTimeout(() => {
        drag.current = null;
        setDraggingId(null);
        if (d.projected === d.index) {
          itemEls.current.forEach(clearStyles);
        } else {
          const next = tasks.slice();
          const [moved] = next.splice(d.index, 1);
          next.splice(d.projected, 0, moved);
          skipFlip.current = true;
          onReorder(next, d.id, baseIndex + d.projected + 1);
        }
      }, reduced() ? 0 : 310);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {tasks.map((t, i) => (
        <div
          key={t.id}
          ref={setRef(t.id)}
          onPointerDown={(e) => onPointerDown(e, i, t.id)}
          title={t.blocked ? 'blocked — the slot skips this row until its children finish' : undefined}
          style={{
            touchAction: onReorder ? 'none' : undefined,
            cursor: onReorder ? (draggingId === t.id ? 'grabbing' : 'grab') : undefined,
            userSelect: 'none', position: 'relative',
            // derived-blocked rows hold their queue position (the slot skips
            // them until the children finish) — hiding them would let the
            // displayed order lie about where a drop actually lands
            opacity: t.blocked ? 0.55 : undefined,
          }}
        >
          {/* only the head row's button is "run now" (an immediate-poll trigger, issue #82 follow-up)
             — every other row's button is pure reordering, color-coded distinctly so the two never look alike */}
          <QueueItem position={baseIndex + i + 1} task={t} skipped={t.skipped} skipReason={skipReason} frontInserted={t.frontInserted} flash={t.flash} isHead={baseIndex + i === 0} onFront={onFront ? () => onFront(t.id) : undefined} />
        </div>
      ))}
    </div>
  );
}

// The slot line reflects the four states of the single execution slot.
// 'limit' additionally renders every queue row as skipped (Swell throttle).
const TP_SLOT_STATES = {
  busy: { color: 'var(--tide-4)', line: 'tp-0142 · Queue reorder — fractional sort keys', meta: 'next poll 08:00' },
  free: { color: 'var(--rock-3)', line: 'slot free — nothing running', meta: 'next poll 08:00' },
  warning: { color: 'var(--sun-4)', line: 'close to limit · finishing tp-0142, starting nothing new', meta: 'per Anthropic threshold' },
  limit: { color: 'var(--coral-4)', line: 'usage limit · nothing starts', meta: 'resumes 06:12 · immediate poll at reset' },
};

// Pause (issue #34) is the fifth slot state, layered over whichever of the
// four above is currently underneath — the same "environmental event freezes
// pickup, running task finishes" shape as throttle's 'limit', but human-
// triggered and manually cleared. `underlyingSlot.taskId` (real deployments
// only — the canned mock states carry none) distinguishes the busy/free
// phrasing.
function pausedSlot(underlyingSlot) {
  return {
    color: 'var(--rock-4)',
    line: underlyingSlot?.taskId
      ? 'pickup paused · task finishes, nothing new starts'
      : 'pickup paused — nothing starts until resumed',
    meta: 'poll idle',
    taskId: underlyingSlot?.taskId ?? null,
  };
}

function QueueScreen({ data, slotState = 'busy', wsAlert = false, paused = false, onTogglePause, onFront, onDoneHuman, onReorder }) {
  const { Card, Button, IdChip } = window.TidepoolDesignSystem_8a0ead;
  // real deployments pass live slot content via data.slot; the canned states remain for the mock
  const underlyingSlot = data.slot || TP_SLOT_STATES[slotState] || TP_SLOT_STATES.busy;
  const slot = paused ? pausedSlot(underlyingSlot) : underlyingSlot;
  const throttled = !paused && slotState === 'limit';
  // the generic "skipped · resumes on reset" row label lied for pause (a
  // human resumes it, not a reset) and for fail-closed throttle (no known
  // reset time to begin with) — issue #82 / #79's lesson about not
  // papering over an unobservable state applies to the row, not just the
  // slot line above it.
  const skipReason = paused
    ? 'pickup paused'
    : data.throttleFailClosed
    ? 'usage check unavailable'
    : data.throttleResumesAt
    ? `resumes ${data.throttleResumesAt}`
    : 'resumes on reset';
  const alert = wsAlert ? data.workspaceAlert : null;
  const queue = (paused || throttled) ? data.queue.map((t) => ({ ...t, skipped: true })) : data.queue;
  React.useEffect(() => { lucide.createIcons(); });
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Queue</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>FIFO · new tasks append · reorder never resets · concurrency=1</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, minHeight: 30 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: slot.color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>slot</span>
        {/* real deployments only */}
        {slot.taskId && (
          <IdChip id={slot.taskId} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: !paused && slotState === 'free' ? 'var(--text-muted)' : 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{slot.line}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flexShrink: 0 }}>{slot.meta}</span>
        {onTogglePause && (
          <button onClick={onTogglePause} aria-pressed={paused}
            aria-label={paused ? 'resume pickup' : 'pause pickup'}
            title={paused ? 'resume pickup — fires an immediate poll' : 'pause pickup — running task finishes, nothing new starts'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: 28, height: 28,
              color: paused ? '#fff' : 'var(--tide-4)',
              background: paused ? 'var(--tide-4)' : 'var(--surface-card)',
              border: 'none', borderRadius: 'var(--radius-full)', padding: 0,
              boxShadow: paused ? 'var(--shadow-primary)' : 'var(--shadow-card)', cursor: 'pointer',
              transition: 'background 120ms var(--ease-tidal), color 120ms var(--ease-tidal)',
            }}>
            <span key={paused ? 'play' : 'pause'} style={{ display: 'inline-flex', width: 13, height: 13 }}>
              <i data-lucide={paused ? 'play' : 'pause'} style={{ width: 13, height: 13 }}></i>
            </span>
          </button>
        )}
      </div>
      {/* waterline — dashed while paused: the tide level holds, nothing flows */}
      <div style={{
        height: 2, borderRadius: 1, marginBottom: 14,
        background: paused
          ? 'repeating-linear-gradient(90deg, var(--rock-3) 0 8px, transparent 8px 14px)'
          : slot.color,
      }}></div>

      {alert && (
        <Card style={{ background: 'var(--coral-1)', border: '1px solid var(--coral-2)', padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--coral-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>workspace needs human</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>{alert.workspace}</span>
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', marginBottom: 4 }}>{alert.reason}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>pickup paused for {alert.held.join(', ')} · see question {alert.question}</div>
        </Card>
      )}

      <div style={{ marginBottom: 28 }}>
        <TpQueueList tasks={queue} onReorder={onReorder} onFront={paused ? undefined : onFront} skipReason={skipReason} />
      </div>

      <h2 style={{ fontSize: 'var(--text-lg)', margin: '0 0 2px' }}>Your tasks</h2>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 12px' }}>outside the queue — you have your own scheduler</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.humanTasks.length === 0 && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: 0 }}>none.</p>}
        {data.humanTasks.map((t) => (
          <Card key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{t.id}</span>
            <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-heading)' }}>{t.title}</span>
            {t.blocking && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sun-4)' }}>blocks {t.blocking}</span>}
            <Button variant="secondary" size="sm" onClick={() => onDoneHuman(t.id)}>Done</Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { QueueScreen, TpQueueList });
