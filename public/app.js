// ui_kits/tidepool-webui/queue-screen.jsx
function TpQueueList({ tasks, baseIndex = 0, onReorder, onFront, skipReason, headId, gap = 6 }) {
  const { QueueItem } = window.TidepoolDesignSystem_8a0ead;
  const itemEls = React.useRef(/* @__PURE__ */ new Map());
  const lastTops = React.useRef(/* @__PURE__ */ new Map());
  const skipFlip = React.useRef(false);
  const drag = React.useRef(null);
  const [draggingId, setDraggingId] = React.useState(null);
  const orderKey = tasks.map((t) => t.id).join("|");
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const setRef = (id) => (el) => {
    if (el) itemEls.current.set(id, el);
    else itemEls.current.delete(id);
  };
  const clearStyles = (el) => {
    el.style.transition = "";
    el.style.transform = "";
    el.style.zIndex = "";
    el.style.filter = "";
    el.style.pointerEvents = "";
  };
  React.useLayoutEffect(() => {
    const tops = /* @__PURE__ */ new Map();
    tasks.forEach((t) => {
      const el = itemEls.current.get(t.id);
      if (el) tops.set(t.id, el.getBoundingClientRect().top);
    });
    if (skipFlip.current) {
      itemEls.current.forEach(clearStyles);
      skipFlip.current = false;
    } else if (!reduced()) {
      tasks.forEach((t) => {
        const el = itemEls.current.get(t.id);
        const last = lastTops.current.get(t.id);
        if (!el || last === void 0) return;
        const dy = last - tops.get(t.id);
        if (Math.abs(dy) < 1) return;
        el.style.transition = "none";
        el.style.transform = `translateY(${dy}px)`;
        el.getBoundingClientRect();
        el.style.transition = "transform 420ms var(--ease-tidal)";
        el.style.transform = "";
        el.addEventListener("transitionend", () => clearStyles(el), { once: true });
      });
    }
    lastTops.current = tops;
  }, [orderKey]);
  const applyShifts = (d) => {
    tasks.forEach((t, j) => {
      if (j === d.index) return;
      const el = itemEls.current.get(t.id);
      if (!el) return;
      const off = j > d.index && j <= d.projected ? -d.shift : j < d.index && j >= d.projected ? d.shift : 0;
      el.style.transition = "transform 260ms var(--ease-tidal)";
      el.style.transform = off ? `translateY(${off}px)` : "";
    });
  };
  const onPointerDown = (e, index, id) => {
    if (!onReorder || e.target.closest("button") || e.button > 0 || drag.current) return;
    const el = itemEls.current.get(id);
    if (!el) return;
    e.preventDefault();
    const d = { id, index, projected: index, startY: e.clientY, shift: el.getBoundingClientRect().height + gap };
    drag.current = d;
    setDraggingId(id);
    el.style.zIndex = 5;
    el.style.transition = "none";
    el.style.filter = "drop-shadow(0 6px 14px rgba(23,33,30,0.22))";
    itemEls.current.forEach((other, oid) => {
      if (oid !== id) other.style.pointerEvents = "none";
    });
    const onMove = (ev) => {
      const dy = ev.clientY - d.startY;
      el.style.transform = `translateY(${dy}px) scale(1.02)`;
      const p = Math.max(0, Math.min(tasks.length - 1, Math.round(d.index + dy / d.shift)));
      if (p !== d.projected) {
        d.projected = p;
        applyShifts(d);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const settle = (d.projected - d.index) * d.shift;
      el.style.transition = "transform 300ms var(--ease-tidal), filter 300ms var(--ease-tidal)";
      el.style.transform = settle ? `translateY(${settle}px)` : "";
      el.style.filter = "";
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
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap } }, tasks.map((t, i) => /* @__PURE__ */ React.createElement(
    "div",
    {
      key: t.id,
      ref: setRef(t.id),
      onPointerDown: (e) => onPointerDown(e, i, t.id),
      title: t.blocked ? "blocked \u2014 the slot skips this row until its children finish" : void 0,
      style: {
        touchAction: onReorder ? "none" : void 0,
        cursor: onReorder ? draggingId === t.id ? "grabbing" : "grab" : void 0,
        userSelect: "none",
        position: "relative",
        // derived-blocked rows hold their queue position (the slot skips
        // them until the children finish) — hiding them would let the
        // displayed order lie about where a drop actually lands
        opacity: t.blocked ? 0.55 : void 0
      }
    },
    /* @__PURE__ */ React.createElement(QueueItem, { position: baseIndex + i + 1, task: t, skipped: t.skipped, skipReason, frontInserted: t.frontInserted, flash: t.flash, isHead: t.id === headId, draggable: !!onReorder, onFront: onFront ? () => onFront(t.id) : void 0 })
  )));
}
const TP_SLOT_STATES = {
  busy: { color: "var(--tide-4)", line: "tp-0142 \xB7 Queue reorder \u2014 fractional sort keys", meta: "next poll 08:00" },
  free: { color: "var(--rock-3)", line: "slot free \u2014 nothing running", meta: "next poll 08:00" },
  warning: { color: "var(--sun-4)", line: "close to limit \xB7 finishing tp-0142, starting nothing new", meta: "per Anthropic threshold" },
  limit: { color: "var(--coral-4)", line: "usage limit \xB7 nothing starts", meta: "resumes 06:12 \xB7 immediate poll at reset" }
};
function pausedSlot(underlyingSlot) {
  return {
    color: "var(--rock-4)",
    line: underlyingSlot?.taskId ? "pickup paused \xB7 task finishes, nothing new starts" : "pickup paused \u2014 nothing starts until resumed",
    meta: "poll idle",
    taskId: underlyingSlot?.taskId ?? null
  };
}
function QueueScreen({ data, slotState = "busy", wsAlert = false, paused = false, onTogglePause, spendDown = null, onSpendDown, onFront, onDoneHuman, onReorder }) {
  const { Card, Button, IdChip } = window.TidepoolDesignSystem_8a0ead;
  const underlyingSlot = data.slot || TP_SLOT_STATES[slotState] || TP_SLOT_STATES.busy;
  const slot = paused ? pausedSlot(underlyingSlot) : underlyingSlot;
  const throttled = !paused && slotState === "limit";
  const skipReason = paused ? "pickup paused" : data.throttleFailClosed ? "usage check unavailable" : data.throttleResumesAt ? `resumes ${data.throttleResumesAt}` : "resumes on reset";
  const alert = wsAlert ? data.workspaceAlert : null;
  const headId = data.queue[0]?.id ?? null;
  const queue = paused || throttled ? data.queue.map((t) => ({ ...t, skipped: true })) : data.queue;
  React.useEffect(() => {
    lucide.createIcons();
  });
  return /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-xl)", margin: "0 0 2px" } }, "Queue"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 16px" } }, "FIFO \xB7 new tasks append \xB7 reorder never resets \xB7 concurrency=1"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, minHeight: 30 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: slot.color, textTransform: "uppercase", letterSpacing: "0.08em" } }, "slot"), slot.taskId && /* @__PURE__ */ React.createElement(IdChip, { id: slot.taskId, style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", flexShrink: 0 } }), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, minWidth: 0, fontSize: "var(--text-sm)", color: !paused && slotState === "free" ? "var(--text-muted)" : "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, slot.line), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", flexShrink: 0 } }, slot.meta), onTogglePause && /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: onTogglePause,
      "aria-pressed": paused,
      "aria-label": paused ? "resume pickup" : "pause pickup",
      title: paused ? "resume pickup \u2014 fires an immediate poll" : "pause pickup \u2014 running task finishes, nothing new starts",
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: 28,
        height: 28,
        color: paused ? "#fff" : "var(--tide-4)",
        background: paused ? "var(--tide-4)" : "var(--surface-card)",
        border: "none",
        borderRadius: "var(--radius-full)",
        padding: 0,
        boxShadow: paused ? "var(--shadow-primary)" : "var(--shadow-card)",
        cursor: "pointer",
        transition: "background 120ms var(--ease-tidal), color 120ms var(--ease-tidal)"
      }
    },
    /* @__PURE__ */ React.createElement("span", { key: paused ? "play" : "pause", style: { display: "inline-flex", width: 13, height: 13 } }, /* @__PURE__ */ React.createElement("i", { "data-lucide": paused ? "play" : "pause", style: { width: 13, height: 13 } }))
  )), /* @__PURE__ */ React.createElement("div", { style: {
    height: 2,
    borderRadius: 1,
    marginBottom: 14,
    background: paused ? "repeating-linear-gradient(90deg, var(--rock-3) 0 8px, transparent 8px 14px)" : slot.color
  } }), onSpendDown && (spendDown ? /* @__PURE__ */ React.createElement("div", { key: "spend-down-active", style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", marginBottom: 14, background: "var(--sun-1)", border: "1px solid var(--sun-2)", borderRadius: "var(--radius-md)" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", width: 13, height: 13, color: "var(--sun-4)", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("i", { "data-lucide": "flame", style: { width: 13, height: 13 } })), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, minWidth: 0, fontSize: "var(--text-sm)", color: "var(--text-body)" } }, "spend-down \xB7 burning the ", /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)" } }, spendDown.window), " budget to the 100% cap"), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", flexShrink: 0 } }, "expires at reset"), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "sm", onClick: () => onSpendDown(null) }, "cancel")) : /* @__PURE__ */ React.createElement("div", { key: "spend-down-idle", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "spend-down"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, minWidth: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "burn what's left of a window before it expires"), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "sm", onClick: () => onSpendDown("session") }, "session"), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "sm", onClick: () => onSpendDown("week") }, "week"))), alert && /* @__PURE__ */ React.createElement(Card, { style: { background: "var(--coral-1)", border: "1px solid var(--coral-2)", padding: "12px 14px", marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--coral-4)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "workspace needs human"), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginLeft: "auto" } }, alert.workspace)), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--text-body)", marginBottom: 4 } }, alert.reason), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-xs)", color: "var(--text-secondary)" } }, "pickup paused for ", alert.held.join(", "), " \xB7 see question ", alert.question)), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 28 } }, /* @__PURE__ */ React.createElement(TpQueueList, { tasks: queue, onReorder, onFront, skipReason, headId })), /* @__PURE__ */ React.createElement("h2", { style: { fontSize: "var(--text-lg)", margin: "0 0 2px" } }, "Your tasks"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 12px" } }, "outside the queue \u2014 you have your own scheduler"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, data.humanTasks.length === 0 && /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-muted)", margin: 0 } }, "none."), data.humanTasks.map((t) => /* @__PURE__ */ React.createElement(Card, { key: t.id, style: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" } }, t.id), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-heading)" } }, t.title), t.blocking && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--sun-4)" } }, "blocks ", t.blocking), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "sm", onClick: () => onDoneHuman(t.id) }, "Done")))));
}
Object.assign(window, { QueueScreen, TpQueueList });

// ui_kits/tidepool-webui/triage-screen.jsx
function TpWaterline({ progress }) {
  return /* @__PURE__ */ React.createElement("div", { style: { height: 2, background: "var(--rock-2)", position: "relative", borderRadius: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: "0 auto 0 0", width: `${progress * 100}%`, background: "var(--tide-4)", borderRadius: 1, transition: "width var(--duration-slow) var(--ease-tidal)" } }));
}
function TpSegmentGauge({ total, filled }) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 5 } }, Array.from({ length: total }).map((_, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { flex: 1, height: 6, borderRadius: 999, background: i < filled ? "var(--tide-4)" : "var(--tide-2)", transition: "background var(--duration-calm) var(--ease-tidal)" } })));
}
function TpQuestionItemPicker({ item, value, locked, onChange, translated }) {
  const { Input, Button } = window.TidepoolDesignSystem_8a0ead;
  const [override, setOverride] = React.useState(false);
  const [overrideText, setOverrideText] = React.useState("");
  return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", marginBottom: item.detail ? 3 : 8, whiteSpace: "pre-wrap" } }, item.title), translated && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--tide-5)", marginBottom: item.detail ? 3 : 8, whiteSpace: "pre-wrap" } }, translated.title), item.detail && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginBottom: 8, whiteSpace: "pre-wrap" } }, item.detail), translated && item.detail && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-xs)", color: "var(--tide-5)", marginBottom: 8, whiteSpace: "pre-wrap" } }, translated.detail), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, item.options.map((o) => {
    const picked = value === o.label;
    return /* @__PURE__ */ React.createElement(
      "button",
      {
        key: o.label,
        onClick: () => !locked && onChange(picked ? null : o.label),
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          textAlign: "left",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-sm)",
          fontWeight: picked ? 600 : 400,
          color: picked ? "#fff" : "var(--text-body)",
          background: picked ? "var(--tide-4)" : "var(--surface-recessed)",
          border: "none",
          boxShadow: picked ? "var(--shadow-primary)" : "none",
          borderRadius: "var(--radius-full)",
          padding: "11px 18px",
          minHeight: 44,
          cursor: locked ? "default" : "pointer",
          opacity: locked && !picked ? 0.45 : 1,
          transition: "background var(--duration-quick) var(--ease-tidal)"
        }
      },
      /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }, o.label),
      o.recommended && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: picked ? "var(--tide-2)" : "var(--tide-4)" } }, "recommended")
    );
  }), locked && value && !item.options.some((o) => o.label === value) && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "#fff", background: "var(--tide-4)", borderRadius: "var(--radius-full)", padding: "11px 18px", boxShadow: "var(--shadow-primary)" } }, value), locked ? null : override ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "flex-end" } }, /* @__PURE__ */ React.createElement(Input, { multiline: true, rows: 2, placeholder: "override answer \u2014 free text", value: overrideText, onChange: (e) => setOverrideText(e.target.value), style: { flex: 1 } }), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "sm", disabled: !overrideText.trim(), onClick: () => {
    onChange(overrideText.trim());
    setOverride(false);
    setOverrideText("");
  } }, "Set")) : /* @__PURE__ */ React.createElement("button", { onClick: () => setOverride(true), style: { background: "none", border: "none", color: "var(--text-muted)", fontSize: "var(--text-xs)", cursor: "pointer", textAlign: "left", padding: "2px 0" } }, "override with free text\u2026")));
}
function runTranslate(onTranslate, target, setState, opts) {
  setState({ status: "loading" });
  onTranslate(target, opts && opts.signal ? { signal: opts.signal } : void 0).then(setState).catch((err) => {
    if (err && err.name === "AbortError") {
      if (opts && opts.onAbort) opts.onAbort();
      return;
    }
    setState({ status: "error", message: String(err.message || err) });
  });
}
function TpTranslationNote({ result }) {
  if (result.status === "loading") return /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, "\u2026");
  if (result.status === "throttled") {
    return /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-xs)", color: "var(--sun-4)" } }, "\u3044\u307E\u306F usage limit \u3067\u8A33\u3092\u6DFB\u3048\u3089\u308C\u307E\u305B\u3093 \u2014 \u539F\u6587\u306E\u307F");
  }
  return /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-xs)", color: "var(--coral-4)" } }, result.message);
}
function TpQuestionCard({ q, answer, onAnswer, locked, onTranslate }) {
  const { Card, AgentChip, Switch } = window.TidepoolDesignSystem_8a0ead;
  const items = q.items;
  const [draft, setDraft] = React.useState(() => answer ?? items.map(() => null));
  React.useEffect(() => {
    if (answer) setDraft(answer);
  }, [answer]);
  const setItemAnswer = (i, value) => {
    const next = draft.slice();
    next[i] = value;
    setDraft(next);
    if (next.every(Boolean)) onAnswer(next);
  };
  const answeredCount = draft.filter(Boolean).length;
  const [translateOn, setTranslateOn] = React.useState(false);
  const [translation, setTranslation] = React.useState(null);
  const translateRequested = React.useRef(false);
  React.useEffect(() => {
    if (!translateOn || !onTranslate || translateRequested.current) return;
    translateRequested.current = true;
    runTranslate(onTranslate, { type: "question", task_id: q.id }, setTranslation);
  }, [translateOn]);
  const translatedItems = translation && translation.status === "translated" ? translation.items : null;
  return /* @__PURE__ */ React.createElement(Card, { style: { marginBottom: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" } }, q.id), /* @__PURE__ */ React.createElement(AgentChip, { name: q.agent, icon: q.agentIcon, board: q.board, size: "sm" }), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" } }, q.agent), q.parent && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginLeft: "auto" } }, "blocks ", q.parent)), q.kind === "approval" && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--sun-4)", background: "var(--sun-1)", borderRadius: "var(--radius-full)", padding: "2px 10px", marginBottom: 6 } }, "out-of-authority \u2192 approval"), onTranslate && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", marginBottom: 6 } }, /* @__PURE__ */ React.createElement(Switch, { label: "\u8A33\u3092\u6DFB\u3048\u308B", checked: translateOn, onChange: setTranslateOn })), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: q.note ? 6 : 14, whiteSpace: "pre-wrap" } }, q.context), translateOn && translation && (translation.status === "translated" ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--tide-5)", marginBottom: q.note ? 6 : 14, whiteSpace: "pre-wrap" } }, translation.purpose) : /* @__PURE__ */ React.createElement("div", { style: { marginBottom: q.note ? 6 : 14 } }, /* @__PURE__ */ React.createElement(TpTranslationNote, { result: translation }))), q.note && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-xs)", color: "var(--sun-4)", marginBottom: 14 } }, "\u26A0 ", q.note), items.length > 1 && !locked && /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 } }, answeredCount, " of ", items.length, " answered \u2014 submits together once every item is"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 18 } }, items.map((item, i) => /* @__PURE__ */ React.createElement(
    TpQuestionItemPicker,
    {
      key: i,
      item,
      value: draft[i],
      locked,
      onChange: (v) => setItemAnswer(i, v),
      translated: translatedItems ? translatedItems[i] : null
    }
  ))));
}
function TpScratchpad({ lines, onAdd, onRemove }) {
  const { Button, Input } = window.TidepoolDesignSystem_8a0ead;
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const add = () => {
    if (draft.trim()) {
      onAdd(draft.trim());
      setDraft("");
    }
  };
  React.useEffect(() => {
    lucide.createIcons();
  });
  return ReactDOM.createPortal(
    /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => setOpen(!open),
        "aria-label": "scratchpad",
        style: {
          position: "fixed",
          bottom: 118,
          right: "max(16px, calc(50vw - 204px))",
          zIndex: 30,
          width: 44,
          height: 44,
          borderRadius: "var(--radius-full)",
          border: "none",
          cursor: "pointer",
          background: open ? "var(--tide-4)" : "var(--surface-card)",
          color: open ? "#fff" : "var(--tide-4)",
          boxShadow: "var(--shadow-card)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      },
      /* @__PURE__ */ React.createElement("i", { "data-lucide": "notebook-pen", style: { width: 18, height: 18 } }),
      lines.length > 0 && !open && /* @__PURE__ */ React.createElement("span", { style: { position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 999, background: "var(--sun-4)", color: "#fff", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: "16px", padding: "0 4px" } }, lines.length)
    ), open && /* @__PURE__ */ React.createElement("div", { style: { position: "fixed", bottom: 170, right: "max(16px, calc(50vw - 204px))", zIndex: 30, width: 300, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-card)", padding: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 } }, 'scratchpad \u2014 "this again?"'), lines.map((l, i) => /* @__PURE__ */ React.createElement("div", { key: l.id, style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)", marginBottom: 6 } }, /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }, l.text), /* @__PURE__ */ React.createElement("button", { onClick: () => onRemove(i), style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 } }, "\xD7"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "flex-end" } }, /* @__PURE__ */ React.createElement(Input, { multiline: true, rows: 1, placeholder: "jot the irritation \u2014 triaged at commit", value: draft, onChange: (e) => setDraft(e.target.value), style: { flex: 1 } }), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "sm", disabled: !draft.trim(), onClick: add }, "Add")))),
    document.body
  );
}
const TP_SCRATCH_KINDS = [
  { key: "task", label: "task" },
  { key: "meta_review", label: "meta-review" },
  { key: "register", label: "register" },
  { key: "discard", label: "discard" }
];
const LOG_READ_BATCH = 8;
const NO_WORKSPACE_LABEL = "no workspace";
function groupLogEntries(entries) {
  const byWorkspace = /* @__PURE__ */ new Map();
  entries.forEach((l, i) => {
    const withKeys = { ...l, chronoKey: l.id != null ? l.id : -i, sourceIndex: i };
    const key = l.workspace || "";
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(withKeys);
  });
  const groups = [...byWorkspace.entries()].map(([key, groupEntries]) => {
    const sorted = groupEntries.slice().sort((a, b) => a.chronoKey - b.chronoKey);
    const unreadEntries = sorted.filter((l) => l.unread);
    return {
      key,
      label: key || NO_WORKSPACE_LABEL,
      entries: sorted,
      unreadCount: unreadEntries.length,
      readCount: sorted.length - unreadEntries.length,
      mostRecentUnread: unreadEntries.length ? Math.max(...unreadEntries.map((l) => l.chronoKey)) : null,
      mostRecent: Math.max(...sorted.map((l) => l.chronoKey))
    };
  });
  groups.sort((a, b) => {
    if (a.unreadCount > 0 !== b.unreadCount > 0) return a.unreadCount > 0 ? -1 : 1;
    return a.unreadCount > 0 ? b.mostRecentUnread - a.mostRecentUnread : b.mostRecent - a.mostRecent;
  });
  return groups;
}
function TriageScreen({ data, onCommit, onReorderQueue, onFront, loadHandoff, onAnswer, onObject, onScratchAdd, onDisplayed, loadPreview, onTranslate }) {
  const { Button, Input, LogEntry, QueueItem, Switch } = window.TidepoolDesignSystem_8a0ead;
  const nQuestions = data.questions.length;
  const [section, setSection] = React.useState(nQuestions ? 0 : 1);
  const [answers, setAnswers] = React.useState({});
  const [objections, setObjections] = React.useState({});
  const [objecting, setObjecting] = React.useState(null);
  const [draft, setDraft] = React.useState("");
  const [scratch, setScratch] = React.useState([]);
  const [dropped, setDropped] = React.useState([]);
  const [scratchKinds, setScratchKinds] = React.useState({});
  const scratchSeq = React.useRef(0);
  const [preview, setPreview] = React.useState(null);
  const answerQ = async (q, a) => {
    if (onAnswer) {
      if (!a || answers[q.id]) return;
      try {
        await onAnswer(q, a);
      } catch {
        return;
      }
    }
    setAnswers((prev) => ({ ...prev, [q.id]: a }));
  };
  const addScratch = async (text) => {
    let entry = { id: `pad-${scratchSeq.current++}`, text };
    if (onScratchAdd) {
      try {
        entry = await onScratchAdd(text);
      } catch {
        return;
      }
    }
    setScratch((prev) => [...prev, entry]);
  };
  const removeScratch = (i) => {
    const entry = scratch[i];
    setScratch((prev) => prev.filter((_, j) => j !== i));
    if (onScratchAdd) setDropped((prev) => [...prev, entry]);
  };
  const refreshPreview = () => {
    if (loadPreview) loadPreview().then(setPreview).catch(() => {
    });
  };
  React.useEffect(() => {
    if (section === 2) refreshPreview();
  }, [section]);
  const logListRef = React.useRef(null);
  const displayedSeen = React.useRef(/* @__PURE__ */ new Set());
  React.useEffect(() => {
    if (section !== 1 || !onDisplayed || !logListRef.current) return;
    const byId = new Map(data.log.filter((l) => l.unread).map((l) => [String(l.id), l]));
    const io = new IntersectionObserver((observed) => {
      const shown = [];
      for (const o of observed) {
        if (!o.isIntersecting) continue;
        const id = o.target.dataset.entryId;
        if (byId.has(id) && !displayedSeen.current.has(id)) {
          displayedSeen.current.add(id);
          shown.push(byId.get(id));
        }
      }
      if (shown.length) onDisplayed(shown);
    }, { threshold: 0.5 });
    logListRef.current.querySelectorAll("[data-entry-id]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [section]);
  const logKey = (entry) => entry.id != null ? entry.id : entry.sourceIndex;
  const [revealedRead, setRevealedRead] = React.useState({});
  const [showFullyReadWorkspaces, setShowFullyReadWorkspaces] = React.useState(false);
  const allLogGroups = React.useMemo(() => groupLogEntries(data.log), [data.log]);
  const fullyReadGroups = allLogGroups.filter((g) => g.unreadCount === 0);
  const logGroups = React.useMemo(
    () => showFullyReadWorkspaces ? allLogGroups : allLogGroups.filter((g) => g.unreadCount > 0),
    [allLogGroups, showFullyReadWorkspaces]
  );
  const [logTranslateOn, setLogTranslateOn] = React.useState(false);
  const [logTranslations, setLogTranslations] = React.useState({});
  const logTranslateRequested = React.useRef(/* @__PURE__ */ new Set());
  const renderedLogEntries = React.useMemo(() => {
    const rendered = [];
    for (const g of logGroups) {
      const revealed = Math.min(revealedRead[g.key] || 0, g.readCount);
      const hiddenCount = g.readCount - revealed;
      rendered.push(...g.entries.slice(hiddenCount, g.readCount), ...g.entries.slice(g.readCount));
    }
    return rendered;
  }, [logGroups, revealedRead]);
  const logTranslateAbort = React.useRef(null);
  React.useEffect(() => {
    if (!logTranslateOn) return;
    const controller = new AbortController();
    logTranslateAbort.current = controller;
    return () => controller.abort();
  }, [logTranslateOn]);
  React.useEffect(() => {
    if (!logTranslateOn || !onTranslate) return;
    const signal = logTranslateAbort.current.signal;
    for (const entry of renderedLogEntries) {
      const k = logKey(entry);
      if (entry.id == null || logTranslateRequested.current.has(k)) continue;
      logTranslateRequested.current.add(k);
      runTranslate(
        onTranslate,
        { type: "log_entry", event_id: entry.id },
        (result) => setLogTranslations((prev) => ({ ...prev, [k]: result })),
        {
          signal,
          onAbort: () => {
            logTranslateRequested.current.delete(k);
            setLogTranslations((prev) => {
              if (!(k in prev)) return prev;
              const next = { ...prev };
              delete next[k];
              return next;
            });
          }
        }
      );
    }
  }, [logTranslateOn, renderedLogEntries]);
  const logThrottled = logTranslateOn && Object.values(logTranslations).some((v) => v && v.status === "throttled");
  const logTranslateTotal = logTranslateOn ? renderedLogEntries.filter((entry) => entry.id != null).length : 0;
  const logTranslateDone = logTranslateOn ? renderedLogEntries.filter((entry) => {
    const v = logTranslations[logKey(entry)];
    return entry.id != null && v && v.status !== "loading";
  }).length : 0;
  const scrollContainer = () => logListRef.current && logListRef.current.closest(".tp-scroll");
  const pendingScrollFix = React.useRef(null);
  React.useLayoutEffect(() => {
    const fix = pendingScrollFix.current;
    pendingScrollFix.current = null;
    const container = scrollContainer();
    if (!fix || !container) return;
    container.scrollTop = fix.scrollTop + (container.scrollHeight - fix.scrollHeight);
  });
  const expandRead = (groupKey) => {
    const container = scrollContainer();
    pendingScrollFix.current = container ? { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight } : null;
    setRevealedRead((prev) => ({ ...prev, [groupKey]: (prev[groupKey] || 0) + LOG_READ_BATCH }));
  };
  const [handoffOpen, setHandoffOpen] = React.useState({});
  const handoffCache = React.useRef({});
  const [handoffTranslateOn, setHandoffTranslateOn] = React.useState({});
  const [handoffTranslations, setHandoffTranslations] = React.useState({});
  const handoffTranslateRequested = React.useRef(/* @__PURE__ */ new Set());
  const toggleObjecting = (k) => {
    setObjecting(objecting === k ? null : k);
    setDraft("");
  };
  const toggleHandoff = async (k, entry) => {
    if (handoffOpen[k]) {
      setHandoffOpen((prev) => ({ ...prev, [k]: false }));
      return;
    }
    if (handoffCache.current[k] == null) {
      try {
        handoffCache.current[k] = entry.handoff != null ? entry.handoff : await loadHandoff(entry);
      } catch {
        handoffCache.current[k] = "(handoff doc failed to load)";
      }
    }
    setHandoffOpen((prev) => ({ ...prev, [k]: true }));
  };
  const setHandoffTranslate = (k, entry, next) => {
    setHandoffTranslateOn((prev) => ({ ...prev, [k]: next }));
    if (!next || !onTranslate || handoffTranslateRequested.current.has(k)) return;
    handoffTranslateRequested.current.add(k);
    runTranslate(onTranslate, { type: "handoff", task_id: entry.taskId }, (result) => setHandoffTranslations((prev) => ({ ...prev, [k]: result })));
  };
  const answered = Object.values(answers).filter(Boolean).length;
  const unread = data.log.filter((l) => l.unread);
  const progress = (section + (section === 0 ? answered / Math.max(1, nQuestions) : 0)) / 3;
  const heads = [
    { step: "1 / 3 \u2014 questions", title: `The tide brought ${nQuestions} question${nQuestions === 1 ? "" : "s"}.`, sub: "answers persist at once; unblocked parents surface at the front on commit.", next: answered === nQuestions ? "Log skim" : `Log skim (${nQuestions - answered} unanswered)` },
    { step: nQuestions ? "2 / 3 \u2014 decision log" : "2 / 3 \u2014 decision log \xB7 no questions today", title: `${unread.length} decisions made overnight.`, sub: "silence is consent \u2014 tap an entry to object.", next: "Queue check" },
    { step: "3 / 3 \u2014 queue", title: "The tide is going out.", sub: loadPreview ? "front-inserted by this session highlighted. read-only \u2014 reorder on the Queue screen. applies at commit." : "front-inserted by this session highlighted. reorder is optional.", next: "Commit" }
  ];
  const cur = heads[section];
  const scratchResolved = () => [
    ...scratch.map((s) => ({ id: s.id, text: s.text, kind: scratchKinds[s.id] || "task" })),
    ...dropped.map((s) => ({ id: s.id, text: s.text, kind: "discard" }))
  ];
  return /* @__PURE__ */ React.createElement("div", { key: section, style: { padding: "20px 16px 28px" } }, /* @__PURE__ */ React.createElement("div", { className: "tp-rise", style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 } }, cur.step), /* @__PURE__ */ React.createElement("h1", { className: "tp-rise", style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: "var(--text-2xl)", fontWeight: 400, color: "var(--tide-5)", margin: "0 0 4px", lineHeight: 1.15, animationDelay: "60ms" } }, cur.title), /* @__PURE__ */ React.createElement("p", { className: "tp-rise", style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 20px", animationDelay: "120ms" } }, cur.sub), section === 0 ? /* @__PURE__ */ React.createElement(TpSegmentGauge, { total: data.questions.length, filled: answered }) : /* @__PURE__ */ React.createElement(TpWaterline, { progress }), /* @__PURE__ */ React.createElement("div", { style: { height: 20 } }), section === 0 && /* @__PURE__ */ React.createElement("div", null, data.questions.map((q, i) => /* @__PURE__ */ React.createElement("div", { key: q.id, className: "tp-rise", style: { animationDelay: `${180 + i * 90}ms` } }, /* @__PURE__ */ React.createElement(TpQuestionCard, { q, answer: answers[q.id], onAnswer: (a) => answerQ(q, a), locked: !!onAnswer && !!answers[q.id], onTranslate })))), section === 1 && (() => {
    const renderLogRow = (l) => {
      const k = logKey(l);
      const hasHandoff = l.kind === "completion" && (l.handoff != null || loadHandoff && l.handoffPresent);
      return /* @__PURE__ */ React.createElement("div", { key: k, "data-entry-id": l.unread && l.id != null ? l.id : void 0 }, /* @__PURE__ */ React.createElement(LogEntry, { entry: { ...l, objection: objections[k] }, active: objecting === k, onObject: () => toggleObjecting(k), onExpand: hasHandoff ? () => toggleHandoff(k, l) : void 0 }), logTranslateOn && logTranslations[k] && logTranslations[k].status !== "throttled" && /* @__PURE__ */ React.createElement("div", { style: { padding: "2px 14px 10px", background: "var(--surface-recessed)" } }, logTranslations[k].status === "translated" ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--tide-5)" } }, logTranslations[k].text) : /* @__PURE__ */ React.createElement(TpTranslationNote, { result: logTranslations[k] })), handoffOpen[k] && /* @__PURE__ */ React.createElement("div", { style: { padding: "10px 14px 12px", background: "var(--surface-recessed)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "handoff \u2014 ", l.taskId), onTranslate && /* @__PURE__ */ React.createElement(Switch, { label: "\u8A33\u3092\u6DFB\u3048\u308B", checked: !!handoffTranslateOn[k], onChange: (next) => setHandoffTranslate(k, l, next), style: { marginLeft: "auto" } })), /* @__PURE__ */ React.createElement("pre", { style: { margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", lineHeight: 1.6, color: "var(--text-body)", overflowX: "auto" } }, handoffCache.current[k]), handoffTranslateOn[k] && handoffTranslations[k] && (handoffTranslations[k].status === "translated" ? /* @__PURE__ */ React.createElement("pre", { style: { margin: "8px 0 0", paddingTop: 8, borderTop: "1px dashed var(--border-hairline)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", lineHeight: 1.6, color: "var(--tide-5)", overflowX: "auto" } }, handoffTranslations[k].doc) : /* @__PURE__ */ React.createElement("div", { style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement(TpTranslationNote, { result: handoffTranslations[k] }))), objecting !== k && /* @__PURE__ */ React.createElement("button", { onClick: () => toggleObjecting(k), style: { background: "none", border: "none", color: "var(--coral-4)", fontSize: "var(--text-xs)", cursor: "pointer", padding: "8px 0 0", display: "block" } }, "object to this entry\u2026")), objecting === k && /* @__PURE__ */ React.createElement("div", { style: { padding: "10px 12px", background: "var(--coral-1)", display: "flex", gap: 8, alignItems: "flex-end" } }, /* @__PURE__ */ React.createElement(Input, { multiline: true, rows: 2, placeholder: "direction \u2014 steering, not rollback", value: draft, onChange: (e) => setDraft(e.target.value), style: { flex: 1 } }), /* @__PURE__ */ React.createElement(Button, { variant: "danger", size: "sm", disabled: !draft.trim(), onClick: async () => {
        if (onObject) {
          try {
            await onObject(l, draft);
          } catch {
            return;
          }
        }
        setObjections({ ...objections, [k]: draft });
        setObjecting(null);
      } }, "Object")));
    };
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("p", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", margin: "0 0 10px" } }, "tap an entry to object \xB7 use a completion\u2019s chevron to read its handoff"), onTranslate && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 10 } }, logTranslateOn && logTranslateTotal > 0 && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" } }, logTranslateDone, " / ", logTranslateTotal), logThrottled && /* @__PURE__ */ React.createElement(TpTranslationNote, { result: { status: "throttled" } }), /* @__PURE__ */ React.createElement(Switch, { label: "\u8A33\u3092\u6DFB\u3048\u308B", checked: logTranslateOn, onChange: setLogTranslateOn })), fullyReadGroups.length > 0 && /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => setShowFullyReadWorkspaces((v) => !v),
        style: { display: "block", width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "0 2px 10px", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", textTransform: "uppercase", letterSpacing: "0.08em" }
      },
      showFullyReadWorkspaces ? "hide fully-read workspaces" : `show ${fullyReadGroups.length} fully-read workspace${fullyReadGroups.length > 1 ? "s" : ""} too`
    ), /* @__PURE__ */ React.createElement("div", { ref: logListRef, style: { display: "flex", flexDirection: "column", gap: 10 } }, logGroups.map((g) => {
      const revealed = Math.min(revealedRead[g.key] || 0, g.readCount);
      const hiddenCount = g.readCount - revealed;
      const visibleReadEntries = g.entries.slice(hiddenCount, g.readCount);
      const unreadEntries = g.entries.slice(g.readCount);
      return /* @__PURE__ */ React.createElement("div", { key: g.key, style: { background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 8, padding: "8px 12px", background: "var(--surface-recessed)", borderBottom: "1px solid var(--border-hairline)" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", textTransform: "uppercase", letterSpacing: "0.06em" } }, g.label), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginLeft: "auto" } }, g.unreadCount > 0 ? `${g.unreadCount} unread` : `${g.readCount} read`)), hiddenCount > 0 && /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: () => expandRead(g.key),
          style: { display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid var(--border-hairline)", cursor: "pointer", padding: "8px 12px", fontSize: "var(--text-xs)", color: "var(--text-muted)" }
        },
        hiddenCount,
        " more read decision",
        hiddenCount > 1 ? "s" : "",
        " \u2014 show"
      ), visibleReadEntries.map(renderLogRow), unreadEntries.map(renderLogRow));
    })));
  })(), section === 2 && (() => {
    const nObjections = Object.keys(objections).length;
    const scratchPanel = scratch.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 } }, "scratchpad \u2014 triage before commit"), scratch.map((l) => /* @__PURE__ */ React.createElement("div", { key: l.id, style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { style: { flex: "1 1 100%", fontSize: "var(--text-sm)", color: (scratchKinds[l.id] || "task") === "discard" ? "var(--text-muted)" : "var(--text-body)", textDecoration: (scratchKinds[l.id] || "task") === "discard" ? "line-through" : "none" } }, l.text), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 4 } }, TP_SCRATCH_KINDS.map((k) => {
      const picked = (scratchKinds[l.id] || "task") === k.key;
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          key: k.key,
          onClick: () => setScratchKinds({ ...scratchKinds, [l.id]: k.key }),
          style: {
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            cursor: "pointer",
            color: picked ? "#fff" : "var(--text-secondary)",
            background: picked ? k.key === "discard" ? "var(--rock-4)" : "var(--tide-4)" : "var(--surface-recessed)",
            border: "none",
            borderRadius: "var(--radius-full)",
            padding: "4px 12px"
          }
        },
        k.label
      );
    })))));
    if (loadPreview) {
      return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, /* @__PURE__ */ React.createElement(TpQueueList, { tasks: preview ?? [] })), nObjections > 0 && /* @__PURE__ */ React.createElement("p", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 10 } }, nObjections, " objection", nObjections > 1 ? "s" : "", " bundle into repair tasks at commit \u2014 one per objected task, queue tail"), scratchPanel);
    }
    const pending = Object.entries(answers).filter(([, a]) => a).map(([qid]) => data.questions.find((x) => x.id === qid)).filter((q) => q.parent).map((q) => ({ id: q.parent, title: `unblocked by ${q.id}`, assignee: q.agent, assigneeIcon: q.agentIcon, frontInserted: true }));
    if (nObjections > 0) {
      pending.push({ id: "tp-0151", title: `repair task \u2014 ${nObjections} objection${nObjections > 1 ? "s" : ""} bundled`, assignee: "reef-crab", frontInserted: true });
    }
    const previewQueue = data.queue.filter((t) => !pending.some((p) => p.id === t.id));
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, pending.map((t, i) => /* @__PURE__ */ React.createElement(QueueItem, { key: t.id, position: i + 1, task: t, frontInserted: true })), /* @__PURE__ */ React.createElement(TpQueueList, { tasks: previewQueue, baseIndex: pending.length, onReorder: onReorderQueue, onFront, headId: data.queue[0]?.id })), scratchPanel);
  })(), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 20 } }, section > (nQuestions ? 0 : 1) && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "lg", onClick: () => setSection(section - 1) }, "Back"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "lg", full: true, onClick: () => section < 2 ? setSection(section + 1) : onCommit(answers, objections, scratchResolved()) }, cur.next)), /* @__PURE__ */ React.createElement(TpScratchpad, { lines: scratch, onAdd: addScratch, onRemove: removeScratch }), section === 2 && /* @__PURE__ */ React.createElement("p", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textAlign: "center", marginTop: 12 } }, "commit applies everything in one transaction \xB7 immediate poll if slot free"));
}
Object.assign(window, { TriageScreen, TpQuestionCard, TpQuestionItemPicker, TpWaterline, TpSegmentGauge });

// ui_kits/tidepool-webui/single-question-view.jsx
function TpPushBanner({ q, onOpen, onDismiss }) {
  const headline = q.items.length > 1 ? `${q.items.length} questions` : q.items[0].title;
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: onOpen,
      style: {
        position: "absolute",
        top: 10,
        left: 12,
        right: 12,
        zIndex: 55,
        cursor: "pointer",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        background: "var(--rock-6)",
        color: "#fff",
        border: "none",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-card)"
      }
    },
    /* @__PURE__ */ React.createElement("i", { "data-lucide": "bell", style: { width: 16, height: 16, flexShrink: 0 } }),
    /* @__PURE__ */ React.createElement("span", { style: { flex: 1, fontSize: "var(--text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("b", null, q.agent), " asks: ", headline),
    /* @__PURE__ */ React.createElement("span", { onClick: (e) => {
      e.stopPropagation();
      onDismiss();
    }, style: { fontSize: "var(--text-sm)", opacity: 0.7, padding: "0 2px" } }, "\xD7")
  );
}
function TpSingleQuestion({ q, onAnswer, onClose, onTranslate }) {
  const heading = q.items.length > 1 ? `${q.items.length} answers, then back to your day.` : "One answer, then back to your day.";
  return /* @__PURE__ */ React.createElement("div", { className: "tp-rise", style: { position: "absolute", inset: 0, zIndex: 56, background: "var(--surface-page)", display: "flex", flexDirection: "column", padding: "20px 16px", overflowY: "auto" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", letterSpacing: "0.08em", textTransform: "uppercase" } }, "push \u2192 ", q.items.length > 1 ? `${q.items.length} questions` : "one question"), /* @__PURE__ */ React.createElement("button", { onClick: onClose, style: { marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", fontSize: "var(--text-lg)", cursor: "pointer", padding: 0 } }, "\xD7")), /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: "var(--text-2xl)", fontWeight: 400, color: "var(--tide-5)", margin: "0 0 16px", lineHeight: 1.15 } }, heading), /* @__PURE__ */ React.createElement(TpQuestionCard, { q, answer: null, onAnswer, onTranslate }), /* @__PURE__ */ React.createElement("p", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textAlign: "center", marginTop: 12 } }, q.parent ? `answering sends ${q.parent} to the front \xB7 ` : "", "applies immediately \xB7 immediate poll if slot free \xB7 no transaction needed"));
}
Object.assign(window, { TpPushBanner, TpSingleQuestion });

// ui_kits/tidepool-webui/board-screen.jsx
function TpFadeScroll({ children, style }) {
  const ref = React.useRef(null);
  const [edges, setEdges] = React.useState({ top: false, bottom: false });
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => e.top === top && e.bottom === bottom ? e : { top, bottom });
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
  const stops = [
    edges.top ? `transparent 0, black ${fade}px` : "black 0",
    edges.bottom ? `black calc(100% - ${fade}px), transparent 100%` : "black 100%"
  ].join(", ");
  const mask = `linear-gradient(to bottom, ${stops})`;
  return /* @__PURE__ */ React.createElement("div", { ref, onScroll: update, className: "tp-scroll", style: { WebkitMaskImage: mask, maskImage: mask, ...style } }, children);
}
function BoardScreen({ data, onOpenTask }) {
  const { TaskCard } = window.TidepoolDesignSystem_8a0ead;
  const cols = ["todo", "in_progress", "blocked", "done"];
  return /* @__PURE__ */ React.createElement("div", { style: { height: "100%", display: "flex", flexDirection: "column", minHeight: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px 0" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-xl)", margin: "0 0 2px" } }, "Board"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 16px" } }, "progress overview \xB7 queue order lives in the queue")), /* @__PURE__ */ React.createElement("div", { className: "tp-scroll", style: { flex: 1, minHeight: 0, overflowX: "auto", display: "flex" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", gap: 12, alignItems: "stretch", padding: "0 16px 16px", minHeight: "100%", boxSizing: "border-box" } }, cols.map((key) => /* @__PURE__ */ React.createElement("div", { key, style: { width: 210, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--surface-recessed)", borderRadius: "var(--radius-md)", padding: 10, boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 6, padding: "2px 4px 10px", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-secondary)" } }, key), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" } }, data.board[key].length)), /* @__PURE__ */ React.createElement(TpFadeScroll, { style: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 } }, data.board[key].map((t) => /* @__PURE__ */ React.createElement(TaskCard, { key: t.id, task: { ...t, status: key }, onClick: () => onOpenTask && onOpenTask(t), style: { flexShrink: 0 } }))))))));
}
Object.assign(window, { BoardScreen, TpFadeScroll });

// webui/app.jsx
const WASH_MS = 1250;
const tabs = [
  { key: "triage", label: "Triage", icon: "sunrise" },
  { key: "board", label: "Board", icon: "columns-3" },
  { key: "queue", label: "Queue", icon: "list-ordered" },
  { key: "register", label: "Register", icon: "plus" },
  { key: "settings", label: "Settings", icon: "settings" }
];
async function api(path, body, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(typeof err.error === "string" ? err.error : res.statusText);
    e.status = res.status;
    e.detail = err;
    throw e;
  }
  return res.json();
}
const MAX_CONCURRENT_TRANSLATIONS = 2;
let translationsInFlight = 0;
const translationQueue = [];
function paceTranslation(run, signal) {
  return new Promise((resolve, reject) => {
    const dispatch = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      translationsInFlight += 1;
      run().then(resolve, reject).finally(() => {
        translationsInFlight -= 1;
        const next = translationQueue.shift();
        if (next) next();
      });
    };
    const onAbort = () => {
      const i = translationQueue.indexOf(dispatch);
      if (i !== -1) translationQueue.splice(i, 1);
      reject(new DOMException("translation cancelled", "AbortError"));
    };
    if (translationsInFlight < MAX_CONCURRENT_TRANSLATIONS) {
      dispatch();
    } else {
      if (signal) signal.addEventListener("abort", onAbort);
      translationQueue.push(dispatch);
    }
  });
}
const translateTarget = (target, { signal } = {}) => paceTranslation(() => api("/api/translate", target), signal);
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return void 0;
  return navigator.serviceWorker.register("/sw.js");
}
async function subscribeToPush(registration) {
  const { publicKey } = await fetch("/api/push/vapid-public-key").then((r) => r.json());
  if (!publicKey || !registration) return null;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  await api("/api/push/subscribe", subscription.toJSON());
  return subscription;
}
const RECENT_FRONTS = /* @__PURE__ */ new Set();
function markFront(id) {
  RECENT_FRONTS.add(id);
  setTimeout(() => RECENT_FRONTS.delete(id), 4e3);
}
function liveTitle(t) {
  if (t.issue_live_state === "stale") return `${t.title} (out of sync)`;
  if (t.issue_live_state === "unavailable") return `${t.title} (unavailable)`;
  return t.title;
}
function mapData(board, log, pause, icons = {}) {
  const paused = pause.paused;
  const throttle = pause.throttle;
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const questions = board.filter((t) => t.status === "todo" && t.type === "question").map((q) => {
    const isBoard = q.registrant === "tidepool";
    return {
      id: q.id,
      parent: q.parent_id,
      agent: q.registrant,
      agentIcon: isBoard ? void 0 : icons[q.registrant],
      board: isBoard,
      context: q.purpose,
      // 1-4 items, each with its own title/detail/options (issue #30) — a
      // single-item bundle is the degenerate, most common case
      items: (q.question_items ?? []).map((item) => ({
        title: item.title,
        detail: item.detail,
        options: item.options.map((o) => ({ label: o, recommended: o === item.recommendation }))
      }))
    };
  });
  const logEntries = [...log.entries].reverse().map((e) => ({
    id: e.id,
    time: fmtTime(e.created_at),
    taskId: e.task_id,
    agent: e.worker_id,
    agentIcon: icons[e.worker_id],
    human: e.worker_id === "human",
    kind: e.kind === "task_completed" ? "completion" : "decision",
    text: e.kind === "task_completed" ? e.payload.result ?? "(no outcome recorded)" : e.payload.line,
    unread: e.id > log.cursor,
    handoffPresent: e.kind === "task_completed" && !!e.payload.handoff_present,
    workspace: e.workspace ?? null
  }));
  const queue = board.filter((t) => (t.status === "todo" || t.status === "blocked") && t.type !== "question").map((t) => ({
    id: t.id,
    title: liveTitle(t),
    assignee: t.assignee ?? void 0,
    assigneeIcon: t.assignee ? icons[t.assignee] : void 0,
    risk: !!t.risk_flag,
    blocked: t.status === "blocked",
    frontInserted: RECENT_FRONTS.has(t.id),
    flash: RECENT_FRONTS.has(t.id)
  }));
  const openChildren = {};
  for (const t of board) {
    if (t.parent_id && t.status !== "done") {
      openChildren[t.parent_id] = (openChildren[t.parent_id] || 0) + 1;
    }
  }
  const cols = { todo: [], in_progress: [], blocked: [], done: [] };
  for (const t of board) {
    if (!cols[t.status]) continue;
    cols[t.status].push({
      id: t.id,
      title: liveTitle(t),
      type: t.type,
      assignee: t.assignee === "human" ? "you" : t.assignee ?? void 0,
      assigneeIcon: t.assignee ? icons[t.assignee] : void 0,
      human: t.assignee === "human",
      risk: !!t.risk_flag,
      children: openChildren[t.id],
      // the card's raw column status + assignee (issue #129's Add-child
      // dialog gates on these client-side — a display convenience only, the
      // API's own assertHumanDecomposable is the real gate) — kept separate
      // from `assignee` above, which is resolved for display and would
      // misrepresent an unset assignee here
      status: t.status,
      rawAssignee: t.raw_assignee,
      // issue #130: the edit form hides content/workspace for an issue-backed
      // task (immutable — the source of truth is GitHub); a display cue only,
      // editTask on the server is the real gate
      githubIssueNumber: t.github_issue_number
    });
  }
  const running = board.find((t) => t.status === "in_progress");
  const throttled = !!throttle?.throttled;
  const throttleFailClosed = throttled && !throttle.resumesAt;
  const throttleResumesAt = throttled && !throttleFailClosed ? fmtTime(throttle.resumesAt) : null;
  const throttleWindows = throttle?.windows ?? { session: null, week: null, fable: null };
  const hitLines = ["session", "week", "fable"].filter((w) => throttleWindows[w]?.throttled);
  const fableWindow = throttleWindows.fable;
  const fableThrottled = !!fableWindow?.throttled;
  const fableResumesAt = fableThrottled && fableWindow.resumeAt ? fmtTime(fableWindow.resumeAt) : null;
  const throttleObservedAt = throttle?.observedAt ? fmtTime(throttle.observedAt) : null;
  const halt = (slot2, kind, msg, detail) => ({ slot: slot2, toast: { kind, msg, detail } });
  const pickupHalt = pause.triageActive ? halt(
    { color: "var(--sun-4)", line: "triage in progress \xB7 nothing starts", meta: "commit triage to resume", taskId: null },
    "warn",
    "moved to front \u2014 pickup blocked",
    "triage in progress \u2014 commit it to resume"
  ) : paused ? halt(
    { color: "var(--tide-4)", line: "pickup paused \u2014 nothing starts until resumed", meta: "", taskId: null },
    "warn",
    "moved to front \u2014 pickup is paused",
    "resume to run it"
  ) : pause.containmentBlocked ? halt(
    { color: "var(--coral-4)", line: "worker containment unavailable \xB7 nothing starts", meta: "see the repair question", taskId: null },
    "warn",
    "moved to front \u2014 pickup blocked",
    "worker containment is not established"
  ) : pause.registryReachabilityBlocked ? halt(
    { color: "var(--coral-4)", line: "registry remote unreachable \xB7 nothing starts", meta: "see the repair question", taskId: null },
    "warn",
    "moved to front \u2014 pickup blocked",
    "registry remote is unreachable"
  ) : throttle?.revalidating ? halt(
    {
      color: "var(--sun-4)",
      line: "usage re-evaluation in progress \xB7 nothing starts",
      taskId: null,
      meta: throttleObservedAt ? `last observed ${throttleObservedAt}` : "no observation yet"
    },
    "info",
    "moved to front \u2014 usage is being re-evaluated",
    "waiting for a fresh observation"
  ) : throttled ? halt(
    {
      color: "var(--coral-4)",
      taskId: null,
      ...throttleFailClosed ? {
        line: "usage check unavailable \xB7 nothing starts",
        meta: `fail-closed \u2014 check usage check logs${throttleObservedAt ? ` \xB7 observed ${throttleObservedAt}` : ""}`
      } : {
        line: "usage pace \xB7 nothing starts",
        // which line is hit (ADR 0030) — an old pre-window row (no
        // windows persisted yet) falls back to the plain resume text
        meta: `${hitLines.length ? `${hitLines.join(" + ")} line \xB7 ` : ""}resumes ${throttleResumesAt}${throttleObservedAt ? ` \xB7 observed ${throttleObservedAt}` : ""}`
      }
    },
    "warn",
    "moved to front \u2014 pickup blocked",
    throttleFailClosed ? "usage check unavailable \u2014 nothing starts until a fresh reading arrives" : `usage limit \xB7 resumes ${throttleResumesAt}`
  ) : null;
  const slot = running ? { color: "var(--tide-4)", line: liveTitle(running), meta: running.assignee ?? "", taskId: running.id } : pickupHalt ? pickupHalt.slot : fableThrottled ? {
    // fable line only (ADR 0030): the board keeps flowing — fable-model
    // tasks alone wait for their catch-up
    color: "var(--rock-3)",
    taskId: null,
    line: "slot free \u2014 fable tasks paced",
    meta: fableResumesAt ? `fable line \xB7 resumes ${fableResumesAt}` : "fable line"
  } : {
    color: "var(--rock-3)",
    line: "slot free \u2014 nothing running",
    taskId: null,
    // fable の観測状態を常時可視化 (ADR 0030): per-model 行の書式変更で
    // 観測が黙って落ちたとき、Max プランの人間がここで気づける
    meta: `concurrency=1 \xB7 fable ${fableWindow ? "on pace" : "not observed"}`
  };
  return {
    questions,
    log: logEntries,
    queue,
    board: cols,
    icons,
    // empty until their domain slices exist: human tasks / agent registry /
    // out-of-authority approval questions — the kit sections render empty
    humanTasks: [],
    agents: [],
    slot,
    pickupHalt,
    running: !!running,
    paused: !!paused,
    triageActive: !!pause.triageActive,
    containmentBlocked: !!pause.containmentBlocked,
    registryReachabilityBlocked: !!pause.registryReachabilityBlocked,
    // Spend-down (ADR 0030 / issue #128) — pause と同じ盤面状態応答から素通し
    spendDown: pause.spendDown ?? null,
    throttled,
    throttleFailClosed,
    throttleResumesAt,
    throttleRevalidating: !!throttle?.revalidating,
    fableThrottled,
    fableResumesAt,
    lastLogId: log.entries.length ? log.entries[log.entries.length - 1].id : null
  };
}
async function fetchData() {
  const [board, log, pause, candidates] = await Promise.all([
    fetch("/api/tasks").then((r) => r.json()),
    fetch("/api/log").then((r) => r.json()),
    fetch("/api/pause").then((r) => r.json()),
    fetch("/api/registry/candidates").then((r) => r.json()).catch(() => ({ icons: {} }))
  ]);
  return mapData(board, log, pause, candidates.icons);
}
function TpTideWash({ label, emoji, duration = 1250 }) {
  const dur = `${duration}ms`;
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, zIndex: 60, overflow: "hidden", pointerEvents: "none" }, "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("div", { className: "tp-wash-water", style: { position: "absolute", inset: "-40px 0 0 0", animationDuration: dur } }, /* @__PURE__ */ React.createElement("div", { style: { animation: `tp-bob ${dur} ease-in-out both` } }, /* @__PURE__ */ React.createElement("svg", { width: "calc(100% + 36px)", height: "40", viewBox: "0 0 476 40", preserveAspectRatio: "none", style: { display: "block" } }, /* @__PURE__ */ React.createElement("path", { d: "M0 24 Q30 10 60 22 T120 22 T180 20 T240 24 T300 18 T360 22 T420 20 T476 22 L476 40 L0 40 Z", fill: "var(--tide-4)", opacity: "0.92" }), /* @__PURE__ */ React.createElement("path", { d: "M0 30 Q40 18 80 28 T160 28 T240 30 T320 26 T400 30 T476 28 L476 40 L0 40 Z", fill: "var(--tide-3)", opacity: "0.5" }))), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 39, left: 0, right: 0, bottom: -80, background: "var(--tide-4)", opacity: 0.94 } }), /* @__PURE__ */ React.createElement("div", { className: "tp-wash-label", style: { position: "absolute", top: "36%", left: 0, right: 0, textAlign: "center", padding: "0 24px", animationDuration: dur } }, emoji && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 44, marginBottom: 12 } }, emoji), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: "var(--text-2xl)", lineHeight: 1.2, color: "#fff" } }, label))));
}
function RegisterScreen({ onRegister, parentTask, onClose }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const childMode = !!parentTask;
  const [source, setSource] = React.useState("manual");
  const [type, setType] = React.useState("work");
  const [title, setTitle] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [criteria, setCriteria] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [workspace, setWorkspace] = React.useState("");
  const [risk, setRisk] = React.useState(false);
  const [review, setReview] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [issueNumber, setIssueNumber] = React.useState("");
  const [gate, setGate] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [dump, setDump] = React.useState("");
  const [drafted, setDrafted] = React.useState(false);
  const [plainFormActive, setPlainFormActive] = React.useState(false);
  const [draftBusy, setDraftBusy] = React.useState(false);
  const [candidates, setCandidates] = React.useState({ assignees: [], workspaces: [] });
  React.useEffect(() => {
    fetch("/api/registry/candidates").then((r) => r.json()).then(setCandidates).catch(() => {
    });
  }, []);
  const issueMode = !childMode && source === "github issue";
  const childExtras = () => childMode ? { parent_id: parentTask.id, decompose_reason: reason.trim() } : {};
  const [issues, setIssues] = React.useState([]);
  const [issuesFailed, setIssuesFailed] = React.useState(false);
  const [truncated, setTruncated] = React.useState(false);
  React.useEffect(() => {
    setIssues([]);
    setIssuesFailed(false);
    setTruncated(false);
    if (!issueMode || !workspace.trim()) return;
    api(`/api/github-issues?workspace=${encodeURIComponent(workspace.trim())}`, void 0, "GET").then((d) => {
      setIssues(d.issues);
      setTruncated(d.truncated);
    }).catch(() => setIssuesFailed(true));
  }, [issueMode, workspace]);
  const [pendingDumps, setPendingDumps] = React.useState([]);
  const [selectedDumpId, setSelectedDumpId] = React.useState(null);
  const refreshPendingDumps = () => fetch("/api/pending-dumps").then((r) => r.json()).then(setPendingDumps).catch(() => {
  });
  React.useEffect(() => {
    refreshPendingDumps();
  }, []);
  const pickPendingDump = (d) => {
    resetContent();
    setSelectedDumpId(d.id);
    setDump(d.line);
  };
  const discardPendingDump = async (id) => {
    if (id === selectedDumpId) {
      setSelectedDumpId(null);
    }
    try {
      await api(`/api/pending-dumps/${id}`, {}, "DELETE");
    } catch {
      return;
    }
    refreshPendingDumps();
  };
  const issueListHintStyle = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
  const filteredIssues = issueNumber.trim() ? issues.filter((i) => String(i.number).includes(issueNumber.trim()) || i.title.toLowerCase().includes(issueNumber.trim().toLowerCase())) : issues;
  const ok = issueMode ? workspace.trim() && /^[0-9]+$/.test(issueNumber.trim()) : title.trim() && purpose.trim() && criteria.trim() && (!childMode || reason.trim());
  const fields = () => issueMode ? { type: "work", workspace: workspace.trim(), github_issue_number: Number(issueNumber.trim()) } : {
    // a decompose child is always type work (decomposeTask's own
    // ChildSpec has no type field) — the type picker is dropped in
    // childMode below, so `type` state never leaves its 'work' default
    type,
    title: title.trim(),
    purpose: purpose.trim(),
    completion_criteria: criteria.trim(),
    risk_flag: risk,
    review_flag: review,
    // unset assignee/workspace resolve to the board's defaults at
    // execution time (CONTEXT.md) — omit rather than send '' so an
    // unknown-workspace 400 never fires on a field the human left blank
    ...assignee ? { assignee } : {},
    ...workspace.trim() ? { workspace: workspace.trim() } : {},
    ...childExtras()
  };
  const resetContent = () => {
    setDump("");
    setDrafted(false);
    setPlainFormActive(false);
    setType("work");
    setTitle("");
    setPurpose("");
    setCriteria("");
    setAssignee("");
    setWorkspace("");
    setIssueNumber("");
    setReason("");
    setRisk(false);
    setReview(false);
    setSelectedDumpId(null);
  };
  const submitFields = async (f) => {
    setBusy(true);
    setGate(null);
    try {
      await onRegister(f);
      if (selectedDumpId != null) {
        const consumedId = selectedDumpId;
        setSelectedDumpId(null);
        api(`/api/pending-dumps/${consumedId}`, {}, "DELETE").then(refreshPendingDumps).catch(() => {
        });
      }
      resetContent();
      if (childMode) onClose();
    } catch (err) {
      if (err.status === 422 && err.detail) {
        setGate({
          ...err.detail,
          workspace: f.workspace,
          github_issue_number: f.github_issue_number
        });
      }
    }
    setBusy(false);
  };
  const submit = () => submitFields(fields());
  const approveComment = async () => {
    setBusy(true);
    try {
      await api("/api/issue-comments", {
        workspace: gate.workspace,
        github_issue_number: gate.github_issue_number,
        body: gate.suggested_comment
      });
    } catch {
      setBusy(false);
      return;
    }
    setBusy(false);
    await submitFields({
      type: "work",
      workspace: gate.workspace,
      github_issue_number: gate.github_issue_number
    });
  };
  const draftFields = async () => {
    setDraftBusy(true);
    try {
      const d = await api("/api/tasks/draft", { dump: dump.trim(), ...childExtras() });
      setTitle(d.title);
      setPurpose(d.purpose);
      setCriteria(d.completion_criteria);
      setAssignee(d.assignee ?? "");
      setWorkspace(d.workspace ?? "");
      setRisk(!!d.risk_flag);
      setReview(!!d.review_flag);
      setDrafted(true);
    } catch {
      setPlainFormActive(true);
    }
    setDraftBusy(false);
  };
  const togglePlainForm = () => {
    const next = !plainFormActive;
    resetContent();
    setPlainFormActive(next);
  };
  const withPlaceholder = (value, label, names) => [
    { value, label },
    ...names.map((n) => ({ value: n, label: n }))
  ];
  const assigneeOptions = withPlaceholder("", "(default agent)", candidates.assignees);
  const workspaceOptions = withPlaceholder("", "(default workspace)", candidates.workspaces);
  const issueWorkspaceOptions = withPlaceholder("", "select workspace\u2026", candidates.workspaces);
  const primaryAction = issueMode || plainFormActive || drafted ? {
    label: childMode ? "Add child \u2014 appends to queue tail" : "Register \u2014 appends to queue tail",
    disabled: !ok || busy,
    onClick: submit
  } : { label: draftBusy ? "Drafting\u2026" : "Draft fields", disabled: !dump.trim() || draftBusy, onClick: draftFields };
  return /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-xl)", margin: "0 0 2px" } }, childMode ? "Add child" : "Register"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 16px" } }, childMode ? `splitting "${parentTask.title}" \u2014 appears as a child, same dump \u2192 draft \u2192 edit flow` : issueMode ? "reference a GitHub issue \u2014 its title/purpose/completion criteria stay live on GitHub" : plainFormActive ? "the LLM is unreachable \u2014 fill the fields yourself" : "dump it \u2014 the LLM drafts the fields, you confirm"), childMode && /* @__PURE__ */ React.createElement(Card, { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Reason for splitting this",
      value: reason,
      onChange: (e) => setReason(e.target.value),
      placeholder: "why this work is being split"
    }
  )), !issueMode && !childMode && pendingDumps.length > 0 && /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--tide-4)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "pending dump", pendingDumps.length > 1 ? "s" : "", " \u2014 sent here from scratchpad triage, awaiting writeup"), pendingDumps.map((d) => /* @__PURE__ */ React.createElement("div", { key: d.id, style: { display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: {
    flex: 1,
    fontSize: "var(--text-sm)",
    color: "var(--text-body)",
    fontWeight: d.id === selectedDumpId ? 600 : 400
  } }, d.line), /* @__PURE__ */ React.createElement(Button, { variant: d.id === selectedDumpId ? "primary" : "secondary", size: "sm", onClick: () => pickPendingDump(d) }, "Use"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => discardPendingDump(d.id) }, "Discard")))), /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, !childMode && /* @__PURE__ */ React.createElement(Select, { label: "Source", options: ["manual", "github issue"], value: source, onChange: (e) => {
    setSource(e.target.value);
    setGate(null);
    setSelectedDumpId(null);
  } }), issueMode && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Select, { label: "Workspace", options: issueWorkspaceOptions, value: workspace, onChange: (e) => setWorkspace(e.target.value) }), /* @__PURE__ */ React.createElement(Input, { label: "Issue number", value: issueNumber, onChange: (e) => setIssueNumber(e.target.value), placeholder: "content stays on GitHub; the board keeps only this reference" }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" } }, !workspace.trim() && /* @__PURE__ */ React.createElement("span", { style: issueListHintStyle }, "select a workspace to browse its open issues"), workspace.trim() && issuesFailed && /* @__PURE__ */ React.createElement("span", { style: issueListHintStyle }, "couldn't fetch open issues \u2014 type the number directly"), workspace.trim() && !issuesFailed && filteredIssues.map((i) => /* @__PURE__ */ React.createElement(
    "div",
    {
      key: i.number,
      onClick: () => setIssueNumber(String(i.number)),
      style: {
        display: "flex",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: "var(--text-sm)",
        color: "var(--text-body)",
        background: String(i.number) === issueNumber.trim() ? "var(--surface-sunken, rgba(0,0,0,0.06))" : "transparent"
      }
    },
    /* @__PURE__ */ React.createElement("span", { style: { color: "var(--text-muted)" } }, "#", i.number),
    /* @__PURE__ */ React.createElement("span", null, i.title)
  )), workspace.trim() && !issuesFailed && truncated && /* @__PURE__ */ React.createElement("span", { style: issueListHintStyle }, "older issues exist \u2014 type the number directly"))), !issueMode && !plainFormActive && !drafted && /* @__PURE__ */ React.createElement(Input, { multiline: true, rows: 4, placeholder: "what needs doing, in your own words \u2014 sloppy is fine here, sloppy completion criteria are not", value: dump, onChange: (e) => setDump(e.target.value) }), !issueMode && (plainFormActive || drafted) && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: drafted ? "var(--tide-4)" : "var(--sun-4)", textTransform: "uppercase", letterSpacing: "0.08em" } }, drafted ? "drafted \u2014 edit freely" : "plain form \u2014 same fields, no draft"), /* @__PURE__ */ React.createElement(Input, { label: "Title", value: title, onChange: (e) => setTitle(e.target.value) }), /* @__PURE__ */ React.createElement(Input, { label: "Purpose", multiline: true, rows: 2, value: purpose, onChange: (e) => setPurpose(e.target.value), placeholder: "state prerequisites here \u2014 the agent verifies and escalates cheaply" }), /* @__PURE__ */ React.createElement(Input, { label: "Completion criteria", multiline: true, rows: 2, value: criteria, onChange: (e) => setCriteria(e.target.value), placeholder: "sloppy completion criteria are the expensive kind" }), !childMode && /* @__PURE__ */ React.createElement(Select, { label: "Type", options: ["work", "review"], value: type, onChange: (e) => setType(e.target.value) }), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(Select, { label: "Assignee", options: assigneeOptions, value: assignee, onChange: (e) => setAssignee(e.target.value) }), /* @__PURE__ */ React.createElement(Select, { label: "Workspace", options: workspaceOptions, value: workspace, onChange: (e) => setWorkspace(e.target.value) })), /* @__PURE__ */ React.createElement(Checkbox, { label: "risk flag \u2014 this task has irreversible external effects", checked: risk, onChange: () => setRisk(!risk) }), /* @__PURE__ */ React.createElement(Checkbox, { label: "review flag \u2014 request an on-completion review", checked: review, onChange: () => setReview(!review) })), /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "lg", full: true, disabled: primaryAction.disabled, onClick: primaryAction.onClick }, primaryAction.label), childMode && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "lg", full: true, disabled: busy, onClick: onClose }, "Cancel")), !issueMode && /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: togglePlainForm,
      style: { background: "none", border: "none", color: "var(--text-muted)", fontSize: "var(--text-xs)", cursor: "pointer", padding: "10px 0 0", display: "block" }
    },
    plainFormActive ? "\u2190 back to brain dump" : "LLM unavailable? use the plain form"
  ), gate && /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 10, marginTop: 14, borderColor: "var(--coral-3, var(--rock-3))" } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600 } }, "the issue fails the registration gate"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, gate.missing), gate.suggested_comment && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)" } }, "suggested comment \u2014 posting it to the issue is your approval:"), /* @__PURE__ */ React.createElement("pre", { style: { whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", background: "var(--surface-sunken, rgba(0,0,0,0.06))", borderRadius: 8, padding: 10, margin: 0 } }, gate.suggested_comment), /* @__PURE__ */ React.createElement(Button, { variant: "primary", full: true, disabled: busy, onClick: approveComment }, "Approve \u2014 post to issue & retry"))));
}
function registryNameOk(name) {
  const v = name.trim();
  return /^[A-Za-z0-9._-]+$/.test(v) && ![".", ".."].includes(v);
}
function PortalDialog(props) {
  const { Dialog } = window.TidepoolDesignSystem_8a0ead;
  return ReactDOM.createPortal(/* @__PURE__ */ React.createElement(Dialog, { ...props }), document.body);
}
function RecordCardHead({ children, editing, onEdit }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minHeight: 26 } }, children, !editing && /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto" } }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: onEdit }, "Edit")));
}
function EditActions({ dirty = true, ok = true, busy, saveLabel, onSave, onCancel }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "lg", full: true, disabled: busy || !dirty || !ok, onClick: onSave }, busy ? "Working\u2026" : saveLabel), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "lg", full: true, disabled: busy, onClick: onCancel }, "Cancel"));
}
function useDirtySignal(edit, open, dirty) {
  React.useEffect(() => {
    if (open) edit.setDirty(dirty);
  }, [open, dirty]);
}
function ReviewCommandsInput({ values, onChange }) {
  const { Input, Button, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState("");
  const addFree = () => {
    const v = free.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setFree("");
  };
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "Review allowed commands"), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, "command prefixes a review session in this workspace may run beyond the read-only default. Empty means review stays read-only (confirmed on save if non-empty)."), values.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, values.map((v) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: v,
      type: "button",
      title: "remove",
      onClick: () => onChange(values.filter((x) => x !== v)),
      style: { border: "none", background: "none", padding: 0, cursor: "pointer" }
    },
    /* @__PURE__ */ React.createElement(Tag, { color: "tide", mono: true }, v, " \u2715")
  ))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement(
    Input,
    {
      value: free,
      mono: true,
      onChange: (e) => {
        setFree(e.target.value);
      },
      placeholder: 'command prefix \u2014 e.g. "npm test"'
    }
  )), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", disabled: !free.trim(), onClick: addFree }, "Add")));
}
function WorkspaceRecord({ ws, say, onChanged, edit }) {
  const { Card, FieldRow, Input, Switch, Tag } = window.TidepoolDesignSystem_8a0ead;
  const id = `workspace:${ws.name}`;
  const open = edit.isOpen(id);
  const [notes, setNotes] = React.useState(ws.notes ?? "");
  const [prot, setProt] = React.useState(!!ws.protected);
  const [cmds, setCmds] = React.useState(ws.review_allowed_commands ?? []);
  const origin = ws.repo ?? ws.path;
  const dirty = notes.trim() !== (ws.notes ?? "") || prot !== !!ws.protected || !sameStrings(cmds, ws.review_allowed_commands ?? []);
  useDirtySignal(edit, open, dirty);
  const { busy, save: submit, dialog } = useWorkspaceSave(say, async () => {
    edit.close();
    await onChanged();
  });
  const startEdit = () => edit.open(id, () => {
    setNotes(ws.notes ?? "");
    setProt(!!ws.protected);
    setCmds(ws.review_allowed_commands ?? []);
  });
  const save = () => {
    const body = { notes: notes.trim() };
    if (prot !== !!ws.protected) body.protected = prot;
    if (!sameStrings(cmds, ws.review_allowed_commands ?? [])) body.review_allowed_commands = cmds;
    submit(`/api/workspaces/${encodeURIComponent(ws.name)}`, "PATCH", body, "updated", ws.name);
  };
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(RecordCardHead, { editing: open, onEdit: startEdit }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "var(--text-sm)" } }, ws.name), ws.registrySelf && /* @__PURE__ */ React.createElement(Tag, { color: "tide", mono: true }, "registry"), ws.protected && /* @__PURE__ */ React.createElement(Tag, { color: "sun" }, "protected")), ws.registrySelf && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, "the board's own registry clone \u2014 protection stays on"), !open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: ws.repo ? "repository" : "path",
      kind: origin ? "mono" : "unset",
      value: origin ? `${origin}${ws.branch ? ` \xB7 ${ws.branch}` : ""}` : "",
      unsetLabel: "not recorded on the entry"
    }
  ), /* @__PURE__ */ React.createElement(FieldRow, { label: "notes", kind: ws.notes ? "text" : "unset", value: ws.notes ?? "", unsetLabel: "\u2014" }), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "protected",
      kind: "bool",
      checked: !!ws.protected,
      onLabel: "changes here always need human approval",
      offLabel: "not protected"
    }
  ), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "review allowed commands",
      kind: (ws.review_allowed_commands ?? []).length ? "tags" : "unset",
      tags: ws.review_allowed_commands ?? [],
      unsetLabel: "no extra commands allowed \u2014 review stays read-only"
    }
  )), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Notes",
      value: notes,
      onChange: (e) => setNotes(e.target.value),
      placeholder: "setup hints for humans \u2014 e.g. run npm install before first use"
    }
  ), /* @__PURE__ */ React.createElement(
    Switch,
    {
      label: "protected \u2014 changes here always need human approval",
      checked: prot,
      disabled: busy || ws.registrySelf && !!ws.protected,
      onChange: (next) => setProt(next)
    }
  ), /* @__PURE__ */ React.createElement(ReviewCommandsInput, { values: cmds, onChange: setCmds }), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      dirty,
      busy,
      saveLabel: "Save \u2014 commits to the registry",
      onSave: save,
      onCancel: () => edit.close()
    }
  )), dialog);
}
const AGENT_ICON_SEA = ["\u{1F419}", "\u{1F980}", "\u{1F990}", "\u{1F99E}", "\u{1F991}", "\u{1F9AA}", "\u{1F41A}", "\u{1F421}", "\u{1F420}", "\u{1F41F}", "\u{1F42C}", "\u{1F433}", "\u{1F988}", "\u{1F9AD}", "\u{1F422}", "\u{1FABC}", "\u{1FAB8}"];
const AGENT_ICON_LAND = ["\u{1F9A6}", "\u{1F415}", "\u{1F408}", "\u{1F98A}", "\u{1F43B}", "\u{1F43C}", "\u{1F428}", "\u{1F981}", "\u{1F42F}", "\u{1F42E}", "\u{1F437}", "\u{1F438}", "\u{1F435}", "\u{1F414}", "\u{1F427}", "\u{1F989}", "\u{1F985}", "\u{1F434}", "\u{1F98B}", "\u{1F41D}"];
function AgentIconPicker({ value, onChange }) {
  const { Input } = window.TidepoolDesignSystem_8a0ead;
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "Icon"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } }, [...AGENT_ICON_SEA, ...AGENT_ICON_LAND].map((emoji) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: emoji,
      type: "button",
      onClick: () => onChange(emoji),
      style: {
        width: 32,
        height: 32,
        padding: 0,
        borderRadius: "var(--radius-md)",
        cursor: "pointer",
        fontSize: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: value === emoji ? "2px solid var(--tide-4)" : "1px solid var(--rock-3)",
        background: value === emoji ? "var(--tide-1)" : "none"
      }
    },
    emoji
  ))), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Custom icon",
      value: value ?? "",
      onChange: (e) => onChange(e.target.value),
      placeholder: "paste any single emoji, or pick one above"
    }
  ));
}
function agentDraftOf(agent) {
  return {
    icon: agent.icon ?? "",
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    authority: agent.authority ?? "",
    model: agent.model ?? "",
    effort: agent.effort ?? "",
    advisor: agent.advisor ?? "",
    // GET /api/agents already returns skills (ADR 0025)
    skills: agent.skills ?? []
  };
}
const NEW_AGENT_DRAFT = {
  icon: "",
  description: "",
  systemPrompt: "",
  authority: "",
  model: "",
  effort: "",
  advisor: "",
  skills: ["@workspace"]
};
function agentBody(d) {
  return {
    authority: d.authority,
    description: d.description.trim(),
    icon: d.icon.trim() || void 0,
    model: d.model.trim() || void 0,
    effort: d.effort.trim() || void 0,
    advisor: d.advisor.trim() || void 0,
    skills: d.skills,
    systemPrompt: d.systemPrompt
  };
}
function agentDraftDirty(d, base) {
  return d.icon !== base.icon || d.description.trim() !== base.description || d.systemPrompt !== base.systemPrompt || d.authority !== base.authority || d.model.trim() !== base.model || d.effort.trim() !== base.effort || d.advisor.trim() !== base.advisor || !sameStrings(d.skills, base.skills);
}
function AgentFields({ draft, set, authorityOptions, hostSkills, hostSkillsDegraded }) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(AgentIconPicker, { value: draft.icon, onChange: (v) => set("icon", v) }), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Description",
      value: draft.description,
      onChange: (e) => set("description", e.target.value),
      placeholder: "when a delegating agent should pick this one"
    }
  ), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Specialty \u2014 persona, perspective, or this agent's own steps (optional; the worker protocol itself is injected separately, not written here)",
      multiline: true,
      rows: 4,
      value: draft.systemPrompt,
      onChange: (e) => set("systemPrompt", e.target.value)
    }
  ), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(Select, { label: "Authority", options: authorityOptions, value: draft.authority, onChange: (e) => set("authority", e.target.value) }), /* @__PURE__ */ React.createElement(Input, { label: "Model", value: draft.model, onChange: (e) => set("model", e.target.value), placeholder: "adapter default if empty" })), /* @__PURE__ */ React.createElement(Input, { label: "Effort", value: draft.effort, onChange: (e) => set("effort", e.target.value), placeholder: "adapter default if empty" }), /* @__PURE__ */ React.createElement(Input, { label: "Advisor model", value: draft.advisor, onChange: (e) => set("advisor", e.target.value), placeholder: "no advisor if empty" }), /* @__PURE__ */ React.createElement(SkillListInput, { candidates: hostSkills, degraded: hostSkillsDegraded, values: draft.skills, onChange: (v) => set("skills", v) }));
}
function AgentRecord({ agent, authorityProfiles, hostSkills, hostSkillsDegraded, say, onChanged, edit }) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const { AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const id = `agent:${agent.name}`;
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(() => agentDraftOf(agent));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const [busy, setBusy] = React.useState(false);
  const dirty = agentDraftDirty(draft, agentDraftOf(agent));
  const ok = !!draft.description.trim() && !!draft.authority;
  useDirtySignal(edit, open, dirty);
  const startEdit = () => edit.open(id, () => setDraft(agentDraftOf(agent)));
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/agents/${encodeURIComponent(agent.name)}`, agentBody(draft), "PATCH");
      say("success", "agent updated \u2014 committed to the registry", agent.name);
      edit.close();
      await onChanged();
    } catch (err) {
      say("danger", "agent update failed", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(RecordCardHead, { editing: open, onEdit: startEdit }, /* @__PURE__ */ React.createElement(AgentChip, { name: agent.name, icon: open ? draft.icon : agent.icon ?? "" })), !open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(FieldRow, { label: "description", kind: agent.description ? "text" : "unset", value: agent.description ?? "", unsetLabel: "\u2014" }), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "specialty",
      kind: agent.systemPrompt ? "text" : "unset",
      value: agent.systemPrompt ?? "",
      unsetLabel: "no specialty \u2014 worker protocol only"
    }
  ), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(FieldRow, { label: "authority", kind: agent.authority ? "mono" : "unset", value: agent.authority ?? "", unsetLabel: "\u2014" }), /* @__PURE__ */ React.createElement(FieldRow, { label: "model", kind: agent.model ? "mono" : "unset", value: agent.model ?? "", unsetLabel: "adapter default" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(FieldRow, { label: "effort", kind: agent.effort ? "mono" : "unset", value: agent.effort ?? "", unsetLabel: "adapter default" }), /* @__PURE__ */ React.createElement(FieldRow, { label: "advisor model", kind: agent.advisor ? "mono" : "unset", value: agent.advisor ?? "", unsetLabel: "no advisor" })), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "skills",
      kind: (agent.skills ?? []).length ? "tags" : "unset",
      tags: agent.skills ?? [],
      scheme: "skills",
      wildcardHint: "every skill",
      unsetLabel: "no skills allowed"
    }
  )), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    AgentFields,
    {
      draft,
      set,
      authorityOptions: authorityProfiles,
      hostSkills,
      hostSkillsDegraded
    }
  ), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      dirty,
      ok,
      busy,
      saveLabel: "Save changes \u2014 commits to the registry",
      onSave: save,
      onCancel: () => edit.close()
    }
  )));
}
const DANGEROUS_REASON_LABEL = {
  merge_auto_if_ci_green: "Merge is auto_if_ci_green \u2014 a PR under this authority merges unattended once CI is green, with no human in the loop.",
  assignable_to_wildcard: 'Assignable-to carries the wildcard "*" \u2014 an agent with this authority may delegate to any agent.',
  allowed_workspaces_wildcard: 'Allowed-workspaces carries the wildcard "*" \u2014 this authority reaches every workspace on the board.',
  unprotect: "Protection is being removed \u2014 tasks targeting this workspace stop converting to approval questions, and its PRs follow the merge dial without waiting for a human.",
  review_allowed_commands_set: "Review-allowed commands is non-empty \u2014 review sessions in this workspace gain Bash access to those command prefixes, beyond the read-only default."
};
const MERGE_OPTIONS = [
  { value: "", label: "no automatic merge decision (default)" },
  { value: "escalate", label: "escalate \u2014 always ask a human before merging" },
  { value: "auto_if_ci_green", label: "auto_if_ci_green \u2014 merge unattended once CI is green" }
];
function sameStrings(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function profileBody(guidance, assignableTo, allowedWorkspaces, merge) {
  return {
    guidance,
    assignable_to: assignableTo,
    allowed_workspaces: allowedWorkspaces,
    merge: merge || void 0
  };
}
function ProfileListInput({ label, hint, candidates, wildcardHint, values, onChange }) {
  const { Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const addable = candidates.filter((c) => !values.includes(c));
  const wildcardAddable = !values.includes("*");
  const options = [
    { value: "", label: addable.length || wildcardAddable ? "add\u2026" : "no more to add" },
    ...addable.map((c) => ({ value: c, label: c })),
    ...wildcardAddable ? [{ value: "*", label: `* \u2014 ${wildcardHint}` }] : []
  ];
  const pick = (e) => {
    if (e.target.value) onChange([...values, e.target.value]);
  };
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, label), hint && /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, hint), values.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, values.map((v) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: v,
      type: "button",
      title: "remove",
      onClick: () => onChange(values.filter((x) => x !== v)),
      style: { border: "none", background: "none", padding: 0, cursor: "pointer" }
    },
    /* @__PURE__ */ React.createElement(Tag, { color: v === "*" ? "sun" : "tide", mono: true }, v, " \u2715")
  ))), /* @__PURE__ */ React.createElement(Select, { value: "", options, onChange: pick }));
}
function skillAddError(entry, existing) {
  const v = entry.trim();
  if (!v) return "empty skill name";
  if (existing.includes(v)) return "already added";
  if (v === "*") {
    return existing.length > 0 ? '"*" must be the only entry \u2014 remove the others first' : null;
  }
  if (existing.includes("*")) return 'remove "*" first \u2014 it must be the only entry';
  if (v.startsWith("@") && v !== "@workspace" && v !== "@host") {
    return "an @ entry may only be @workspace or @host";
  }
  return null;
}
function SkillListInput({ candidates, degraded, values, onChange }) {
  const { Input, Button, Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState("");
  const [freeError, setFreeError] = React.useState(null);
  const offerable = ["@workspace", "@host", ...candidates, "*"].filter(
    (c) => skillAddError(c, values) === null
  );
  const options = [
    { value: "", label: offerable.length ? "add a scope or skill\u2026" : "no more to add" },
    ...offerable.map((c) => ({ value: c, label: c === "*" ? "* \u2014 every skill" : c }))
  ];
  const pick = (e) => {
    if (e.target.value) onChange([...values, e.target.value]);
  };
  const addFree = () => {
    const err = skillAddError(free, values);
    if (err) {
      setFreeError(err);
      return;
    }
    onChange([...values, free.trim()]);
    setFree("");
    setFreeError(null);
  };
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "Skills"), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, `which skills this agent may use \u2014 a scope (@workspace / @host), an enumerated host skill, "plugin-name:*", or "*" for all. Free entry adds a workspace-specific name the picker can't list.`), degraded && /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-secondary)" } }, "host skill list unavailable \u2014 scope words and free entry still work."), values.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, values.map((v) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: v,
      type: "button",
      title: "remove",
      onClick: () => onChange(values.filter((x) => x !== v)),
      style: { border: "none", background: "none", padding: 0, cursor: "pointer" }
    },
    /* @__PURE__ */ React.createElement(Tag, { color: v === "*" ? "sun" : v.startsWith("@") ? "grass" : "tide", mono: true }, v, " \u2715")
  ))), /* @__PURE__ */ React.createElement(Select, { value: "", options, onChange: pick }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement(
    Input,
    {
      value: free,
      mono: true,
      error: freeError || void 0,
      onChange: (e) => {
        setFree(e.target.value);
        setFreeError(null);
      },
      placeholder: 'free entry \u2014 e.g. a workspace skill name or "plugin-name:*"'
    }
  )), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", disabled: !free.trim(), onClick: addFree }, "Add")));
}
function ProfileFields({ agentNames, workspaceNames, guidance, setGuidance, assignableTo, setAssignableTo, allowedWorkspaces, setAllowedWorkspaces, merge, setMerge }) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Guidance \u2014 prose injected into the agent's system prompt at spawn",
      multiline: true,
      rows: 4,
      value: guidance,
      onChange: (e) => setGuidance(e.target.value),
      placeholder: "how an agent carrying this authority should act"
    }
  ), /* @__PURE__ */ React.createElement(
    ProfileListInput,
    {
      label: "Assignable to",
      hint: 'who this authority may delegate to \u2014 a registered agent or the human, or "*" for any (confirmed on save)',
      candidates: agentNames.includes("human") ? agentNames : [...agentNames, "human"],
      wildcardHint: "any agent",
      values: assignableTo,
      onChange: setAssignableTo
    }
  ), /* @__PURE__ */ React.createElement(
    ProfileListInput,
    {
      label: "Allowed workspaces",
      hint: 'which workspaces this authority may act in \u2014 pick a registered workspace, or "*" for every one (confirmed on save)',
      candidates: workspaceNames,
      wildcardHint: "every workspace",
      values: allowedWorkspaces,
      onChange: setAllowedWorkspaces
    }
  ), /* @__PURE__ */ React.createElement(Select, { label: "Merge authority", options: MERGE_OPTIONS, value: merge, onChange: (e) => setMerge(e.target.value) }));
}
function useDangerousSave(say, onDone, { noun, confirmKey, dialogTitle, dialogLead }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(null);
  const save = async (path, method, body, verb, name) => {
    const attempt = async (confirmed) => {
      setBusy(true);
      try {
        await api(path, confirmed ? { ...body, [confirmKey]: true } : body, method);
        setConfirm(null);
        say("success", `${noun} ${verb} \u2014 committed to the registry`, name);
        await onDone();
      } catch (err) {
        if (err.status === 409 && err.detail?.confirm_required) {
          setConfirm({ reasons: err.detail.dangerous_values ?? [], resend: () => attempt(true) });
        } else {
          setConfirm(null);
          say("danger", `${noun} ${verb} failed`, String(err.message || err));
        }
      }
      setBusy(false);
    };
    await attempt(false);
  };
  const dialog = /* @__PURE__ */ React.createElement(
    PortalDialog,
    {
      open: !!confirm,
      title: dialogTitle,
      onClose: () => setConfirm(null),
      footer: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { variant: "secondary", disabled: busy, onClick: () => setConfirm(null) }, "Cancel"), /* @__PURE__ */ React.createElement(Button, { variant: "danger", disabled: busy, onClick: () => confirm && confirm.resend() }, "Save anyway"))
    },
    /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 8px", fontSize: "var(--text-sm)" } }, dialogLead),
    /* @__PURE__ */ React.createElement("ul", { style: { margin: 0, paddingLeft: 18, fontSize: "var(--text-sm)", display: "flex", flexDirection: "column", gap: 6 } }, (confirm?.reasons ?? []).map((r) => /* @__PURE__ */ React.createElement("li", { key: r }, DANGEROUS_REASON_LABEL[r] ?? r)))
  );
  return { busy, save, dialog };
}
function useProfileSave(say, onDone) {
  return useDangerousSave(say, onDone, {
    noun: "profile",
    confirmKey: "confirmDangerous",
    dialogTitle: "Save a profile with broad power?",
    dialogLead: "This profile grants broad power. Review before saving:"
  });
}
function useWorkspaceSave(say, onDone) {
  return useDangerousSave(say, onDone, {
    noun: "workspace",
    confirmKey: "confirm",
    dialogTitle: "Save a change that widens what agents may do?",
    dialogLead: "This change widens what agents may do here. Review before saving:"
  });
}
function ProfileRecord({ profile, agentNames, agentIcons, workspaceNames, say, onChanged, edit }) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const id = `profile:${profile.name}`;
  const open = edit.isOpen(id);
  const [guidance, setGuidance] = React.useState(profile.guidance ?? "");
  const [assignableTo, setAssignableTo] = React.useState(profile.assignable_to ?? []);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState(profile.allowed_workspaces ?? []);
  const [merge, setMerge] = React.useState(profile.merge ?? "");
  const { busy, save, dialog } = useProfileSave(say, async () => {
    edit.close();
    await onChanged();
  });
  const dirty = guidance !== (profile.guidance ?? "") || !sameStrings(assignableTo, profile.assignable_to ?? []) || !sameStrings(allowedWorkspaces, profile.allowed_workspaces ?? []) || (merge || "") !== (profile.merge ?? "");
  useDirtySignal(edit, open, dirty);
  const startEdit = () => edit.open(id, () => {
    setGuidance(profile.guidance ?? "");
    setAssignableTo(profile.assignable_to ?? []);
    setAllowedWorkspaces(profile.allowed_workspaces ?? []);
    setMerge(profile.merge ?? "");
  });
  const submit = () => save(
    `/api/profiles/${encodeURIComponent(profile.name)}`,
    "PATCH",
    profileBody(guidance, assignableTo, allowedWorkspaces, merge),
    "updated",
    profile.name
  );
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(RecordCardHead, { editing: open, onEdit: startEdit }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "var(--text-sm)" } }, profile.name)), !open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(FieldRow, { label: "guidance", kind: profile.guidance ? "text" : "unset", value: profile.guidance ?? "", unsetLabel: "\u2014" }), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "assignable to",
      kind: (profile.assignable_to ?? []).length ? "tags" : "unset",
      tags: profile.assignable_to ?? [],
      agentIcons,
      wildcardHint: "any agent",
      unsetLabel: "nobody \u2014 this authority can't be delegated"
    }
  ), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "allowed workspaces",
      kind: (profile.allowed_workspaces ?? []).length ? "tags" : "unset",
      tags: profile.allowed_workspaces ?? [],
      wildcardHint: "every workspace",
      unsetLabel: "no workspace \u2014 this authority can't act anywhere"
    }
  ), /* @__PURE__ */ React.createElement(
    FieldRow,
    {
      label: "merge authority",
      kind: profile.merge ? "mono" : "unset",
      value: profile.merge ?? "",
      unsetLabel: "no automatic merge decision"
    }
  )), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    ProfileFields,
    {
      agentNames,
      workspaceNames,
      guidance,
      setGuidance,
      assignableTo,
      setAssignableTo,
      allowedWorkspaces,
      setAllowedWorkspaces,
      merge,
      setMerge
    }
  ), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      dirty,
      busy,
      saveLabel: "Save changes \u2014 commits to the registry",
      onSave: submit,
      onCancel: () => edit.close()
    }
  )), dialog);
}
const settingsFootnote = { margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" };
const settingsCardLabel = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em"
};
function DisplayLanguageCard({ language, options, say, onSaved, edit }) {
  const { Card, FieldRow, Select } = window.TidepoolDesignSystem_8a0ead;
  const id = "board:language";
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(language);
  const [busy, setBusy] = React.useState(false);
  const dirty = draft !== language;
  useDirtySignal(edit, open, dirty);
  const save = async () => {
    setBusy(true);
    try {
      const { language: saved } = await api("/api/settings/display-language", { language: draft });
      say("success", "display language saved", saved);
      edit.close();
      await onSaved();
    } catch (err) {
      say("danger", "display language save failed", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(RecordCardHead, { editing: open, onEdit: () => edit.open(id, () => setDraft(language)) }, /* @__PURE__ */ React.createElement("span", { style: settingsCardLabel }, "display language")), !open && /* @__PURE__ */ React.createElement(FieldRow, { label: "language", kind: language ? "mono" : "unset", value: language, unsetLabel: "unset" }), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Select, { label: "Language", options, value: draft, onChange: (e) => setDraft(e.target.value) }), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      dirty,
      ok: !!draft,
      busy,
      saveLabel: "Save display language",
      onSave: save,
      onCancel: () => edit.close()
    }
  )));
}
function QuietHoursCard({ start, end, tz, say, onSaved, edit }) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = "board:quiet-hours";
  const open = edit.isOpen(id);
  const [draftStart, setDraftStart] = React.useState(start);
  const [draftEnd, setDraftEnd] = React.useState(end);
  const [busy, setBusy] = React.useState(false);
  const dirty = draftStart !== start || draftEnd !== end;
  const ok = !!draftStart.trim() && !!draftEnd.trim();
  useDirtySignal(edit, open, dirty);
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api("/api/settings/quiet-hours", { start: draftStart, end: draftEnd });
      say("success", "quiet hours saved", `${saved.start}\u2013${saved.end}`);
      edit.close();
      await onSaved();
    } catch (err) {
      say("danger", "quiet hours save failed", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(RecordCardHead, { editing: open, onEdit: () => edit.open(id, () => {
    setDraftStart(start);
    setDraftEnd(end);
  }) }, /* @__PURE__ */ React.createElement("span", { style: settingsCardLabel }, "quiet hours")), !open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(FieldRow, { label: "start", kind: "mono", value: start }), /* @__PURE__ */ React.createElement(FieldRow, { label: "end", kind: "mono", value: end })), /* @__PURE__ */ React.createElement(FieldRow, { label: "timezone", kind: tz ? "mono" : "unset", value: tz, unsetLabel: "unset" })), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(Input, { label: "Start", mono: true, value: draftStart, onChange: (e) => setDraftStart(e.target.value), placeholder: "HH:MM" }), /* @__PURE__ */ React.createElement(Input, { label: "End", mono: true, value: draftEnd, onChange: (e) => setDraftEnd(e.target.value), placeholder: "HH:MM" })), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, "start after end wraps past midnight (e.g. 23:00\u201307:00) \u2014 that's valid, not an error. timezone: ", tz || "unset", " \u2014 change it from the timezone setting, not here."), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      dirty,
      ok,
      busy,
      saveLabel: "Save quiet hours",
      onSave: save,
      onCancel: () => edit.close()
    }
  )));
}
function PaceOffsetsCard({ offsets, say, onSaved, edit }) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = "board:pace-offsets";
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(offsets);
  const [busy, setBusy] = React.useState(false);
  const keys = ["session", "week", "fable"];
  const dirty = keys.some((k) => String(draft[k]) !== String(offsets[k]));
  const validOffset = (v) => /^\d{1,3}$/.test(String(v).trim()) && Number(v) <= 100;
  const ok = keys.every((k) => validOffset(draft[k]));
  useDirtySignal(edit, open, dirty);
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api("/api/settings/pace-offsets", {
        session: Number(draft.session),
        week: Number(draft.week),
        fable: Number(draft.fable)
      });
      say("success", "pace offsets saved", `session ${saved.session}pt \xB7 week ${saved.week}pt \xB7 fable ${saved.fable}pt`);
      edit.close();
      await onSaved();
    } catch (err) {
      say("danger", "pace offsets save failed", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(RecordCardHead, { editing: open, onEdit: () => edit.open(id, () => setDraft(offsets)) }, /* @__PURE__ */ React.createElement("span", { style: settingsCardLabel }, "pace offsets")), !open && /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 } }, keys.map((k) => /* @__PURE__ */ React.createElement(FieldRow, { key: k, label: k, kind: "mono", value: `${offsets[k]} pt` }))), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(Input, { label: "Session", mono: true, value: String(draft.session), onChange: (e) => setDraft({ ...draft, session: e.target.value }), placeholder: "20" }), /* @__PURE__ */ React.createElement(Input, { label: "Week", mono: true, value: String(draft.week), onChange: (e) => setDraft({ ...draft, week: e.target.value }), placeholder: "10" }), /* @__PURE__ */ React.createElement(Input, { label: "Fable", mono: true, value: String(draft.fable), onChange: (e) => setDraft({ ...draft, fable: e.target.value }), placeholder: "10" })), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, "your reserved share of each usage window, in points (0\u2013100). the board stays this far behind the elapsed-time pace, leaving that slice of the budget for your own sessions."), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      dirty,
      ok,
      busy,
      saveLabel: "Save pace offsets",
      onSave: save,
      onCancel: () => edit.close()
    }
  )));
}
function NewWorkspaceForm({ say, onCreated, edit }) {
  const { Card, Checkbox, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [mode, setMode] = React.useState("clone");
  const [name, setName] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [path, setPath] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [prot, setProt] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ok = registryNameOk(name) && (mode === "clone" ? !!repo.trim() : mode === "register" ? !!path.trim() : true);
  const dirty = mode !== "clone" || !!name.trim() || !!repo.trim() || !!path.trim() || !!notes.trim() || prot;
  useDirtySignal(edit, true, dirty);
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/workspaces", {
        mode,
        name: name.trim(),
        ...mode === "clone" ? { repo: repo.trim() } : {},
        ...mode === "register" ? { path: path.trim() } : {},
        ...notes.trim() ? { notes: notes.trim() } : {},
        ...prot ? { protected: true } : {}
      });
      say("success", "workspace added \u2014 committed to the registry", name.trim());
      edit.close();
      await onCreated();
    } catch (err) {
      say("danger", "workspace creation failed \u2014 safe to retry as-is", String(err.message || err));
    }
    setBusy(false);
  };
  const modeOptions = [
    { value: "clone", label: "clone a repository" },
    { value: "create", label: "create a new private repository" },
    { value: "register", label: "register an existing path" }
  ];
  const modeHint = {
    clone: "clones into the workspaces directory \u2014 the entry stays host-independent",
    create: "creates a private GitHub repo named after the workspace, then clones it",
    register: "points at a checkout already on this host \u2014 the one mode that records a path"
  }[mode];
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement("span", { style: settingsCardLabel }, "add a workspace"), /* @__PURE__ */ React.createElement(Select, { label: "Mode", options: modeOptions, value: mode, onChange: (e) => setMode(e.target.value) }), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" } }, modeHint), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Name",
      value: name,
      onChange: (e) => setName(e.target.value),
      placeholder: "letters, digits, - _ . \u2014 safe as a directory and a repo name"
    }
  ), mode === "clone" && /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Repository",
      value: repo,
      onChange: (e) => setRepo(e.target.value),
      placeholder: "anything git clone accepts \u2014 recorded on the entry"
    }
  ), mode === "register" && /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Path",
      value: path,
      onChange: (e) => setPath(e.target.value),
      placeholder: "an existing checkout on this host"
    }
  ), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Notes",
      value: notes,
      onChange: (e) => setNotes(e.target.value),
      placeholder: "setup hints for humans \u2014 optional"
    }
  ), /* @__PURE__ */ React.createElement(Checkbox, { label: "protected \u2014 changes here always need human approval", checked: prot, onChange: () => setProt(!prot) }), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      ok,
      busy,
      saveLabel: "Add workspace \u2014 commits to the registry",
      onSave: submit,
      onCancel: () => edit.close()
    }
  ));
}
function NewAgentForm({ authorityProfiles, hostSkills, hostSkillsDegraded, say, onCreated, edit }) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState("");
  const [draft, setDraft] = React.useState(() => ({ ...NEW_AGENT_DRAFT }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const [busy, setBusy] = React.useState(false);
  const ok = registryNameOk(name) && !!draft.description.trim() && !!draft.authority;
  const dirty = !!name.trim() || agentDraftDirty(draft, NEW_AGENT_DRAFT);
  useDirtySignal(edit, true, dirty);
  const authorityCreateOptions = [
    { value: "", label: "select authority\u2026" },
    ...authorityProfiles.map((n) => ({ value: n, label: n }))
  ];
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/agents", { name: name.trim(), ...agentBody(draft) });
      say("success", "agent added \u2014 committed to the registry", name.trim());
      edit.close();
      await onCreated();
    } catch (err) {
      say("danger", "agent creation failed \u2014 safe to retry as-is", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement("span", { style: settingsCardLabel }, "add an agent"), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Name",
      value: name,
      onChange: (e) => setName(e.target.value),
      placeholder: "letters, digits, - _ . \u2014 becomes agents/<name>.md, not renameable later"
    }
  ), /* @__PURE__ */ React.createElement(
    AgentFields,
    {
      draft,
      set,
      authorityOptions: authorityCreateOptions,
      hostSkills,
      hostSkillsDegraded
    }
  ), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      ok,
      busy,
      saveLabel: "Add agent \u2014 commits to the registry",
      onSave: submit,
      onCancel: () => edit.close()
    }
  ));
}
function NewProfileForm({ agentNames, workspaceNames, say, onCreated, edit }) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState("");
  const [guidance, setGuidance] = React.useState("");
  const [assignableTo, setAssignableTo] = React.useState([]);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState([]);
  const [merge, setMerge] = React.useState("");
  const { busy, save, dialog } = useProfileSave(say, async () => {
    edit.close();
    await onCreated();
  });
  const dirty = !!name.trim() || !!guidance.trim() || assignableTo.length > 0 || allowedWorkspaces.length > 0 || !!merge;
  useDirtySignal(edit, true, dirty);
  const submit = () => save(
    "/api/profiles",
    "POST",
    { name: name.trim(), ...profileBody(guidance, assignableTo, allowedWorkspaces, merge) },
    "created",
    name.trim()
  );
  return /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement("span", { style: settingsCardLabel }, "add an authority profile"), /* @__PURE__ */ React.createElement(
    Input,
    {
      label: "Name",
      value: name,
      onChange: (e) => setName(e.target.value),
      placeholder: "letters, digits, - _ . \u2014 becomes authority/<name>.yaml, not renameable later"
    }
  ), /* @__PURE__ */ React.createElement(
    ProfileFields,
    {
      agentNames,
      workspaceNames,
      guidance,
      setGuidance,
      assignableTo,
      setAssignableTo,
      allowedWorkspaces,
      setAllowedWorkspaces,
      merge,
      setMerge
    }
  ), /* @__PURE__ */ React.createElement(
    EditActions,
    {
      ok: registryNameOk(name),
      busy,
      saveLabel: "Add authority profile \u2014 commits to the registry",
      onSave: submit,
      onCancel: () => edit.close()
    }
  ), dialog);
}
function SettingsScreen({ say, registerLeaveGuard }) {
  const { Button, Card, NavRow, ScreenHeader } = window.TidepoolDesignSystem_8a0ead;
  const [displayLanguage, setDisplayLanguage] = React.useState("");
  const [displayLanguageOptions, setDisplayLanguageOptions] = React.useState([]);
  const [displayLanguageLoaded, setDisplayLanguageLoaded] = React.useState(false);
  const loadDisplayLanguage = async () => {
    const { language, options } = await api("/api/settings/display-language", void 0, "GET");
    setDisplayLanguage(language);
    setDisplayLanguageOptions(options);
    setDisplayLanguageLoaded(true);
  };
  React.useEffect(() => {
    loadDisplayLanguage();
  }, []);
  const [quietHoursStart, setQuietHoursStart] = React.useState("");
  const [quietHoursEnd, setQuietHoursEnd] = React.useState("");
  const [quietHoursTz, setQuietHoursTz] = React.useState("");
  const [quietHoursLoaded, setQuietHoursLoaded] = React.useState(false);
  const loadQuietHours = async () => {
    const { start, end, tz } = await api("/api/settings/quiet-hours", void 0, "GET");
    setQuietHoursStart(start);
    setQuietHoursEnd(end);
    setQuietHoursTz(tz);
    setQuietHoursLoaded(true);
  };
  React.useEffect(() => {
    loadQuietHours();
  }, []);
  const [paceOffsets, setPaceOffsets] = React.useState(null);
  const loadPaceOffsets = async () => {
    setPaceOffsets(await api("/api/settings/pace-offsets", void 0, "GET"));
  };
  React.useEffect(() => {
    loadPaceOffsets();
  }, []);
  const [workspaces, setWorkspaces] = React.useState(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const load = async () => {
    try {
      setWorkspaces(await api("/api/workspaces", void 0, "GET"));
    } catch {
      setUnavailable(true);
      setWorkspaces([]);
    }
  };
  React.useEffect(() => {
    load();
  }, []);
  const [agents, setAgents] = React.useState(null);
  const [authorityProfiles, setAuthorityProfiles] = React.useState([]);
  const [agentsUnavailable, setAgentsUnavailable] = React.useState(false);
  const loadAgents = async () => {
    try {
      const res = await api("/api/agents", void 0, "GET");
      setAgents(res.agents);
      setAuthorityProfiles(res.authorityProfiles);
    } catch {
      setAgentsUnavailable(true);
      setAgents([]);
    }
  };
  React.useEffect(() => {
    loadAgents();
  }, []);
  const [profiles, setProfiles] = React.useState(null);
  const [profilesUnavailable, setProfilesUnavailable] = React.useState(false);
  const loadProfiles = async () => {
    try {
      const res = await api("/api/profiles", void 0, "GET");
      setProfiles(res.profiles);
    } catch {
      setProfilesUnavailable(true);
      setProfiles([]);
    }
  };
  React.useEffect(() => {
    loadProfiles();
  }, []);
  const [hostSkills, setHostSkills] = React.useState([]);
  const [hostSkillsDegraded, setHostSkillsDegraded] = React.useState(false);
  const loadSkills = async () => {
    try {
      const res = await api("/api/skills", void 0, "GET");
      setHostSkills(res.skills ?? []);
      setHostSkillsDegraded(!!res.degraded);
    } catch {
      setHostSkills([]);
      setHostSkillsDegraded(true);
    }
  };
  React.useEffect(() => {
    loadSkills();
  }, []);
  const refreshAfterProfile = async () => {
    await loadProfiles();
    await loadAgents();
  };
  const agentNames = (agents ?? []).map((a) => a.name);
  const workspaceNames = (workspaces ?? []).map((w) => w.name);
  const agentIcons = {};
  (agents ?? []).forEach((a) => {
    if (a.icon) agentIcons[a.name] = a.icon;
  });
  const [stack, setStack] = React.useState([]);
  const [editing, setEditing] = React.useState(null);
  const [dirty, setDirty] = React.useState(false);
  const [pending, setPending] = React.useState(null);
  const unsaved = React.useRef(false);
  unsaved.current = editing !== null && dirty;
  const guard = (move) => {
    if (unsaved.current) {
      setPending({ move });
      return true;
    }
    move();
    return false;
  };
  const closeEdit = () => {
    setEditing(null);
    setDirty(false);
  };
  const edit = {
    isOpen: (id) => editing === id,
    // `prime` fills the card's draft from the record. It runs with the open,
    // not before it, so a parked open (another card holds unsaved work) primes
    // only once the human has answered the discard dialog.
    open: (id, prime) => guard(() => {
      if (prime) prime();
      setEditing(id);
      setDirty(false);
    }),
    // `close` is the deliberate discard behind Cancel and the exit after a
    // successful save; `requestClose` is for a control that merely folds the
    // card away (the Add toggle), which must not drop a draft silently
    close: closeEdit,
    requestClose: () => guard(closeEdit),
    setDirty
  };
  const go = (next) => guard(() => {
    setStack(next);
    closeEdit();
  });
  React.useEffect(() => {
    registerLeaveGuard((move) => guard(move));
    return () => registerLeaveGuard(null);
  }, []);
  const SECTIONS = {
    workspaces: {
      title: "Workspaces",
      singular: "workspace",
      note: "where tasks run",
      items: workspaces,
      unavailable,
      footnote: "edits commit to the registry",
      indexSummary: (items) => `${items.length} \xB7 ${items.filter((w) => w.protected).length} protected`,
      rowIdentity: (w) => ({ label: w.name }),
      rowSummary: (w) => w.repo || w.path || "\u2014",
      record: (rec) => /* @__PURE__ */ React.createElement(WorkspaceRecord, { ws: rec, say, onChanged: load, edit }),
      createForm: () => /* @__PURE__ */ React.createElement(NewWorkspaceForm, { say, onCreated: load, edit })
    },
    agents: {
      title: "Agents",
      singular: "agent",
      note: "who does the work",
      items: agents,
      unavailable: agentsUnavailable,
      footnote: "edits commit to agents/<name>.md in the registry",
      indexSummary: (items) => `${items.length} agents`,
      rowIdentity: (a) => ({ agentName: a.name, agentIcon: a.icon ?? "" }),
      rowSummary: (a) => a.authority,
      record: (rec) => /* @__PURE__ */ React.createElement(
        AgentRecord,
        {
          agent: rec,
          authorityProfiles,
          hostSkills,
          hostSkillsDegraded,
          say,
          onChanged: loadAgents,
          edit
        }
      ),
      createForm: () => /* @__PURE__ */ React.createElement(
        NewAgentForm,
        {
          authorityProfiles,
          hostSkills,
          hostSkillsDegraded,
          say,
          onCreated: loadAgents,
          edit
        }
      )
    },
    profiles: {
      title: "Authority Profiles",
      singular: "authority profile",
      note: "what the work is allowed to do",
      items: profiles,
      unavailable: profilesUnavailable,
      footnote: "edits commit to authority/<name>.yaml in the registry",
      indexSummary: (items) => `${items.length} profiles`,
      rowIdentity: (p) => ({ label: p.name }),
      rowSummary: (p) => (p.assignable_to ?? []).join(", ") || "\u2014",
      record: (rec) => /* @__PURE__ */ React.createElement(
        ProfileRecord,
        {
          profile: rec,
          agentNames,
          agentIcons,
          workspaceNames,
          say,
          onChanged: refreshAfterProfile,
          edit
        }
      ),
      createForm: () => /* @__PURE__ */ React.createElement(
        NewProfileForm,
        {
          agentNames,
          workspaceNames,
          say,
          onCreated: refreshAfterProfile,
          edit
        }
      )
    }
  };
  const sectionSummary = (s, count = (items) => `${items.length} registered`) => s.unavailable ? "no registry configured" : s.items === null ? "loading\u2026" : count(s.items);
  const sectionKey = stack[0];
  const recordName = stack[1];
  const sec = SECTIONS[sectionKey];
  const addId = `new:${sectionKey}`;
  const adding = editing === addId;
  let body;
  if (stack.length === 0) {
    const rows = [
      {
        key: "board",
        label: "Board",
        summary: displayLanguageLoaded && quietHoursLoaded ? `${displayLanguage} \xB7 ${quietHoursStart}\u2013${quietHoursEnd}` : "loading\u2026"
      },
      ...Object.keys(SECTIONS).map((key) => ({
        key,
        label: SECTIONS[key].title,
        summary: sectionSummary(SECTIONS[key], SECTIONS[key].indexSummary),
        alert: SECTIONS[key].unavailable
      }))
    ];
    body = /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-xl)", margin: "0 0 2px" } }, "Settings"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 } }, "the board's preferences, and the registry it works from")), /* @__PURE__ */ React.createElement(Card, { padding: "0", style: { overflow: "hidden" } }, rows.map((r, i) => /* @__PURE__ */ React.createElement(
      NavRow,
      {
        key: r.key,
        label: r.label,
        summary: r.summary,
        testId: `settings-section-${r.key}`,
        summaryTone: r.alert ? "alert" : "muted",
        divider: i > 0,
        first: i === 0,
        last: i === rows.length - 1,
        onClick: () => go([r.key])
      }
    ))));
  } else if (sectionKey === "board") {
    body = /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(ScreenHeader, { title: "Board", backLabel: "Settings", meta: "board-wide preferences", onBack: () => go([]) }), displayLanguageLoaded && /* @__PURE__ */ React.createElement(
      DisplayLanguageCard,
      {
        language: displayLanguage,
        options: displayLanguageOptions,
        say,
        onSaved: loadDisplayLanguage,
        edit
      }
    ), quietHoursLoaded && /* @__PURE__ */ React.createElement(
      QuietHoursCard,
      {
        start: quietHoursStart,
        end: quietHoursEnd,
        tz: quietHoursTz,
        say,
        onSaved: loadQuietHours,
        edit
      }
    ), paceOffsets && /* @__PURE__ */ React.createElement(PaceOffsetsCard, { offsets: paceOffsets, say, onSaved: loadPaceOffsets, edit }), (!displayLanguageLoaded || !quietHoursLoaded || !paceOffsets) && /* @__PURE__ */ React.createElement(Card, { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "loading\u2026"), /* @__PURE__ */ React.createElement("p", { style: settingsFootnote }, "applies to every task the board picks up"));
  } else if (!sec) {
    body = /* @__PURE__ */ React.createElement(ScreenHeader, { title: "Settings", backLabel: "Settings", onBack: () => go([]) });
  } else if (recordName === void 0) {
    body = /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(ScreenHeader, { title: sec.title, backLabel: "Settings", meta: sectionSummary(sec), onBack: () => go([]) }, !sec.unavailable && sec.items && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => adding ? edit.requestClose() : edit.open(addId) }, adding ? "Close" : "Add")), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 } }, sec.note), sec.unavailable && /* @__PURE__ */ React.createElement(Card, { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "no registry configured on this board \u2014 ", sec.title.toLowerCase(), " need one"), adding && sec.createForm(), !sec.unavailable && sec.items === null && /* @__PURE__ */ React.createElement(Card, { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "loading\u2026"), !sec.unavailable && sec.items && sec.items.length === 0 && /* @__PURE__ */ React.createElement(Card, { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "none registered yet \u2014 Add is above"), !sec.unavailable && sec.items && sec.items.length > 0 && /* @__PURE__ */ React.createElement(Card, { padding: "0", style: { overflow: "hidden" } }, sec.items.map((it, i) => /* @__PURE__ */ React.createElement(
      NavRow,
      {
        key: it.name,
        ...sec.rowIdentity(it),
        summary: sec.rowSummary(it),
        testId: `settings-record-${sectionKey}-${it.name}`,
        divider: i > 0,
        first: i === 0,
        last: i === sec.items.length - 1,
        onClick: () => go([sectionKey, it.name])
      }
    ))), /* @__PURE__ */ React.createElement("p", { style: settingsFootnote }, sec.footnote));
  } else {
    const items = sec.items ?? [];
    const idx = items.findIndex((x) => x.name === recordName);
    const rec = idx === -1 ? null : items[idx];
    body = /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      ScreenHeader,
      {
        title: recordName,
        backLabel: sec.title,
        meta: rec ? `${sec.singular} \xB7 ${idx + 1} of ${items.length}` : sec.singular,
        onBack: () => go([sectionKey])
      }
    ), !rec && sec.items === null && /* @__PURE__ */ React.createElement(Card, { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "loading\u2026"), !rec && sec.items !== null && /* @__PURE__ */ React.createElement(Card, { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "no longer in the registry \u2014 it may have been removed outside the board"), rec && sec.record(rec), /* @__PURE__ */ React.createElement("p", { style: settingsFootnote }, sec.footnote));
  }
  return /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px", display: "flex", flexDirection: "column", gap: 14 } }, body, /* @__PURE__ */ React.createElement(
    PortalDialog,
    {
      open: !!pending,
      title: "Discard unsaved changes?",
      onClose: () => setPending(null),
      footer: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { variant: "secondary", onClick: () => setPending(null) }, "Keep editing"), /* @__PURE__ */ React.createElement(Button, { variant: "danger", onClick: () => {
        const p = pending;
        setPending(null);
        closeEdit();
        p.move();
      } }, "Discard"))
    },
    /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "var(--text-sm)" } }, "The card you're editing has changes that were never saved. Leaving now drops them.")
  ));
}
function toQuestionCardShape(task, parentTask) {
  return {
    id: task.id,
    parent: task.parent_id,
    agent: parentTask?.assignee ?? "\u2014",
    context: task.purpose,
    items: (task.question_items ?? []).map((item) => ({
      title: item.title,
      detail: item.detail,
      options: item.options.map((o) => ({ label: o, recommended: o === item.recommendation }))
    }))
  };
}
function QuestionDeepLinkView({ questionId, onDone, onTranslate }) {
  const { Button, Card } = window.TidepoolDesignSystem_8a0ead;
  const [q, setQ] = React.useState(void 0);
  const [rawTask, setRawTask] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/tasks/${questionId}`);
      const task = res.ok ? await res.json() : null;
      if (!task || task.type !== "question" || task.status !== "todo") {
        if (!cancelled) setQ(null);
        return;
      }
      const parentTask = task.parent_id ? await fetch(`/api/tasks/${task.parent_id}`).then((r) => r.ok ? r.json() : null) : null;
      if (cancelled) return;
      setRawTask(task);
      setQ(toQuestionCardShape(task, parentTask));
    })().catch(() => {
      if (!cancelled) setQ(null);
    });
    return () => {
      cancelled = true;
    };
  }, [questionId]);
  const answer = async (answers) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/tasks/${questionId}/answer`, { answers });
      onDone(rawTask);
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };
  if (q === void 0) {
    return /* @__PURE__ */ React.createElement("div", { style: { height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-page)" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: "var(--text-2xl)", color: "var(--tide-5)" } }, "tidepool"));
  }
  if (q === null) {
    return /* @__PURE__ */ React.createElement("div", { style: { height: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: 24, boxSizing: "border-box", background: "var(--surface-page)" } }, /* @__PURE__ */ React.createElement(Card, { style: { textAlign: "center", padding: 24, display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "This question is no longer available \u2014 it may already be answered."), /* @__PURE__ */ React.createElement(Button, { variant: "primary", onClick: () => onDone(null) }, "Open board")));
  }
  return (
    // TpSingleQuestion is `position: absolute; inset: 0` (same as the design
    // kit's own shell) — needs this positioned, width-capped ancestor so it
    // covers the 440px column instead of the full viewport.
    /* @__PURE__ */ React.createElement("div", { style: { height: "100vh", position: "relative", overflow: "hidden", background: "var(--surface-page)" } }, /* @__PURE__ */ React.createElement(TpSingleQuestion, { q, onAnswer: answer, onClose: () => onDone(null), onTranslate }), err && /* @__PURE__ */ React.createElement("div", { style: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 60, fontSize: "var(--text-sm)", color: "#fff", background: "var(--danger-fg, #c0392b)", borderRadius: "var(--radius-md)", padding: "10px 16px" } }, err))
  );
}
function TaskActionsDialog({ task, onAddChild, onEdit, onCancel, onClose }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px", display: "flex", flexDirection: "column", gap: 10 } }, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-lg)", margin: "0 0 2px" } }, task.title), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-2xs)", fontFamily: "var(--font-mono)", color: "var(--text-muted)", margin: "0 0 8px" } }, task.id, " \xB7 ", task.type), /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "lg", full: true, onClick: onAddChild }, "Add child"), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "lg", full: true, onClick: onEdit }, "Edit"), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", size: "lg", full: true, onClick: onCancel }, "Cancel task"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "lg", full: true, onClick: onClose }, "Close"));
}
function EditTaskDialog({ taskCard, onSaved, onClose, say }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const [full, setFull] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [candidates, setCandidates] = React.useState({ assignees: [], workspaces: [] });
  const [fields, setFields] = React.useState(null);
  React.useEffect(() => {
    fetch("/api/registry/candidates").then((r) => r.json()).then(setCandidates).catch(() => {
    });
    api(`/api/tasks/${taskCard.id}`, void 0, "GET").then((t) => {
      setFull(t);
      setFields({
        title: t.title ?? "",
        purpose: t.purpose ?? "",
        completion_criteria: t.completion_criteria ?? "",
        assignee: t.assignee ?? "",
        workspace: t.workspace ?? "",
        risk_flag: !!t.risk_flag,
        review_flag: !!t.review_flag
      });
    }).catch((err) => say("danger", "could not load task", String(err.message || err)));
  }, [taskCard.id]);
  if (!full || !fields) {
    return /* @__PURE__ */ React.createElement("div", { style: { padding: "24px 16px", color: "var(--text-muted)" } }, "loading\u2026");
  }
  const issueBacked = full.github_issue_number != null;
  const set = (k, v) => setFields((f) => ({ ...f, [k]: v }));
  const withPlaceholder = (label, names) => [{ value: "", label }, ...names.map((n) => ({ value: n, label: n }))];
  const changed = () => {
    const out = {};
    if (!issueBacked) {
      if (fields.title !== (full.title ?? "")) out.title = fields.title;
      if (fields.purpose !== (full.purpose ?? "")) out.purpose = fields.purpose;
      if (fields.completion_criteria !== (full.completion_criteria ?? "")) out.completion_criteria = fields.completion_criteria;
      if (fields.workspace !== (full.workspace ?? "")) out.workspace = fields.workspace;
    }
    if (fields.assignee !== (full.assignee ?? "")) out.assignee = fields.assignee;
    if (fields.risk_flag !== !!full.risk_flag) out.risk_flag = fields.risk_flag;
    if (fields.review_flag !== !!full.review_flag) out.review_flag = fields.review_flag;
    return out;
  };
  const submit = async () => {
    const patch = changed();
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api(`/api/tasks/${taskCard.id}`, patch, "PATCH");
      say("info", "task edited", taskCard.id);
      await onSaved();
      onClose();
    } catch (err) {
      say("danger", "edit failed", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-xl)", margin: "0 0 2px" } }, "Edit"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 16px" } }, issueBacked ? "issue-backed \u2014 content and workspace stay on GitHub, only board-side fields are editable" : "unconsumed fields only \u2014 type and parent link are not editable"), /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, !issueBacked && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Input, { label: "Title", value: fields.title, onChange: (e) => set("title", e.target.value) }), /* @__PURE__ */ React.createElement(Input, { label: "Purpose", multiline: true, rows: 2, value: fields.purpose, onChange: (e) => set("purpose", e.target.value) }), /* @__PURE__ */ React.createElement(Input, { label: "Completion criteria", multiline: true, rows: 2, value: fields.completion_criteria, onChange: (e) => set("completion_criteria", e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: issueBacked ? "1fr" : "1fr 1fr", gap: 12 } }, /* @__PURE__ */ React.createElement(Select, { label: "Assignee", options: withPlaceholder("(default agent)", candidates.assignees), value: fields.assignee, onChange: (e) => set("assignee", e.target.value) }), !issueBacked && /* @__PURE__ */ React.createElement(Select, { label: "Workspace", options: withPlaceholder("(default workspace)", candidates.workspaces), value: fields.workspace, onChange: (e) => set("workspace", e.target.value) })), /* @__PURE__ */ React.createElement(Checkbox, { label: "risk flag \u2014 this task has irreversible external effects", checked: fields.risk_flag, onChange: () => set("risk_flag", !fields.risk_flag) }), /* @__PURE__ */ React.createElement(Checkbox, { label: "review flag \u2014 request an on-completion review", checked: fields.review_flag, onChange: () => set("review_flag", !fields.review_flag) }), /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "lg", full: true, disabled: busy, onClick: submit }, "Save changes"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "lg", full: true, disabled: busy, onClick: onClose }, "Cancel")));
}
function CancelTaskDialog({ task, onCancelled, onClose, say }) {
  const { Button, Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/cancel`, reason.trim() ? { reason: reason.trim() } : {}, "POST");
      say("info", "task cancelled", task.id);
      await onCancelled();
      onClose();
    } catch (err) {
      say("danger", "cancel failed", String(err.message || err));
    }
    setBusy(false);
  };
  return /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 16px" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontSize: "var(--text-xl)", margin: "0 0 2px" } }, "Cancel task"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 16px" } }, 'cancels "', task.title, '" and its unfinished descendants \u2014 the record is kept, never erased'), /* @__PURE__ */ React.createElement(Card, { style: { display: "flex", flexDirection: "column", gap: 14 } }, /* @__PURE__ */ React.createElement(Input, { label: "Reason (optional)", multiline: true, rows: 2, value: reason, onChange: (e) => setReason(e.target.value), placeholder: "left blank, only the fact of the cancel is recorded" }), /* @__PURE__ */ React.createElement(Button, { variant: "primary", size: "lg", full: true, disabled: busy, onClick: submit }, "Cancel this task"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "lg", full: true, disabled: busy, onClick: onClose }, "Keep it")));
}
function App() {
  const { Toast, Button, IdChip } = window.TidepoolDesignSystem_8a0ead;
  const [data, setData] = React.useState(null);
  const [tab, setTabRaw] = React.useState("triage");
  const [tabDir, setTabDir] = React.useState("right");
  const [toast, setToast] = React.useState(null);
  const [wash, setWash] = React.useState(null);
  const [addChildParent, setAddChildParent] = React.useState(null);
  const [actionsTask, setActionsTask] = React.useState(null);
  const [editTaskCard, setEditTaskCard] = React.useState(null);
  const [cancelTaskCard, setCancelTaskCard] = React.useState(null);
  const [deepLinkQuestionId, setDeepLinkQuestionId] = React.useState(
    () => new URLSearchParams(location.search).get("question")
  );
  const [notifPermission, setNotifPermission] = React.useState(
    () => typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [translationEnabled, setTranslationEnabled] = React.useState(true);
  React.useEffect(() => {
    api("/api/settings/display-language", void 0, "GET").then(({ language }) => setTranslationEnabled(language !== "English")).catch(() => {
    });
  }, []);
  const onTranslateProp = translationEnabled ? translateTarget : void 0;
  const tabOrder = tabs.map((x) => x.key);
  const pointerDown = React.useRef(false);
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  React.useEffect(() => {
    registerServiceWorker().then((reg) => {
      if (reg && typeof Notification !== "undefined" && Notification.permission === "granted") {
        subscribeToPush(reg).catch(() => {
        });
      }
    });
  }, []);
  React.useEffect(() => {
    fetch("/api/settings/timezone").then((r) => r.json()).then(({ tz }) => {
      const observed = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (observed && observed !== tz) return api("/api/settings/timezone", { tz: observed });
    }).catch(() => {
    });
  }, []);
  const enableNotifications = async () => {
    try {
      const permission = await Notification.requestPermission();
      setNotifPermission(permission);
      if (permission === "granted") {
        const reg = await registerServiceWorker();
        await subscribeToPush(reg);
        say("success", "notifications enabled", "questions outside quiet hours arrive immediately");
      }
    } catch (err) {
      say("danger", "failed to enable notifications", String(err.message || err));
    }
  };
  const refreshFull = () => fetchData().then(setData).catch(() => {
  });
  const applyTab = (next) => {
    setTabRaw((prev) => {
      if (next !== prev) setTabDir(tabOrder.indexOf(next) > tabOrder.indexOf(prev) ? "right" : "left");
      return next;
    });
    refreshFull();
  };
  const leaveGuard = React.useRef(null);
  const setTab = (next) => {
    if (leaveGuard.current) {
      leaveGuard.current(() => applyTab(next));
      return;
    }
    applyTab(next);
  };
  React.useEffect(() => {
    refreshFull();
    const dn = () => {
      pointerDown.current = true;
    };
    const up = () => {
      pointerDown.current = false;
    };
    window.addEventListener("pointerdown", dn);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    const iv = setInterval(() => {
      if (pointerDown.current || tabRef.current === "triage") return;
      refreshFull();
    }, 15e3);
    return () => {
      clearInterval(iv);
      window.removeEventListener("pointerdown", dn);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);
  React.useEffect(() => {
    lucide.createIcons();
  });
  const dismissToast = React.useCallback(() => {
    setToast((cur) => cur && !cur.leaving ? { ...cur, leaving: true } : cur);
    setTimeout(() => setToast(null), 260);
  }, []);
  React.useEffect(() => {
    if (!toast || toast.leaving) return;
    const t = setTimeout(dismissToast, 3200);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);
  const say = (kind, msg, detail) => setToast({ kind, msg, detail });
  const runWash = (label, emoji, apply) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      apply();
      return;
    }
    setWash({ label, emoji });
    setTimeout(apply, WASH_MS * 0.4);
    setTimeout(() => setWash(null), WASH_MS + 50);
  };
  const refresh = async () => {
    const fresh = await fetchData();
    setData((d) => tab === "triage" && d ? { ...fresh, questions: d.questions, log: d.log, lastLogId: d.lastLogId } : fresh);
    return fresh;
  };
  React.useEffect(() => {
    if (!data?.throttleRevalidating) return;
    const iv = setInterval(() => {
      void refresh().then((fresh) => {
        if (!fresh.throttleRevalidating) clearInterval(iv);
      }).catch(() => {
      });
    }, 1e3);
    return () => clearInterval(iv);
  }, [data?.throttleRevalidating]);
  const answerNow = async (q, a) => {
    try {
      await api(`/api/tasks/${q.id}/answer`, { answers: a, triage: true });
    } catch (err) {
      say("danger", "answer failed", String(err.message || err));
      throw err;
    }
  };
  const objectNow = async (entry, direction) => {
    try {
      await api("/api/triage/objection", { entry_id: entry.id, comment: direction });
    } catch (err) {
      say("danger", "objection failed", String(err.message || err));
      throw err;
    }
  };
  const scratchAdd = async (text) => {
    try {
      const l = await api("/api/triage/scratchpad", { line: text });
      return { id: l.id, text: l.line };
    } catch (err) {
      say("danger", "scratchpad failed", String(err.message || err));
      throw err;
    }
  };
  const displayedReported = React.useRef(/* @__PURE__ */ new Set());
  const reportDisplayed = (entries) => {
    const ids = entries.map((e) => e.id).filter((id) => typeof id === "number" && !displayedReported.current.has(id));
    if (!ids.length) return;
    ids.forEach((id) => displayedReported.current.add(id));
    api("/api/triage/displayed", { entry_ids: ids }).catch(() => {
      ids.forEach((id) => displayedReported.current.delete(id));
    });
  };
  const loadPreview = async () => {
    const res = await fetch("/api/triage");
    if (!res.ok) throw new Error(res.statusText);
    const { queue } = await res.json();
    return (queue ?? []).map((t) => ({
      id: t.id,
      title: liveTitle(t),
      assignee: t.assignee ?? void 0,
      assigneeIcon: t.assignee ? data.icons[t.assignee] : void 0,
      risk: !!t.risk_flag,
      blocked: t.status === "blocked",
      frontInserted: t.front_inserted
    }));
  };
  const commitTriage = async (answers, objections, scratch) => {
    try {
      await api("/api/triage/commit", {
        // kit dispositions already speak the domain vocabulary
        scratchpad: scratch.filter((s) => typeof s.id === "number").map((s) => ({ id: s.id, disposition: s.kind }))
      });
    } catch (err) {
      refreshFull();
      say(
        "danger",
        "triage commit failed \u2014 nothing applied, cursor NOT advanced",
        String(err.message || err)
      );
      return;
    }
    for (const [qid, a] of Object.entries(answers)) {
      if (!a) continue;
      const q = data.questions.find((x) => x.id === qid);
      if (q && q.parent) markFront(q.parent);
    }
    let cursorNote = "";
    try {
      if (data.lastLogId != null) await api("/api/log/cursor", { last_read: data.lastLogId });
    } catch {
      cursorNote = " \xB7 read cursor NOT advanced (retry from the log)";
    }
    const answered = Object.values(answers).filter(Boolean).length;
    const repairTasks = new Set(Object.keys(objections).map((k) => data.log.find((e) => String(e.id) === String(k))?.taskId).filter(Boolean)).size;
    const noted = scratch.filter((s) => s.kind !== "discard").length;
    runWash("The tide is going out.", "\u{1F30A}", () => {
      setTab("queue");
      say(
        cursorNote ? "warn" : "success",
        "triage committed \u2014 one transaction",
        `${answered} answered${repairTasks ? ` \xB7 ${repairTasks} repair` : ""}${noted ? ` \xB7 ${noted} from scratchpad` : ""} \xB7 immediate poll fired${cursorNote}`
      );
    });
  };
  const moveFront = async (id) => {
    const wasHead = data.queue[0]?.id === id;
    try {
      await api(`/api/tasks/${id}/move`, { after: null });
      markFront(id);
      const fresh = await refresh();
      if (!wasHead) {
        say("info", "moved to front", "reordered only \u2014 press \u2191 again to run it now");
      } else if (fresh.pickupHalt) {
        const { kind, msg, detail } = fresh.pickupHalt.toast;
        say(kind, msg, detail);
      } else {
        say("success", "moved to front \u2014 immediate poll fired", id);
      }
    } catch (err) {
      say("danger", "move failed", String(err.message || err));
    }
  };
  const togglePause = async () => {
    const next = !data.paused;
    try {
      await api("/api/pause", { paused: next });
      await refresh();
      say(
        next ? "info" : "success",
        next ? "pickup paused" : "pickup resumed",
        next ? data.slot?.taskId ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(IdChip, { id: data.slot.taskId, style: { display: "inline-block", verticalAlign: "bottom" } }), " finishes \xB7 nothing new starts") : "nothing starts until resumed" : "immediate poll fired"
      );
    } catch (err) {
      say("danger", "pause toggle failed", String(err.message || err));
    }
  };
  const setSpendDown = async (window2) => {
    try {
      await api("/api/spend-down", { window: window2 });
      await refresh();
      say(
        window2 ? "warn" : "info",
        window2 ? `spend-down armed \xB7 ${window2}` : "spend-down cancelled",
        window2 ? "pace line off \u2014 burns to the 100% cap, expires at the window reset" : "pace line back on"
      );
    } catch (err) {
      say("danger", "spend-down failed", String(err.message || err));
    }
  };
  const reorder = async (next, movedId, pos) => {
    try {
      const idx = next.findIndex((t) => t.id === movedId);
      const after = idx <= 0 ? null : next[idx - 1].id;
      setData((d) => ({ ...d, queue: next }));
      await api(`/api/tasks/${movedId}/move`, { after });
      await refresh();
      say("info", "queue reordered", `${movedId} \u2192 position ${pos}`);
    } catch (err) {
      await refresh();
      say("danger", "reorder failed", String(err.message || err));
    }
  };
  const loadHandoff = async (entry) => {
    const res = await fetch(`/api/tasks/${entry.taskId}`);
    if (!res.ok) throw new Error(res.statusText);
    const task = await res.json();
    return task.handoff_doc ?? "(no handoff doc)";
  };
  const register = async (fields) => {
    try {
      const t = await api("/api/tasks", fields);
      runWash("Into the pool.", "\u{1FAE7}", () => {
        setTab("queue");
        say("info", "registered \u2014 appended to queue tail", t.id);
      });
    } catch (err) {
      if (err.status !== 422) say("danger", "registration failed", String(err.message || err));
      throw err;
    }
  };
  const openTask = (t) => {
    const settled = t.status === "done";
    const othersInProgress = t.status === "in_progress" && t.rawAssignee !== "human";
    if (settled || othersInProgress) {
      say("info", t.title, `${t.id} \xB7 ${t.type}`);
      return;
    }
    setActionsTask(t);
  };
  const addChild = async (fields) => {
    try {
      const t = await api("/api/tasks", fields);
      say(
        "info",
        t.type === "question" ? "sent for approval" : "child added \u2014 appended to queue tail",
        t.id
      );
      await refreshFull();
    } catch (err) {
      say("danger", "add child failed", String(err.message || err));
      throw err;
    }
  };
  if (deepLinkQuestionId) {
    return /* @__PURE__ */ React.createElement(
      QuestionDeepLinkView,
      {
        questionId: deepLinkQuestionId,
        onTranslate: onTranslateProp,
        onDone: (answeredTask) => {
          if (answeredTask && answeredTask.parent_id) markFront(answeredTask.parent_id);
          history.replaceState(null, "", location.pathname);
          setDeepLinkQuestionId(null);
          refreshFull();
        }
      }
    );
  }
  if (!data) {
    return /* @__PURE__ */ React.createElement("div", { style: { height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-page)" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: "var(--text-2xl)", color: "var(--tide-5)" } }, "tidepool"));
  }
  const unreadCount = data.log.filter((l) => l.unread).length;
  return /* @__PURE__ */ React.createElement("div", { style: { height: "100vh", display: "flex", flexDirection: "column", background: "var(--surface-page)", boxShadow: "0 0 40px rgba(23,33,30,0.12)", position: "relative", overflow: "hidden" } }, wash && /* @__PURE__ */ React.createElement(TpTideWash, { label: wash.label, emoji: wash.emoji, duration: WASH_MS }), /* @__PURE__ */ React.createElement("header", { style: { display: "flex", alignItems: "center", gap: 8, padding: "14px 16px 10px", borderBottom: "1px solid var(--border-hairline)", position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 10 } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 22, color: "var(--tide-5)" } }, "tidepool"), /* @__PURE__ */ React.createElement("span", { style: { marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: data.paused ? "var(--rock-4)" : "var(--text-muted)" } }, data.paused ? "pickup paused \xB7 " : "", data.questions.length, " questions \xB7 ", unreadCount, " new log \xB7 queue ", data.queue.length)), data.triageActive && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--sun-2)", background: "var(--sun-1)" } }, /* @__PURE__ */ React.createElement("span", { style: { flex: 1, fontSize: "var(--text-sm)", color: "var(--text-body)" } }, "triage in progress \u2014 pickup is stopped"), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", onClick: () => commitTriage({}, {}, []) }, "commit triage")), notifPermission === "default" && "serviceWorker" in navigator && "PushManager" in window && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)", background: "var(--rock-2)" } }, /* @__PURE__ */ React.createElement("span", { style: { flex: 1, fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "Enable notifications to get questions outside quiet hours the moment they're asked."), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", onClick: enableNotifications }, "Enable")), /* @__PURE__ */ React.createElement("main", { className: "tp-scroll", style: { flex: 1, minHeight: 0, overflowY: tab === "board" ? "hidden" : "auto", paddingBottom: tab === "board" ? 56 : 76, boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement("div", { key: tab, className: tabDir === "right" ? "tp-tab-right" : "tp-tab-left", style: tab === "board" ? { height: "100%" } : { minHeight: "100%" } }, tab === "triage" && (data.questions.length || unreadCount ? /* @__PURE__ */ React.createElement(
    TriageScreen,
    {
      data,
      onCommit: commitTriage,
      onReorderQueue: reorder,
      onFront: moveFront,
      loadHandoff,
      onAnswer: answerNow,
      onObject: objectNow,
      onScratchAdd: scratchAdd,
      onDisplayed: reportDisplayed,
      loadPreview,
      onTranslate: onTranslateProp
    }
  ) : /* @__PURE__ */ React.createElement("div", { style: { padding: "64px 24px", textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 28, marginBottom: 6 } }, "\u{1F41A}"), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: "var(--text-2xl)", color: "var(--tide-5)", marginBottom: 8 } }, "Low tide. Go enjoy your coffee."), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } }, "the pool refills as tasks come in."))), tab === "board" && /* @__PURE__ */ React.createElement(BoardScreen, { data, onOpenTask: openTask }), tab === "queue" && /* @__PURE__ */ React.createElement(QueueScreen, { data, slotState: data.running ? "busy" : data.throttled ? "limit" : "free", paused: data.paused, onTogglePause: togglePause, spendDown: data.spendDown, onSpendDown: setSpendDown, onFront: moveFront, onDoneHuman: () => {
  }, onReorder: reorder }), tab === "register" && /* @__PURE__ */ React.createElement(RegisterScreen, { onRegister: register }), tab === "settings" && /* @__PURE__ */ React.createElement(SettingsScreen, { say, registerLeaveGuard: (fn) => {
    leaveGuard.current = fn;
  } }))), toast && /* @__PURE__ */ React.createElement("div", { style: { position: "fixed", bottom: 86, left: "50%", transform: "translateX(-50%)", zIndex: 50, width: "calc(100% - 32px)", maxWidth: 408 } }, /* @__PURE__ */ React.createElement("div", { className: toast.leaving ? "tp-toast-out" : "tp-toast-in" }, /* @__PURE__ */ React.createElement(Toast, { kind: toast.kind, detail: toast.detail, onDismiss: dismissToast }, toast.msg))), /* @__PURE__ */ React.createElement(PortalDialog, { open: !!addChildParent, onClose: () => setAddChildParent(null) }, addChildParent && /* @__PURE__ */ React.createElement(RegisterScreen, { parentTask: addChildParent, onRegister: addChild, onClose: () => setAddChildParent(null) })), /* @__PURE__ */ React.createElement(PortalDialog, { open: !!actionsTask, onClose: () => setActionsTask(null) }, actionsTask && /* @__PURE__ */ React.createElement(
    TaskActionsDialog,
    {
      task: actionsTask,
      onAddChild: () => {
        setAddChildParent(actionsTask);
        setActionsTask(null);
      },
      onEdit: () => {
        setEditTaskCard(actionsTask);
        setActionsTask(null);
      },
      onCancel: () => {
        setCancelTaskCard(actionsTask);
        setActionsTask(null);
      },
      onClose: () => setActionsTask(null)
    }
  )), /* @__PURE__ */ React.createElement(PortalDialog, { open: !!editTaskCard, onClose: () => setEditTaskCard(null) }, editTaskCard && /* @__PURE__ */ React.createElement(EditTaskDialog, { taskCard: editTaskCard, say, onSaved: refreshFull, onClose: () => setEditTaskCard(null) })), /* @__PURE__ */ React.createElement(PortalDialog, { open: !!cancelTaskCard, onClose: () => setCancelTaskCard(null) }, cancelTaskCard && /* @__PURE__ */ React.createElement(CancelTaskDialog, { task: cancelTaskCard, say, onCancelled: refreshFull, onClose: () => setCancelTaskCard(null) })), /* @__PURE__ */ React.createElement("nav", { style: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 440, display: "flex", background: "var(--surface-card)", borderTop: "1px solid var(--border-hairline)", zIndex: 20 } }, tabs.map((t) => {
    const active = tab === t.key;
    return /* @__PURE__ */ React.createElement(
      "button",
      {
        key: t.key,
        onClick: () => setTab(t.key),
        style: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          padding: "10px 0 12px",
          minHeight: 56,
          background: "none",
          border: "none",
          cursor: "pointer",
          color: active ? "var(--tide-4)" : "var(--text-muted)",
          borderTop: `2px solid ${active ? "var(--tide-4)" : "transparent"}`,
          marginTop: -1
        }
      },
      /* @__PURE__ */ React.createElement("i", { "data-lucide": t.icon, style: { width: 20, height: 20 } }),
      /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--text-2xs)", fontFamily: "var(--font-mono)" } }, t.label.toLowerCase()),
      t.key === "triage" && data.questions.length + unreadCount > 0 && !active && /* @__PURE__ */ React.createElement("span", { style: { position: "absolute", transform: "translate(16px, -2px)", minWidth: 15, height: 15, borderRadius: 999, background: "var(--tide-4)", color: "#fff", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: "15px", padding: "0 3px" } }, data.questions.length + unreadCount)
    );
  })));
}
(function mountWhenReady(tries) {
  if (window.TidepoolDesignSystem_8a0ead) {
    ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
  } else if (tries > 0) {
    setTimeout(() => mountWhenReady(tries - 1), 100);
  } else {
    document.getElementById("root").innerHTML = '<p style="padding:24px;font-family:monospace;font-size:12px;color:#5c6b66">_ds_bundle.js failed to load \u2014 recompile the design system.</p>';
  }
})(50);
