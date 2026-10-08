// Triage flow (ADR 0092 決定4) — 質問 → ログ流し読み → merge 判断 → キュー確認 → コミット。
// 着地 question は先頭の質問ステップではなく流し読みの後ろの merge 判断に並ぶ:
// 流し読みの前に merge を答えれば異議の機会が失われ、後に答えても修理子がまだ無い。
// Loaded as a text/babel script from index.html; components read from the DS bundle at render time.

// この画面が扱う形 —— 画面内で閉じた型で、集合ごとのサーバ型の移送は issue #352 が持つ。

/** 質問カード1枚が読む形。作るのは webui/app.tsx の toQuestionCardShape で、
 *  あちらの戻り値型がこれである(写しを2本持たない)。 */
interface TpQuestionItem {
  title: string;
  detail?: string | null;
  /** memory の提案 question で移された pin の今の置き場(ADR 0162 決定6)—— detail の下に出す。 */
  movedNote?: string;
  options: { label: string; recommended: boolean }[];
}
interface TpQuestion {
  id: string;
  blocking?: string | null;
  agent: string;
  agentIcon?: string;
  board: boolean;
  context: string;
  items: TpQuestionItem[];
  /** 承認 question なら 'approval'、上方伝播があれば note に注記(issue #757)。 */
  kind?: 'approval';
  note?: string;
  /** 修正値を添えられる提案 question(ADR 0150 決定2・ADR 0152 決定2): 表の行の提案は tier / effort、agent の tier の提案は下げ先 `to`、
   *  段の説明の提案は文面、段を足す提案は名前・説明・位置、memory の approve / consolidate は `candidateId` の文言と宛先(Exemplar なら title・宛先と注釈 list)。 */
  amendable?: 'row' | 'agent_tier' | 'tier_description' | 'add_tier' | 'memory';
  /** 段を足す提案の段 —— 修正値の欄の初期値(issue #1439)。 */
  proposedTier?: { name: string; description: string; position: number };
  /** agent の tier の提案の pin の tier —— 下げ先の選択肢はこれより下の段(ADR 0150 決定2)。 */
  amendBelow?: string;
  candidateId?: number;
  /** comment が要る選択肢 —— 盤面の `needs_comment` 注釈(ADR 0179 決定4)。 */
  needsComment?: string[];
  /** 自由記述の override を受けるか —— 盤面の `free_text` 注釈(issue #1309)。固定選択肢の question は false。 */
  freeText: boolean;
  /** 行の Quarantine の question(ADR 0184 決定6)—— settings タブを開くボタンを持つ。 */
  opensSettings?: boolean;
}
/** approve に添える修正値。空欄は送らない(memory の宛先の null = 全員は送る)。 */
type TpAmendment = {
  tier?: string; effort?: string; to?: string; description?: string; name?: string; position?: number;
  title?: string; text?: string; addressee?: string | null; original_title?: string; original_text?: string;
  annotations?: ReturnType<typeof annotationsToSend>;
};
/** トリアージが受け取る question —— 着地 question だけが `landing` を持つ
 *  (ADR 0092 決定4)。判定は盤面側で、ここは描画だけ。 */
interface TpTriageQuestion extends TpQuestion {
  landing?: { blocked_by: string | null } | null;
}
/** POST /api/translate の対象(ADR 0015)と、その答えの4状態。`translated` の
 *  中身は対象ごとに違う欄に載る —— 呼び手が自分の欄だけを読む。 */
type TpTranslateTarget =
  | { type: 'question' | 'handoff'; task_id: string }
  | { type: 'log_entry'; event_id: number }
  | { type: 'memory_entry'; entry_id: number }
  | { type: 'to_english' | 'back_translation'; text: string };
type TpTranslateFn = (
  target: TpTranslateTarget,
  opts?: { signal?: AbortSignal },
) => Promise<TpTranslation>;
type TpTranslation =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | WireContract['POST /api/translate'];
/** 流し読みの1行 —— LogEntry が受け取る形 + この画面が読む欄。 */
type TpLogEntry = NonNullable<import('../design-system/components/board/LogEntry').LogEntryProps['entry']> & {
  id: number;
  taskId: string;
  unread: boolean;
  kind: 'completion' | 'decision';
  handoffPresent: boolean;
  workspace?: string | null;
  pendingObjections?: string[];
  bundledObjections?: string[];
};
/** scratchpad の1行(サーバが id を振る)。 */
interface TpScratchLine {
  id: number;
  text: string;
}

function TpWaterline({ progress }: { progress: number }) {
  return (
    <div style={{ height: 2, background: 'var(--rock-2)', position: 'relative', borderRadius: 1 }}>
      <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${progress * 100}%`, background: 'var(--tide-4)', borderRadius: 1, transition: 'width var(--duration-slow) var(--ease-tidal)' }}></div>
    </div>
  );
}

function TpSegmentGauge({ total, filled }: { total: number; filled: number }) {
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{ flex: 1, height: 6, borderRadius: 999, background: i < filled ? 'var(--tide-4)' : 'var(--tide-2)', transition: 'background var(--duration-calm) var(--ease-tidal)' }}></div>
      ))}
    </div>
  );
}

// One question item's option list — a pick, or a free-text override.
// Fires onChange(label) on every pick; a pick only changes TpQuestionCard's
// local draft and can be re-picked freely — the card's Submit sends the whole
// answer set atomically (issue #30 / #1233). This component only ever reports
// its own item's value, never submits on its own.
// translated: { title, detail } for this item (issue #47), shown as a second
// line under each original — the options below never take a translated
// variant (CONTEXT.md's scope exclusion: a mistranslated option is a
// 30-second decision an agent reads back).
function TpQuestionItemPicker({ item, value, locked, freeText, onChange, translated, disabled = [] }: {
  item: TpQuestionItem;
  /** 今は選べない選択肢(宛先が死んでいる memory 提案の approve)。 */
  disabled?: string[];
  /** 未選択は null / undefined のどちらでも来る(呼び手は配列の添字)。 */
  value?: string | null;
  locked: boolean;
  /** false なら override のリンクも入力欄も出さない(issue #1309)。 */
  freeText: boolean;
  onChange: (value: string | null) => void;
  translated?: { title: string; detail?: string } | null;
}) {
  const { Input, Button } = window.TidepoolDesignSystem_8a0ead;
  const [override, setOverride] = React.useState(false);
  const [overrideText, setOverrideText] = React.useState('');
  return (
    <div>
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', marginBottom: item.detail ? 3 : 8, whiteSpace: 'pre-wrap' }}>{item.title}</div>
      {translated && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tide-5)', marginBottom: item.detail ? 3 : 8, whiteSpace: 'pre-wrap' }}>{translated.title}</div>}
      {item.detail && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{item.detail}</div>}
      {translated && item.detail && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--tide-5)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{translated.detail}</div>}
      {item.movedNote && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--sun-4)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{item.movedNote}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {item.options.map((o) => {
          const picked = value === o.label;
          const off = disabled.includes(o.label);
          return (
            <button key={o.label} disabled={off} onClick={() => !locked && onChange(picked ? null : o.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)', fontWeight: picked ? 600 : 400,
                color: picked ? '#fff' : 'var(--text-body)',
                background: picked ? 'var(--tide-4)' : 'var(--surface-recessed)',
                border: 'none',
                boxShadow: picked ? 'var(--shadow-primary)' : 'none',
                borderRadius: 'var(--radius-full)', padding: '11px 18px', minHeight: 44,
                cursor: locked || off ? 'default' : 'pointer',
                opacity: (locked && !picked) || off ? 0.45 : 1,
                transition: 'background var(--duration-quick) var(--ease-tidal)',
              }}>
              <span style={{ flex: 1 }}>{o.label}</span>
              {o.recommended && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: picked ? 'var(--tide-2)' : 'var(--tide-4)' }}>recommended</span>}
            </button>
          );
        })}
        {locked && value && !item.options.some((o) => o.label === value) && (
          <div style={{ fontSize: 'var(--text-sm)', color: '#fff', background: 'var(--tide-4)', borderRadius: 'var(--radius-full)', padding: '11px 18px', boxShadow: 'var(--shadow-primary)' }}>{value}</div>
        )}
        {locked || !freeText ? null : override
          ? <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <Input multiline rows={2} placeholder="override answer — free text" value={overrideText} onChange={(e) => setOverrideText(e.target.value)} style={{ flex: 1 }} />
              <Button variant="secondary" size="sm" disabled={!!TidepoolRules.whyBlank(overrideText)} onClick={() => { onChange(TidepoolRules.normalizeText(overrideText)); setOverride(false); setOverrideText(''); }}>Set</Button>
            </div>
          : <button onClick={() => setOverride(true)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', textAlign: 'left', padding: '2px 0' }}>override with free text…</button>}
      </div>
    </div>
  );
}

// Fires target through onTranslate and folds the outcome into setState as
// one of this diff's 4 result shapes — {status: 'loading'|'throttled'|
// 'error'|'translated', ...} — the one seam all 3 toggle sites (question
// card, log skim, handoff expansion) route through, so the request/catch
// shape is written once. `opts.signal` (ADR 0063 決定4) is optional — only
// the log skim passes one, along with `opts.onAbort` to unwind its own
// bookkeeping when a not-yet-sent request is cancelled instead of folding
// the cancellation into `setState` as a 5th state.
function runTranslate(
  onTranslate: TpTranslateFn,
  target: TpTranslateTarget,
  setState: (result: TpTranslation) => void,
  opts?: { signal?: AbortSignal; onAbort?: () => void },
) {
  setState({ status: 'loading' });
  onTranslate(target, opts && opts.signal ? { signal: opts.signal } : undefined)
    .then(setState)
    .catch((err) => {
      if (err && err.name === 'AbortError') {
        if (opts && opts.onAbort) opts.onAbort();
        return;
      }
      setState({ status: 'error', message: String(err.message || err) });
    });
}

// The non-'translated' states of a translation result (issue #47) — the
// 'translated' state renders differently per caller (a string vs a
// purpose+items bundle vs a doc), so callers render that one themselves.
function TpTranslationNote({ result }: { result: Exclude<TpTranslation, { status: 'translated' }> }) {
  if (result.status === 'loading') return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>…</span>;
  if (result.status === 'throttled') {
    return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--sun-4)' }}>いまは usage limit で訳を添えられません — 原文のみ</span>;
  }
  return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--coral-4)' }}>{result.message}</span>;
}

/** 人間が書く記憶の文言の Translate(原文 → 英語)と Back-translate(英語 → 表示言語)(ADR 0015)。`originals` が
 *  あれば先に英語を訳し、無ければ `english` をそのまま逆翻訳する。settings の書き込みと question カードの修正値が共有する。 */
async function translateMemoryWording(translate: TpTranslateFn, english: Record<string, string>, originals: Record<string, string> | null) {
  const out = { ...english };
  const back: Record<string, string> = {};
  for (const key of Object.keys(out)) {
    if (originals) {
      const r = await translate({ type: 'to_english', text: originals[key]! });
      if (r.status !== 'translated') throw new Error('translation is throttled right now');
      out[key] = r.text!;
    }
    const r = await translate({ type: 'back_translation', text: out[key]! });
    if (r.status !== 'translated') throw new Error('translation is throttled right now');
    back[key] = r.text!;
  }
  return { english: out, back };
}

/** 段の修正値の select(ADR 0200 決定1): 選択肢は盤面の段の一覧 —— このカードは設定を持たないので自分で引く。`below` があれば
 *  それより下の段だけ。引けなければ選択肢は「as proposed」だけで、approve はそのまま送れる。 */
function TpTierAmendment({ label, below, value, onChange }: {
  label: string;
  below?: string;
  value: string;
  onChange: (tier: string) => void;
}) {
  const { Select } = window.TidepoolDesignSystem_8a0ead;
  const [tiers, setTiers] = React.useState<SettingsExecution['tiers']>([]);
  React.useEffect(() => {
    api('GET /api/settings/execution').then(({ tiers }) => setTiers(tiers)).catch(() => {});
  }, []);
  const options = below === undefined ? tiers : tiers.slice(0, Math.max(tiers.findIndex((tier) => tier.name === below), 0));
  return <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} options={tierOptions(options, 'as proposed')} />;
}

// 段を足す提案の修正値(ADR 0200 決定3・8 / issue #1439): 提案の段を初期値に名前・位置・説明を出し、位置の上下に盤面のいまの段を並べる
// —— 隣は pin の提案時点の値でなく、いまの一覧と修正後の位置から引く。提案から変えた欄だけを上に渡す。一覧が引けなければ欄は出さない。
function TpAddTierAmendment({ proposed, onChange }: {
  proposed: { name: string; description: string; position: number };
  onChange: (amendment: TpAmendment) => void;
}) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [tiers, setTiers] = React.useState<SettingsExecution['tiers'] | null>(null);
  const [draft, setDraft] = React.useState(proposed);
  React.useEffect(() => {
    api('GET /api/settings/execution').then(({ tiers }) => setTiers(tiers)).catch(() => {});
  }, []);
  React.useEffect(() => {
    const changed: TpAmendment = {};
    if (TidepoolRules.normalizeText(draft.name) !== proposed.name) changed.name = TidepoolRules.normalizeText(draft.name);
    if (TidepoolRules.normalizeText(draft.description) !== proposed.description) changed.description = TidepoolRules.normalizeText(draft.description);
    if (draft.position !== proposed.position) changed.position = draft.position;
    onChange(changed);
  }, [draft]);
  if (!tiers) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
      <Input label="Name" mono value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder="a lowercase letter, then a-z 0-9 - _ — agent.md writes it as its tier" />
      <Select label="Position" value={String(draft.position)}
        options={Array.from({ length: tiers.length + 1 }, (_, p) => ({ value: String(p), label: tierPositionLabel(tiers, p) }))}
        onChange={(e) => setDraft({ ...draft, position: Number(e.target.value) })} />
      {tierNeighbour('next tier above', tiers[draft.position])}
      <Input label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        placeholder="one line: the work the tier below cannot do and this one can" />
      {tierNeighbour('next tier below', tiers[draft.position - 1])}
    </div>
  );
}

// memory の提案の修正値(ADR 0152 決定2・5): candidate の文言を初期値に、settings と同じ英語 + 原文の2欄と逆翻訳。
// Exemplar の candidate(#950)は settings の Exemplar の扉と同じ注釈の form で、case は candidate の出所に固定。
// candidate から変えた欄(と原文)だけを修正値として上に渡す —— 何も変えなければ素の approve になる。
function TpMemoryAmendment({ candidateId, onTranslate, onChange, onDeadAddressee }: {
  candidateId: number;
  onTranslate?: TpTranslateFn;
  onChange: (amendment: TpAmendment) => void;
  /** 宛先が孤立した現在値のままか(ADR 0173 決定3)—— その間 approve は送れない */
  onDeadAddressee: (dead: boolean) => void;
}) {
  const { Button, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  type Wording = { title: string; text: string; addressee: string; annotations: TpDraftAnnotation[] };
  const [base, setBase] = React.useState<(Wording & { kind: string; source: number | null; dead: string | null }) | null>(null);
  const [draft, setDraft] = React.useState({ title: '', text: '', addressee: '', originalTitle: '', originalText: '', annotations: [] as TpDraftAnnotation[] });
  const [back, setBack] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // settings の Behavior フォーム(#943)と同じ registry 引き —— このカードは agent 一覧を持たないので自分で引く
  // 取得の失敗は翻訳の失敗と別に持つ —— 翻訳の setError(null) で消えると、選択肢が欠けたまま理由が見えなくなる
  const [agentNames, setAgentNames] = React.useState<string[]>([]);
  const [agentsError, setAgentsError] = React.useState<string | null>(null);
  React.useEffect(() => {
    api('GET /api/agents')
      .then(({ agents }) => setAgentNames(agents.map((a) => a.name)))
      .catch((err) => setAgentsError(String(err.message || err)));
  }, []);
  React.useEffect(() => {
    api('GET /api/settings/memory/entries', { query: { state: 'candidate' } })
      .then(({ entries }) => {
        const candidate = entries.find((e) => e.id === candidateId);
        if (!candidate) return;
        // candidate の文言は trim されずに保存されうる —— 比べる基準を trim しておかないと、触らない承認が修正つきになる
        const wording = {
          title: candidate.title.trim(), text: candidate.text.trim(), addressee: candidate.addressee?.trim() ?? '',
          annotations: (candidate.annotations ?? []).map(({ anchor, polarity, text }) => ({ anchor, polarity, text: text.trim(), original: '', back: null })),
        };
        // Exemplar の出所は常に event(case を描けない出所は Exemplar にならない)
        setBase({ ...wording, kind: candidate.kind, source: typeof candidate.source.ref === 'number' ? candidate.source.ref : null, dead: deadRefs(candidate).addressee?.trim() ?? null });
        setDraft({ ...wording, originalTitle: '', originalText: '' });
      })
      .catch((err) => setError(String(err.message || err)));
  }, [candidateId]);
  React.useEffect(() => {
    if (!base) return;
    const changed: TpAmendment = {};
    if (TidepoolRules.normalizeText(draft.title) !== base.title) changed.title = TidepoolRules.normalizeText(draft.title);
    if (TidepoolRules.normalizeText(draft.text) !== base.text) changed.text = TidepoolRules.normalizeText(draft.text);
    if (draft.addressee.trim() !== base.addressee) changed.addressee = draft.addressee.trim() || null;
    // 注釈は list ごと送る(ADR 0153 決定2)
    const annotations = annotationsToSend(draft.annotations);
    if (JSON.stringify(annotations) !== JSON.stringify(annotationsToSend(base.annotations))) changed.annotations = annotations;
    // a partial original is sent as is so the server's refusal says why
    if (draft.originalTitle.trim()) changed.original_title = draft.originalTitle.trim();
    if (draft.originalText.trim()) changed.original_text = draft.originalText.trim();
    onChange(changed);
    onDeadAddressee(draft.addressee === base.dead);
  }, [base, draft]);
  if (!base) return error ? <div style={{ fontSize: 'var(--text-xs)', color: 'var(--coral-4)', marginBottom: 14 }}>{error}</div> : null;
  const set = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setDraft({ ...draft, [key]: e.target.value });
    if (key === 'title' || key === 'text') setBack(null);
  };
  const translate = async (toEnglish: boolean) => {
    setError(null);
    try {
      const out = await translateMemoryWording(onTranslate!, { title: draft.title, text: draft.text }, toEnglish ? { title: draft.originalTitle, text: draft.originalText } : null);
      setDraft({ ...draft, ...out.english });
      setBack(`${out.back.title} — ${out.back.text}`);
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };
  // a current addressee whose agent has left the registry is shown but cannot be approved again
  const addressee = (
    <React.Fragment>
      <Select label="Addressee" value={draft.addressee} onChange={set('addressee')}
        options={[{ value: '', label: 'every agent' }, ...offerNames(agentNames, draft.addressee, base.dead)]} />
      {agentsError && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--coral-4)' }}>{agentsError}</div>}
    </React.Fragment>
  );
  if (base.kind === 'exemplar') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        <Input label="Title (English)" value={draft.title} onChange={set('title')} />
        {addressee}
        <MemoryExemplarAnnotations workspace="" source={base.source} annotations={draft.annotations}
          onChange={(update) => setDraft((d) => ({ ...d, annotations: update(d.annotations) }))} translate={onTranslate} onError={setError}
          busy={busy} setBusy={setBusy} />
        {error && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--coral-4)' }}>{error}</div>}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
      {onTranslate && (
        <React.Fragment>
          <Input label="Amend original title (optional)" value={draft.originalTitle} onChange={set('originalTitle')} />
          <Input label="Amend original (optional)" multiline rows={3} value={draft.originalText} onChange={set('originalText')} />
          <Button variant="secondary" size="sm" disabled={!!TidepoolRules.whyBlank(draft.originalTitle) || !!TidepoolRules.whyBlank(draft.originalText)} onClick={() => translate(true)}>Translate</Button>
        </React.Fragment>
      )}
      <Input label="Title (English)" value={draft.title} onChange={set('title')} />
      <Input label="English (approved as the canonical text)" multiline rows={3} value={draft.text} onChange={set('text')} />
      {addressee}
      {onTranslate && <Button variant="secondary" size="sm" disabled={!!TidepoolRules.whyBlank(draft.title) || !!TidepoolRules.whyBlank(draft.text)} onClick={() => translate(false)}>Back-translate</Button>}
      {back && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }} data-testid="amendment-back-translation">back: {back}</p>}
      {error && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--coral-4)' }}>{error}</div>}
    </div>
  );
}

// One question task's card: the shared context (its `purpose`) once, then
// every item's picker (issue #30 — a single-item bundle is the degenerate,
// most common case). The card owns its own in-progress picks as a draft that
// is never persisted, and fires onAnswer(answers) — one array entry per item,
// in item order — only from its Submit button, which stays disabled until
// every item has a pick. An answer can merge a PR or cancel a tree with no
// way back, so a mis-tap only ever changes the draft (issue #1233). Still one submission for the whole
// bundle, never a partial-answer state (CONTEXT.md's Question).
// onTranslate(target): the display-time translation seam (issue #47 / ADR
// 0015), a POST /api/translate caller — absent in the standalone kit (no
// toggle rendered), passed through by both TriageScreen (section 0) and
// TpSingleQuestion (single-question-view.tsx)'s push-answer flow, since both
// render this same card. The question card's own toggle (one of the 3
// switches ADR 0063's table enumerates): translates `purpose`/items'
// title+detail, never the options an answer is picked from.
function TpQuestionCard({ q, answer, onAnswer, locked = false, onTranslate, onOpenSettings }: {
  q: TpQuestion;
  /** `q.opensSettings` の question のボタンが撃つ。 */
  onOpenSettings?: () => void;
  /** 盤面が確定した回答 —— 未回答は null(呼び手は id 引きの map)。 */
  answer?: string[] | null;
  /** amendment は修正値を添えられる提案を approve したときだけ、入力があれば渡る。 */
  onAnswer: (answers: string[], amendment?: TpAmendment, comment?: string) => Promise<void>;
  /** 回答済みのカードは選び直せない。 */
  locked?: boolean;
  onTranslate?: TpTranslateFn;
}) {
  const { Card, AgentChip, Switch, Input, Button } = window.TidepoolDesignSystem_8a0ead;
  const items = q.items;
  const [draft, setDraft] = React.useState<(string | null)[]>(() => answer ?? items.map(() => null));
  // a server-confirmed answer (locked) always wins over in-progress local picks
  React.useEffect(() => { if (answer) setDraft(answer); }, [answer]);
  const [amendment, setAmendment] = React.useState<TpAmendment>({});
  const [deadAddressee, setDeadAddressee] = React.useState(false);
  const [comment, setComment] = React.useState('');
  const setItemAnswer = (i: number, value: string | null) => setDraft(draft.map((v, j) => (j === i ? value : v)));
  const disabledOptions = deadAddressee ? ['approve'] : [];
  // picked options the board says need a reason (ADR 0179 決定5): pickable, but not submittable while the comment is blank
  const pickedNeedingComment = draft.filter((v) => v && q.needsComment?.includes(v));
  // a pick made before the addressee turned out dead is not submittable either
  const canSubmit = draft.every(Boolean) && !draft.some((v) => disabledOptions.includes(v!)) && (pickedNeedingComment.length === 0 || !TidepoolRules.whyBlank(comment));
  // triage marks the card answered only after the POST resolves, so Submit stays pressable until then
  const [submitting, setSubmitting] = React.useState(false);
  const submit = () => {
    setSubmitting(true);
    // memory と段の追加は提案から変えた欄だけを上げてくる(位置 0 が偽値で落ちないよう、ここで間引かない)
    const filled = q.amendable === 'memory' || q.amendable === 'add_tier' ? amendment : Object.fromEntries(Object.entries(amendment).filter(([, v]) => v)) as TpAmendment;
    onAnswer(draft as string[], q.amendable && draft[0] === 'approve' && Object.keys(filled).length > 0 ? filled : undefined, comment.trim() ? comment : undefined)
      .finally(() => setSubmitting(false));
  };
  const answeredCount = draft.filter(Boolean).length;

  const [translateOn, setTranslateOn] = React.useState(false);
  const [translation, setTranslation] = React.useState<TpTranslation | null>(null);
  const translateRequested = React.useRef(false);
  React.useEffect(() => {
    if (!translateOn || !onTranslate || translateRequested.current) return;
    translateRequested.current = true;
    runTranslate(onTranslate, { type: 'question', task_id: q.id }, setTranslation);
  }, [translateOn]);
  const translatedItems = translation && translation.status === 'translated' ? translation.items : null;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{q.id}</span>
        <AgentChip name={q.agent} icon={q.agentIcon} board={q.board} size="sm" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>{q.agent}</span>
        {q.blocking && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>blocks {q.blocking}</span>}
      </div>
      {q.kind === 'approval' && (
        <span style={{ display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sun-4)', background: 'var(--sun-1)', borderRadius: 'var(--radius-full)', padding: '2px 10px', marginBottom: 6 }}>
          out-of-authority → approval
        </span>
      )}
      {onTranslate && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <Switch label="訳を添える" checked={translateOn} onChange={setTranslateOn} />
        </div>
      )}
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: q.note ? 6 : 14, whiteSpace: 'pre-wrap' }}>{q.context}</div>
      {translateOn && translation && (
        translation.status === 'translated'
          ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tide-5)', marginBottom: q.note ? 6 : 14, whiteSpace: 'pre-wrap' }}>{translation.purpose}</div>
          : <div style={{ marginBottom: q.note ? 6 : 14 }}><TpTranslationNote result={translation} /></div>
      )}
      {q.note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--sun-4)', marginBottom: 14 }}>⚠ {q.note}</div>}
      {q.opensSettings && onOpenSettings && !locked && (
        <div style={{ marginBottom: 14 }}>
          <Button variant="secondary" size="sm" onClick={onOpenSettings}>Open settings</Button>
        </div>
      )}
      {q.amendable === 'agent_tier' && !locked && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <TpTierAmendment label="Amend target tier (optional)" below={q.amendBelow} value={amendment.to ?? ''}
            onChange={(to) => setAmendment({ ...amendment, to })} />
        </div>
      )}
      {q.amendable === 'tier_description' && !locked && (
        <div style={{ marginBottom: 14 }}>
          <Input label="Amend description (optional)" value={amendment.description ?? ''} placeholder="as proposed"
            onChange={(e) => setAmendment({ description: e.target.value })} />
        </div>
      )}
      {q.amendable === 'add_tier' && !locked && (
        <TpAddTierAmendment proposed={q.proposedTier!} onChange={setAmendment} />
      )}
      {q.amendable === 'memory' && !locked && (
        <TpMemoryAmendment candidateId={q.candidateId!} onTranslate={onTranslate} onChange={setAmendment} onDeadAddressee={setDeadAddressee} />
      )}
      {q.amendable === 'row' && !locked && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <TpTierAmendment label="Amend tier (optional)" value={amendment.tier ?? ''}
            onChange={(tier) => setAmendment({ ...amendment, tier })} />
          <Input label="Amend effort (optional)" value={amendment.effort ?? ''} placeholder="as proposed" mono
            onChange={(e) => setAmendment({ ...amendment, effort: e.target.value.trim() })} />
        </div>
      )}
      {!locked && (
        <div style={{ marginBottom: 14 }}>
          <Input label={pickedNeedingComment.length ? `Comment (required to ${pickedNeedingComment.join(' / ')})` : 'Comment (optional)'} multiline rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="why" />
        </div>
      )}
      {items.length > 1 && !locked && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
          {answeredCount} of {items.length} answered — sent together on Submit
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {items.map((item, i) => (
          <TpQuestionItemPicker key={i} item={item} value={draft[i]} locked={locked} freeText={q.freeText} onChange={(v) => setItemAnswer(i, v)}
            translated={translatedItems ? translatedItems[i] : null}
            disabled={disabledOptions} />
        ))}
      </div>
      {!locked && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="primary" disabled={!canSubmit || submitting} onClick={submit}>Submit</Button>
        </div>
      )}
    </Card>
  );
}

// Shared scratchpad — pain capture across all triage sections. Free text is
// allowed here by design: human steering information is itself the payload.
function TpScratchpad({ lines, onAdd, onRemove }: {
  lines: TpScratchLine[];
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
}) {
  const { Button, Input } = window.TidepoolDesignSystem_8a0ead;
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const add = () => { if (!TidepoolRules.whyBlank(draft)) { onAdd(TidepoolRules.normalizeText(draft)); setDraft(''); } };
  React.useEffect(() => { lucide.createIcons(); });
  // portal: the tab-switch animation's transform hijacks position:fixed inside the app tree
  return ReactDOM.createPortal(
    <>
      <button onClick={() => setOpen(!open)} aria-label="scratchpad"
        style={{
          position: 'fixed', bottom: 118, right: 'max(16px, calc(50vw - 204px))', zIndex: 30,
          width: 44, height: 44, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer',
          background: open ? 'var(--tide-4)' : 'var(--surface-card)', color: open ? '#fff' : 'var(--tide-4)',
          boxShadow: 'var(--shadow-card)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <i data-lucide="notebook-pen" style={{ width: 18, height: 18 }}></i>
        {lines.length > 0 && !open && (
          <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 999, background: 'var(--sun-4)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>{lines.length}</span>
        )}
      </button>
      {open && (
        <div style={{ position: 'fixed', bottom: 170, right: 'max(16px, calc(50vw - 204px))', zIndex: 30, width: 300, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)', padding: 12 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>scratchpad — "this again?"</div>
          {lines.map((l, i) => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-body)', marginBottom: 6 }}>
              <span style={{ flex: 1 }}>{l.text}</span>
              <button onClick={() => onRemove(i)} aria-label={`remove ${l.text}`} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <Input multiline rows={1} placeholder="jot the irritation — triaged at commit" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" disabled={!!TidepoolRules.whyBlank(draft)} onClick={add}>Add</Button>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}

// keys are the domain's disposition vocabulary (task / register / discard,
// issue #61) so no translation layer sits between the screen and the commit
// API
const TP_SCRATCH_KINDS = [
  { key: 'task', label: 'task' },
  { key: 'register', label: 'register' },
  { key: 'discard', label: 'discard' },
];

// Decision log workspace grouping (issue #44): the API stays flat and only
// annotates each entry with a resolved `workspace` name (null when neither
// the task nor the board names one) — grouping, sort order, and the
// read/unread fold are all client-side view derivation over that flat list,
// re-run from scratch on every render (nothing about it is persisted).
// 一本道の5段。番号を直に書くと「どの section が何か」が読めなくなる
const S_QUESTIONS = 0;
const S_LOG = 1;
const S_MERGE = 2;
const S_QUEUE = 3;
const S_COMMIT = 4;

// 盤面が返す回答不能の理由(`landing.blocked_by`)を1行の文言にする。判定は盤面側で
// 済んでいるので、ここは描画だけ(ADR 0092 決定4)。"held" とは呼ばない —
// CONTEXT.md の Held は祖先の未回答 question による導出状態で「question 自身は held の
// 影響を受けない」と定義されており、同じ画面の `hold` 回答とも読み違えられる。
const TP_LANDING_BLOCKED: Record<string, string> = {
  attached_children: 'attached children unsettled',
  objections: 'objections await commit',
};

const LOG_READ_BATCH = 8;
const NO_WORKSPACE_LABEL = 'no workspace';

// Groups `data.log` by workspace, sorted groups-with-unread-first (most
// recent unread first), then fully-read groups (most recent entry first).
// Within a group, read and unread entries are each chronological. Human-authored
// entries are read regardless of their id, so the two sets are partitioned by
// the server verdict rather than inferred as two sides of the cursor.
//
// Ordering inside a group is the entry's own id, which ascends with time.
function groupLogEntries(entries: TpLogEntry[]) {
  const byWorkspace = new Map<string, TpLogEntry[]>();
  entries.forEach((l) => {
    const key = l.workspace || '';
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key)!.push(l);
  });
  const groups = [...byWorkspace.entries()].map(([key, groupEntries]) => {
    const sorted = groupEntries.slice().sort((a, b) => a.id - b.id);
    const unreadEntries = sorted.filter((l) => l.unread);
    const readEntries = sorted.filter((l) => !l.unread);
    return {
      key,
      label: key || NO_WORKSPACE_LABEL,
      readEntries,
      unreadEntries,
      unreadCount: unreadEntries.length,
      readCount: readEntries.length,
      mostRecentUnread: unreadEntries.length ? Math.max(...unreadEntries.map((l) => l.id)) : null,
      mostRecent: Math.max(...sorted.map((l) => l.id)),
    };
  });
  groups.sort((a, b) => {
    if ((a.unreadCount > 0) !== (b.unreadCount > 0)) return a.unreadCount > 0 ? -1 : 1;
    return a.unreadCount > 0 ? b.mostRecentUnread! - a.mostRecentUnread! : b.mostRecent - a.mostRecent;
  });
  return groups;
}

// Multiple objections on one entry render as a bullet list, matching the
// server's own bundling (renderObjectionPairs in src/triage.ts); a single
// objection keeps its original plain-text look (issue #251).
const objectionBadge = (comments?: string[] | null) =>
  (comments?.length)! > 1 ? comments!.map((c) => `- ${c}`).join('\n') : comments?.[0];

// A `GET /api/log` entry as a LogEntry row — shared by webui/app.tsx's triage log
// and the settings case picker, so the two never drift apart again (#1102).
// ADR 0085: the entry's `objections` (every one ever raised) split by whether it
// belongs to the currently open session — the sole fact `session_id` carries —
// into commit-pending vs. already-bundled. No open session → all bundled.
// biome-ignore lint/correctness/noUnusedVariables: used by webui/app.tsx and webui/settings-screen.tsx — one concatenated bundle
const toLogEntryShape = (e: WireContract['GET /api/log']['entries'][number], openSessionId: number | null) => ({
  taskId: e.task_id, agent: e.worker_id, human: e.worker_id === 'human',
  kind: e.payload.kind === 'task_completed' ? 'completion' as const : 'decision' as const,
  text: e.payload.kind === 'task_completed' ? (e.payload.result ?? '(no outcome recorded)') : e.payload.line,
  cause: e.cause ?? undefined,
  causeEntries: e.entries ?? undefined,
  pendingObjections: e.objections.filter((o) => o.session_id === openSessionId).map((o) => o.comment),
  bundledObjections: e.objections.filter((o) => o.session_id !== openSessionId).map((o) => o.comment),
});

// The entry keys with a commit-pending objection (ADR 0085): the union of
// this tab's own immediate reflection (`localObjections`, populated the
// moment Object is tapped) and the server-delivered entries whose
// objections already resolved as commit-pending. Shared by TriageScreen's
// own nObjections and webui/app.tsx's commit summary — the same count.
function commitPendingObjectionKeys(log: TpLogEntry[], localObjections: Record<string, string[]>) {
  return new Set([
    ...Object.keys(localObjections),
    ...log.filter((l) => l.pendingObjections?.length).map((l) => String(l.id)),
  ]);
}

// onAnswer / onObject / onScratchAdd persist immediately (中断安全),
// onDisplayed records the skimmed entries, loadPreview fetches the server's
// staged S3 queue, loadLanding re-reads the landing questions' answerability.
// onCommit always closes the flow.
// biome-ignore lint/correctness/noUnusedVariables: rendered by webui/app.tsx — one concatenated bundle
function TriageScreen({ data, onCommit, loadHandoff, onAnswer, onObject, onScratchAdd, onDisplayed, loadPreview, loadLanding, onTranslate, onOpenMemoryEntry, onOpenSettings }: {
  data: { questions: TpTriageQuestion[]; log: TpLogEntry[]; scratchpad?: TpScratchLine[] };
  onCommit: (
    answers: Record<string, string[]>,
    objections: Record<string, string[]>,
    scratch: { id: number; text: string; kind: string }[],
  ) => void;
  loadHandoff: (entry: TpLogEntry) => Promise<string>;
  onAnswer: (q: TpTriageQuestion, answers: string[], amendment?: TpAmendment, comment?: string) => Promise<void>;
  onObject: (entry: TpLogEntry, comment: string) => Promise<void>;
  onScratchAdd: (text: string) => Promise<TpScratchLine>;
  onDisplayed: (entries: TpLogEntry[]) => void;
  loadPreview: () => Promise<QueueScreenTask[]>;
  loadLanding: () => Promise<Record<string, { blocked_by: string | null }>>;
  onTranslate?: TpTranslateFn;
  onOpenMemoryEntry: (id: number) => void;
  onOpenSettings: () => void;
}) {
  const { Button, Input, LogEntry, Switch } = window.TidepoolDesignSystem_8a0ead;
  // 着地 question(`landing` を持つ行)は merge 判断ステップの持ち物 — 先頭の質問
  // ステップが数えるのも描くのも一般 question だけ(ADR 0092 決定4)
  const generalQuestions = data.questions.filter((q) => !q.landing);
  const landingQuestions = data.questions.filter((q) => q.landing);
  const nQuestions = generalQuestions.length;
  // no questions overnight → the flow still exists for the log skim; start at the log
  const [section, setSection] = React.useState(nQuestions ? S_QUESTIONS : S_LOG);
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({});
  const [objections, setObjections] = React.useState<Record<string, string[]>>({});
  const [objecting, setObjecting] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState('');
  const [scratch, setScratch] = React.useState(data.scratchpad ?? []); // [{ id, text }]
  const [dropped, setDropped] = React.useState<TpScratchLine[]>([]);       // persisted lines removed in-UI → discard at commit
  const [scratchKinds, setScratchKinds] = React.useState<Record<number, string>>({}); // keyed by line id
  const [preview, setPreview] = React.useState<QueueScreenTask[] | null>(null);
  // data.questions はフロー1回分の凍結 snapshot(webui/app.tsx の refresh)なので、
  // 流し読みで打った異議はそこに映らない。merge 判断に入る瞬間に盤面へ回答可否を
  // 訊き直す — 判定は盤面側のまま、UI は今の答えを引くだけ(ADR 0092 決定4/決定5)。
  const [landingNow, setLandingNow] = React.useState<Record<string, { blocked_by: string | null }> | null>(null); // { [questionId]: { blocked_by } }

  // live answers are one-way: a persisted answer cannot be untapped or replaced
  const answerQ = async (q: TpTriageQuestion, a: string[] | null, amendment?: TpAmendment, comment?: string) => {
    if (!a || answers[q.id]) return;
    try { await onAnswer(q, a, amendment, comment); } catch { return; }
    setAnswers((prev) => ({ ...prev, [q.id]: a }));
  };

  const addScratch = async (text: string) => {
    let entry: TpScratchLine;
    try { entry = await onScratchAdd(text); } catch { return; }
    setScratch((prev) => [...prev, entry]);
  };
  const removeScratch = (i: number) => {
    const entry = scratch[i];
    setScratch((prev) => prev.filter((_, j) => j !== i));
    // a server-persisted line cannot be unwritten — it is dispositioned as discard at commit
    setDropped((prev) => [...prev, entry!]);
  };

  React.useEffect(() => {
    if (section === S_QUEUE) loadPreview().then(setPreview).catch(() => {});
  }, [section]);
  React.useEffect(() => {
    if (section === S_MERGE) loadLanding().then(setLandingNow).catch(() => {});
  }, [section]);
  // "displayed" is an event: the objection-rate denominator counts only what
  // was actually put in front of the human — an entry reports once it is
  // genuinely in the viewport, not merely because the skim section mounted
  const logListRef = React.useRef<HTMLDivElement | null>(null);
  const displayedSeen = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (section !== S_LOG || !logListRef.current) return;
    const byId = new Map(data.log.filter((l) => l.unread).map((l) => [String(l.id), l]));
    const io = new IntersectionObserver((observed) => {
      const shown: TpLogEntry[] = [];
      for (const o of observed) {
        if (!o.isIntersecting) continue;
        const id = (o.target as HTMLElement).dataset.entryId!;
        if (byId.has(id) && !displayedSeen.current.has(id)) {
          displayedSeen.current.add(id);
          shown.push(byId.get(id)!);
        }
      }
      if (shown.length) onDisplayed(shown);
    }, { threshold: 0.5 });
    logListRef.current.querySelectorAll('[data-entry-id]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [section]);
  // completion rows carry a handoff doc behind their own chevron. Row taps
  // always open the same objection path, regardless of entry kind. Per-entry
  // state below is keyed by the entry's own id, so a log refresh can't retarget
  // an objection at a different line, and grouping/reordering can't either.
  // one fold per workspace group (issue #44): how many of a group's read
  // entries are revealed, keyed by group key, growing by LOG_READ_BATCH per
  // tap starting from the most recent (closest to the unread boundary) and
  // working backward. A group with zero unread stays hidden entirely until
  // the section-wide toggle below flips it into view — the one control that
  // makes every workspace reachable; its own read entries still fold same as
  // any other group's, one more tap away.
  const [revealedRead, setRevealedRead] = React.useState<Record<string, number>>({});
  const [showFullyReadWorkspaces, setShowFullyReadWorkspaces] = React.useState(false);
  const allLogGroups = React.useMemo(() => groupLogEntries(data.log), [data.log]);
  const fullyReadGroups = allLogGroups.filter((g) => g.unreadCount === 0);
  // memoized (not a bare .filter() per render): renderedLogEntries below
  // depends on this, and an unstable reference here would defeat that
  // useMemo on every unrelated re-render — including the very re-renders a
  // translation result landing causes (see the note above the fanout effect).
  const logGroups = React.useMemo(
    () => (showFullyReadWorkspaces ? allLogGroups : allLogGroups.filter((g) => g.unreadCount > 0)),
    [allLogGroups, showFullyReadWorkspaces],
  );
  // the log skim's own toggle (one of the 3 switches ADR 0063's table
  // enumerates, issue #47): one switch governs every entry currently
  // rendered in this section — not
  // just unread — keyed by entry id so a fold/reveal never re-requests an
  // entry already translated this session. `renderedLogEntries` mirrors
  // exactly what the two .map calls below actually paint (visible-read +
  // unread, per group).
  const [logTranslateOn, setLogTranslateOn] = React.useState(false);
  const [logTranslations, setLogTranslations] = React.useState<Record<number, TpTranslation>>({});
  const logTranslateRequested = React.useRef(new Set<number>());
  const renderedLogEntries = React.useMemo(() => {
    const rendered: TpLogEntry[] = [];
    for (const g of logGroups) {
      const revealed = Math.min(revealedRead[g.key] || 0, g.readCount);
      const hiddenCount = g.readCount - revealed;
      rendered.push(...g.readEntries.slice(hiddenCount), ...g.unreadEntries);
    }
    return rendered;
  }, [logGroups, revealedRead]);
  // ADR 0063 決定4: the AbortController's lifecycle is the *toggle*
  // (logTranslateOn alone), not the fanout below — deliberately narrower
  // than renderedLogEntries' own deps. Before `logGroups` above was
  // memoized, its identity was unstable across *any* re-render of this
  // component, including the one `setLogTranslations` itself causes when a
  // translation lands; keying the controller to renderedLogEntries too
  // (measured, via browser console instrumentation) turned that instability
  // into a self-sustaining loop: a result arrives → re-render → new
  // renderedLogEntries identity → cleanup aborts whatever is still queued →
  // onAbort deletes its key → re-scan re-queues it → repeat. `logGroups` is
  // fixed now, but the controller's own deps stay narrow regardless — cancel
  // belongs only to "スイッチを戻した", not to every re-render, memoized or
  // not. The fanout effect below reads the current controller via a ref and
  // carries no cleanup of its own — re-running it on a re-render is harmless
  // (it just skips already-requested keys).
  const logTranslateAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    if (!logTranslateOn) return;
    const controller = new AbortController();
    logTranslateAbort.current = controller;
    return () => controller.abort();
  }, [logTranslateOn]);
  // Toggling off cancels this cycle's not-yet-sent requests (the controller
  // above) — already-dispatched ones ignore it and run to completion
  // (translateTarget's own gate). The trap: a cancelled key must come back
  // out of `logTranslateRequested`, or turning the switch back on never
  // re-requests it and the row stays on 'loading' forever.
  React.useEffect(() => {
    if (!logTranslateOn || !onTranslate) return;
    const signal = logTranslateAbort.current!.signal;
    for (const entry of renderedLogEntries) {
      const k = entry.id;
      if (logTranslateRequested.current.has(k)) continue;
      logTranslateRequested.current.add(k);
      runTranslate(onTranslate, { type: 'log_entry', event_id: entry.id },
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
          },
        });
    }
  }, [logTranslateOn, renderedLogEntries]);
  // one switch covers a whole morning's worth of entries — a throttled
  // reading is the same fact for every one of them, so it renders once next
  // to the switch rather than once per row (a real skim can have many
  // unread entries; N identical notes would just be noise).
  const logThrottled = logTranslateOn && Object.values(logTranslations).some((v) => v && v.status === 'throttled');
  // ADR 0063 決定3: one number next to the switch, derived from state the
  // kit already holds — no new wiring. Not a progress bar (7.4s/entry is too
  // coarse to read as motion, and it can't distinguish "stalled" from "slow").
  const logTranslateTotal = logTranslateOn
    ? renderedLogEntries.length
    : 0;
  const logTranslateDone = logTranslateOn
    ? renderedLogEntries.filter((entry) => {
        const v = logTranslations[entry.id];
        return v && v.status !== 'loading';
      }).length
    : 0;
  // iOS Safari has no CSS overflow-anchor: revealing an older batch inserts
  // content above the reader's current position, which would otherwise jump
  // the viewport by the inserted height. Captured synchronously in the click
  // handler (before the reveal), applied in the same frame the reveal paints.
  // `<main class="tp-scroll">` (public/index.html) is the actual scrolling
  // element — this list's own div is just a layout container inside it.
  const scrollContainer = () => logListRef.current && logListRef.current.closest('.tp-scroll');
  const pendingScrollFix = React.useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  React.useLayoutEffect(() => {
    const fix = pendingScrollFix.current;
    pendingScrollFix.current = null;
    const container = scrollContainer();
    if (!fix || !container) return;
    container.scrollTop = fix.scrollTop + (container.scrollHeight - fix.scrollHeight);
  });
  const expandRead = (groupKey: string) => {
    const container = scrollContainer();
    pendingScrollFix.current = container
      ? { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight }
      : null;
    setRevealedRead((prev) => ({ ...prev, [groupKey]: (prev[groupKey] || 0) + LOG_READ_BATCH }));
  };
  const [handoffOpen, setHandoffOpen] = React.useState<Record<number, boolean>>({});
  const handoffCache = React.useRef<Record<number, string>>({});
  // the handoff expansion's own toggle (one of the 3 switches ADR 0063's
  // table enumerates, issue #47) — one instance per expanded entry (its own
  // on/off + cached result), keyed the same as handoffOpen.
  const [handoffTranslateOn, setHandoffTranslateOn] = React.useState<Record<number, boolean>>({});
  const [handoffTranslations, setHandoffTranslations] = React.useState<Record<number, TpTranslation>>({});
  const handoffTranslateRequested = React.useRef(new Set<number>());
  const toggleObjecting = (k: number) => { setObjecting(objecting === k ? null : k); setDraft(''); };
  const toggleHandoff = async (k: number, entry: TpLogEntry) => {
    if (handoffOpen[k]) { setHandoffOpen((prev) => ({ ...prev, [k]: false })); return; }
    if (handoffCache.current[k] == null) {
      try {
        handoffCache.current[k] = await loadHandoff(entry);
      } catch {
        handoffCache.current[k] = '(handoff doc failed to load)';
      }
    }
    setHandoffOpen((prev) => ({ ...prev, [k]: true }));
  };
  const setHandoffTranslate = (k: number, entry: TpLogEntry, next: boolean) => {
    setHandoffTranslateOn((prev) => ({ ...prev, [k]: next }));
    if (!next || !onTranslate || handoffTranslateRequested.current.has(k)) return;
    handoffTranslateRequested.current.add(k);
    runTranslate(onTranslate, { type: 'handoff', task_id: entry.taskId }, (result) =>
      setHandoffTranslations((prev) => ({ ...prev, [k]: result })));
  };
  const answered = generalQuestions.filter((q) => answers[q.id]).length;
  const nObjections = commitPendingObjectionKeys(data.log, objections).size;
  const unread = data.log.filter((l) => l.unread);
  const progress = (section + (section === S_QUESTIONS ? answered / Math.max(1, nQuestions) : 0)) / (S_COMMIT + 1);
  // 回答可否は盤面が言う(`landing.blocked_by`)。merge 判断に入ったときの読み直しが
  // あればそれを、無ければ凍結 snapshot の注釈を使う。回答済みは locked のまま残す。
  const landingBlockOf = (q: TpTriageQuestion) => (landingNow?.[q.id] ?? q.landing)!.blocked_by;
  const landingReady = landingQuestions.filter((q) => answers[q.id] || landingBlockOf(q) === null);
  const landingBlocked = landingQuestions.filter((q) => !answers[q.id] && landingBlockOf(q) !== null);

  const steps = [
    { step: 'questions', title: `The tide brought ${nQuestions} question${nQuestions === 1 ? '' : 's'}.`, sub: 'answers persist at once; unblocked parents surface at the front on commit.', next: answered === nQuestions ? 'Log skim' : `Log skim (${nQuestions - answered} unanswered)` },
    { step: nQuestions ? 'decision log' : 'decision log · no questions today', title: `${unread.length} decisions made overnight.`, sub: 'silence is consent — tap an entry to object.', next: 'Merge decisions' },
    { step: 'merge decisions', title: `${landingReady.length} branch${landingReady.length === 1 ? '' : 'es'} ready to land.`, sub: 'you have read the decisions behind these — merge or hold.', next: 'Queue check' },
    { step: 'queue', title: 'The tide is going out.', sub: 'front-inserted by this session highlighted. read-only — reorder on the Queue screen. applies at commit.', next: 'Wrap up' },
    { step: 'commit', title: 'One last sort.', sub: 'lines you leave unsorted carry over to the next triage.', next: 'Commit' },
  ];
  // 段数の出所は S_COMMIT ひとつ — ラベルに番号を焼き込むと段を足すたびに全部書き直す
  const heads = steps.map((head, i) => ({ ...head, step: `${i + 1} / ${S_COMMIT + 1} — ${head.step}` }));
  const cur = heads[section]!;
  const scratchResolved = () => [
    ...scratch.map((s) => ({ id: s.id, text: s.text, kind: scratchKinds[s.id] || 'task' })),
    ...dropped.map((s) => ({ id: s.id, text: s.text, kind: 'discard' })),
  ];

  return (
    <div key={section} style={{ padding: '20px 16px 28px' }}>
      <div className="tp-rise" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>{cur.step}</div>
      <h1 className="tp-rise" style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', fontWeight: 400, color: 'var(--tide-5)', margin: '0 0 4px', lineHeight: 1.15, animationDelay: '60ms' }}>{cur.title}</h1>
      <p className="tp-rise" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 20px', animationDelay: '120ms' }}>{cur.sub}</p>
      {section === S_QUESTIONS ? <TpSegmentGauge total={nQuestions} filled={answered} /> : <TpWaterline progress={progress} />}
      <div style={{ height: 20 }}></div>

      {section === S_QUESTIONS && (
        <div>
          {generalQuestions.map((q, i) => (
            <div key={q.id} className="tp-rise" style={{ animationDelay: `${180 + i * 90}ms` }}>
              <TpQuestionCard q={q} answer={answers[q.id]} onAnswer={(a, amendment, comment) => answerQ(q, a, amendment, comment)} locked={!!answers[q.id]} onTranslate={onTranslate} onOpenSettings={onOpenSettings} />
            </div>
          ))}
        </div>
      )}

      {section === S_LOG && (() => {
        // renders one entry row + its handoff/objection expansion — shared by
        // every group's revealed-read and unread rows below
        const renderLogRow = (l: TpLogEntry) => {
          const k = l.id;
          const hasHandoff = l.kind === 'completion' && l.handoffPresent;
          return (
            <div key={k} data-entry-id={l.unread ? l.id : undefined}>
              <LogEntry
                entry={{
                  ...l,
                  // server-delivered commit-pending + this tab's own immediate
                  // reflection never overlap: `data.log` is a fixed snapshot
                  // for the whole triage flow (App component), so an entry
                  // objected-to in this same load never re-appears from the
                  // server mid-session (issue #371)
                  objection: objectionBadge([...(l.pendingObjections ?? []), ...(objections[k] ?? [])]),
                  bundledObjection: objectionBadge(l.bundledObjections),
                }}
                active={objecting === k}
                onObject={() => toggleObjecting(k)}
                onExpand={hasHandoff ? () => toggleHandoff(k, l) : undefined}
                onOpenMemoryEntry={onOpenMemoryEntry}
              />
              {logTranslateOn && logTranslations[k] && logTranslations[k].status !== 'throttled' && (
                <div style={{ padding: '2px 14px 10px', background: 'var(--surface-recessed)' }}>
                  {logTranslations[k].status === 'translated'
                    ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tide-5)' }}>{logTranslations[k].text}</div>
                    : <TpTranslationNote result={logTranslations[k]} />}
                </div>
              )}
              {handoffOpen[k] && (
                <div style={{ padding: '10px 14px 12px', background: 'var(--surface-recessed)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>handoff — {l.taskId}</span>
                    {onTranslate && (
                      <Switch label="訳を添える" checked={!!handoffTranslateOn[k]} onChange={(next) => setHandoffTranslate(k, l, next)} style={{ marginLeft: 'auto' }} />
                    )}
                  </div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, color: 'var(--text-body)', overflowX: 'auto' }}>{handoffCache.current[k]}</pre>
                  {handoffTranslateOn[k] && handoffTranslations[k] && (
                    handoffTranslations[k].status === 'translated'
                      ? <pre style={{ margin: '8px 0 0', paddingTop: 8, borderTop: '1px dashed var(--border-hairline)', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, color: 'var(--tide-5)', overflowX: 'auto' }}>{handoffTranslations[k].doc}</pre>
                      : <div style={{ marginTop: 8 }}><TpTranslationNote result={handoffTranslations[k]} /></div>
                  )}
                  {objecting !== k && (
                    <button onClick={() => toggleObjecting(k)} style={{ background: 'none', border: 'none', color: 'var(--coral-4)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: '8px 0 0', display: 'block' }}>object to this entry…</button>
                  )}
                </div>
              )}
              {objecting === k && (
                <div style={{ padding: '10px 12px', background: 'var(--coral-1)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <Input multiline rows={2} placeholder="direction — steering, not rollback" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }} />
                  <Button variant="danger" size="sm" disabled={!!TidepoolRules.whyBlank(draft)} onClick={async () => {
                    // the annotation is persisted the moment it is raised
                    try { await onObject(l, draft); } catch { return; }
                    setObjections({ ...objections, [k]: [...(objections[k] ?? []), draft] });
                    setObjecting(null);
                  }}>Object</Button>
                </div>
              )}
            </div>
          );
        };
        return (
          <div>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', margin: '0 0 10px' }}>
              tap an entry to object · use a completion’s chevron to read its handoff
            </p>
            {onTranslate && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                {logTranslateOn && logTranslateTotal > 0 && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{logTranslateDone} / {logTranslateTotal}</span>
                )}
                {logThrottled && <TpTranslationNote result={{ status: 'throttled' }} />}
                <Switch label="訳を添える" checked={logTranslateOn} onChange={setLogTranslateOn} />
              </div>
            )}
            {fullyReadGroups.length > 0 && (
              <button onClick={() => setShowFullyReadWorkspaces((v) => !v)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px 10px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {showFullyReadWorkspaces
                  ? 'hide fully-read workspaces'
                  : `show ${fullyReadGroups.length} fully-read workspace${fullyReadGroups.length > 1 ? 's' : ''} too`}
              </button>
            )}
            <div ref={logListRef} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {logGroups.map((g) => {
                const revealed = Math.min(revealedRead[g.key] || 0, g.readCount);
                const hiddenCount = g.readCount - revealed;
                const visibleReadEntries = g.readEntries.slice(hiddenCount);
                const unreadEntries = g.unreadEntries;
                return (
                  <div key={g.key} style={{ background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 12px', background: 'var(--surface-recessed)', borderBottom: '1px solid var(--border-hairline)' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{g.label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                        {g.unreadCount > 0 ? `${g.unreadCount} unread` : `${g.readCount} read`}
                      </span>
                    </div>
                    {hiddenCount > 0 && (
                      <button onClick={() => expandRead(g.key)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer', padding: '8px 12px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {hiddenCount} more read decision{hiddenCount > 1 ? 's' : ''} — show
                      </button>
                    )}
                    {visibleReadEntries.map(renderLogRow)}
                    {unreadEntries.map(renderLogRow)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {section === S_MERGE && (
        <div>
          {landingReady.map((q, i) => (
            <div key={q.id} className="tp-rise" style={{ animationDelay: `${180 + i * 90}ms` }}>
              <TpQuestionCard q={q} answer={answers[q.id]} onAnswer={(a, amendment, comment) => answerQ(q, a, amendment, comment)} locked={!!answers[q.id]} onTranslate={onTranslate} />
            </div>
          ))}
          {/* 回答不能な着地 question は件数と理由の1行だけ — 押せば必ず 409 になる
             merge ボタンを出さない。理由は盤面が返した blocked_by をそのまま写す */}
          {Object.keys(TP_LANDING_BLOCKED).map((kind) => {
            const blocked = landingBlocked.filter((q) => landingBlockOf(q) === kind);
            if (blocked.length === 0) return null;
            return (
              <p key={kind} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', margin: '0 0 8px' }}>
                {blocked.length} landing question{blocked.length > 1 ? 's' : ''} not yet answerable — {TP_LANDING_BLOCKED[kind]}
              </p>
            );
          })}
        </div>
      )}

      {/* the server's staged preview is the truth — this session's front-inserts
         arrive on top, already highlighted. Read-only: nothing touches the queue
         before commit (a mid-session reorder would break the "abandoning triage
         never changes the queue" guarantee), so reorder/front stay on the queue
         screen. */}
      {section === S_QUEUE && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <TpQueueList tasks={preview ?? []} />
        </div>
      )}

      {section === S_COMMIT && (() => {
        // 振り分けと束ねの件数は終端に置く(CONTEXT.md の Scratchpad / Objection) —
        // どちらもコミットが適用する行為であって、キューの確認ではない
        return (
          <div>
            {nObjections > 0 && (
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', margin: 0 }}>
                {nObjections} objection{nObjections > 1 ? 's' : ''} bundle into repair tasks at commit — one per objected task, queue tail
              </p>
            )}
            {scratch.length > 0 && (
              <div style={{ marginTop: 20, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: 14 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>scratchpad — triage before commit</div>
                {scratch.map((l) => (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={{ flex: '1 1 100%', fontSize: 'var(--text-sm)', color: (scratchKinds[l.id] || 'task') === 'discard' ? 'var(--text-muted)' : 'var(--text-body)', textDecoration: (scratchKinds[l.id] || 'task') === 'discard' ? 'line-through' : 'none' }}>{l.text}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {TP_SCRATCH_KINDS.map((k) => {
                        const picked = (scratchKinds[l.id] || 'task') === k.key;
                        return (
                          <button key={k.key} onClick={() => setScratchKinds({ ...scratchKinds, [l.id]: k.key })}
                            style={{
                              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', cursor: 'pointer',
                              color: picked ? '#fff' : 'var(--text-secondary)',
                              background: picked ? (k.key === 'discard' ? 'var(--rock-4)' : 'var(--tide-4)') : 'var(--surface-recessed)',
                              border: 'none', borderRadius: 'var(--radius-full)', padding: '4px 12px',
                            }}>{k.label}</button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        {section > (nQuestions ? S_QUESTIONS : S_LOG) && <Button variant="ghost" size="lg" onClick={() => setSection(section - 1)}>Back</Button>}
        <Button variant="primary" size="lg" full onClick={() => (section < S_COMMIT ? setSection(section + 1) : onCommit(answers, objections, scratchResolved()))}>{cur.next}</Button>
      </div>
      <TpScratchpad lines={scratch} onAdd={addScratch} onRemove={removeScratch} />
      {section === S_COMMIT && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
          commit applies scratchpad dispositions and advances the read cursor
        </p>
      )}
    </div>
  );
}
