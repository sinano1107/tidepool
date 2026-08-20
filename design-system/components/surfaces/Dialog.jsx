import { FadeScroll } from './FadeScroll.jsx';

export function Dialog({ open = true, title, children, footer, onClose, width = 420 }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(23, 33, 30, 0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-4)',
      }}
    >
      <div
        role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: width, maxHeight: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          padding: 'var(--space-6)',
        }}
      >
        {title && <h2 style={{ flexShrink: 0, margin: '0 0 var(--space-3)', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{title}</h2>}
        <FadeScroll style={{ minHeight: 0, overflowY: 'auto', fontSize: 'var(--text-md)', color: 'var(--text-body)' }}>{children}</FadeScroll>
        {footer && <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-6)' }}>{footer}</div>}
      </div>
    </div>
  );
}
