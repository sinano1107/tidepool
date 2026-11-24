import { AgentChip } from './AgentChip.jsx';
import { IdChip } from './IdChip.jsx';
import { RiskFlag } from './RiskFlag.jsx';

export function QueueItem({ position, task = {}, skipped = false, skipReason, frontInserted = false, flash = false, isHead = false, draggable = false, onFront, style }) {
  const { id, title, assignee, assigneeIcon } = task;
  // hover styling lives in CSS (.tp-queue-item) — JS mouseenter state gets stuck
  // when rows are reordered under a stationary pointer.
  return (
    <div
      className="tp-queue-item"
      data-front={flash ? '' : undefined}
      style={{
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: '10px 18px',
        border: skipped ? '1px dashed var(--rock-3)' : 'none',
        boxShadow: skipped ? 'none' : 'var(--shadow-card)',
        borderRadius: 'var(--radius-full)',
        opacity: skipped ? 0.65 : 1,
        ...style,
      }}
    >
      {/* the first line never wraps: a skipped row is exactly two lines, a row that is not skipped exactly one */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {draggable && <span aria-hidden="true" data-testid="queue-drag-handle" style={{ color: 'var(--rock-3)', cursor: 'grab', fontSize: 14, lineHeight: 1, letterSpacing: '-2px' }}>⠿</span>}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', background: frontInserted ? 'var(--surface-card)' : 'var(--tide-1)', borderRadius: 'var(--radius-full)', padding: '2px 8px', flexShrink: 0 }}>{position}</span>
        <IdChip id={id} />
        {/* the title's flex-basis is 0%, so it absorbs no shrink at all — without
            a floor the labels beside it squeeze it to zero width (issue #219) */}
        <span style={{ flex: 1, minWidth: 80, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-heading)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        {task.risk && <RiskFlag />}
        {frontInserted && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)' }}>front-inserted</span>}
        <AgentChip name={assignee} icon={assigneeIcon} size="sm" />
        {onFront && (
          // the head row's button is "run now" (tide fill, immediate-poll
          // trigger); every other row is pure reordering — same tide hue so
          // both read as "the queue action," but outlined instead of filled
          // so it never reads as disabled (unlike a neutral/rock treatment,
          // which this design system's own tokens reserve for that)
          <button
            className={isHead ? 'tp-queue-front-btn' : 'tp-queue-promote-btn'}
            onClick={onFront} title={isHead ? 'Run now — fires an immediate pickup poll' : 'Move to front — reorders only; press again once it is head to run it now'}
            style={{
              fontFamily: 'var(--font-ui)', fontSize: 'var(--text-xs)', color: 'var(--tide-4)',
              background: isHead ? 'var(--tide-1)' : 'transparent',
              border: isHead ? 'none' : '1px solid var(--tide-3)',
              borderRadius: 'var(--radius-full)', padding: '4px 10px', cursor: 'pointer', flexShrink: 0,
            }}
          >↑</button>
        )}
      </div>
      {/* the skip label takes its own line, as the queue slot row's meta does (issue #396): at 375px the
          first line has ~16px left, so inline even a bare `skipped` was cut (ADR 0102's two-row fallback, issue #3703) */}
      {skipped && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--status-skipped-fg)' }}>
          {skipReason ? `skipped · ${skipReason}` : 'skipped'}
        </span>
      )}
    </div>
  );
}
