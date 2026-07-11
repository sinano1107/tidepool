export function Checkbox({ label, checked = false, onChange, disabled = false, style }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, ...style }}>
      <span style={{
        width: 18, height: 18, flexShrink: 0, boxSizing: 'border-box',
        borderRadius: 'var(--radius-xs)',
        border: `1.5px solid ${checked ? 'var(--tide-4)' : 'var(--border-default)'}`,
        background: checked ? 'var(--tide-4)' : 'var(--surface-card)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background var(--duration-quick) var(--ease-tidal), border-color var(--duration-quick) var(--ease-tidal)',
      }}>
        {checked && (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 6.5L5 9L9.5 3.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      {label && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>{label}</span>}
    </label>
  );
}
