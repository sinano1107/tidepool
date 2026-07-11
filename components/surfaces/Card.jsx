export function Card({ children, padding = 'var(--space-4)', interactive = false, selected = false, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: interactive && hover ? 'var(--surface-hover)' : 'var(--surface-card)',
        border: 'none',
        boxShadow: selected ? 'var(--shadow-focus), var(--shadow-card)' : 'var(--shadow-card)',
        borderRadius: 'var(--radius-lg)',
        padding,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background var(--duration-quick) var(--ease-tidal), box-shadow var(--duration-quick) var(--ease-tidal)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
