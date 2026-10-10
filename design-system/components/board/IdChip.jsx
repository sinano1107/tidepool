export function IdChip({ id, style }) {
  return (
    <span
      title={id}
      style={{
        maxWidth: '9ch', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)',
        flexShrink: 0,
        ...style,
      }}
    >{id}</span>
  );
}
