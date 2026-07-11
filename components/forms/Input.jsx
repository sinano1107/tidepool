const fieldLabel = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--weight-medium)',
  color: 'var(--text-body)',
  marginBottom: '6px',
};

export function Input({ label, hint, error, multiline = false, mono = false, value, defaultValue, onChange, placeholder, rows = 3, disabled = false, style }) {
  const [focus, setFocus] = React.useState(false);
  const shared = {
    width: '100%', boxSizing: 'border-box',
    fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
    fontSize: 'var(--text-md)',
    color: 'var(--text-body)',
    background: disabled ? 'var(--surface-recessed)' : 'var(--surface-card)',
    border: `1px solid ${error ? 'var(--coral-3)' : focus ? 'var(--border-focus)' : 'var(--border-default)'}`,
    borderRadius: 'var(--radius-sm)',
    padding: '9px 12px',
    outline: 'none',
    boxShadow: focus ? 'var(--shadow-focus)' : 'none',
    transition: 'box-shadow var(--duration-quick) var(--ease-tidal), border-color var(--duration-quick) var(--ease-tidal)',
    resize: multiline ? 'vertical' : undefined,
  };
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <label style={{ display: 'block', ...style }}>
      {label && <span style={fieldLabel}>{label}</span>}
      <Tag
        value={value} defaultValue={defaultValue} placeholder={placeholder}
        disabled={disabled} rows={multiline ? rows : undefined}
        onChange={onChange}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={shared}
      />
      {error
        ? <span style={{ display: 'block', marginTop: 5, fontSize: 'var(--text-xs)', color: 'var(--coral-4)' }}>{error}</span>
        : hint && <span style={{ display: 'block', marginTop: 5, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</span>}
    </label>
  );
}
