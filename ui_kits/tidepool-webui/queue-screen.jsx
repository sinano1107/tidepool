// TODO queue — ordering + manual intervention live here, plus "your tasks" (human list)

// Reorderable queue list — pointer-driven drag & drop with tidal FLIP animations.
// Reused by QueueScreen and the triage queue-check step.
function TpQueueList({ tasks, baseIndex = 0, onReorder, onFront, gap = 6 }) {
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
          style={{
            touchAction: onReorder ? 'none' : undefined,
            cursor: onReorder ? (draggingId === t.id ? 'grabbing' : 'grab') : undefined,
            userSelect: 'none', position: 'relative',
          }}
        >
          <QueueItem position={baseIndex + i + 1} task={t} skipped={t.skipped} frontInserted={t.frontInserted} flash={t.flash} onFront={onFront && i > 0 ? () => onFront(t.id) : undefined} />
        </div>
      ))}
    </div>
  );
}

function QueueScreen({ data, onFront, onDoneHuman, onReorder }) {
  const { Card, Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Queue</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>FIFO · new tasks append · reorder never resets · concurrency=1</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>slot</span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>tp-0142 · Queue reorder — fractional sort keys</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flexShrink: 0 }}>next poll 08:00</span>
      </div>
      <div style={{ height: 2, background: 'var(--tide-4)', borderRadius: 1, marginBottom: 14 }}></div>

      <div style={{ marginBottom: 28 }}>
        <TpQueueList tasks={data.queue} onReorder={onReorder} onFront={onFront} />
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
