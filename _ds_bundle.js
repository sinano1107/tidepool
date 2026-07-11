/* @ds-bundle: {"format":4,"namespace":"TidepoolDesignSystem_8a0ead","components":[{"name":"Button","sourcePath":"components/actions/Button.jsx"},{"name":"IconButton","sourcePath":"components/actions/IconButton.jsx"},{"name":"AgentChip","sourcePath":"components/board/AgentChip.jsx"},{"name":"LogEntry","sourcePath":"components/board/LogEntry.jsx"},{"name":"QueueItem","sourcePath":"components/board/QueueItem.jsx"},{"name":"RiskFlag","sourcePath":"components/board/RiskFlag.jsx"},{"name":"StatusBadge","sourcePath":"components/board/StatusBadge.jsx"},{"name":"TaskCard","sourcePath":"components/board/TaskCard.jsx"},{"name":"TypeBadge","sourcePath":"components/board/TypeBadge.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Card","sourcePath":"components/surfaces/Card.jsx"},{"name":"Dialog","sourcePath":"components/surfaces/Dialog.jsx"},{"name":"Tag","sourcePath":"components/surfaces/Tag.jsx"},{"name":"Toast","sourcePath":"components/surfaces/Toast.jsx"}]} */

(() => {

const __ds_ns = (window.TidepoolDesignSystem_8a0ead = window.TidepoolDesignSystem_8a0ead || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/actions/Button.jsx
try { (() => {
const btnBase = {
  fontFamily: "var(--font-ui)",
  fontWeight: "var(--weight-semibold)",
  border: "none",
  borderRadius: "var(--radius-full)",
  cursor: "pointer",
  transition: "background var(--duration-quick) var(--ease-tidal), color var(--duration-quick) var(--ease-tidal), box-shadow var(--duration-quick) var(--ease-tidal)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
  whiteSpace: "nowrap"
};
const btnSizes = {
  sm: { fontSize: "var(--text-sm)", padding: "6px 14px", minHeight: "30px" },
  md: { fontSize: "var(--text-md)", padding: "9px 20px", minHeight: "38px" },
  lg: { fontSize: "var(--text-md)", padding: "11px 24px", minHeight: "44px" }
};
const btnVariants = {
  primary: { background: "var(--action-primary)", color: "#fff", boxShadow: "var(--shadow-primary)" },
  secondary: { background: "var(--surface-card)", color: "var(--tide-5)", boxShadow: "var(--shadow-raised)" },
  ghost: { background: "transparent", color: "var(--text-secondary)" },
  danger: { background: "var(--coral-1)", color: "var(--coral-4)" }
};
const btnHover = {
  primary: { background: "var(--action-primary-hover)" },
  secondary: { background: "var(--surface-hover)" },
  ghost: { background: "var(--surface-hover)", color: "var(--text-body)" },
  danger: { background: "var(--coral-2)" }
};
function Button({ variant = "primary", size = "md", full = false, disabled = false, children, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: disabled ? void 0 : onClick,
      disabled,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        ...btnBase,
        ...btnSizes[size],
        ...btnVariants[variant],
        ...hover && !disabled ? btnHover[variant] : {},
        ...full ? { width: "100%" } : {},
        ...disabled ? { opacity: 0.45, cursor: "default" } : {},
        ...style
      }
    },
    children
  );
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/Button.jsx", error: String((e && e.message) || e) }); }

// components/actions/IconButton.jsx
try { (() => {
function IconButton({ label, size = "md", variant = "ghost", disabled = false, children, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  const px = size === "sm" ? 28 : size === "lg" ? 44 : 36;
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      "aria-label": label,
      title: label,
      onClick: disabled ? void 0 : onClick,
      disabled,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        width: px,
        height: px,
        padding: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: "var(--radius-full)",
        boxShadow: variant === "outline" ? "var(--shadow-raised)" : "none",
        background: hover && !disabled ? "var(--surface-hover)" : variant === "outline" ? "var(--surface-card)" : "transparent",
        color: hover && !disabled ? "var(--text-body)" : "var(--text-secondary)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "background var(--duration-quick) var(--ease-tidal)",
        ...style
      }
    },
    children
  );
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/board/AgentChip.jsx
try { (() => {
const chipPalette = ["var(--tide-3)", "var(--sun-3)", "var(--coral-3)", "var(--grass-3)", "var(--rock-5)"];
const speciesIcons = { "reef-crab": "\u{1F980}", "anemone": "\u{1FAB8}", "hermit": "\u{1F41A}" };
function AgentChip({ name = "", human = false, size = "md", style }) {
  const px = size === "sm" ? 20 : 26;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = hash * 31 + name.charCodeAt(i) | 0;
  const species = human ? "\u{1F9CD}" : speciesIcons[name];
  const bg = species ? "var(--tide-1)" : chipPalette[Math.abs(hash) % chipPalette.length];
  const initials = name.split(/[-_ ]/).map((w) => w[0]).join("").slice(0, 2);
  return /* @__PURE__ */ React.createElement("span", { title: human ? "you" : name, style: { display: "inline-flex", alignItems: "center", gap: 6, ...style } }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true", style: {
    width: px,
    height: px,
    borderRadius: "50%",
    background: bg,
    color: "#fff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: species ? px * 0.58 : px * 0.42,
    fontWeight: 500,
    flexShrink: 0
  } }, species || initials), size !== "sm" && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-secondary)" } }, human ? "you" : name));
}
Object.assign(__ds_scope, { AgentChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/AgentChip.jsx", error: String((e && e.message) || e) }); }

// components/board/LogEntry.jsx
try { (() => {
const kindColors = {
  decision: "var(--text-body)",
  completion: "var(--grass-4)",
  escalation: "var(--sun-4)",
  objection: "var(--coral-4)"
};
function LogEntry({ entry = {}, onObject, active = false, style }) {
  const { time, taskId, agent, kind = "decision", text, objection, unread = false } = entry;
  const completion = kind === "completion";
  const clickable = !!onObject && !objection;
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "tp-log-entry",
      "data-clickable": clickable ? "" : void 0,
      "data-active": active ? "" : void 0,
      onClick: clickable ? onObject : void 0,
      role: clickable ? "button" : void 0,
      tabIndex: clickable ? 0 : void 0,
      onKeyDown: clickable ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onObject();
        }
      } : void 0,
      style: {
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        background: completion ? "var(--grass-1)" : void 0,
        borderBottom: "1px solid var(--border-hairline)",
        borderLeft: unread ? "2px solid var(--tide-4)" : "2px solid transparent",
        ...style
      }
    },
    /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", paddingTop: 2, flexShrink: 0 } }, time),
    /* @__PURE__ */ React.createElement(__ds_scope.AgentChip, { name: agent, size: "sm", style: { paddingTop: 1 } }),
    /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: kindColors[kind], lineHeight: "var(--leading-normal)" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginRight: 6 } }, taskId), completion && /* @__PURE__ */ React.createElement("strong", { style: { fontWeight: "var(--weight-semibold)", marginRight: 4 } }, "done \u2014"), text), objection && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 6, padding: "6px 10px", background: "var(--coral-1)", borderRadius: "var(--radius-xs)", fontSize: "var(--text-xs)", color: "var(--coral-4)" } }, "objection: ", objection)),
    active && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--coral-4)", paddingTop: 3, flexShrink: 0 } }, "objecting\u2026")
  );
}
Object.assign(__ds_scope, { LogEntry });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/LogEntry.jsx", error: String((e && e.message) || e) }); }

// components/board/QueueItem.jsx
try { (() => {
function QueueItem({ position, task = {}, skipped = false, frontInserted = false, flash = false, onFront, style }) {
  const { id, title, assignee } = task;
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "tp-queue-item",
      "data-front": flash ? "" : void 0,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 18px",
        border: skipped ? "1px dashed var(--rock-3)" : "none",
        boxShadow: skipped ? "none" : "var(--shadow-card)",
        borderRadius: "var(--radius-full)",
        opacity: skipped ? 0.65 : 1,
        ...style
      }
    },
    /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true", style: { color: "var(--rock-3)", cursor: "grab", fontSize: 14, lineHeight: 1, letterSpacing: "-2px" } }, "\u283F"),
    /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", background: frontInserted ? "var(--surface-card)" : "var(--tide-1)", borderRadius: "var(--radius-full)", padding: "2px 8px", flexShrink: 0 } }, position),
    /* @__PURE__ */ React.createElement(
      "span",
      {
        title: id,
        style: {
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-muted)",
          flexShrink: 0,
          maxWidth: "9ch",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis"
        }
      },
      id
    ),
    /* @__PURE__ */ React.createElement("span", { style: { flex: 1, fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, title),
    task.risk && /* @__PURE__ */ React.createElement(__ds_scope.RiskFlag, null),
    skipped && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--status-skipped-fg)" } }, "skipped \xB7 resumes on reset"),
    frontInserted && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)" } }, "front-inserted"),
    /* @__PURE__ */ React.createElement(__ds_scope.AgentChip, { name: assignee, size: "sm" }),
    onFront && !skipped && /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "tp-queue-front-btn",
        onClick: onFront,
        title: "Move to front",
        style: {
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-xs)",
          color: "var(--tide-4)",
          background: "var(--tide-1)",
          border: "none",
          borderRadius: "var(--radius-full)",
          padding: "4px 10px",
          cursor: "pointer",
          flexShrink: 0
        }
      },
      "\u2191"
    )
  );
}
Object.assign(__ds_scope, { QueueItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/QueueItem.jsx", error: String((e && e.message) || e) }); }

// components/board/RiskFlag.jsx
try { (() => {
function RiskFlag({ style }) {
  return /* @__PURE__ */ React.createElement("span", { style: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-medium)",
    color: "var(--risk-fg)",
    background: "var(--risk-bg)",
    padding: "2px 8px",
    borderRadius: "var(--radius-xs)",
    whiteSpace: "nowrap",
    ...style
  } }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true" }, "\u26A0"), " risk");
}
Object.assign(__ds_scope, { RiskFlag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/RiskFlag.jsx", error: String((e && e.message) || e) }); }

// components/board/StatusBadge.jsx
try { (() => {
const statusStyles = {
  todo: { color: "var(--status-todo-fg)", background: "var(--status-todo-bg)", boxShadow: "0 2px 8px rgba(29, 106, 102, 0.10)" },
  in_progress: { color: "var(--status-inprogress-fg)", background: "var(--status-inprogress-bg)" },
  blocked: { color: "var(--status-blocked-fg)", background: "var(--status-blocked-bg)" },
  done: { color: "var(--status-done-fg)", background: "var(--status-done-bg)" },
  cancelled: { color: "var(--status-cancelled-fg)", background: "var(--status-cancelled-bg)", textDecoration: "line-through" },
  skipped: { color: "var(--status-skipped-fg)", background: "transparent", border: "1px dashed var(--rock-3)" }
};
function StatusBadge({ status = "todo", style }) {
  return /* @__PURE__ */ React.createElement("span", { style: {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-medium)",
    padding: "3px 12px",
    borderRadius: "var(--radius-full)",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    ...statusStyles[status],
    ...style
  } }, status);
}
Object.assign(__ds_scope, { StatusBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/StatusBadge.jsx", error: String((e && e.message) || e) }); }

// components/board/TaskCard.jsx
try { (() => {
function TaskCard({ task = {}, onClick, style }) {
  const { id, title, status = "todo", type = "work", assignee, human = false, risk = false, children: childCount = 0 } = task;
  const [hover, setHover] = React.useState(false);
  const cancelled = status === "cancelled";
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      onClick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        background: hover ? "var(--surface-hover)" : "var(--surface-card)",
        border: "none",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-card)",
        padding: "14px 16px",
        cursor: onClick ? "pointer" : "default",
        transition: "background var(--duration-quick) var(--ease-tidal)",
        ...style
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" } }, id), /* @__PURE__ */ React.createElement(__ds_scope.TypeBadge, { type, showLabel: false }), risk && /* @__PURE__ */ React.createElement(__ds_scope.RiskFlag, { style: { marginLeft: "auto" } })),
    /* @__PURE__ */ React.createElement("div", { style: {
      fontSize: "var(--text-sm)",
      fontWeight: "var(--weight-medium)",
      color: cancelled ? "var(--text-muted)" : "var(--text-heading)",
      textDecoration: cancelled ? "line-through" : "none",
      marginBottom: 10,
      lineHeight: "var(--leading-tight)"
    } }, title),
    /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 6, minWidth: 0 } }, /* @__PURE__ */ React.createElement(__ds_scope.AgentChip, { name: assignee, human, size: "sm" }), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1 } }, human ? "you" : assignee), childCount > 0 && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--sun-4)", whiteSpace: "nowrap" } }, childCount, " open child", childCount > 1 ? "ren" : ""), /* @__PURE__ */ React.createElement(__ds_scope.StatusBadge, { status, style: { marginLeft: "auto" } }))
  );
}
Object.assign(__ds_scope, { TaskCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TaskCard.jsx", error: String((e && e.message) || e) }); }

// components/board/TypeBadge.jsx
try { (() => {
const typeStyles = {
  work: { color: "var(--type-work-fg)", symbol: "\u25CF" },
  question: { color: "var(--type-question-fg)", symbol: "?" },
  review: { color: "var(--type-review-fg)", symbol: "\u25CD" }
};
function TypeBadge({ type = "work", showLabel = true, style }) {
  const t = typeStyles[type];
  return /* @__PURE__ */ React.createElement("span", { style: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    color: t.color,
    whiteSpace: "nowrap",
    ...style
  } }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true", style: { fontSize: 10 } }, t.symbol), showLabel && type);
}
Object.assign(__ds_scope, { TypeBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TypeBadge.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function Checkbox({ label, checked = false, onChange, disabled = false, style }) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "inline-flex", alignItems: "center", gap: 9, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, ...style } }, /* @__PURE__ */ React.createElement("span", { style: {
    width: 18,
    height: 18,
    flexShrink: 0,
    boxSizing: "border-box",
    borderRadius: "var(--radius-xs)",
    border: `1.5px solid ${checked ? "var(--tide-4)" : "var(--border-default)"}`,
    background: checked ? "var(--tide-4)" : "var(--surface-card)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background var(--duration-quick) var(--ease-tidal), border-color var(--duration-quick) var(--ease-tidal)"
  } }, checked && /* @__PURE__ */ React.createElement("svg", { width: "11", height: "11", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d: "M2.5 6.5L5 9L9.5 3.5", stroke: "#fff", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }))), /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked, onChange, disabled, style: { position: "absolute", opacity: 0, width: 0, height: 0 } }), label && /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-sm)", color: "var(--text-body)" } }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
const fieldLabel = {
  display: "block",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--text-body)",
  marginBottom: "6px"
};
function Input({ label, hint, error, multiline = false, mono = false, value, defaultValue, onChange, placeholder, rows = 3, disabled = false, style }) {
  const [focus, setFocus] = React.useState(false);
  const shared = {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
    fontSize: "var(--text-md)",
    color: "var(--text-body)",
    background: disabled ? "var(--surface-recessed)" : "var(--surface-card)",
    border: `1px solid ${error ? "var(--coral-3)" : focus ? "var(--border-focus)" : "var(--border-default)"}`,
    borderRadius: "var(--radius-sm)",
    padding: "9px 12px",
    outline: "none",
    boxShadow: focus ? "var(--shadow-focus)" : "none",
    transition: "box-shadow var(--duration-quick) var(--ease-tidal), border-color var(--duration-quick) var(--ease-tidal)",
    resize: multiline ? "vertical" : void 0
  };
  const Tag = multiline ? "textarea" : "input";
  return /* @__PURE__ */ React.createElement("label", { style: { display: "block", ...style } }, label && /* @__PURE__ */ React.createElement("span", { style: fieldLabel }, label), /* @__PURE__ */ React.createElement(
    Tag,
    {
      value,
      defaultValue,
      placeholder,
      disabled,
      rows: multiline ? rows : void 0,
      onChange,
      onFocus: () => setFocus(true),
      onBlur: () => setFocus(false),
      style: shared
    }
  ), error ? /* @__PURE__ */ React.createElement("span", { style: { display: "block", marginTop: 5, fontSize: "var(--text-xs)", color: "var(--coral-4)" } }, error) : hint && /* @__PURE__ */ React.createElement("span", { style: { display: "block", marginTop: 5, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function Select({ label, options = [], value, onChange, disabled = false, style }) {
  const [focus, setFocus] = React.useState(false);
  return /* @__PURE__ */ React.createElement("label", { style: { display: "block", ...style } }, label && /* @__PURE__ */ React.createElement("span", { style: { display: "block", fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-body)", marginBottom: 6 } }, label), /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement(
    "select",
    {
      value,
      onChange,
      disabled,
      onFocus: () => setFocus(true),
      onBlur: () => setFocus(false),
      style: {
        width: "100%",
        boxSizing: "border-box",
        appearance: "none",
        WebkitAppearance: "none",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-md)",
        color: "var(--text-body)",
        background: disabled ? "var(--surface-recessed)" : "var(--surface-card)",
        border: `1px solid ${focus ? "var(--border-focus)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-sm)",
        padding: "9px 32px 9px 12px",
        outline: "none",
        boxShadow: focus ? "var(--shadow-focus)" : "none",
        cursor: "pointer",
        transition: "box-shadow var(--duration-quick) var(--ease-tidal)"
      }
    },
    options.map((o) => {
      const opt = typeof o === "string" ? { value: o, label: o } : o;
      return /* @__PURE__ */ React.createElement("option", { key: opt.value, value: opt.value }, opt.label);
    })
  ), /* @__PURE__ */ React.createElement("span", { style: { position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-muted)", fontSize: 10 } }, "\u25BE")));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function Switch({ label, checked = false, onChange, disabled = false, style }) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "inline-flex", alignItems: "center", gap: 10, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, ...style } }, /* @__PURE__ */ React.createElement(
    "span",
    {
      role: "switch",
      "aria-checked": checked,
      onClick: disabled ? void 0 : () => onChange && onChange(!checked),
      style: {
        width: 36,
        height: 21,
        borderRadius: "var(--radius-full)",
        flexShrink: 0,
        background: checked ? "var(--tide-4)" : "var(--rock-3)",
        position: "relative",
        transition: "background var(--duration-quick) var(--ease-tidal)"
      }
    },
    /* @__PURE__ */ React.createElement("span", { style: {
      position: "absolute",
      top: 2.5,
      left: checked ? 18 : 2.5,
      width: 16,
      height: 16,
      borderRadius: "50%",
      background: "#fff",
      boxShadow: "0 1px 2px rgba(23,33,30,0.2)",
      transition: "left var(--duration-quick) var(--ease-tidal)"
    } })
  ), label && /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-sm)", color: "var(--text-body)" } }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Card.jsx
try { (() => {
function Card({ children, padding = "var(--space-4)", interactive = false, selected = false, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      onClick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        background: interactive && hover ? "var(--surface-hover)" : "var(--surface-card)",
        border: "none",
        boxShadow: selected ? "var(--shadow-focus), var(--shadow-card)" : "var(--shadow-card)",
        borderRadius: "var(--radius-lg)",
        padding,
        cursor: interactive ? "pointer" : "default",
        transition: "background var(--duration-quick) var(--ease-tidal), box-shadow var(--duration-quick) var(--ease-tidal)",
        ...style
      }
    },
    children
  );
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Card.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Dialog.jsx
try { (() => {
function Dialog({ open = true, title, children, footer, onClose, width = 420 }) {
  if (!open) return null;
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      onClick: onClose,
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(23, 33, 30, 0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)"
      }
    },
    /* @__PURE__ */ React.createElement(
      "div",
      {
        role: "dialog",
        "aria-modal": "true",
        onClick: (e) => e.stopPropagation(),
        style: {
          width: "100%",
          maxWidth: width,
          boxSizing: "border-box",
          background: "var(--surface-card)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-overlay)",
          padding: "var(--space-6)"
        }
      },
      title && /* @__PURE__ */ React.createElement("h2", { style: { margin: "0 0 var(--space-3)", fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" } }, title),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-md)", color: "var(--text-body)" } }, children),
      footer && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-6)" } }, footer)
    )
  );
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Tag.jsx
try { (() => {
const tagColors = {
  neutral: { color: "var(--rock-5)", background: "var(--rock-1)" },
  tide: { color: "var(--tide-4)", background: "var(--tide-1)" },
  sun: { color: "var(--sun-4)", background: "var(--sun-1)" },
  coral: { color: "var(--coral-4)", background: "var(--coral-1)" },
  grass: { color: "var(--grass-4)", background: "var(--grass-1)" }
};
function Tag({ color = "neutral", mono = false, children, style }) {
  return /* @__PURE__ */ React.createElement("span", { style: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-medium)",
    padding: "3px 10px",
    borderRadius: "var(--radius-full)",
    whiteSpace: "nowrap",
    ...tagColors[color],
    ...style
  } }, children);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Tag.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Toast.jsx
try { (() => {
const toastKinds = {
  info: { border: "var(--tide-3)", icon: "var(--tide-4)" },
  success: { border: "var(--grass-2)", icon: "var(--grass-3)" },
  warn: { border: "var(--sun-2)", icon: "var(--sun-3)" },
  danger: { border: "var(--coral-2)", icon: "var(--coral-3)" }
};
function Toast({ kind = "info", children, detail, onDismiss, style }) {
  const k = toastKinds[kind];
  return /* @__PURE__ */ React.createElement("div", { style: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "var(--surface-card)",
    color: "var(--text-heading)",
    borderRadius: "var(--radius-full)",
    boxShadow: "var(--shadow-overlay)",
    padding: "12px 18px",
    maxWidth: 420,
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    ...style
  } }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true", style: { width: 8, height: 8, borderRadius: "50%", background: k.icon, marginTop: 6, flexShrink: 0 } }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", null, children), detail && /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 3, fontWeight: 400 } }, detail)), onDismiss && /* @__PURE__ */ React.createElement("button", { onClick: onDismiss, "aria-label": "Dismiss", style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1, alignSelf: "center", flexShrink: 0 } }, "\u2715"));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Toast.jsx", error: String((e && e.message) || e) }); }

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
