// Kanban board — progress overview. skipped is never shown here.
// Fills available height; each column scrolls vertically on overflow.
function BoardScreen({ data, onOpenTask }) {
  const { FadeScroll, TaskCard } = window.TidepoolDesignSystem_8a0ead;
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
              <FadeScroll style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
                {data.board[key].map((t) => (
                  <TaskCard key={t.id} task={{ ...t, status: key }} onClick={() => onOpenTask && onOpenTask(t)} style={{ flexShrink: 0 }} />
                ))}
              </FadeScroll>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { BoardScreen });
