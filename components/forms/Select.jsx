export function Select({ label, options = [], value, onChange, disabled = false, style }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: 'block', ...style }}>
      {label && <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-body)', marginBottom: 6 }}>{label}</span>}
      <div style={{ position: 'relative' }}>
        <select
          value={value} onChange={onChange} disabled={disabled}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{
            width: '100%', boxSizing: 'border-box', appearance: 'none', WebkitAppearance: 'none',
            fontFamily: 'var(--font-ui)', fontSize: 'var(--text-md)', color: 'var(--text-body)',
            background: disabled ? 'var(--surface-recessed)' : 'var(--surface-card)',
            border: `1px solid ${focus ? 'var(--border-focus)' : 'var(--border-default)'}`,
            borderRadius: 'var(--radius-sm)', padding: '9px 32px 9px 12px',
            outline: 'none', boxShadow: focus ? 'var(--shadow-focus)' : 'none', cursor: 'pointer',
            transition: 'box-shadow var(--duration-quick) var(--ease-tidal)',
          }}
        >
          {options.map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
        <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 10 }}>▾</span>
      </div>
    </label>
  );
}
