const statusStyles = {
  todo:        { color: 'var(--status-todo-fg)', background: 'var(--status-todo-bg)', boxShadow: '0 2px 8px rgba(29, 106, 102, 0.10)' },
  in_progress: { color: 'var(--status-inprogress-fg)', background: 'var(--status-inprogress-bg)' },
  blocked:     { color: 'var(--status-blocked-fg)', background: 'var(--status-blocked-bg)' },
  done:        { color: 'var(--status-done-fg)', background: 'var(--status-done-bg)' },
  cancelled:   { color: 'var(--status-cancelled-fg)', background: 'var(--status-cancelled-bg)', textDecoration: 'line-through' },
  skipped:     { color: 'var(--status-skipped-fg)', background: 'transparent', border: '1px dashed var(--rock-3)' },
};

export function StatusBadge({ status = 'todo', style }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)',
      padding: '3px 12px', borderRadius: 'var(--radius-full)', whiteSpace: 'nowrap',
      boxSizing: 'border-box',
      ...statusStyles[status],
      ...style,
    }}>
      {status}
    </span>
  );
}
