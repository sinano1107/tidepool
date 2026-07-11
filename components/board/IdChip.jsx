export function IdChip({ id, style }) {
  return (
    <span
      title={id}
      style={{
        maxWidth: '9ch', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        ...style,
      }}
    >{id}</span>
  );
}
