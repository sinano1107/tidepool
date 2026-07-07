// Vertically scrollable list that fades content out at the clipped edge(s).
function TpFadeScroll({ children, style }) {
  const ref = React.useRef(null);
  const [edges, setEdges] = React.useState({ top: false, bottom: false });
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, []);
  React.useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, children]);
  const fade = 28;
  const stops = [
    edges.top ? `transparent 0, black ${fade}px` : 'black 0',
    edges.bottom ? `black calc(100% - ${fade}px), transparent 100%` : 'black 100%',
  ].join(', ');
  const mask = `linear-gradient(to bottom, ${stops})`;
  return (
    <div ref={ref} onScroll={update} className="tp-scroll" style={{ WebkitMaskImage: mask, maskImage: mask, ...style }}>
      {children}
    </div>
  );
}

// Kanban board — progress overview. skipped is never shown here.
// Fills available height; each column scrolls vertically on overflow.
function BoardScreen({ data, onOpenTask }) {
  const { TaskCard } = window.TidepoolDesignSystem_8a0ead;
  const cols = ['todo', 'in_progress', 'blocked', 'done'];
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '20px 16px 0' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Board</h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>progress overview · queue order lives in the queue</p>
      </div>
      <div className="tp-scroll" style={{ flex: 1, minHeight: 0, overflowX: 'auto', display: 'flex' }}>
        <div style={{ display: 'inline-flex', gap: 12, alignItems: 'stretch', padding: '0 16px 16px', minHeight: '100%', boxSizing: 'border-box' }}>
          {cols.map((key) => (
            <div key={key} style={{ width: 210, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--surface-recessed)', borderRadius: 'var(--radius-md)', padding: 10, boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '2px 4px 10px', flexShrink: 0 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--text-secondary)' }}>{key}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{data.board[key].length}</span>
              </div>
              <TpFadeScroll style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
                {data.board[key].map((t) => (
                  <TaskCard key={t.id} task={{ ...t, status: key }} onClick={() => onOpenTask && onOpenTask(t)} style={{ flexShrink: 0 }} />
                ))}
              </TpFadeScroll>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { BoardScreen, TpFadeScroll });
