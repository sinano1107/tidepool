// Vertically scrollable content that fades out only at its clipped edge(s).
export function FadeScroll({ children, style }) {
  const ref = React.useRef(null);
  const [edges, setEdges] = React.useState({ top: false, bottom: false });
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
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
    edges.top ? `transparent 0, black ${fade}px` : 'black 0',
    edges.bottom ? `black calc(100% - ${fade}px), transparent 100%` : 'black 100%',
  ].join(', ');
  const mask = `linear-gradient(to bottom, ${stops})`;
  return (
    <div ref={ref} onScroll={update} className="tp-scroll" style={{ WebkitMaskImage: mask, maskImage: mask, ...style }}>
      {children}
    </div>
  );
}
