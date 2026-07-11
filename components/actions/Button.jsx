const btnBase = {
  fontFamily: 'var(--font-ui)',
  fontWeight: 'var(--weight-semibold)',
  border: 'none',
  borderRadius: 'var(--radius-full)',
  cursor: 'pointer',
  transition: 'background var(--duration-quick) var(--ease-tidal), color var(--duration-quick) var(--ease-tidal), box-shadow var(--duration-quick) var(--ease-tidal)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  whiteSpace: 'nowrap',
};

const btnSizes = {
  sm: { fontSize: 'var(--text-sm)', padding: '6px 14px', minHeight: '30px' },
  md: { fontSize: 'var(--text-md)', padding: '9px 20px', minHeight: '38px' },
  lg: { fontSize: 'var(--text-md)', padding: '11px 24px', minHeight: '44px' },
};

const btnVariants = {
  primary:   { background: 'var(--action-primary)', color: '#fff', boxShadow: 'var(--shadow-primary)' },
  secondary: { background: 'var(--surface-card)', color: 'var(--tide-5)', boxShadow: 'var(--shadow-raised)' },
  ghost:     { background: 'transparent', color: 'var(--text-secondary)' },
  danger:    { background: 'var(--coral-1)', color: 'var(--coral-4)' },
};

const btnHover = {
  primary:   { background: 'var(--action-primary-hover)' },
  secondary: { background: 'var(--surface-hover)' },
  ghost:     { background: 'var(--surface-hover)', color: 'var(--text-body)' },
  danger:    { background: 'var(--coral-2)' },
};

export function Button({ variant = 'primary', size = 'md', full = false, disabled = false, children, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...btnBase,
        ...btnSizes[size],
        ...btnVariants[variant],
        ...(hover && !disabled ? btnHover[variant] : {}),
        ...(full ? { width: '100%' } : {}),
        ...(disabled ? { opacity: 0.45, cursor: 'default' } : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
