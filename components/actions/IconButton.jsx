export function IconButton({ label, size = 'md', variant = 'ghost', disabled = false, children, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  const px = size === 'sm' ? 28 : size === 'lg' ? 44 : 36;
  return (
    <button
      aria-label={label}
      title={label}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: px, height: px, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--radius-full)',
        boxShadow: variant === 'outline' ? 'var(--shadow-raised)' : 'none',
        background: hover && !disabled ? 'var(--surface-hover)' : variant === 'outline' ? 'var(--surface-card)' : 'transparent',
        color: hover && !disabled ? 'var(--text-body)' : 'var(--text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background var(--duration-quick) var(--ease-tidal)',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
