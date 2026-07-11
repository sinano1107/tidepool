export function Switch({ label, checked = false, onChange, disabled = false, style }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, ...style }}>
      <span
        role="switch" aria-checked={checked}
        onClick={disabled ? undefined : () => onChange && onChange(!checked)}
        style={{
          width: 36, height: 21, borderRadius: 'var(--radius-full)', flexShrink: 0,
          background: checked ? 'var(--tide-4)' : 'var(--rock-3)',
          position: 'relative',
          transition: 'background var(--duration-quick) var(--ease-tidal)',
        }}
      >
        <span style={{
          position: 'absolute', top: 2.5, left: checked ? 18 : 2.5,
          width: 16, height: 16, borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 2px rgba(23,33,30,0.2)',
          transition: 'left var(--duration-quick) var(--ease-tidal)',
        }}></span>
      </span>
      {label && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>{label}</span>}
    </label>
  );
}
