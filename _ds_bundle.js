/* @ds-bundle: {"format":4,"namespace":"TidepoolDesignSystem_8a0ead","components":[{"name":"Button","sourcePath":"components/actions/Button.jsx"},{"name":"IconButton","sourcePath":"components/actions/IconButton.jsx"},{"name":"AgentChip","sourcePath":"components/board/AgentChip.jsx"},{"name":"LogEntry","sourcePath":"components/board/LogEntry.jsx"},{"name":"QueueItem","sourcePath":"components/board/QueueItem.jsx"},{"name":"RiskFlag","sourcePath":"components/board/RiskFlag.jsx"},{"name":"StatusBadge","sourcePath":"components/board/StatusBadge.jsx"},{"name":"TaskCard","sourcePath":"components/board/TaskCard.jsx"},{"name":"TypeBadge","sourcePath":"components/board/TypeBadge.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Card","sourcePath":"components/surfaces/Card.jsx"},{"name":"Dialog","sourcePath":"components/surfaces/Dialog.jsx"},{"name":"Tag","sourcePath":"components/surfaces/Tag.jsx"},{"name":"Toast","sourcePath":"components/surfaces/Toast.jsx"}],"sourceHashes":{"components/actions/Button.jsx":"0e958063b877","components/actions/IconButton.jsx":"bbb5065d6aff","components/board/AgentChip.jsx":"f04d4a78c6b0","components/board/LogEntry.jsx":"4ba71f2a478d","components/board/QueueItem.jsx":"22bba8c68be7","components/board/RiskFlag.jsx":"ed9e1a477412","components/board/StatusBadge.jsx":"b9c75f03bde0","components/board/TaskCard.jsx":"3b748388d804","components/board/TypeBadge.jsx":"98652c1281c5","components/forms/Checkbox.jsx":"1636ff9d5487","components/forms/Input.jsx":"0a31c8ff38f9","components/forms/Select.jsx":"d46971f01b6c","components/forms/Switch.jsx":"5b3372700472","components/surfaces/Card.jsx":"093c38c4b4c8","components/surfaces/Dialog.jsx":"f2932d1af2a9","components/surfaces/Tag.jsx":"26fba4a69c0e","components/surfaces/Toast.jsx":"3ecb10bfb799","ui_kits/tidepool-webui/board-screen.jsx":"3c4b37cf67fe","ui_kits/tidepool-webui/data.js":"797963c30b6e","ui_kits/tidepool-webui/queue-screen.jsx":"1e972080371d","ui_kits/tidepool-webui/register-screen.jsx":"8ff254501204","ui_kits/tidepool-webui/triage-screen.jsx":"7276ed3fe473","ui_kits/tidepool-webui/tweaks-panel.jsx":"6591467622ed"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.TidepoolDesignSystem_8a0ead = window.TidepoolDesignSystem_8a0ead || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/actions/Button.jsx
try { (() => {
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
  whiteSpace: 'nowrap'
};
const btnSizes = {
  sm: {
    fontSize: 'var(--text-sm)',
    padding: '6px 14px',
    minHeight: '30px'
  },
  md: {
    fontSize: 'var(--text-md)',
    padding: '9px 20px',
    minHeight: '38px'
  },
  lg: {
    fontSize: 'var(--text-md)',
    padding: '11px 24px',
    minHeight: '44px'
  }
};
const btnVariants = {
  primary: {
    background: 'var(--action-primary)',
    color: '#fff',
    boxShadow: 'var(--shadow-primary)'
  },
  secondary: {
    background: 'var(--surface-card)',
    color: 'var(--tide-5)',
    boxShadow: 'var(--shadow-raised)'
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-secondary)'
  },
  danger: {
    background: 'var(--coral-1)',
    color: 'var(--coral-4)'
  }
};
const btnHover = {
  primary: {
    background: 'var(--action-primary-hover)'
  },
  secondary: {
    background: 'var(--surface-hover)'
  },
  ghost: {
    background: 'var(--surface-hover)',
    color: 'var(--text-body)'
  },
  danger: {
    background: 'var(--coral-2)'
  }
};
function Button({
  variant = 'primary',
  size = 'md',
  full = false,
  disabled = false,
  children,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    onClick: disabled ? undefined : onClick,
    disabled: disabled,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      ...btnBase,
      ...btnSizes[size],
      ...btnVariants[variant],
      ...(hover && !disabled ? btnHover[variant] : {}),
      ...(full ? {
        width: '100%'
      } : {}),
      ...(disabled ? {
        opacity: 0.45,
        cursor: 'default'
      } : {}),
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/Button.jsx", error: String((e && e.message) || e) }); }

// components/actions/IconButton.jsx
try { (() => {
function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  disabled = false,
  children,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  const px = size === 'sm' ? 28 : size === 'lg' ? 44 : 36;
  return /*#__PURE__*/React.createElement("button", {
    "aria-label": label,
    title: label,
    onClick: disabled ? undefined : onClick,
    disabled: disabled,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: px,
      height: px,
      padding: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: 'var(--radius-full)',
      boxShadow: variant === 'outline' ? 'var(--shadow-raised)' : 'none',
      background: hover && !disabled ? 'var(--surface-hover)' : variant === 'outline' ? 'var(--surface-card)' : 'transparent',
      color: hover && !disabled ? 'var(--text-body)' : 'var(--text-secondary)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      transition: 'background var(--duration-quick) var(--ease-tidal)',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/board/AgentChip.jsx
try { (() => {
const chipPalette = ['var(--tide-3)', 'var(--sun-3)', 'var(--coral-3)', 'var(--grass-3)', 'var(--rock-5)'];

// Species icons — the one sanctioned emoji use (visual identity for agents, never in copy).
const speciesIcons = {
  'reef-crab': '🦀',
  'anemone': '🪸',
  'hermit': '🐚'
};
function AgentChip({
  name = '',
  human = false,
  size = 'md',
  style
}) {
  const px = size === 'sm' ? 20 : 26;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = hash * 31 + name.charCodeAt(i) | 0;
  const species = human ? '🧍' : speciesIcons[name];
  const bg = species ? 'var(--tide-1)' : chipPalette[Math.abs(hash) % chipPalette.length];
  const initials = name.split(/[-_ ]/).map(w => w[0]).join('').slice(0, 2);
  return /*#__PURE__*/React.createElement("span", {
    title: human ? 'you' : name,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: px,
      height: px,
      borderRadius: '50%',
      background: bg,
      color: '#fff',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-mono)',
      fontSize: species ? px * 0.58 : px * 0.42,
      fontWeight: 500,
      flexShrink: 0
    }
  }, species || initials), size !== 'sm' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      color: 'var(--text-secondary)'
    }
  }, human ? 'you' : name));
}
Object.assign(__ds_scope, { AgentChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/AgentChip.jsx", error: String((e && e.message) || e) }); }

// components/board/LogEntry.jsx
try { (() => {
const kindColors = {
  decision: 'var(--text-body)',
  completion: 'var(--grass-4)',
  escalation: 'var(--sun-4)',
  objection: 'var(--coral-4)'
};
function LogEntry({
  entry = {},
  onObject,
  active = false,
  style
}) {
  const {
    time,
    taskId,
    agent,
    kind = 'decision',
    text,
    objection,
    unread = false
  } = entry;
  const completion = kind === 'completion';
  const clickable = !!onObject && !objection;
  return /*#__PURE__*/React.createElement("div", {
    className: "tp-log-entry",
    "data-clickable": clickable ? '' : undefined,
    "data-active": active ? '' : undefined,
    onClick: clickable ? onObject : undefined,
    role: clickable ? 'button' : undefined,
    tabIndex: clickable ? 0 : undefined,
    onKeyDown: clickable ? e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onObject();
      }
    } : undefined,
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '10px 12px',
      background: completion ? 'var(--grass-1)' : undefined,
      borderBottom: '1px solid var(--border-hairline)',
      borderLeft: unread ? '2px solid var(--tide-4)' : '2px solid transparent',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      paddingTop: 2,
      flexShrink: 0
    }
  }, time), /*#__PURE__*/React.createElement(__ds_scope.AgentChip, {
    name: agent,
    size: "sm",
    style: {
      paddingTop: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-sm)',
      color: kindColors[kind],
      lineHeight: 'var(--leading-normal)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      marginRight: 6
    }
  }, taskId), completion && /*#__PURE__*/React.createElement("strong", {
    style: {
      fontWeight: 'var(--weight-semibold)',
      marginRight: 4
    }
  }, "done \u2014"), text), objection && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      padding: '6px 10px',
      background: 'var(--coral-1)',
      borderRadius: 'var(--radius-xs)',
      fontSize: 'var(--text-xs)',
      color: 'var(--coral-4)'
    }
  }, "objection: ", objection)), active && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--coral-4)',
      paddingTop: 3,
      flexShrink: 0
    }
  }, "objecting\u2026"));
}
Object.assign(__ds_scope, { LogEntry });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/LogEntry.jsx", error: String((e && e.message) || e) }); }

// components/board/RiskFlag.jsx
try { (() => {
function RiskFlag({
  style
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--weight-medium)',
      color: 'var(--risk-fg)',
      background: 'var(--risk-bg)',
      padding: '2px 8px',
      borderRadius: 'var(--radius-xs)',
      whiteSpace: 'nowrap',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true"
  }, "\u26A0"), " risk");
}
Object.assign(__ds_scope, { RiskFlag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/RiskFlag.jsx", error: String((e && e.message) || e) }); }

// components/board/QueueItem.jsx
try { (() => {
function QueueItem({
  position,
  task = {},
  skipped = false,
  frontInserted = false,
  flash = false,
  onFront,
  style
}) {
  const {
    id,
    title,
    assignee
  } = task;
  // hover styling lives in CSS (.tp-queue-item) — JS mouseenter state gets stuck
  // when rows are reordered under a stationary pointer.
  return /*#__PURE__*/React.createElement("div", {
    className: "tp-queue-item",
    "data-front": flash ? '' : undefined,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 18px',
      border: skipped ? '1px dashed var(--rock-3)' : 'none',
      boxShadow: skipped ? 'none' : 'var(--shadow-card)',
      borderRadius: 'var(--radius-full)',
      opacity: skipped ? 0.65 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      color: 'var(--rock-3)',
      cursor: 'grab',
      fontSize: 14,
      lineHeight: 1,
      letterSpacing: '-2px'
    }
  }, "\u283F"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--tide-4)',
      background: frontInserted ? 'var(--surface-card)' : 'var(--tide-1)',
      borderRadius: 'var(--radius-full)',
      padding: '2px 8px',
      flexShrink: 0
    }
  }, position), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      flexShrink: 0
    }
  }, id), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--weight-medium)',
      color: 'var(--text-heading)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, title), task.risk && /*#__PURE__*/React.createElement(__ds_scope.RiskFlag, null), skipped && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--status-skipped-fg)'
    }
  }, "skipped \xB7 resumes on reset"), frontInserted && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--tide-4)'
    }
  }, "front-inserted"), /*#__PURE__*/React.createElement(__ds_scope.AgentChip, {
    name: assignee,
    size: "sm"
  }), onFront && !skipped && /*#__PURE__*/React.createElement("button", {
    className: "tp-queue-front-btn",
    onClick: onFront,
    title: "Move to front",
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--text-xs)',
      color: 'var(--tide-4)',
      background: 'var(--tide-1)',
      border: 'none',
      borderRadius: 'var(--radius-full)',
      padding: '4px 10px',
      cursor: 'pointer',
      flexShrink: 0
    }
  }, "\u2191"));
}
Object.assign(__ds_scope, { QueueItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/QueueItem.jsx", error: String((e && e.message) || e) }); }

// components/board/StatusBadge.jsx
try { (() => {
const statusStyles = {
  todo: {
    color: 'var(--status-todo-fg)',
    background: 'var(--status-todo-bg)',
    boxShadow: '0 2px 8px rgba(29, 106, 102, 0.10)'
  },
  in_progress: {
    color: 'var(--status-inprogress-fg)',
    background: 'var(--status-inprogress-bg)'
  },
  blocked: {
    color: 'var(--status-blocked-fg)',
    background: 'var(--status-blocked-bg)'
  },
  done: {
    color: 'var(--status-done-fg)',
    background: 'var(--status-done-bg)'
  },
  cancelled: {
    color: 'var(--status-cancelled-fg)',
    background: 'var(--status-cancelled-bg)',
    textDecoration: 'line-through'
  },
  skipped: {
    color: 'var(--status-skipped-fg)',
    background: 'transparent',
    border: '1px dashed var(--rock-3)'
  }
};
function StatusBadge({
  status = 'todo',
  style
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--weight-medium)',
      padding: '3px 12px',
      borderRadius: 'var(--radius-full)',
      whiteSpace: 'nowrap',
      boxSizing: 'border-box',
      ...statusStyles[status],
      ...style
    }
  }, status);
}
Object.assign(__ds_scope, { StatusBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/StatusBadge.jsx", error: String((e && e.message) || e) }); }

// components/board/TypeBadge.jsx
try { (() => {
const typeStyles = {
  work: {
    color: 'var(--type-work-fg)',
    symbol: '●'
  },
  question: {
    color: 'var(--type-question-fg)',
    symbol: '?'
  },
  review: {
    color: 'var(--type-review-fg)',
    symbol: '◍'
  }
};
function TypeBadge({
  type = 'work',
  showLabel = true,
  style
}) {
  const t = typeStyles[type];
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      color: t.color,
      whiteSpace: 'nowrap',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      fontSize: 10
    }
  }, t.symbol), showLabel && type);
}
Object.assign(__ds_scope, { TypeBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TypeBadge.jsx", error: String((e && e.message) || e) }); }

// components/board/TaskCard.jsx
try { (() => {
function TaskCard({
  task = {},
  onClick,
  style
}) {
  const {
    id,
    title,
    status = 'todo',
    type = 'work',
    assignee,
    human = false,
    risk = false,
    children: childCount = 0
  } = task;
  const [hover, setHover] = React.useState(false);
  const cancelled = status === 'cancelled';
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: hover ? 'var(--surface-hover)' : 'var(--surface-card)',
      border: 'none',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-card)',
      padding: '14px 16px',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'background var(--duration-quick) var(--ease-tidal)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)'
    }
  }, id), /*#__PURE__*/React.createElement(__ds_scope.TypeBadge, {
    type: type,
    showLabel: false
  }), risk && /*#__PURE__*/React.createElement(__ds_scope.RiskFlag, {
    style: {
      marginLeft: 'auto'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--weight-medium)',
      color: cancelled ? 'var(--text-muted)' : 'var(--text-heading)',
      textDecoration: cancelled ? 'line-through' : 'none',
      marginBottom: 10,
      lineHeight: 'var(--leading-tight)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
      rowGap: 6,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.AgentChip, {
    name: assignee,
    human: human,
    size: "sm"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-secondary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      minWidth: 0,
      flexShrink: 1
    }
  }, human ? 'you' : assignee), childCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--sun-4)',
      whiteSpace: 'nowrap'
    }
  }, childCount, " open child", childCount > 1 ? 'ren' : ''), /*#__PURE__*/React.createElement(__ds_scope.StatusBadge, {
    status: status,
    style: {
      marginLeft: 'auto'
    }
  })));
}
Object.assign(__ds_scope, { TaskCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TaskCard.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function Checkbox({
  label,
  checked = false,
  onChange,
  disabled = false,
  style
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 9,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      flexShrink: 0,
      boxSizing: 'border-box',
      borderRadius: 'var(--radius-xs)',
      border: `1.5px solid ${checked ? 'var(--tide-4)' : 'var(--border-default)'}`,
      background: checked ? 'var(--tide-4)' : 'var(--surface-card)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background var(--duration-quick) var(--ease-tidal), border-color var(--duration-quick) var(--ease-tidal)'
    }
  }, checked && /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "11",
    viewBox: "0 0 12 12",
    fill: "none",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2.5 6.5L5 9L9.5 3.5",
    stroke: "#fff",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: checked,
    onChange: onChange,
    disabled: disabled,
    style: {
      position: 'absolute',
      opacity: 0,
      width: 0,
      height: 0
    }
  }), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-body)'
    }
  }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
const fieldLabel = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--weight-medium)',
  color: 'var(--text-body)',
  marginBottom: '6px'
};
function Input({
  label,
  hint,
  error,
  multiline = false,
  mono = false,
  value,
  defaultValue,
  onChange,
  placeholder,
  rows = 3,
  disabled = false,
  style
}) {
  const [focus, setFocus] = React.useState(false);
  const shared = {
    width: '100%',
    boxSizing: 'border-box',
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
    resize: multiline ? 'vertical' : undefined
  };
  const Tag = multiline ? 'textarea' : 'input';
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'block',
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: fieldLabel
  }, label), /*#__PURE__*/React.createElement(Tag, {
    value: value,
    defaultValue: defaultValue,
    placeholder: placeholder,
    disabled: disabled,
    rows: multiline ? rows : undefined,
    onChange: onChange,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: shared
  }), error ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      marginTop: 5,
      fontSize: 'var(--text-xs)',
      color: 'var(--coral-4)'
    }
  }, error) : hint && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      marginTop: 5,
      fontSize: 'var(--text-xs)',
      color: 'var(--text-muted)'
    }
  }, hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function Select({
  label,
  options = [],
  value,
  onChange,
  disabled = false,
  style
}) {
  const [focus, setFocus] = React.useState(false);
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'block',
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--weight-medium)',
      color: 'var(--text-body)',
      marginBottom: 6
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: value,
    onChange: onChange,
    disabled: disabled,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      width: '100%',
      boxSizing: 'border-box',
      appearance: 'none',
      WebkitAppearance: 'none',
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--text-md)',
      color: 'var(--text-body)',
      background: disabled ? 'var(--surface-recessed)' : 'var(--surface-card)',
      border: `1px solid ${focus ? 'var(--border-focus)' : 'var(--border-default)'}`,
      borderRadius: 'var(--radius-sm)',
      padding: '9px 32px 9px 12px',
      outline: 'none',
      boxShadow: focus ? 'var(--shadow-focus)' : 'none',
      cursor: 'pointer',
      transition: 'box-shadow var(--duration-quick) var(--ease-tidal)'
    }
  }, options.map(o => {
    const opt = typeof o === 'string' ? {
      value: o,
      label: o
    } : o;
    return /*#__PURE__*/React.createElement("option", {
      key: opt.value,
      value: opt.value
    }, opt.label);
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: 12,
      top: '50%',
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
      color: 'var(--text-muted)',
      fontSize: 10
    }
  }, "\u25BE")));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function Switch({
  label,
  checked = false,
  onChange,
  disabled = false,
  style
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    role: "switch",
    "aria-checked": checked,
    onClick: disabled ? undefined : () => onChange && onChange(!checked),
    style: {
      width: 36,
      height: 21,
      borderRadius: 'var(--radius-full)',
      flexShrink: 0,
      background: checked ? 'var(--tide-4)' : 'var(--rock-3)',
      position: 'relative',
      transition: 'background var(--duration-quick) var(--ease-tidal)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 2.5,
      left: checked ? 18 : 2.5,
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 2px rgba(23,33,30,0.2)',
      transition: 'left var(--duration-quick) var(--ease-tidal)'
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-body)'
    }
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Card.jsx
try { (() => {
function Card({
  children,
  padding = 'var(--space-4)',
  interactive = false,
  selected = false,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: interactive && hover ? 'var(--surface-hover)' : 'var(--surface-card)',
      border: 'none',
      boxShadow: selected ? 'var(--shadow-focus), var(--shadow-card)' : 'var(--shadow-card)',
      borderRadius: 'var(--radius-lg)',
      padding,
      cursor: interactive ? 'pointer' : 'default',
      transition: 'background var(--duration-quick) var(--ease-tidal), box-shadow var(--duration-quick) var(--ease-tidal)',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Card.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Dialog.jsx
try { (() => {
function Dialog({
  open = true,
  title,
  children,
  footer,
  onClose,
  width = 420
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 100,
      background: 'rgba(23, 33, 30, 0.4)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    onClick: e => e.stopPropagation(),
    style: {
      width: '100%',
      maxWidth: width,
      boxSizing: 'border-box',
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-overlay)',
      padding: 'var(--space-6)'
    }
  }, title && /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: '0 0 var(--space-3)',
      fontSize: 'var(--text-lg)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-heading)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-md)',
      color: 'var(--text-body)'
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 'var(--space-2)',
      marginTop: 'var(--space-6)'
    }
  }, footer)));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Tag.jsx
try { (() => {
const tagColors = {
  neutral: {
    color: 'var(--rock-5)',
    background: 'var(--rock-1)'
  },
  tide: {
    color: 'var(--tide-4)',
    background: 'var(--tide-1)'
  },
  sun: {
    color: 'var(--sun-4)',
    background: 'var(--sun-1)'
  },
  coral: {
    color: 'var(--coral-4)',
    background: 'var(--coral-1)'
  },
  grass: {
    color: 'var(--grass-4)',
    background: 'var(--grass-1)'
  }
};
function Tag({
  color = 'neutral',
  mono = false,
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--weight-medium)',
      padding: '3px 10px',
      borderRadius: 'var(--radius-full)',
      whiteSpace: 'nowrap',
      ...tagColors[color],
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Tag.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Toast.jsx
try { (() => {
const toastKinds = {
  info: {
    border: 'var(--tide-3)',
    icon: 'var(--tide-4)'
  },
  success: {
    border: 'var(--grass-2)',
    icon: 'var(--grass-3)'
  },
  warn: {
    border: 'var(--sun-2)',
    icon: 'var(--sun-3)'
  },
  danger: {
    border: 'var(--coral-2)',
    icon: 'var(--coral-3)'
  }
};
function Toast({
  kind = 'info',
  children,
  detail,
  onDismiss,
  style
}) {
  const k = toastKinds[kind];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      background: 'var(--surface-card)',
      color: 'var(--text-heading)',
      borderRadius: 'var(--radius-full)',
      boxShadow: 'var(--shadow-overlay)',
      padding: '12px 18px',
      maxWidth: 420,
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--weight-medium)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: k.icon,
      marginTop: 6,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", null, children), detail && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      marginTop: 3,
      fontWeight: 400
    }
  }, detail)), onDismiss && /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    "aria-label": "Dismiss",
    style: {
      background: 'none',
      border: 'none',
      color: 'var(--text-muted)',
      cursor: 'pointer',
      fontSize: 14,
      padding: 0,
      lineHeight: 1,
      alignSelf: 'center',
      flexShrink: 0
    }
  }, "\u2715"));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Toast.jsx", error: String((e && e.message) || e) }); }

// ui_kits/tidepool-webui/board-screen.jsx
try { (() => {
// Vertically scrollable list that fades content out at the clipped edge(s).
function TpFadeScroll({
  children,
  style
}) {
  const ref = React.useRef(null);
  const [edges, setEdges] = React.useState({
    top: false,
    bottom: false
  });
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges(e => e.top === top && e.bottom === bottom ? e : {
      top,
      bottom
    });
  }, []);
  React.useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, children]);
  const fade = 28;
  const stops = [edges.top ? `transparent 0, black ${fade}px` : 'black 0', edges.bottom ? `black calc(100% - ${fade}px), transparent 100%` : 'black 100%'].join(', ');
  const mask = `linear-gradient(to bottom, ${stops})`;
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    onScroll: update,
    className: "tp-scroll",
    style: {
      WebkitMaskImage: mask,
      maskImage: mask,
      ...style
    }
  }, children);
}

// Kanban board — progress overview. skipped is never shown here.
// Fills available height; each column scrolls vertically on overflow.
function BoardScreen({
  data,
  onOpenTask
}) {
  const {
    TaskCard
  } = window.TidepoolDesignSystem_8a0ead;
  const cols = ['todo', 'in_progress', 'blocked', 'done'];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 16px 0'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 'var(--text-xl)',
      margin: '0 0 2px'
    }
  }, "Board"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-secondary)',
      margin: '0 0 16px'
    }
  }, "progress overview \xB7 queue order lives in the queue")), /*#__PURE__*/React.createElement("div", {
    className: "tp-scroll",
    style: {
      flex: 1,
      minHeight: 0,
      overflowX: 'auto',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      gap: 12,
      alignItems: 'stretch',
      padding: '0 16px 16px',
      minHeight: '100%',
      boxSizing: 'border-box'
    }
  }, cols.map(key => /*#__PURE__*/React.createElement("div", {
    key: key,
    style: {
      width: 210,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      background: 'var(--surface-recessed)',
      borderRadius: 'var(--radius-md)',
      padding: 10,
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      padding: '2px 4px 10px',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      fontWeight: 500,
      color: 'var(--text-secondary)'
    }
  }, key), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)'
    }
  }, data.board[key].length)), /*#__PURE__*/React.createElement(TpFadeScroll, {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      paddingRight: 2
    }
  }, data.board[key].map(t => /*#__PURE__*/React.createElement(TaskCard, {
    key: t.id,
    task: {
      ...t,
      status: key
    },
    onClick: () => onOpenTask && onOpenTask(t),
    style: {
      flexShrink: 0
    }
  }))))))));
}
Object.assign(window, {
  BoardScreen,
  TpFadeScroll
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/tidepool-webui/board-screen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/tidepool-webui/data.js
try { (() => {
// tidepool webui — shared fake data for the UI kit
const tpData = {
  agents: [{
    name: 'reef-crab',
    desc: 'implementation · sonnet + git-guardrails'
  }, {
    name: 'anemone',
    desc: 'review · read-only authority'
  }, {
    name: 'hermit',
    desc: 'docs + registry edits'
  }],
  questions: [{
    id: 'tp-0143',
    parent: 'tp-0141',
    agent: 'reef-crab',
    title: 'Merge PR #58? CI green',
    context: 'registry loader — 4 files, all checks pass. Merge is outside my authority (merge: escalate).',
    options: [{
      label: 'Merge',
      recommended: true
    }, {
      label: 'Hold — I will look today'
    }, {
      label: 'Request changes via repair task'
    }]
  }, {
    id: 'tp-0148',
    parent: 'tp-0146',
    agent: 'anemone',
    title: 'Schema: soft-delete or hard-delete cancelled tasks?',
    context: 'events table is append-only either way; this only affects the tasks row.',
    options: [{
      label: 'Keep rows, status=cancelled',
      recommended: true
    }, {
      label: 'Hard delete'
    }]
  }, {
    id: 'tp-0149',
    parent: null,
    agent: 'hermit',
    title: 'Registry README: document probation model?',
    context: 'new-agent onboarding section. 2 paragraphs, no authority change.',
    options: [{
      label: 'Yes, write it',
      recommended: true
    }, {
      label: 'Skip for v1'
    }]
  }],
  log: [{
    time: '06:41',
    taskId: 'tp-0142',
    agent: 'reef-crab',
    kind: 'decision',
    text: 'used better-sqlite3 transactions for queue reorder — single writer, no locking needed',
    unread: true
  }, {
    time: '03:52',
    taskId: 'tp-0139',
    agent: 'anemone',
    kind: 'completion',
    text: 'criteria met — review of watchdog timer, findings → 1 repair task. handoff: PR #58',
    unread: true
  }, {
    time: '02:07',
    taskId: 'tp-0141',
    agent: 'reef-crab',
    kind: 'decision',
    text: 'chose YAML over TOML for authority profiles — matches workspaces.yaml',
    unread: true
  }, {
    time: '01:30',
    taskId: 'tp-0141',
    agent: 'reef-crab',
    kind: 'escalation',
    text: 'escalated: merge PR #58 → question tp-0143',
    unread: true
  }, {
    time: '23:58',
    taskId: 'tp-0138',
    agent: 'hermit',
    kind: 'completion',
    text: 'criteria met — workspaces.yaml documented, branch task/tp-0138',
    unread: false
  }],
  queue: [{
    id: 'tp-0144',
    title: 'Write board schema DDL',
    assignee: 'reef-crab'
  }, {
    id: 'tp-0146',
    title: 'Scaffold MCP server verbs',
    assignee: 'reef-crab',
    risk: true
  }, {
    id: 'tp-0147',
    title: 'Vite PWA shell + push subscription',
    assignee: 'hermit',
    skipped: true
  }, {
    id: 'tp-0150',
    title: 'Watchdog repair: clear stale timer on SIGKILL path',
    assignee: 'reef-crab'
  }],
  board: {
    todo: [{
      id: 'tp-0144',
      title: 'Write board schema DDL',
      type: 'work',
      assignee: 'reef-crab'
    }, {
      id: 'tp-0146',
      title: 'Scaffold MCP server verbs',
      type: 'work',
      assignee: 'reef-crab',
      risk: true
    }, {
      id: 'tp-0143',
      title: 'Merge PR #58? CI green',
      type: 'question',
      assignee: 'you',
      human: true
    }],
    in_progress: [{
      id: 'tp-0142',
      title: 'Queue reorder — fractional sort keys',
      type: 'work',
      assignee: 'reef-crab'
    }],
    blocked: [{
      id: 'tp-0141',
      title: 'Registry loader + agent.md parser',
      type: 'work',
      assignee: 'reef-crab',
      risk: true,
      children: 1
    }],
    done: [{
      id: 'tp-0139',
      title: 'Review watchdog timer implementation',
      type: 'review',
      assignee: 'anemone'
    }, {
      id: 'tp-0138',
      title: 'Document workspaces.yaml format',
      type: 'work',
      assignee: 'hermit'
    }, {
      id: 'tp-0136',
      title: 'Watchdog timer — kill + question after 2h',
      type: 'work',
      assignee: 'reef-crab'
    }, {
      id: 'tp-0135',
      title: 'agent.md template for the registry',
      type: 'work',
      assignee: 'hermit'
    }, {
      id: 'tp-0134',
      title: 'Tailscale serve config for the Pi',
      type: 'work',
      assignee: 'reef-crab'
    }, {
      id: 'tp-0132',
      title: 'Review escalation-path doc',
      type: 'review',
      assignee: 'anemone'
    }, {
      id: 'tp-0131',
      title: 'events table — append-only DDL',
      type: 'work',
      assignee: 'reef-crab'
    }]
  },
  humanTasks: [{
    id: 'tp-0145',
    title: 'Plug in the second SSD to the Pi',
    blocking: 'tp-0147'
  }]
};
window.tpData = tpData;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/tidepool-webui/data.js", error: String((e && e.message) || e) }); }

// ui_kits/tidepool-webui/queue-screen.jsx
try { (() => {
// TODO queue — ordering + manual intervention live here, plus "your tasks" (human list)

// Reorderable queue list — pointer-driven drag & drop with tidal FLIP animations.
// Reused by QueueScreen and the triage queue-check step.
function TpQueueList({
  tasks,
  baseIndex = 0,
  onReorder,
  onFront,
  gap = 6
}) {
  const {
    QueueItem
  } = window.TidepoolDesignSystem_8a0ead;
  const itemEls = React.useRef(new Map());
  const lastTops = React.useRef(new Map());
  const skipFlip = React.useRef(false);
  const drag = React.useRef(null);
  const [draggingId, setDraggingId] = React.useState(null);
  const orderKey = tasks.map(t => t.id).join('|');
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const setRef = id => el => {
    if (el) itemEls.current.set(id, el);else itemEls.current.delete(id);
  };
  const clearStyles = el => {
    el.style.transition = '';
    el.style.transform = '';
    el.style.zIndex = '';
    el.style.filter = '';
    el.style.pointerEvents = '';
  };

  // FLIP on order change — animates move-to-front, front-inserts, drag commits.
  React.useLayoutEffect(() => {
    const tops = new Map();
    tasks.forEach(t => {
      const el = itemEls.current.get(t.id);
      if (el) tops.set(t.id, el.getBoundingClientRect().top);
    });
    if (skipFlip.current) {
      // visuals already match final order (drag transforms) — clear silently
      itemEls.current.forEach(clearStyles);
      skipFlip.current = false;
    } else if (!reduced()) {
      tasks.forEach(t => {
        const el = itemEls.current.get(t.id);
        const last = lastTops.current.get(t.id);
        if (!el || last === undefined) return;
        const dy = last - tops.get(t.id);
        if (Math.abs(dy) < 1) return;
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
        el.getBoundingClientRect();
        el.style.transition = 'transform 420ms var(--ease-tidal)';
        el.style.transform = '';
        el.addEventListener('transitionend', () => clearStyles(el), {
          once: true
        });
      });
    }
    lastTops.current = tops;
  }, [orderKey]);
  const applyShifts = d => {
    tasks.forEach((t, j) => {
      if (j === d.index) return;
      const el = itemEls.current.get(t.id);
      if (!el) return;
      const off = j > d.index && j <= d.projected ? -d.shift : j < d.index && j >= d.projected ? d.shift : 0;
      el.style.transition = 'transform 260ms var(--ease-tidal)';
      el.style.transform = off ? `translateY(${off}px)` : '';
    });
  };
  const onPointerDown = (e, index, id) => {
    if (!onReorder || e.target.closest('button') || e.button > 0 || drag.current) return;
    const el = itemEls.current.get(id);
    if (!el) return;
    e.preventDefault();
    const d = {
      id,
      index,
      projected: index,
      startY: e.clientY,
      shift: el.getBoundingClientRect().height + gap
    };
    drag.current = d;
    setDraggingId(id);
    el.style.zIndex = 5;
    el.style.transition = 'none';
    el.style.filter = 'drop-shadow(0 6px 14px rgba(23,33,30,0.22))';
    // rows sliding under the cursor mid-drag must not take hover
    itemEls.current.forEach((other, oid) => {
      if (oid !== id) other.style.pointerEvents = 'none';
    });
    const onMove = ev => {
      const dy = ev.clientY - d.startY;
      el.style.transform = `translateY(${dy}px) scale(1.02)`;
      const p = Math.max(0, Math.min(tasks.length - 1, Math.round(d.index + dy / d.shift)));
      if (p !== d.projected) {
        d.projected = p;
        applyShifts(d);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const settle = (d.projected - d.index) * d.shift;
      el.style.transition = 'transform 300ms var(--ease-tidal), filter 300ms var(--ease-tidal)';
      el.style.transform = settle ? `translateY(${settle}px)` : '';
      el.style.filter = '';
      setTimeout(() => {
        drag.current = null;
        setDraggingId(null);
        if (d.projected === d.index) {
          itemEls.current.forEach(clearStyles);
        } else {
          const next = tasks.slice();
          const [moved] = next.splice(d.index, 1);
          next.splice(d.projected, 0, moved);
          skipFlip.current = true;
          onReorder(next, d.id, baseIndex + d.projected + 1);
        }
      }, reduced() ? 0 : 310);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap
    }
  }, tasks.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    ref: setRef(t.id),
    onPointerDown: e => onPointerDown(e, i, t.id),
    style: {
      touchAction: onReorder ? 'none' : undefined,
      cursor: onReorder ? draggingId === t.id ? 'grabbing' : 'grab' : undefined,
      userSelect: 'none',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(QueueItem, {
    position: baseIndex + i + 1,
    task: t,
    skipped: t.skipped,
    frontInserted: t.frontInserted,
    flash: t.flash,
    onFront: onFront && i > 0 ? () => onFront(t.id) : undefined
  }))));
}
function QueueScreen({
  data,
  onFront,
  onDoneHuman,
  onReorder
}) {
  const {
    Card,
    Button
  } = window.TidepoolDesignSystem_8a0ead;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 16px'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 'var(--text-xl)',
      margin: '0 0 2px'
    }
  }, "Queue"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-secondary)',
      margin: '0 0 16px'
    }
  }, "FIFO \xB7 new tasks append \xB7 reorder never resets \xB7 concurrency=1"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--tide-4)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em'
    }
  }, "slot"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-body)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, "tp-0142 \xB7 Queue reorder \u2014 fractional sort keys"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      flexShrink: 0
    }
  }, "next poll 08:00")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 2,
      background: 'var(--tide-4)',
      borderRadius: 1,
      marginBottom: 14
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement(TpQueueList, {
    tasks: data.queue,
    onReorder: onReorder,
    onFront: onFront
  })), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-lg)',
      margin: '0 0 2px'
    }
  }, "Your tasks"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-secondary)',
      margin: '0 0 12px'
    }
  }, "outside the queue \u2014 you have your own scheduler"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, data.humanTasks.length === 0 && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-muted)',
      margin: 0
    }
  }, "none."), data.humanTasks.map(t => /*#__PURE__*/React.createElement(Card, {
    key: t.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 14px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)'
    }
  }, t.id), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 'var(--text-sm)',
      fontWeight: 500,
      color: 'var(--text-heading)'
    }
  }, t.title), t.blocking && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--sun-4)'
    }
  }, "blocks ", t.blocking), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm",
    onClick: () => onDoneHuman(t.id)
  }, "Done")))));
}
Object.assign(window, {
  QueueScreen,
  TpQueueList
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/tidepool-webui/queue-screen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/tidepool-webui/register-screen.jsx
try { (() => {
// Task registration — brain dump → LLM drafts structured fields → confirm
function RegisterScreen({
  data,
  onRegister
}) {
  const {
    Button,
    Card,
    Input,
    Select,
    Checkbox
  } = window.TidepoolDesignSystem_8a0ead;
  const [dump, setDump] = React.useState('');
  const [drafted, setDrafted] = React.useState(false);
  const [risk, setRisk] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 16px'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 'var(--text-xl)',
      margin: '0 0 2px'
    }
  }, "Register"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-secondary)',
      margin: '0 0 16px'
    }
  }, "dump it \u2014 the LLM drafts the fields, you confirm"), /*#__PURE__*/React.createElement(Input, {
    multiline: true,
    rows: 4,
    placeholder: "what needs doing, in your own words \u2014 sloppy is fine here, sloppy completion criteria are not",
    value: dump,
    onChange: e => setDump(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 12
    }
  }), !drafted && /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    full: true,
    disabled: !dump.trim(),
    onClick: () => setDrafted(true)
  }, "Draft fields"), drafted && /*#__PURE__*/React.createElement(Card, {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--tide-4)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em'
    }
  }, "drafted \u2014 edit freely"), /*#__PURE__*/React.createElement(Input, {
    label: "Title",
    defaultValue: "Add usage-limit gate to hourly poll"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Purpose",
    multiline: true,
    rows: 2,
    defaultValue: "Stop starting tasks when any rate-limit window is rejected; resume at resets_at."
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Completion criteria",
    multiline: true,
    rows: 2,
    defaultValue: "rejected window \u2192 nothing starts; skipped shows in queue; immediate poll fires at reset. Covered by an integration test."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Select, {
    label: "Assignee",
    options: data.agents.map(a => a.name).concat('you'),
    defaultValue: "reef-crab"
  }), /*#__PURE__*/React.createElement(Select, {
    label: "Workspace",
    options: ['tidepool', 'registry', 'skills-fork'],
    defaultValue: "tidepool"
  })), /*#__PURE__*/React.createElement(Checkbox, {
    label: "risk flag \u2014 request on-completion review",
    checked: risk,
    onChange: () => setRisk(!risk)
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    full: true,
    onClick: () => {
      onRegister();
      setDrafted(false);
      setDump('');
      setRisk(false);
    }
  }, "Register \u2014 appends to queue tail")));
}
Object.assign(window, {
  RegisterScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/tidepool-webui/register-screen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/tidepool-webui/triage-screen.jsx
try { (() => {
// Triage flow — section 1 questions → section 2 log skim → section 3 queue check → commit
// Loaded as a text/babel script from index.html; components read from the DS bundle at render time.

function TpWaterline({
  progress
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 2,
      background: 'var(--rock-2)',
      position: 'relative',
      borderRadius: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: '0 auto 0 0',
      width: `${progress * 100}%`,
      background: 'var(--tide-4)',
      borderRadius: 1,
      transition: 'width var(--duration-slow) var(--ease-tidal)'
    }
  }));
}
function TpSegmentGauge({
  total,
  filled
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5
    }
  }, Array.from({
    length: total
  }).map((_, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      flex: 1,
      height: 6,
      borderRadius: 999,
      background: i < filled ? 'var(--tide-4)' : 'var(--tide-2)',
      transition: 'background var(--duration-calm) var(--ease-tidal)'
    }
  })));
}
function TpQuestionCard({
  q,
  answer,
  onAnswer
}) {
  const {
    Card,
    Input,
    AgentChip
  } = window.TidepoolDesignSystem_8a0ead;
  const [override, setOverride] = React.useState(false);
  return /*#__PURE__*/React.createElement(Card, {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)'
    }
  }, q.id), /*#__PURE__*/React.createElement(AgentChip, {
    name: q.agent,
    size: "sm"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-secondary)'
    }
  }, q.agent), q.parent && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      marginLeft: 'auto'
    }
  }, "blocks ", q.parent)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-md)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-heading)',
      marginBottom: 4
    }
  }, q.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-secondary)',
      marginBottom: 14
    }
  }, q.context), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, q.options.map(o => {
    const picked = answer === o.label;
    return /*#__PURE__*/React.createElement("button", {
      key: o.label,
      onClick: () => onAnswer(picked ? null : o.label),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        textAlign: 'left',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--text-sm)',
        fontWeight: picked ? 600 : 400,
        color: picked ? '#fff' : 'var(--text-body)',
        background: picked ? 'var(--tide-4)' : 'var(--surface-recessed)',
        border: 'none',
        boxShadow: picked ? 'var(--shadow-primary)' : 'none',
        borderRadius: 'var(--radius-full)',
        padding: '11px 18px',
        minHeight: 44,
        cursor: 'pointer',
        transition: 'background var(--duration-quick) var(--ease-tidal)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }, o.label), o.recommended && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-2xs)',
        color: picked ? 'var(--tide-2)' : 'var(--tide-4)'
      }
    }, "recommended"));
  }), override ? /*#__PURE__*/React.createElement(Input, {
    multiline: true,
    rows: 2,
    placeholder: "override answer \u2014 free text"
  }) : /*#__PURE__*/React.createElement("button", {
    onClick: () => setOverride(true),
    style: {
      background: 'none',
      border: 'none',
      color: 'var(--text-muted)',
      fontSize: 'var(--text-xs)',
      cursor: 'pointer',
      textAlign: 'left',
      padding: '2px 0'
    }
  }, "override with free text\u2026")));
}
function TriageScreen({
  data,
  onCommit,
  onReorderQueue,
  onFront
}) {
  const {
    Button,
    Input,
    LogEntry,
    QueueItem
  } = window.TidepoolDesignSystem_8a0ead;
  const [section, setSection] = React.useState(0);
  const [answers, setAnswers] = React.useState({});
  const [objections, setObjections] = React.useState({});
  const [objecting, setObjecting] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const answered = Object.values(answers).filter(Boolean).length;
  const unread = data.log.filter(l => l.unread);
  const progress = (section + (section === 0 ? answered / data.questions.length : 0)) / 3;
  const heads = [{
    step: '1 / 3 — questions',
    title: `The tide brought ${data.questions.length} questions.`,
    sub: 'answers apply at commit; parents return to the front of the queue.',
    next: answered === data.questions.length ? 'Log skim' : `Log skim (${data.questions.length - answered} unanswered)`
  }, {
    step: '2 / 3 — decision log',
    title: `${unread.length} decisions made overnight.`,
    sub: 'silence is consent — tap an entry to object.',
    next: 'Queue check'
  }, {
    step: '3 / 3 — queue',
    title: 'The tide is going out.',
    sub: 'front-inserted by this session highlighted. reorder is optional.',
    next: 'Commit'
  }];
  const cur = heads[section];
  return /*#__PURE__*/React.createElement("div", {
    key: section,
    style: {
      padding: '20px 16px 28px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-rise",
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--tide-4)',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      marginBottom: 8
    }
  }, cur.step), /*#__PURE__*/React.createElement("h1", {
    className: "tp-rise",
    style: {
      fontFamily: 'var(--font-display)',
      fontStyle: 'italic',
      fontSize: 'var(--text-2xl)',
      fontWeight: 400,
      color: 'var(--tide-5)',
      margin: '0 0 4px',
      lineHeight: 1.15,
      animationDelay: '60ms'
    }
  }, cur.title), /*#__PURE__*/React.createElement("p", {
    className: "tp-rise",
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-secondary)',
      margin: '0 0 20px',
      animationDelay: '120ms'
    }
  }, cur.sub), section === 0 ? /*#__PURE__*/React.createElement(TpSegmentGauge, {
    total: data.questions.length,
    filled: answered
  }) : /*#__PURE__*/React.createElement(TpWaterline, {
    progress: progress
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 20
    }
  }), section === 0 && /*#__PURE__*/React.createElement("div", null, data.questions.map((q, i) => /*#__PURE__*/React.createElement("div", {
    key: q.id,
    className: "tp-rise",
    style: {
      animationDelay: `${180 + i * 90}ms`
    }
  }, /*#__PURE__*/React.createElement(TpQuestionCard, {
    q: q,
    answer: answers[q.id],
    onAnswer: a => setAnswers({
      ...answers,
      [q.id]: a
    })
  })))), section === 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden'
    }
  }, data.log.map((l, i) => /*#__PURE__*/React.createElement("div", {
    key: i
  }, /*#__PURE__*/React.createElement(LogEntry, {
    entry: {
      ...l,
      objection: objections[i]
    },
    active: objecting === i,
    onObject: () => {
      setObjecting(objecting === i ? null : i);
      setDraft('');
    }
  }), objecting === i && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 12px',
      background: 'var(--coral-1)',
      display: 'flex',
      gap: 8,
      alignItems: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Input, {
    multiline: true,
    rows: 2,
    placeholder: "direction \u2014 steering, not rollback",
    value: draft,
    onChange: e => setDraft(e.target.value),
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "danger",
    size: "sm",
    disabled: !draft.trim(),
    onClick: () => {
      setObjections({
        ...objections,
        [objecting]: draft
      });
      setObjecting(null);
    }
  }, "Object"))))), section === 2 && (() => {
    const pending = Object.entries(answers).filter(([, a]) => a).map(([qid]) => data.questions.find(x => x.id === qid)).filter(q => q.parent).map(q => ({
      id: q.parent,
      title: `unblocked by ${q.id}`,
      assignee: q.agent,
      frontInserted: true
    }));
    if (Object.keys(objections).length > 0) {
      pending.push({
        id: 'tp-0151',
        title: `repair task — ${Object.keys(objections).length} objection${Object.keys(objections).length > 1 ? 's' : ''} bundled`,
        assignee: 'reef-crab',
        frontInserted: true
      });
    }
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6
      }
    }, pending.map((t, i) => /*#__PURE__*/React.createElement(QueueItem, {
      key: t.id,
      position: i + 1,
      task: t,
      frontInserted: true
    })), /*#__PURE__*/React.createElement(TpQueueList, {
      tasks: data.queue,
      baseIndex: pending.length,
      onReorder: onReorderQueue,
      onFront: onFront
    }));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 20
    }
  }, section > 0 && /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "lg",
    onClick: () => setSection(section - 1)
  }, "Back"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    full: true,
    onClick: () => section < 2 ? setSection(section + 1) : onCommit(answers, objections)
  }, cur.next)), section === 2 && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-muted)',
      textAlign: 'center',
      marginTop: 12
    }
  }, "commit applies everything in one transaction \xB7 immediate poll if slot free"));
}
Object.assign(window, {
  TriageScreen,
  TpQuestionCard,
  TpWaterline,
  TpSegmentGauge
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/tidepool-webui/triage-screen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/tidepool-webui/tweaks-panel.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
// Exports (to window): useTweaks, TweaksPanel, TweakSection, TweakRow, TweakSlider,
//   TweakToggle, TweakRadio, TweakSelect, TweakText, TweakNumber, TweakColor, TweakButton.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "palette": ["#D97757", "#29261b", "#f6f4ef"],
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        options={['#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0']}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakColor  label="Palette" value={t.palette}
//                        options={[['#D97757', '#29261b', '#f6f4ef'],
//                                  ['#475569', '#0f172a', '#f1f5f9']]}
//                        onChange={(v) => setTweak('palette', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// TweakRadio is the segmented control for 2–3 short options (auto-falls-back to
// TweakSelect past ~16/~10 chars per label); reach for TweakSelect directly when
// options are many or long. For color tweaks always curate 3-4 options rather than
// a free picker; an option can also be a whole 2–5 color palette (the stored value
// is the array). The Tweak* controls are a floor, not a ceiling — build custom
// controls inside the panel if a tweak calls for UI they don't cover.
/* END USAGE */
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null ? keyOrEdits : {
      [keyOrEdits]: val
    };
    setValues(prev => ({
      ...prev,
      ...edits
    }));
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits
    }, '*');
    // Same-window signal so in-page listeners (deck-stage rail thumbnails)
    // can react — the parent message only reaches the host, not peers.
    window.dispatchEvent(new CustomEvent('tweakchange', {
      detail: edits
    }));
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
function TweaksPanel({
  title = 'Tweaks',
  children
}) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({
    x: 16,
    y: 16
  });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth,
      h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = e => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({
      type: '__edit_mode_available'
    }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({
      type: '__edit_mode_dismissed'
    }, '*');
  };
  const onDragStart = e => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = ev => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  if (!open) return null;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, __TWEAKS_STYLE), /*#__PURE__*/React.createElement("div", {
    ref: dragRef,
    className: "twk-panel",
    "data-omelette-chrome": "",
    style: {
      right: offsetRef.current.x,
      bottom: offsetRef.current.y
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-hd",
    onMouseDown: onDragStart
  }, /*#__PURE__*/React.createElement("b", null, title), /*#__PURE__*/React.createElement("button", {
    className: "twk-x",
    "aria-label": "Close tweaks",
    onMouseDown: e => e.stopPropagation(),
    onClick: dismiss
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "twk-body"
  }, children)));
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "twk-sect"
  }, label), children);
}
function TweakRow({
  label,
  value,
  children,
  inline = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: inline ? 'twk-row twk-row-h' : 'twk-row'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label), value != null && /*#__PURE__*/React.createElement("span", {
    className: "twk-val"
  }, value)), children);
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label,
    value: `${value}${unit}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "twk-slider",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange(Number(e.target.value))
  }));
}
function TweakToggle({
  label,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-row twk-row-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "twk-toggle",
    "data-on": value ? '1' : '0',
    role: "switch",
    "aria-checked": !!value,
    onClick: () => onChange(!value)
  }, /*#__PURE__*/React.createElement("i", null)));
}
function TweakRadio({
  label,
  value,
  options,
  onChange
}) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  // Segments wrap mid-word once per-segment width runs out. The track is
  // ~248px (280 panel − 28 body pad − 4 seg pad), each button loses 12px
  // to its own padding, and 11.5px system-ui averages ~6.3px/char — so 2
  // options fit ~16 chars each, 3 fit ~10. Past that (or >3 options), fall
  // back to a dropdown rather than wrap.
  const labelLen = o => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({
    2: 16,
    3: 10
  }[options.length] ?? 0);
  if (!fitsAsSegments) {
    // <select> emits strings — map back to the original option value so the
    // fallback stays type-preserving (numbers, booleans) like the segment path.
    const resolve = s => {
      const m = options.find(o => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return /*#__PURE__*/React.createElement(TweakSelect, {
      label: label,
      value: value,
      options: options,
      onChange: s => onChange(resolve(s))
    });
  }
  const opts = options.map(o => typeof o === 'object' ? o : {
    value: o,
    label: o
  });
  const idx = Math.max(0, opts.findIndex(o => o.value === value));
  const n = opts.length;
  const segAt = clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = e => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = ev => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    ref: trackRef,
    role: "radiogroup",
    onPointerDown: onPointerDown,
    className: dragging ? 'twk-seg dragging' : 'twk-seg'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-seg-thumb",
    style: {
      left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
      width: `calc((100% - 4px) / ${n})`
    }
  }), opts.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "radio",
    "aria-checked": o.value === value
  }, o.label))));
}
function TweakSelect({
  label,
  value,
  options,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("select", {
    className: "twk-field",
    value: value,
    onChange: e => onChange(e.target.value)
  }, options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })));
}
function TweakText({
  label,
  value,
  placeholder,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("input", {
    className: "twk-field",
    type: "text",
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value)
  }));
}
function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange
}) {
  const clamp = n => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({
    x: 0,
    val: 0
  });
  const onScrubStart = e => {
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      val: value
    };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = ev => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-num"
  }, /*#__PURE__*/React.createElement("span", {
    className: "twk-num-lbl",
    onPointerDown: onScrubStart
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: value,
    min: min,
    max: max,
    step: step,
    onChange: e => onChange(clamp(Number(e.target.value)))
  }), unit && /*#__PURE__*/React.createElement("span", {
    className: "twk-num-unit"
  }, unit));
}

// Relative-luminance contrast pick — checkmarks drawn over a swatch need to
// read on both #111 and #fafafa without per-option configuration. Hex input
// only (#rgb / #rrggbb); named or rgb()/hsl() colors fall through to "light".
function __twkIsLight(hex) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}
const __TwkCheck = ({
  light
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 14 14",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 7.2 5.8 10 11 4.2",
  fill: "none",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  stroke: light ? 'rgba(0,0,0,.78)' : '#fff'
}));

// TweakColor — curated color/palette picker. Each option is either a single
// hex string or an array of 1-5 hex strings; the card adapts — a lone color
// renders solid, a palette renders colors[0] as the hero (left ~2/3) with the
// rest stacked in a sharp column on the right. onChange emits the
// option in the shape it was passed (string stays string, array stays array).
// Without options it falls back to the native color input for back-compat.
function TweakColor({
  label,
  value,
  options,
  onChange
}) {
  if (!options || !options.length) {
    return /*#__PURE__*/React.createElement("div", {
      className: "twk-row twk-row-h"
    }, /*#__PURE__*/React.createElement("div", {
      className: "twk-lbl"
    }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("input", {
      type: "color",
      className: "twk-swatch",
      value: value,
      onChange: e => onChange(e.target.value)
    }));
  }
  // Native <input type=color> emits lowercase hex per the HTML spec, so
  // compare case-insensitively. String() guards JSON.stringify(undefined),
  // which returns the primitive undefined (no .toLowerCase).
  const key = o => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-chips",
    role: "radiogroup"
  }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "twk-chip",
      role: "radio",
      "aria-checked": on,
      "data-on": on ? '1' : '0',
      "aria-label": colors.join(', '),
      title: colors.join(' · '),
      style: {
        background: hero
      },
      onClick: () => onChange(o)
    }, sup.length > 0 && /*#__PURE__*/React.createElement("span", null, sup.map((c, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        background: c
      }
    }))), on && /*#__PURE__*/React.createElement(__TwkCheck, {
      light: __twkIsLight(hero)
    }));
  })));
}
function TweakButton({
  label,
  onClick,
  secondary = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: secondary ? 'twk-btn secondary' : 'twk-btn',
    onClick: onClick
  }, label);
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/tidepool-webui/tweaks-panel.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Button = __ds_scope.Button;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.AgentChip = __ds_scope.AgentChip;

__ds_ns.LogEntry = __ds_scope.LogEntry;

__ds_ns.QueueItem = __ds_scope.QueueItem;

__ds_ns.RiskFlag = __ds_scope.RiskFlag;

__ds_ns.StatusBadge = __ds_scope.StatusBadge;

__ds_ns.TaskCard = __ds_scope.TaskCard;

__ds_ns.TypeBadge = __ds_scope.TypeBadge;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Toast = __ds_scope.Toast;

})();
