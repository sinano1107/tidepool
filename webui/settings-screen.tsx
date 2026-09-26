// The client-side mirror of the server's REGISTRY_NAME_PATTERN gate, shared by
// the workspace / agent / profile create forms — the name becomes a directory
// or a file name in the registry, so the three share one rule. It drives the
// disabled state only; the server's assertValid*Name stays the authority.
/** 面全体で編集中のカードは高々1枚(issue #204 決定4)。その1枠を配る口。 */
interface SettingsEditSlot {
  isOpen: (id: string) => boolean;
  /** `prime` は下書きを record から満たす。parked なら人間が答えるまで走らない。 */
  open: (id: string, prime?: () => void) => boolean;
  close: () => void;
  requestClose: () => boolean;
  setDirty: (dirty: boolean) => void;
}

/** 設定面が読むサーバ応答の行 —— 形の正本は wire の契約(ADR 0138)。 */
type SettingsWorkspace = WireContract['GET /api/workspaces']['workspaces'][number];
type SettingsBaseDir = WireContract['GET /api/workspaces']['workspacesBaseDir'];
type SettingsAgent = WireContract['GET /api/agents']['agents'][number];
type SettingsProfile = WireContract['GET /api/profiles']['profiles'][number];
type SettingsExecution = WireContract['GET /api/settings/execution'];
type SettingsExecutionRow = SettingsExecution['table'][number];

function registryNameOk(name: string) {
  const v = name.trim();
  return /^[A-Za-z0-9._-]+$/.test(v) && !['.', '..'].includes(v);
}

// ADR 0018 の規約(基点 + 名前)を表示のために合成する。ADR 0082 決定1: 解決その
// ものは server 側の1点に残り、ここは「その1本の規約を読み上げる」だけである。
function landingPath(baseDir: { path: string }, name: string) {
  return `${baseDir.path.replace(/\/+$/, '')}/${name.trim()}`;
}

// The head of a record card (issue #204): identity on the left, Edit on the
// right while viewing. At most one card on the settings surface is in edit mode
// at a time, so the button asks the screen for that slot rather than flipping
// local state.
function RecordCardHead({ children, editing, onEdit }: {
  children: React.ReactNode;
  editing: boolean;
  onEdit?: () => void;
}) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
      {children}
      {!editing && onEdit && (
        <div style={{ marginLeft: 'auto' }}>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        </div>
      )}
    </div>
  );
}

// Every edit and create form on the settings surface ends the same way (issue
// #204 決定6): Save always present but inert until the draft is both changed
// and sendable, Cancel always available so an opened card is never a trap.
function EditActions({ dirty = true, ok = true, busy, saveLabel, onSave, onCancel }: {
  dirty?: boolean;
  ok?: boolean;
  busy: boolean;
  saveLabel: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <Button variant="primary" size="lg" full disabled={busy || !dirty || !ok} onClick={onSave}>
        {busy ? 'Working…' : saveLabel}
      </Button>
      <Button variant="ghost" size="lg" full disabled={busy} onClick={onCancel}>Cancel</Button>
    </React.Fragment>
  );
}

// Keeps the screen's single edit slot informed of this card's draft state, so
// anything that would leave it — another card, a back, a tab switch — can ask
// before discarding (issue #204 決定4).
function useDirtySignal(edit: SettingsEditSlot, open: boolean, dirty: boolean) {
  React.useEffect(() => { if (open) edit.setDirty(dirty); }, [open, dirty]);
}

// Free-entry-only chip list for workspace allowlists. Grammar is re-checked
// server-side before write; this stays a plain free-text add.
function FreeEntryAllowlistInput({
  values,
  onChange,
  label = 'Review allowed commands',
  description = 'command prefixes a review session in this workspace may run beyond the read-only default. Empty means review stays read-only (confirmed on save if non-empty).',
  placeholder = 'command prefix — e.g. "npm test"',
}: {
  values: string[];
  onChange: (values: string[]) => void;
  label?: string;
  description?: string;
  placeholder?: string;
}) {
  const { Input, Button, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState('');
  const addFree = () => {
    const v = free.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setFree('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </span>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        {description}
      </p>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color="tide" mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Input value={free} mono onChange={(e) => { setFree(e.target.value); }}
            placeholder={placeholder} />
        </div>
        <Button variant="secondary" disabled={!free.trim()} onClick={addFree}>Add</Button>
      </div>
    </div>
  );
}

// The purely-local → remote-backed door (ADR 0066 決定2/8, issue #285). No
// confirmation step: publish is not one of ADR 0061's dangerous values — it
// widens nothing an agent may do — and the destination being a URL the human
// types every time is itself the shape of consent. The board creates nothing
// on GitHub: the repository is one the human prepared and invited the bot to.
function PublishWorkspace({ ws, say, onPublished }: {
  ws: SettingsWorkspace;
  say: AppSay;
  onPublished: () => Promise<void> | void;
}) {
  const { Button, Input } = window.TidepoolDesignSystem_8a0ead;
  const [repo, setRepo] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/workspaces/${encodeURIComponent(ws.name)}/publish`, { repo: repo.trim() });
      setRepo('');
      say('success', 'workspace published — every branch is on the remote', ws.name);
      await onPublished();
    } catch (err) {
      // a failed publish leaves no trace (the board rolls its own `remote add`
      // back), so "fix the cause and press it again" is honest — the refusal's
      // message already carries the one-line repair when it is an access one
      say('danger', 'publish failed — nothing landed, safe to retry', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Publish</span>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        give this purely-local workspace a remote source of truth — every branch is pushed to an
        empty repository you created and invited the bot to. The board creates nothing on GitHub.
      </p>
      <Input value={repo} onChange={(e) => setRepo(e.target.value)}
        placeholder="the destination repository URL — must be empty" />
      <Button variant="secondary" size="sm" disabled={busy || !repo.trim()} onClick={submit}>
        Publish — pushes every branch, then commits to the registry
      </Button>
    </div>
  );
}

// One workspace as a record card (issue #57 phase 3, restructured by #204):
// read-only until Edit, then notes + protection as a single draft — the Switch
// no longer PATCHes the moment it is touched. path/repo/branch re-point the
// entry at a different checkout, which stays a manual registry edit, so they
// are shown but never editable here.
function WorkspaceRecord({ ws, baseDir, say, onChanged, edit }: {
  ws: SettingsWorkspace;
  baseDir: SettingsBaseDir | null;
  say: AppSay;
  onChanged: () => Promise<void>;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow, Input, Switch, Tag } = window.TidepoolDesignSystem_8a0ead;
  // ADR 0066 決定2: publish は編集ではなく状態遷移なので、Edit の下書きには入らない
  // — purely-local な workspace だけがこの扉を持ち、registry clone 自身は持たない
  // (サーバ側も RegistrySelfPublishError で拒む)
  const publishable = !ws.repo && !ws.registrySelf;
  const id = `workspace:${ws.name}`;
  const open = edit.isOpen(id);
  const [notes, setNotes] = React.useState(ws.notes ?? '');
  const [prot, setProt] = React.useState(!!ws.protected);
  const [cmds, setCmds] = React.useState(ws.review_allowed_commands ?? []);
  const [domains, setDomains] = React.useState(ws.allowed_domains ?? []);
  const origin = ws.repo ?? ws.path;
  const dirty = notes.trim() !== (ws.notes ?? '')
    || prot !== !!ws.protected
    || !sameStrings(cmds, ws.review_allowed_commands ?? [])
    || !sameStrings(domains, ws.allowed_domains ?? []);
  useDirtySignal(edit, open, dirty);
  const { busy, save: submit, dialog } = useWorkspaceSave(say, async () => { edit.close(); await onChanged(); });

  const startEdit = () => edit.open(id, () => {
    setNotes(ws.notes ?? ''); setProt(!!ws.protected); setCmds(ws.review_allowed_commands ?? []);
    setDomains(ws.allowed_domains ?? []);
  });
  // Notes always travels; dangerous fields join only when actually changed —
  // untouched fields must stay absent for pure-payload confirmation judgment
  // (ADR 0061 決定2 / ADR 0072).
  const save = () => {
    const body: { notes: string; protected?: boolean; review_allowed_commands?: string[]; allowed_domains?: string[] } = { notes: notes.trim() };
    if (prot !== !!ws.protected) body.protected = prot;
    if (!sameStrings(cmds, ws.review_allowed_commands ?? [])) body.review_allowed_commands = cmds;
    if (!sameStrings(domains, ws.allowed_domains ?? [])) body.allowed_domains = domains;
    submit(async (confirm) => { await api(`/api/workspaces/${encodeURIComponent(ws.name)}`, { ...body, ...confirm }, 'PATCH'); }, 'updated', ws.name);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={startEdit}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{ws.name}</span>
        {ws.registrySelf && <Tag color="tide" mono>registry</Tag>}
        {ws.protected && <Tag color="sun">protected</Tag>}
      </RecordCardHead>
      {ws.registrySelf && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          the board's own registry clone — protection stays on
        </div>
      )}
      {!open && (
        <React.Fragment>
          <FieldRow label={ws.repo ? 'repository' : 'path'} kind={origin ? 'mono' : 'unset'}
            value={origin ? `${origin}${ws.branch ? ` · ${ws.branch}` : ''}` : ''}
            unsetLabel="not recorded on the entry" />
          {/* ADR 0082 決定3: path を持たないエントリの着地先は origin とは別の行で。
              エントリに書かれた値ではなく規約から導かれた値だと分かる形で見せる */}
          {!ws.path && baseDir && (
            <FieldRow label="checkout (derived)" kind="mono" value={landingPath(baseDir, ws.name)} />
          )}
          <FieldRow label="notes" kind={ws.notes ? 'text' : 'unset'} value={ws.notes ?? ''} unsetLabel="—" />
          <FieldRow label="protected" kind="bool" checked={!!ws.protected}
            onLabel="changes here always need human approval" offLabel="not protected" />
          <FieldRow label="review allowed commands" kind={(ws.review_allowed_commands ?? []).length ? 'tags' : 'unset'}
            tags={ws.review_allowed_commands ?? []} unsetLabel="no extra commands allowed — review stays read-only" />
          <FieldRow label="allowed domains" kind={(ws.allowed_domains ?? []).length ? 'tags' : 'unset'}
            tags={ws.allowed_domains ?? []} unsetLabel="external fetches unavailable" />
          {publishable && <PublishWorkspace ws={ws} say={say} onPublished={onChanged} />}
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="setup hints for humans — e.g. run npm install before first use" />
          {/* the board's own registry clone never offers the off position —
              the server refuses it too (ADR 0013), this just keeps the UI honest */}
          <Switch label="protected — changes here always need human approval" checked={prot}
            disabled={busy || (ws.registrySelf && !!ws.protected)} onChange={(next) => setProt(next)} />
          <FreeEntryAllowlistInput values={cmds} onChange={setCmds} />
          <FreeEntryAllowlistInput values={domains} onChange={setDomains}
            label="Allowed domains"
            description="domains this workspace's worker sessions may reach. Empty keeps external fetches closed (confirmed on save if non-empty)."
            placeholder='domain — e.g. "registry.npmjs.org"' />
          <EditActions dirty={dirty} busy={busy} saveLabel="Save — commits to the registry"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
      {dialog}
    </Card>
  );
}

// Default icon picker rows (issue #72): sea life first, then land animals —
// the fixed order is the worldview convention (CONTEXT.md's "tidepool
// dweller" naming), not cosmetic, so it must never be reordered or trimmed.
const AGENT_ICON_SEA = ['🐙', '🦀', '🦐', '🦞', '🦑', '🦪', '🐚', '🐡', '🐠', '🐟', '🐬', '🐳', '🦈', '🦭', '🐢', '🪼', '🪸'];
const AGENT_ICON_LAND = ['🦦', '🐕', '🐈', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦅', '🐴', '🦋', '🐝'];

// A grid of the default icons plus a free-input escape hatch (issue #72's AC:
// "加えて任意の絵文字の自由入力欄") — #52's loader already enforces the
// single-Twemoji-grapheme shape server-side, so this stays a plain text
// field rather than duplicating that check in the browser.
function AgentIconPicker({ value, onChange }: { value?: string; onChange: (icon: string) => void }) {
  const { Input } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Icon
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[...AGENT_ICON_SEA, ...AGENT_ICON_LAND].map((emoji) => (
          <button key={emoji} type="button" onClick={() => onChange(emoji)}
            style={{
              width: 32, height: 32, padding: 0, borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: value === emoji ? '2px solid var(--tide-4)' : '1px solid var(--rock-3)',
              background: value === emoji ? 'var(--tide-1)' : 'none',
            }}>
            {emoji}
          </button>
        ))}
      </div>
      <Input label="Custom icon" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
        placeholder="paste any single emoji, or pick one above" />
    </div>
  );
}

// The agent fields an edit or a creation resubmits (agent-create.ts's
// UpdateAgentInput), pulled off a record as one draft. `name` is absent on
// purpose: it is the file name, offered at creation and never editable
// afterwards (parent issue #54).
/** 編集・作成が出し入れするエージェントの下書き(agent-create.ts の
 *  UpdateAgentInput)。`name` はファイル名なので入っていない(親 issue #54)。 */
interface AgentDraft {
  icon: string;
  description: string;
  systemPrompt: string;
  authority: string;
  provider: string;
  tier: string;
  advisor: boolean;
  skills: string[];
}
type AgentDraftValue = AgentDraft[keyof AgentDraft];
/** Select が受け取る選択肢(サーバが返す value+label)。 */
interface SettingsOption {
  value: string;
  label: string;
}

function agentDraftOf(agent: SettingsAgent): AgentDraft {
  return {
    icon: agent.icon ?? '', description: agent.description,
    systemPrompt: agent.systemPrompt, authority: agent.authority,
    provider: agent.provider,
    tier: agent.tier ?? '', advisor: agent.advisor,
    // GET /api/agents already returns skills (ADR 0025)
    skills: agent.skills,
  };
}

// ADR 0025 決定7 / issue #106: the default agent (tako) is ["@workspace"], so a
// new agent starts there too — a visible field, not a hidden default: the
// author sees it and edits it before creating.
const NEW_AGENT_DRAFT: AgentDraft = {
  icon: '', description: '', systemPrompt: '', authority: '',
  provider: '', tier: '', advisor: false, skills: ['@workspace'],
};

// The API body those fields make. The optional ones drop out when blank, so a
// cleared field round-trips to absent rather than to an empty string.
function agentBody(d: AgentDraft) {
  return {
    authority: d.authority,
    description: d.description.trim(),
    provider: d.provider,
    icon: d.icon.trim() || undefined,
    tier: d.tier || undefined,
    advisor: d.advisor || undefined,
    skills: d.skills,
    systemPrompt: d.systemPrompt,
  };
}

// Whether the draft differs from what it was primed with. The skills
// comparison is order-sensitive (sameStrings, matching the server's no-op
// detection) — a reorder is a real edit.
function agentDraftDirty(d: AgentDraft, base: AgentDraft) {
  return d.icon !== base.icon
    || d.description.trim() !== base.description
    || d.systemPrompt !== base.systemPrompt
    || d.authority !== base.authority
    || d.provider !== base.provider
    || d.tier !== base.tier
    || d.advisor !== base.advisor
    || !sameStrings(d.skills, base.skills);
}

// The provider select's leading entry (ADR 0097): provider is required, so
// this is "not chosen yet", not a default — Save stays disabled until one is
// picked (the same shape as MERGE_OPTIONS below). The value+label options
// themselves are server-supplied over GET /api/agents (registry.ts's
// PROVIDER_OPTIONS) so the client never duplicates the enumeration.
const PROVIDER_PLACEHOLDER = { value: '', label: 'choose one — provider is required' };

// The requested tier (ADR 0110 決定1). Optional, unlike the provider above: the
// blank entry is the real "no default of my own", which resolves to the board's
// default tier at pickup. Model and effort are not fields here at all any more —
// the board's provider × tier table decides them, and #545 opens that table for
// editing.
const TIER_OPTIONS = [
  { value: '', label: "board default — standard, unless the board's table says otherwise" },
  { value: 'economy', label: 'economy — the cheap tier' },
  { value: 'standard', label: 'standard — the workhorse tier' },
  { value: 'frontier', label: 'frontier — the top tier' },
];

// Those fields as controls, shared by the record card and the create form so
// the two never drift — the agent analogue of ProfileFields.
function AgentFields({ draft, set, authorityOptions, providerOptions, hostSkills, hostSkillsDegraded }: {
  draft: AgentDraft;
  set: (key: keyof AgentDraft, value: AgentDraftValue) => void;
  authorityOptions: (string | SettingsOption)[];
  providerOptions: SettingsOption[];
  hostSkills: string[];
  hostSkillsDegraded: boolean;
}) {
  const { Checkbox, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <AgentIconPicker value={draft.icon} onChange={(v) => set('icon', v)} />
      <Input label="Description" value={draft.description} onChange={(e) => set('description', e.target.value)}
        placeholder="when a delegating agent should pick this one" />
      <Input label="Specialty — persona, perspective, or this agent's own steps (optional; the worker protocol itself is injected separately, not written here)"
        multiline rows={4} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Select label="Authority" options={authorityOptions} value={draft.authority} onChange={(e) => set('authority', e.target.value)} />
        <Select label="Provider" options={[PROVIDER_PLACEHOLDER, ...providerOptions]} value={draft.provider} onChange={(e) => set('provider', e.target.value)} />
      </div>
      <Select label="Default tier" options={TIER_OPTIONS} value={draft.tier} onChange={(e) => set('tier', e.target.value)} />
      <Checkbox testId="agent-advisor" label="advisor — this agent may consult a stronger model at decision points"
        checked={draft.advisor} onChange={() => set('advisor', !draft.advisor)} />
      <SkillListInput candidates={hostSkills} degraded={hostSkillsDegraded} values={draft.skills} onChange={(v) => set('skills', v)} />
    </React.Fragment>
  );
}

// One agent as a record card (issue #72, restructured by #204),
// WorkspaceRecord's twin: read-only until Edit, and then the draft above,
// prefilled from the GET /api/agents list. `name` is shown via AgentChip only —
// renaming isn't offered here at all (it's the file name, parent issue #54).
function AgentRecord({ agent, authorityProfiles, providerOptions, hostSkills, hostSkillsDegraded, say, onChanged, edit }: {
  agent: SettingsAgent;
  authorityProfiles: string[];
  providerOptions: SettingsOption[];
  hostSkills: string[];
  hostSkillsDegraded: boolean;
  say: AppSay;
  onChanged: () => Promise<void>;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const { AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const id = `agent:${agent.name}`;
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(() => agentDraftOf(agent));
  const set = (key: keyof AgentDraft, value: AgentDraftValue) => setDraft((d) => ({ ...d, [key]: value }) as AgentDraft);
  const [busy, setBusy] = React.useState(false);

  const dirty = agentDraftDirty(draft, agentDraftOf(agent));
  const ok = !!draft.description.trim() && !!draft.authority && !!draft.provider;
  useDirtySignal(edit, open, dirty);

  const startEdit = () => edit.open(id, () => setDraft(agentDraftOf(agent)));

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/agents/${encodeURIComponent(agent.name)}`, agentBody(draft), 'PATCH');
      say('success', 'agent updated — committed to the registry', agent.name);
      edit.close();
      await onChanged();
    } catch (err) {
      say('danger', 'agent update failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* a built-in has no registry file to edit (ADR 0117 決定2) — the door
          is left out rather than offered and refused; creating a same-named
          agent is how it gets shadowed, and that door announces itself */}
      <RecordCardHead editing={open} onEdit={agent.builtin ? undefined : startEdit}>
        {/* while editing, the chip previews the draft icon — picking one
            confirms itself immediately, as it did on the flat surface */}
        <AgentChip name={agent.name} icon={open ? draft.icon : (agent.icon ?? '')} />
      </RecordCardHead>
      {!open && (agent.builtin || agent.shadowsBuiltIn) && (
        <FieldRow label="definition" kind="text"
          value={agent.builtin
            ? 'built-in — no registry file; create an agent with this name to shadow it'
            : 'shadows built-in — this entry wins; delete it to fall back to the board\'s own'} />
      )}
      {!open && (
        <React.Fragment>
          <FieldRow label="description" kind={agent.description ? 'text' : 'unset'} value={agent.description} unsetLabel="—" />
          <FieldRow label="specialty" kind={agent.systemPrompt ? 'text' : 'unset'} value={agent.systemPrompt}
            unsetLabel="no specialty — worker protocol only" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="authority" kind={agent.authority ? 'mono' : 'unset'} value={agent.authority} unsetLabel="—" />
            <FieldRow label="provider" kind={agent.provider ? 'mono' : 'unset'} value={agent.provider} unsetLabel="—" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="default tier" kind={agent.tier ? 'mono' : 'unset'} value={agent.tier ?? ''} unsetLabel="board default" />
            <FieldRow label="advisor" kind={agent.advisor ? 'mono' : 'unset'} value={agent.advisor ? 'yes' : ''} unsetLabel="no advisor" />
          </div>
          <FieldRow label="skills" kind={agent.skills.length ? 'tags' : 'unset'} tags={agent.skills}
            scheme="skills" wildcardHint="every skill" unsetLabel="no skills allowed" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <AgentFields draft={draft} set={set} authorityOptions={authorityProfiles}
            providerOptions={providerOptions}
            hostSkills={hostSkills} hostSkillsDegraded={hostSkillsDegraded} />
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save changes — commits to the registry"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// The server's machine reason codes (profile-create.ts's dangerousValues,
// workspace-create.ts's dangerousWorkspaceValues) rendered as prose for the
// confirmation dialog (issue #78, generalized to workspaces by ADR 0061 決定1).
// The board never decides on its own what counts as dangerous — it only
// translates the codes the 409 hands back, so the danger definition stays
// single-sourced on the server (ADR 0027). An unrecognized code (server added
// a reason the WebUI hasn't caught up to) falls back to the raw string rather
// than being dropped — see DANGEROUS_REASON_LABEL[r] ?? r below.
const DANGEROUS_REASON_LABEL: Record<string, string> = {
  merge_auto_if_ci_green:
    'Merge is auto_if_ci_green — a PR under this authority merges unattended once CI is green, with no human in the loop.',
  assignable_to_wildcard:
    'Assignable-to carries the wildcard "*" — an agent with this authority may delegate to any agent.',
  allowed_workspaces_wildcard:
    'Allowed-workspaces carries the wildcard "*" — this authority reaches every workspace on the board.',
  unprotect:
    'Protection is being removed — tasks targeting this workspace stop converting to approval questions, and its PRs follow the merge dial without waiting for a human.',
  review_allowed_commands_set:
    'Review-allowed commands is non-empty — review sessions in this workspace gain Bash access to those command prefixes, beyond the read-only default.',
  allowed_domains_set:
    'Allowed domains is non-empty — worker sessions in this workspace gain an external data-transfer path to those domains.',
};

// issue #383 の信号コード。DANGEROUS_REASON_LABEL とは別の表である — この族は
// エージェントの権限を1ミリも広げず、守っているのは人間自身の作業ツリーのほう
// なので、CONTEXT.md「危険な値」の列挙に混ぜない(混ぜると ADR 0088 の
// 「確認は WebUI 専用」がこの族まで及ぶと読める)。訳すだけという性質は同じで、
// 判定はサーバ単一正本(ADR 0027)。
const LIVE_CHECKOUT_SIGNAL_LABEL: Record<string, string> = {
  uncommitted_changes:
    'The checkout has uncommitted changes or untracked files — someone is working in this tree right now.',
  worktree_unreadable:
    'The checkout has no readable working tree — the board could not tell whether work is in progress there.',
  claude_settings_local:
    'The checkout has .claude/settings.local.json — host-local state a human put there for their own sessions.',
  claude_settings_hooks:
    'The checkout\'s .claude/settings.json carries hooks — the shape of a development checkout, not a disposable one.',
};

// The merge dial (registry.ts): required and three-valued since ADR 0079, so
// the leading entry is "not chosen yet", not a default — Save stays disabled
// until one of the three is picked. auto_if_ci_green is the dangerous one.
const MERGE_OPTIONS = [
  { value: '', label: 'choose one — the dial is required' },
  { value: 'escalate', label: 'escalate — always ask a human before merging' },
  { value: 'auto_if_ci_green', label: 'auto_if_ci_green — merge unattended once CI is green' },
  { value: 'external', label: 'external — the merge lives on GitHub, off the board' },
];

// Order-sensitive content equality — the profile save payload's arrays compare
// by contents, not reference (mirrors profile-create.ts's sameStringArray so
// the edit card's dirty flag and the server's no-op detection agree).
function sameStrings(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// A list field for a profile's assignable_to / allowed_workspaces (issue #78):
// picks from the registry's existing agents / workspaces rather than free text,
// so a value can't be a typo for a name that doesn't exist. Selected entries
// render as removable Tags; the wildcard "*" rides as its own option — it is
// exactly what the server flags as dangerous, so it stays selectable and the
// judgment is left to the save-time dialog. Values already on the profile are
// shown even when absent from `candidates` (an entry can outlive the agent or
// workspace it named) — the picker only constrains what you can newly add.
function ProfileListInput({ label, hint, candidates, wildcardHint, values, onChange }: {
  label: string;
  hint?: string;
  candidates: string[];
  wildcardHint: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  // the wildcard is an addable option too — the placeholder must count it, or
  // it reads "no more to add" while `*` still sits selectable below
  const addable = candidates.filter((c) => !values.includes(c));
  const wildcardAddable = !values.includes('*');
  const options = [
    { value: '', label: addable.length || wildcardAddable ? 'add…' : 'no more to add' },
    ...addable.map((c) => ({ value: c, label: c })),
    ...(wildcardAddable ? [{ value: '*', label: `* — ${wildcardHint}` }] : []),
  ];
  const pick = (e: React.ChangeEvent<HTMLSelectElement>) => { if (e.target.value) onChange([...values, e.target.value]); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </span>
      {hint && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</p>}
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color={v === '*' ? 'sun' : 'tide'} mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      {/* value is pinned to '' so the control always shows the placeholder and
          snaps back after each pick — it is an add-picker, not a bound field */}
      <Select value="" options={options} onChange={pick} />
    </div>
  );
}

// The skills allowlist picker's client-side grammar gate (issue #106 / ADR
// 0025): mirrors just two of assertValidSkillAllowlist's rules — "* only when
// alone" and "@ entries are only @workspace/@host" — plus empty/duplicate UX
// guards. Everything else (a bare individual name, a "plugin名:*" glob, a
// workspace-specific name) is deliberately let through: free entry's whole
// point is adding references the picker can't enumerate (an allowlist is a
// reference, not a claim of stock — ADR 0023). The server's
// assertValidSkillAllowlist stays the authority; this only spares the round
// trip on the two mistakes that are obvious at input time. Returns an error
// string, or null when the entry may be added.
function skillAddError(entry: string, existing: string[]) {
  const v = entry.trim();
  if (!v) return 'empty skill name';
  if (existing.includes(v)) return 'already added';
  if (v === '*') {
    return existing.length > 0 ? '"*" must be the only entry — remove the others first' : null;
  }
  if (existing.includes('*')) return 'remove "*" first — it must be the only entry';
  if (v.startsWith('@') && v !== '@workspace' && v !== '@host') {
    return 'an @ entry may only be @workspace or @host';
  }
  return null;
}

// The agent skills allowlist picker (issue #106 / ADR 0025), ProfileListInput's
// sibling: selected entries render as removable Tags; a Select adds a scope word
// (@workspace/@host) or an enumerated @host skill; a free-entry field adds
// anything the picker can't offer (a workspace-specific name, a "plugin名:*"
// glob). `candidates` is the enumerated @host set from GET /api/skills; the
// scope words and the "*" wildcard are this component's own additions. When the
// enumeration degraded, `degraded` shows a one-line note — the scope words and
// free entry still work, so the picker never hard-fails.
function SkillListInput({ candidates, degraded, values, onChange }: {
  candidates: string[];
  degraded: boolean;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { Input, Button, Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState('');
  const [freeError, setFreeError] = React.useState<string | null>(null);
  // scope words first, then the enumerated @host skills, then the bare wildcard
  // — offer only entries the grammar would currently accept (this drops "*"
  // once anything else is selected, drops everything once "*" is, and hides
  // already-selected entries), so the Select can add without its own gate
  const offerable = ['@workspace', '@host', ...candidates, '*'].filter(
    (c) => skillAddError(c, values) === null,
  );
  const options = [
    { value: '', label: offerable.length ? 'add a scope or skill…' : 'no more to add' },
    ...offerable.map((c) => ({ value: c, label: c === '*' ? '* — every skill' : c })),
  ];
  const pick = (e: React.ChangeEvent<HTMLSelectElement>) => { if (e.target.value) onChange([...values, e.target.value]); };
  const addFree = () => {
    const err = skillAddError(free, values);
    if (err) { setFreeError(err); return; }
    onChange([...values, free.trim()]);
    setFree(''); setFreeError(null);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Skills
      </span>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        which skills this agent may use — a scope (@workspace / @host), an enumerated host skill, "plugin-name:*", or "*" for all. Free entry adds a workspace-specific name the picker can't list.
      </p>
      {degraded && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          host skill list unavailable — scope words and free entry still work.
        </p>
      )}
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color={v === '*' ? 'sun' : v.startsWith('@') ? 'grass' : 'tide'} mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      {/* value pinned to '' so the control snaps back after each pick */}
      <Select value="" options={options} onChange={pick} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Input value={free} mono error={freeError || undefined}
            onChange={(e) => { setFree(e.target.value); setFreeError(null); }}
            placeholder='free entry — e.g. a workspace skill name or "plugin-name:*"' />
        </div>
        <Button variant="secondary" disabled={!free.trim()} onClick={addFree}>Add</Button>
      </div>
    </div>
  );
}

// The four editable profile fields, shared by the edit card and the create
// form so the two never drift (the profile analogue of the duplication the
// agent card and its create form carry field-by-field).
function ProfileFields({ agentNames, workspaceNames, guidance, setGuidance, assignableTo, setAssignableTo, allowedWorkspaces, setAllowedWorkspaces, merge, setMerge }: {
  agentNames: string[];
  workspaceNames: string[];
  guidance: string;
  setGuidance: (guidance: string) => void;
  assignableTo: string[];
  setAssignableTo: (names: string[]) => void;
  allowedWorkspaces: string[];
  setAllowedWorkspaces: (names: string[]) => void;
  merge: string;
  setMerge: (merge: string) => void;
}) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <Input label="Guidance — prose injected into the agent's system prompt at spawn"
        multiline rows={4} value={guidance} onChange={(e) => setGuidance(e.target.value)}
        hint={'name the act you want stopped — offering it as one example of a category ("irreversible or outward-facing") leaves the category call to the reader. And guidance is never a floor: a boundary that must hold goes in Assignable to / Allowed workspaces, or in a protected workspace — never in a flag, which declares rather than gates'}
        placeholder="how an agent carrying this authority should act" />
      <ProfileListInput label="Assignable to"
        hint={'who this authority may delegate to — a registered agent or the human, or "*" for any (confirmed on save)'}
        candidates={agentNames.includes('human') ? agentNames : [...agentNames, 'human']}
        wildcardHint="any agent"
        values={assignableTo} onChange={setAssignableTo} />
      <ProfileListInput label="Allowed workspaces"
        hint={'which workspaces this authority may act in — pick a registered workspace, or "*" for every one (confirmed on save)'}
        candidates={workspaceNames} wildcardHint="every workspace"
        values={allowedWorkspaces} onChange={setAllowedWorkspaces} />
      <Select label="Merge authority" options={MERGE_OPTIONS} value={merge} onChange={(e) => setMerge(e.target.value)} />
    </React.Fragment>
  );
}

// The record-level delete door (ADR 0087 / issue #205). WebUI-only (ADR 0088):
// the management MCP has no delete verb at all. Two-phase like every other
// dangerous action — the first request omits `confirm`, the server's 409
// `confirm_required` opens the dialog, and accepting resends the same request
// with the flag. A 409 that carries `blocked` instead is a refusal no
// confirmation can buy (referenced by unsettled tasks, the board's default, the
// registry clone itself); it lands on the ordinary failure toast, whose message
// already spells out the count / agent names the server counted.
/** registry 由来の3節(issue #204)。一覧・節・record の3段が同じ形で読む。 */
type SettingsSectionKey = 'workspaces' | 'agents' | 'profiles';
/** 3節の行が共有する欄 —— 段の側はこの形だけを読む。 */
interface SettingsRecord {
  name: string;
  builtin?: true;
}
/** 1節の定義。関数値の欄をメソッド記法で書くのは、行の型が違う3節を
 *  `SettingsSection<SettingsRecord>` の1つの形で受けるため(メソッドの引数は双変)。 */
interface SettingsSection<R extends SettingsRecord> {
  title: string;
  singular: string;
  note: string;
  items: R[] | null;
  unavailable: boolean;
  footnote: string;
  indexSummary(items: R[]): string;
  rowIdentity(item: R): { label?: string; agentName?: string; agentIcon?: string };
  rowSummary(item: R): string;
  record(rec: R): React.ReactNode;
  createForm(): React.ReactNode;
  reload(): Promise<void>;
  deleteNote: string;
  deleteLead: string;
  /** 削除の要求。既定は `DELETE /api/<節>/<name>` を送るだけで、応答を読む節だけが持つ。 */
  remove?(confirm: Record<string, true>, name: string): Promise<string | void>;
}

function DeleteRecord({ section, sectionKey, name, say, onDeleted }: {
  section: SettingsSection<SettingsRecord>;
  sectionKey: SettingsSectionKey;
  name: string;
  say: AppSay;
  onDeleted: () => Promise<void> | void;
}) {
  const { Button, Card } = window.TidepoolDesignSystem_8a0ead;
  const { busy, save, dialog } = useDangerousSave(say, onDeleted, {
    noun: section.singular,
    confirmKey: 'confirm',
    dialogTitle: `Delete this ${section.singular}?`,
    // 削除の確認に理由コードは無い(危険な値と違い「消す」1つきり)ので、
    // ダイアログの本文がそのまま資源ごとの説明である
    dialogLead: section.deleteLead,
    confirmLabel: 'Delete',
    confirmOf: (err) => (apiErrorDetail(err, `DELETE /api/${sectionKey}/:name 409`)?.confirm_required ? { reasons: [] } : null),
  });
  const remove = section.remove
    ?? (async (confirm: Record<string, true>) => { await api(`/api/${sectionKey}/${encodeURIComponent(name)}`, confirm, 'DELETE'); });
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {section.deleteNote}
        </p>
        <Button variant="danger" size="sm" disabled={busy}
          onClick={() => save((confirm) => remove(confirm, name), 'deleted', name)}>
          Delete {section.singular}
        </Button>
      </div>
      {dialog}
    </Card>
  );
}

// The two-phase confirmed save (issue #78, #55 phase 3; generalized to
// workspaces by ADR 0061 決定1), shared by every door whose first attempt can
// come back 409 `confirm_required`. Most of those doors carry a dangerous
// value; issue #383's register gate does not (it shows the human what their
// own checkout looks like), which is why the reason codes and their labels are
// per-door rather than one table. The first attempt omits the confirm flag; when the payload
// grants broad power the server answers 409 confirm_required with the machine
// reason codes (issue #77). We surface those in a dialog and, once the human
// accepts, resend the very same body with the flag set. The board makes no
// pre-judgment of danger — the 409 is the only trigger. `confirmKey` is the
// flag name the door reads (`confirmDangerous` for profiles, `confirm` for
// workspaces — ADR 0061 決定1 kept the workspace door's existing flag name
// rather than adding a second boolean). Returns the busy flag, the save
// entrypoint, and the dialog element the caller renders inline.
/** 409 confirm_required を開く扉ごとの文言と旗の名前。 */
interface DangerousSaveOptions {
  noun: string;
  confirmKey: string;
  dialogTitle: string;
  dialogLead: string;
  confirmLabel?: string;
  failDetail?: string;
  labels?: Record<string, string>;
  /** その扉の 409 を契約のエラー行で読む —— 確認で買える拒否なら、ダイアログが列挙する
   *  理由コードと、その扉だけが持つ一行(issue #383 の clone 入口の着地先など)を返す。 */
  confirmOf: (err: unknown) => { reasons: string[]; note?: React.ReactNode } | null;
}
function useDangerousSave(
  say: AppSay,
  onDone: () => Promise<void> | void,
  { noun, confirmKey, dialogTitle, dialogLead, confirmLabel, failDetail, labels = DANGEROUS_REASON_LABEL, confirmOf }: DangerousSaveOptions,
) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ reasons: string[]; note?: React.ReactNode; resend: () => void } | null>(null); // null while safe
  // `send` は扉ごとの要求そのもの(確認の旗を本文へ混ぜて出す)。返す文字列は完了表示の
  // 名指し —— workspace の削除だけが「残る checkout の場所」を返す(ADR 0087 決定4)
  const save = async (send: (confirm: Record<string, true>) => Promise<string | void>, verb: string, name: string) => {
    const attempt = async (confirmed: boolean) => {
      setBusy(true);
      try {
        const detail = await send(confirmed ? { [confirmKey]: true } : {});
        setConfirm(null);
        say('success', `${noun} ${verb} — committed to the registry`, detail || name);
        await onDone();
      } catch (err) {
        // the #77 confirmation 409 is distinguished from any other failure
        // (bad input, a push that never landed — ADR 0052 決定1) by its
        // confirm_required flag — only that one opens the dialog for a resend
        const asked = confirmOf(err);
        if (asked) {
          setConfirm({ ...asked, resend: () => attempt(true) });
        } else {
          setConfirm(null);
          // `not ${verb}` であって `${verb} failed` ではない — verb は過去分詞
          // (added / deleted / updated)なので、後者は「workspace added failed」に崩れる
          say('danger', `${noun} not ${verb}${failDetail ? ` — ${failDetail}` : ''}`, String((err as Error).message || err));
        }
      }
      setBusy(false);
    };
    await attempt(false);
  };
  const dialog = (
    <PortalDialog open={!!confirm} title={dialogTitle} onClose={() => setConfirm(null)}
      footer={
        <React.Fragment>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => confirm && confirm.resend()}>{confirmLabel ?? 'Save anyway'}</Button>
        </React.Fragment>
      }>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--text-sm)' }}>{dialogLead}</p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(confirm?.reasons ?? []).map((r: string) => (
          <li key={r}>{labels[r] ?? r}</li>
        ))}
      </ul>
      {/* 理由コードの列挙の下に、その扉だけが持つ一行(issue #383 の clone 入口の
          着地先など)。出せるものが無ければ何も描かない */}
      {confirm?.note}
    </PortalDialog>
  );
  return { busy, save, dialog };
}

/** 危険な値の 409 を契約のその扉の行で読む(ADR 0061 決定1)。 */
function dangerousValuesOf(key: 'PATCH /api/workspaces/:name 409' | 'POST /api/profiles 409' | 'PATCH /api/profiles/:name 409') {
  return (err: unknown) => {
    const detail = apiErrorDetail(err, key);
    return detail?.confirm_required ? { reasons: detail.dangerous_values } : null;
  };
}

function useProfileSave(say: AppSay, onDone: () => Promise<void> | void, conflict: 'POST /api/profiles 409' | 'PATCH /api/profiles/:name 409') {
  return useDangerousSave(say, onDone, {
    noun: 'profile', confirmKey: 'confirmDangerous',
    dialogTitle: 'Save a profile with broad power?',
    dialogLead: 'This profile grants broad power. Review before saving:',
    confirmOf: dangerousValuesOf(conflict),
  });
}

// The workspace twin of useProfileSave (ADR 0061 決定1). Replaces the old
// client-side pre-confirm (issue #57's "off→on asks before sending") — that
// path never actually hit the server's 409 (src/api.ts's comment on the
// confirm_required branch used to say as much), and it recomputed danger
// itself, which is exactly the single-source-on-the-server posture ADR 0027
// and DANGEROUS_REASON_LABEL's own comment rule out. Every dangerous save now
// round-trips through the same 409 the direct API gets.
function useWorkspaceSave(say: AppSay, onDone: () => Promise<void> | void) {
  return useDangerousSave(say, onDone, {
    noun: 'workspace', confirmKey: 'confirm',
    dialogTitle: 'Save a change that widens what agents may do?',
    dialogLead: 'This change widens what agents may do here. Review before saving:',
    confirmOf: dangerousValuesOf('PATCH /api/workspaces/:name 409'),
  });
}

// One authority profile as a record card (issue #78, restructured by #204),
// AgentRecord's twin: read-only until Edit, then the four editable fields
// prefilled from GET /api/profiles. `name` is the file name
// (authority/<name>.yaml), not renameable here, same as agents. No delete: an
// agent referencing this profile would break at spawn (parent issue #55).
function ProfileRecord({ profile, agentNames, agentIcons, workspaceNames, say, onChanged, edit }: {
  profile: SettingsProfile;
  agentNames: string[];
  agentIcons: Record<string, string>;
  workspaceNames: string[];
  say: AppSay;
  onChanged: () => Promise<void>;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const id = `profile:${profile.name}`;
  const open = edit.isOpen(id);
  const [guidance, setGuidance] = React.useState(profile.guidance);
  const [assignableTo, setAssignableTo] = React.useState(profile.assignable_to ?? []);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState(profile.allowed_workspaces ?? []);
  const [merge, setMerge] = React.useState(profile.merge ?? '');
  const { busy, save, dialog } = useProfileSave(say, async () => { edit.close(); await onChanged(); }, 'PATCH /api/profiles/:name 409');

  // Per-field, because the wire body carries exactly the changed fields
  // (ADR 0086 決定4) — one source for the dirty flag and for what travels, so
  // an untouched value can never sneak into the danger judgment.
  const changed = {
    guidance: guidance !== profile.guidance,
    assignable_to: !sameStrings(assignableTo, profile.assignable_to ?? []),
    allowed_workspaces: !sameStrings(allowedWorkspaces, profile.allowed_workspaces ?? []),
    merge: (merge || '') !== (profile.merge ?? ''),
  };
  const dirty = Object.values(changed).some(Boolean);
  useDirtySignal(edit, open, dirty);

  const startEdit = () => edit.open(id, () => {
    setGuidance(profile.guidance);
    setAssignableTo(profile.assignable_to ?? []);
    setAllowedWorkspaces(profile.allowed_workspaces ?? []);
    setMerge(profile.merge ?? '');
  });

  const submit = () => {
    const body: Partial<Record<'guidance' | 'merge', string> & Record<'assignable_to' | 'allowed_workspaces', string[]>> = {};
    if (changed.guidance) body.guidance = guidance;
    if (changed.assignable_to) body.assignable_to = assignableTo;
    if (changed.allowed_workspaces) body.allowed_workspaces = allowedWorkspaces;
    if (changed.merge) body.merge = merge;
    save(async (confirm) => { await api(`/api/profiles/${encodeURIComponent(profile.name)}`, { ...body, ...confirm }, 'PATCH'); }, 'updated', profile.name);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={startEdit}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{profile.name}</span>
      </RecordCardHead>
      {!open && (
        <React.Fragment>
          <FieldRow label="guidance" kind={profile.guidance ? 'text' : 'unset'} value={profile.guidance} unsetLabel="—" />
          <FieldRow label="assignable to" kind={(profile.assignable_to ?? []).length ? 'tags' : 'unset'}
            tags={profile.assignable_to ?? []} agentIcons={agentIcons} wildcardHint="any agent"
            unsetLabel="nobody — this authority can't be delegated" />
          <FieldRow label="allowed workspaces" kind={(profile.allowed_workspaces ?? []).length ? 'tags' : 'unset'}
            tags={profile.allowed_workspaces ?? []} wildcardHint="every workspace"
            unsetLabel="no workspace — this authority can't act anywhere" />
          <FieldRow label="merge authority" kind="mono" value={profile.merge} />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <ProfileFields
            agentNames={agentNames} workspaceNames={workspaceNames}
            guidance={guidance} setGuidance={setGuidance}
            assignableTo={assignableTo} setAssignableTo={setAssignableTo}
            allowedWorkspaces={allowedWorkspaces} setAllowedWorkspaces={setAllowedWorkspaces}
            merge={merge} setMerge={setMerge} />
          <EditActions dirty={dirty} ok={!!merge} busy={busy} saveLabel="Save changes — commits to the registry"
            onSave={submit} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
      {dialog}
    </Card>
  );
}

// The footnote under a settings screen — where its edits actually land.
const settingsFootnote = { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' };

// The mono-caps label a settings card wears in place of a heading.
const settingsCardLabel = {
  margin: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

// Display language (issue #46) as a record card: the one board setting both the
// draft prompt's language instruction and a later display-time-translation
// feature read — a plain board-wide setting, not gated on the registry like the
// workspaces/agents/profiles sections.
// GitHub login state (ADR 0093 決定5). Read-only on purpose: logging in writes a
// credential, and that door stays on the terminal — this card only says whether
// the board has one, and names the command that makes it.
function GitHubLoginCard({ loggedIn }: { loggedIn: boolean | null }) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>github</span>
      <FieldRow label="login" kind={loggedIn ? 'mono' : 'unset'}
        value={loggedIn ? 'logged in' : ''} unsetLabel="not logged in" />
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        the board acts on GitHub as tidepool[bot], and reaches only the repositories the
        Tidepool App is installed on. run <code>npm run github-login</code> in a terminal on
        this host to log in — the same command re-logs in, and the board picks it up without
        a restart.
      </p>
    </Card>
  );
}

// Translation spend (issue #273). The last call's in/out is where a regression
// in ADR 0062's env would show — compared against that ADR, not against a
// second copy of its numbers kept here.
// `records` null means the read failed: a face put here to catch a silent
// regression must not itself go silent, so the card stays and says so.
function TranslateUsageCard({ records }: { records: WireContract['GET /api/translate/usage']['records'] | null }) {
  const { Card, FieldRow } = window.TidepoolDesignSystem_8a0ead;
  const last = records?.at(-1);
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>translation spend</span>
      {last ? (
        <React.Fragment>
          <FieldRow label="translations" kind="mono" value={`${records!.length} generated`} />
          <FieldRow label="estimated cost" kind="mono"
            value={`$${records!.reduce((sum, r) => sum + r.usage.estimated_cost_usd, 0).toFixed(4)}`} />
          <FieldRow label="last call" kind="mono"
            value={`${last.usage.input_tokens} in / ${last.usage.output_tokens} out`} />
        </React.Fragment>
      ) : (
        <FieldRow label="translations" kind="unset"
          unsetLabel={records ? 'none generated yet' : 'usage unavailable'} />
      )}
    </Card>
  );
}

function DisplayLanguageCard({ language, options, say, onSaved, edit }: {
  language: string;
  options: string[];
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow, Select } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:language';
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(language);
  const [busy, setBusy] = React.useState(false);
  const dirty = draft !== language;
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      // the select can only hold a canonical value, so POST sends it verbatim —
      // no trimming/normalization here (that lives at the write boundary)
      const { language: saved } = await api('POST /api/settings/display-language', { body: { language: draft } });
      say('success', 'display language saved', saved);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'display language save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(language))}>
        <span style={settingsCardLabel}>display language</span>
      </RecordCardHead>
      {!open && <FieldRow label="language" kind={language ? 'mono' : 'unset'} value={language} unsetLabel="unset" />}
      {open && (
        <React.Fragment>
          {/* options come straight from GET (display-language.ts's canonical
              list) — the UI never hardcodes the language list, so a board that
              adds a language needs no WebUI change (issue #115) */}
          <Select label="Language" options={options} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <EditActions dirty={dirty} ok={!!draft} busy={busy} saveLabel="Save display language"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Quiet hours (issue #64) as a record card: start/end only — tz is shown but is
// only ever changed via POST /api/settings/timezone (ADR 0022), which this card
// never calls.
function QuietHoursCard({ start, end, tz, say, onSaved, edit }: {
  start: string;
  end: string;
  tz: string;
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:quiet-hours';
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
      const saved = await api('POST /api/settings/quiet-hours', { body: { start: draftStart, end: draftEnd } });
      say('success', 'quiet hours saved', `${saved.start}–${saved.end}`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'quiet hours save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => { setDraftStart(start); setDraftEnd(end); })}>
        <span style={settingsCardLabel}>quiet hours</span>
      </RecordCardHead>
      {!open && (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="start" kind="mono" value={start} />
            <FieldRow label="end" kind="mono" value={end} />
          </div>
          <FieldRow label="timezone" kind={tz ? 'mono' : 'unset'} value={tz} unsetLabel="unset" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Start" mono value={draftStart} onChange={(e) => setDraftStart(e.target.value)} placeholder="HH:MM" />
            <Input label="End" mono value={draftEnd} onChange={(e) => setDraftEnd(e.target.value)} placeholder="HH:MM" />
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            start after end wraps past midnight (e.g. 23:00–07:00) — that's valid, not an error.
            timezone: {tz || 'unset'} — change it from the timezone setting, not here.
          </p>
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save quiet hours"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Pace offsets (issue #126 / ADR 0030) as a record card: the human's reserved
// share (pt) per usage window — the board runs this far behind the elapsed-time
// pace.
function PaceOffsetsCard({ offsets, say, onSaved, edit }: {
  offsets: WireContract['GET /api/settings/provider-pace-offsets']['offsets'];
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:provider-pace-offsets';
  const open = edit.isOpen(id);
  // 下書きは入力欄の文字列だが、初期値はサーバの数値のまま —— 比較も検査も String() を通す
  const asDraft = (values: typeof offsets): Record<string, string | number> => Object.fromEntries(
    values.map((value) => [`${value.provider}:${value.window}`, value.offset]),
  );
  const [draft, setDraft] = React.useState(() => asDraft(offsets));
  const [busy, setBusy] = React.useState(false);
  const keys = offsets.map((value) => `${value.provider}:${value.window}`);
  const current = asDraft(offsets);
  const dirty = keys.some((key) => String(draft[key]) !== String(current[key]));
  // the API rejects non-integers / out-of-range at the entry (ADR 0030) — the
  // form mirrors that check so the button only enables on a sendable value
  const validOffset = (v: string | number | undefined) => /^\d{1,3}$/.test(String(v).trim()) && Number(v) <= 100;
  const ok = keys.every((key) => validOffset(draft[key]));
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      const changed = offsets.filter((value) => {
        const key = `${value.provider}:${value.window}`;
        return String(draft[key]) !== String(value.offset);
      });
      await Promise.all(changed.map((value) => api('/api/settings/provider-pace-offsets', {
        provider: value.provider,
        window: value.window,
        offset: Number(draft[`${value.provider}:${value.window}`]),
      })));
      say('success', 'provider pace offsets saved', `${changed.length} window${changed.length === 1 ? '' : 's'} updated`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'pace offsets save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(asDraft(offsets)))}>
        <span style={settingsCardLabel}>provider pace offsets</span>
      </RecordCardHead>
      {!open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
          {offsets.map((value) => (
            <FieldRow key={`${value.provider}:${value.window}`} label={`${value.provider} · ${value.window}`} kind="mono" value={`${value.offset} pt`} />
          ))}
        </div>
      )}
      {open && (
        <React.Fragment>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {offsets.map((value) => {
              const key = `${value.provider}:${value.window}`;
              return <Input key={key} label={`${value.provider} · ${value.window}`} mono value={String(draft[key])}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} placeholder={String(value.offset)} />;
            })}
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            your reserved share of each usage window, in points (0–100). the board stays this far
            behind the elapsed-time pace, leaving that slice of the budget for your own sessions.
          </p>
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save provider offsets"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Memory (issue #592 / spec #586 C) as a record card: the token cap on the
// memory section injected into a worker at spawn.
function MemorySettingsCard({ settings, say, onSaved, edit }: {
  settings: WireContract['GET /api/settings/memory'];
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:memory';
  const open = edit.isOpen(id);
  const cap = String(settings.injection_token_cap);
  const [draft, setDraft] = React.useState(cap);
  const [busy, setBusy] = React.useState(false);
  const dirty = draft.trim() !== cap;
  // the API takes positive integers only — mirror it so Save enables on a sendable value
  const ok = /^[1-9]\d*$/.test(draft.trim());
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('POST /api/settings/memory', { body: { injection_token_cap: Number(draft.trim()) } });
      say('success', 'memory settings saved', `${saved.injection_token_cap} tokens`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'memory settings save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(cap))}>
        <span style={settingsCardLabel}>memory</span>
      </RecordCardHead>
      {!open && <FieldRow label="injection cap" kind="mono" value={`${cap} tokens`} />}
      {open && (
        <React.Fragment>
          <Input label="Injection cap (tokens)" mono value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={cap} />
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            the most memory a worker is handed at spawn. past the cap, entry text is dropped first, then the index gets shallower, then relevant entries go one at a time from the bottom.
          </p>
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save memory settings"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Meta-review (issue #924) as a record card: the one period shared by every
// subject's periodic meta-review (memory and routing).
function MetaReviewSettingsCard({ settings, say, onSaved, edit }: {
  settings: WireContract['GET /api/settings/meta-review'];
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, FieldRow, Input } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:meta-review';
  const open = edit.isOpen(id);
  const period = String(settings.period_days);
  const [draft, setDraft] = React.useState(period);
  const [busy, setBusy] = React.useState(false);
  const dirty = draft.trim() !== period;
  // the API takes positive integers only — mirror it so Save enables on a sendable value
  const ok = /^[1-9]\d*$/.test(draft.trim());
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('POST /api/settings/meta-review', { body: { period_days: Number(draft.trim()) } });
      say('success', 'meta-review settings saved', `every ${saved.period_days} days`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'meta-review settings save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(period))}>
        <span style={settingsCardLabel}>meta-review</span>
      </RecordCardHead>
      {!open && <FieldRow label="period" kind="mono" value={`${period} days`} />}
      {open && (
        <React.Fragment>
          <Input label="Period (days)" mono value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={period} />
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            the fewest days between two meta-reviews of the same subject (memory or routing). once past it, the board registers one as soon as there is something new to review.
          </p>
          <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save meta-review settings"
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// Memory entries (spec #586 F / issue #593): the human reads, writes and
// invalidates board memory here. Entries without an original are agent-written
// and get a display-language translation through the shared translate pacer;
// a failed or throttled one just stays untranslated. There is no approve action
// (ADR 0152): a behavior the human writes or edits here is approved on write, and
// an AI-drafted candidate is approved only through its proposal question.
const MEMORY_INVALIDATION_REASONS = ['superseded', 'path_moved', 'capability', 'environment', 'requirement_change'];
const needsSuccessor = (reason: string) => reason === 'superseded' || reason === 'path_moved';

function MemoryEntriesCard({ workspaceNames, agentNames, language, say, edit }: {
  workspaceNames: string[];
  agentNames: string[];
  language: string;
  say: AppSay;
  edit: SettingsEditSlot;
}) {
  const { Button, Card, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [filter, setFilter] = React.useState({ workspace: '', kind: '', state: '' });
  const [entries, setEntries] = React.useState<WireContract['GET /api/settings/memory/entries']['entries'] | null>(null); // null → still loading
  const [translations, setTranslations] = React.useState<Record<number, Extract<TpTranslation, { status: 'translated' }>>>({});
  const load = async () => {
    const query: Record<string, string> = {};
    if (filter.workspace === '(board)') query.board_wide = 'true';
    else if (filter.workspace) query.workspace = filter.workspace;
    if (filter.kind) query.kind = filter.kind;
    if (filter.state) query.state = filter.state;
    try {
      const loaded = (await api('GET /api/settings/memory/entries', { query })).entries;
      setEntries(loaded);
      if (language === 'English') return;
      for (const entry of loaded.filter((e) => e.original === null)) {
        translateTarget({ type: 'memory_entry', entry_id: entry.id })
          .then((out) => out.status === 'translated' && setTranslations((t) => ({ ...t, [entry.id]: out })))
          .catch(() => {});
      }
    } catch (err) {
      say('danger', 'memory entries load failed', String((err as Error).message || err));
    }
  };
  React.useEffect(() => { load(); }, [filter.workspace, filter.kind, filter.state]);

  const setFilterField = (key: string) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilter({ ...filter, [key]: e.target.value });
  const muted = { margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' };

  // the write form: one edit slot, like every settings card
  const writeId = 'board:memory-write';
  const writing = edit.isOpen(writeId);
  /** 記憶エントリの下書き。`backTranslation` は「読み返しのために今だけ持つ」訳
   *  (ADR 0015) なので欄ごとの map か null。 */
  const blank: {
    kind: string; workspace: string; path: string; originalTitle: string; originalText: string;
    title: string; text: string; backTranslation: Record<string, string> | null; supersedes: string; addressee: string;
  } = { kind: 'knowledge', workspace: '', path: '', originalTitle: '', originalText: '', title: '', text: '', backTranslation: null, supersedes: '', addressee: '' };
  const [draft, setDraft] = React.useState(blank);
  const [busy, setBusy] = React.useState(false);
  const setDraftField = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setDraft({ ...draft, [key]: e.target.value, ...(key === 'title' || key === 'text' ? { backTranslation: null } : {}), ...(key === 'kind' ? { supersedes: '' } : {}) });
  useDirtySignal(edit, writing, [draft.originalTitle, draft.originalText, draft.title, draft.text].some((v) => v.trim() !== ''));
  const translatable = language !== 'English';
  // a definition is one line with no title: its original and English are the text alone (ADR 0015)
  const fields: ('title' | 'text')[] = draft.kind === 'definition' ? ['text'] : ['title', 'text'];
  // editing an approved behavior writes its successor (ADR 0152 決定4), so the kind is fixed
  const editingBehavior = draft.kind === 'behavior' && !!draft.supersedes;
  const originalOf: Record<'title' | 'text', string> = { title: draft.originalTitle, text: draft.originalText };

  // Translate fills both English fields from the original title + text; Back-translate re-checks English the
  // human edited by hand (ADR 0015: the English is saved after the human reads its back-translation, never stored)
  const runTranslation = async (toEnglish: boolean) => {
    setBusy(true);
    try {
      const { english, back } = await translateMemoryWording(translateTarget, Object.fromEntries(fields.map((key) => [key, draft[key]])), toEnglish ? originalOf : null);
      setDraft({ ...draft, ...english, backTranslation: back });
    } catch (err) {
      say('danger', 'translate failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      // a partial original is sent as is so the server's 400 says why
      const originals = fields.map((key) => [`original_${key}`, originalOf[key].trim()]).filter(([, v]) => v);
      const body = { workspace: draft.workspace || null, path: draft.path.trim(), text: draft.text.trim(), ...Object.fromEntries(originals) };
      const supersedes = draft.supersedes ? { supersedes: Number(draft.supersedes) } : {};
      if (draft.kind === 'knowledge') await api('/api/settings/memory/knowledge', { ...body, title: draft.title.trim() });
      else if (draft.kind === 'behavior') await api('/api/settings/memory/behaviors', { ...body, title: draft.title.trim(), addressee: draft.addressee || null, ...supersedes });
      else await api('/api/settings/memory/definitions', { ...body, ...supersedes });
      say('success', `${draft.kind} saved`, body.path);
      edit.close();
      await load();
    } catch (err) {
      say('danger', `${draft.kind} save failed`, String((err as Error).message || err));
    }
    setBusy(false);
  };

  // invalidation: one entry at a time, reason + successor when the reason needs one
  const [invalidating, setInvalidating] = React.useState<{ id: number; reason: string; successor: string } | null>(null);
  const invalidate = async () => {
    setBusy(true);
    try {
      await api(`/api/settings/memory/entries/${invalidating!.id}/invalidate`, {
        reason: invalidating!.reason,
        ...(needsSuccessor(invalidating!.reason) ? { successor_id: Number(invalidating!.successor) } : {}),
      });
      say('success', 'entry invalidated', `#${invalidating!.id} · ${invalidating!.reason}`);
      setInvalidating(null);
      await load();
    } catch (err) {
      say('danger', 'invalidate failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
        <span style={settingsCardLabel}>memory entries</span>
        {!writing && (
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="ghost" size="sm" onClick={() => edit.open(writeId, () => setDraft(blank))}>Write</Button>
          </div>
        )}
      </div>
      {writing && (
        <React.Fragment>
          {editingBehavior
            ? <p style={muted}>editing behavior #{draft.supersedes} — saving writes a new approved entry and supersedes this one</p>
            : <Select label="Kind" value={draft.kind} onChange={setDraftField('kind')} options={['knowledge', 'behavior', 'definition']} />}
          <Select label="Workspace" value={draft.workspace} onChange={setDraftField('workspace')} options={[{ value: '', label: 'board-wide' }, ...workspaceNames]} />
          <Input label={draft.kind === 'definition' ? 'Branch path' : 'Path'} mono value={draft.path} onChange={setDraftField('path')} placeholder="build/tests" />
          {draft.kind === 'behavior' && (
            // the current addressee stays offered even if its agent has left the registry
            <Select label="Addressee" value={draft.addressee} onChange={setDraftField('addressee')}
              options={[{ value: '', label: 'every agent' }, ...new Set([...agentNames, ...(draft.addressee ? [draft.addressee] : [])])]} />
          )}
          {draft.kind === 'definition' && (
            <Input label="Supersedes (entry id, to revise the branch's current definition)" mono value={draft.supersedes} onChange={setDraftField('supersedes')} />
          )}
          {translatable && (
            <React.Fragment>
              {draft.kind !== 'definition' && (
                <Input label={`Original title (${language})`} value={draft.originalTitle} onChange={setDraftField('originalTitle')} />
              )}
              <Input label={`Original (${language})`} multiline rows={3} value={draft.originalText} onChange={setDraftField('originalText')} />
              <Button variant="secondary" size="sm" disabled={busy || fields.some((key) => !originalOf[key].trim())} onClick={() => runTranslation(true)}>Translate</Button>
            </React.Fragment>
          )}
          {draft.kind !== 'definition' && <Input label="Title (English)" value={draft.title} onChange={setDraftField('title')} />}
          <Input label="English (saved as the canonical text)" multiline rows={3} value={draft.text} onChange={setDraftField('text')} />
          {translatable && (
            <Button variant="secondary" size="sm" disabled={busy || fields.some((key) => !draft[key].trim())} onClick={() => runTranslation(false)}>Back-translate</Button>
          )}
          {draft.backTranslation && (
            <p style={muted} data-testid="memory-back-translation">back in {language}: {fields.map((key) => draft.backTranslation![key]).join(' — ')}</p>
          )}
          <EditActions ok={fields.every((key) => draft[key].trim() !== '')} busy={busy} saveLabel={`Save ${draft.kind}`}
            onSave={save} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Select label="Workspace" value={filter.workspace} onChange={setFilterField('workspace')} style={{ flex: '1 1 120px' }}
          options={[{ value: '', label: 'all' }, { value: '(board)', label: 'board-wide' }, ...workspaceNames]} />
        <Select label="Kind" value={filter.kind} onChange={setFilterField('kind')} style={{ flex: '1 1 120px' }}
          options={[{ value: '', label: 'all' }, 'knowledge', 'behavior', 'definition']} />
        <Select label="State" value={filter.state} onChange={setFilterField('state')} style={{ flex: '1 1 120px' }}
          options={[{ value: '', label: 'all' }, 'approved', 'candidate', 'invalidated']} />
      </div>
      {entries === null && <p style={muted}>loading…</p>}
      {entries?.length === 0 && <p style={muted}>no entries</p>}
      {entries?.map((entry) => {
        const shown = entry.original ?? translations[entry.id];
        return (
        <div key={entry.id} data-testid={`memory-entry-${entry.id}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--border-default)', paddingTop: 10 }}>
          <p style={{ ...muted, fontFamily: 'var(--font-mono)' }}>
            #{entry.id} · {entry.kind} · {entry.invalidation_reason
              ? `invalidated: ${entry.invalidation_reason}${entry.successor_id ? ` → #${entry.successor_id}` : ''}`
              : entry.state} · {entry.scope ?? 'board-wide'} · {entry.path}{entry.kind === 'behavior' && ` · to ${entry.addressee ?? 'every agent'}`} · {entry.author.activity}{entry.cause && ` · ${entry.cause}`}
          </p>
          {entry.kind !== 'definition' && <strong style={{ fontSize: 'var(--text-sm)' }}>{entry.title}</strong>}
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{entry.text}</p>
          {shown && (
            // a definition's title is its text, so the Set shows it once
            <p style={muted}>{entry.original ? 'original' : 'translation'}: {[...new Set([shown.title, shown.text])].join(' — ')}</p>
          )}
          {!entry.invalidation_reason && invalidating?.id !== entry.id && (
            <div style={{ display: 'flex', gap: 8 }}>
              {entry.kind === 'behavior' && entry.state === 'approved' && (
                <Button variant="ghost" size="sm" onClick={() => edit.open(writeId, () => setDraft({
                  ...blank, kind: 'behavior', workspace: entry.scope ?? '', path: entry.path, title: entry.title, text: entry.text,
                  originalTitle: entry.original?.title ?? '', originalText: entry.original?.text ?? '',
                  addressee: entry.addressee ?? '', supersedes: String(entry.id),
                }))}>Edit</Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setInvalidating({ id: entry.id, reason: 'capability', successor: '' })}>Invalidate</Button>
            </div>
          )}
          {invalidating?.id === entry.id && (
            <React.Fragment>
              <Select label="Reason" value={invalidating!.reason} options={MEMORY_INVALIDATION_REASONS}
                onChange={(e) => setInvalidating({ ...invalidating!, reason: e.target.value })} />
              {needsSuccessor(invalidating!.reason) && (
                <Input label="Successor (entry id)" mono value={invalidating!.successor}
                  onChange={(e) => setInvalidating({ ...invalidating!, successor: e.target.value })} />
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="danger" size="sm" onClick={invalidate}
                  disabled={busy || (needsSuccessor(invalidating!.reason) && !/^[1-9]\d*$/.test(invalidating!.successor))}>
                  Invalidate #{entry.id}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setInvalidating(null)}>Cancel</Button>
              </div>
            </React.Fragment>
          )}
        </div>
        );
      })}
    </Card>
  );
}

// Execution defaults (issue #545 / ADR 0110 決定5) as a record card: Provider
// rank, the default priority and the frontier-advisor flag. Each differing
// value is one POST — the API takes one change per request.
function ExecutionDefaultsCard({ settings, say, onSaved, edit }: {
  settings: SettingsExecution;
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Button, Card, Checkbox, FieldRow, Select } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:execution-defaults';
  const open = edit.isOpen(id);
  const current = { rank: settings.providerRank, priority: settings.priority, advisor: settings.frontierAdvisor, retrospectiveTier: settings.retrospectiveTier };
  const [draft, setDraft] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  const rankChanged = draft.rank.join() !== current.rank.join();
  const dirty = rankChanged || draft.priority !== current.priority || draft.advisor !== current.advisor || draft.retrospectiveTier !== current.retrospectiveTier;
  // the API only takes a permutation of every provider (a missing one would
  // sort first in the selector) — mirror that so Save only enables on a sendable rank
  const ok = new Set(draft.rank).size === settings.providers.length;
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      const changes = [
        rankChanged && { setting: 'provider_rank', value: draft.rank },
        draft.priority !== current.priority && { setting: 'priority', value: draft.priority },
        draft.advisor !== current.advisor && { setting: 'frontier_advisor', value: draft.advisor },
        draft.retrospectiveTier !== current.retrospectiveTier && { setting: 'retrospective_tier', value: draft.retrospectiveTier },
      ].filter(Boolean);
      for (const change of changes) await api('/api/settings/execution', change);
      say('success', 'execution defaults saved', `${changes.length} setting${changes.length === 1 ? '' : 's'} updated`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'execution defaults save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  const demote = async () => {
    setBusy(true);
    try {
      await api('/api/settings/execution', { setting: 'learner_promoted', value: false });
      say('success', 'learner demoted', 'work tasks run on the table again');
      await onSaved();
    } catch (err) {
      say('danger', 'learner demote failed', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <div data-testid="execution-defaults">
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(current))}>
          <span style={settingsCardLabel}>execution defaults</span>
        </RecordCardHead>
        {!open && (
          <React.Fragment>
            <FieldRow label="provider rank" kind="mono" value={settings.providerRank.join(' › ')} />
            <FieldRow label="default priority" kind="mono" value={settings.priority} />
            <FieldRow label="frontier advisor" kind="mono" value={settings.frontierAdvisor ? 'on' : 'off'} />
            <FieldRow label="retrospective tier" kind="mono" value={settings.retrospectiveTier} />
            {/* promotion only comes from approving a routing meta-review's question (ADR 0150 決定4); this card only demotes */}
            <FieldRow label="learner" kind="mono" value={settings.learnerPromoted ? 'promoted — chooses work tasks' : 'shadow — the table chooses'} />
            {settings.learnerPromoted && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={demote}>Demote learner</Button>
            )}
          </React.Fragment>
        )}
        {open && (
          <React.Fragment>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {draft.rank.map((provider, i) => (
                <Select key={i} label={`Rank ${i + 1}`} options={[...settings.providers]} value={provider}
                  onChange={(e) => setDraft({ ...draft, rank: draft.rank.map((p, j) => (j === i ? e.target.value : p)) })} />
              ))}
            </div>
            <Select label="Default priority" options={[...settings.priorities]} value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
            <Checkbox testId="execution-frontier-advisor" checked={draft.advisor}
              label="frontier advisor — an advisor may use the frontier row even when the main model is a lower tier"
              onChange={() => setDraft({ ...draft, advisor: !draft.advisor })} />
            <Select label="Retrospective tier" options={[...settings.tiers]} value={draft.retrospectiveTier}
              onChange={(e) => setDraft({ ...draft, retrospectiveTier: e.target.value })} />
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              rank orders the providers a task may run on (first = preferred; every provider exactly once).
              priority is the default for tasks that request none: quality = rank then price, cost = price then rank.
              retrospective tier is the anthropic row the board's own retrospective Board calls (allocation review, attribution, Behavior candidate drafting) resolve on.
            </p>
            <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save execution defaults"
              onSave={save} onCancel={() => edit.close()} />
          </React.Fragment>
        )}
      </Card>
    </div>
  );
}

// The execution-setting table (issue #545 / ADR 0114 決定2) as a record card:
// model rows keyed by provider + model. Save diffs the draft against the
// current table — rows gone → delete_row, rows new or changed → row upsert.
function ExecutionTableCard({ settings, say, onSaved, edit }: {
  settings: SettingsExecution;
  say: AppSay;
  onSaved: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Button, Card, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const id = 'board:execution-table';
  const open = edit.isOpen(id);
  const rowKey = (row: Pick<SettingsExecutionRow, 'provider' | 'model'>) => `${row.provider}:${row.model}`;
  // 下書きの行は価格を入力欄の文字列で持つ —— サーバの行と下書きの行を toRow で同じ形に揃えて比べる
  type DraftRow = Omit<SettingsExecutionRow, 'price_in' | 'price_out'> & { key: string; price_in: string; price_out: string };
  const asDraft = (table: SettingsExecution['table']): DraftRow[] => table.map((row) => ({ ...row, key: rowKey(row), price_in: String(row.price_in), price_out: String(row.price_out) }));
  const [draft, setDraft] = React.useState(() => asDraft(settings.table));
  const [busy, setBusy] = React.useState(false);
  const current = new Map(settings.table.map((row) => [rowKey(row), row]));
  const toRow = (d: DraftRow): SettingsExecutionRow => ({ provider: d.provider, tier: d.tier, model: d.model.trim(), effort: d.effort.trim(), price_in: Number(d.price_in), price_out: Number(d.price_out) });
  const same = (a: SettingsExecutionRow | undefined, b: SettingsExecutionRow) => a && a.tier === b.tier && a.effort === b.effort && a.price_in === b.price_in && a.price_out === b.price_out;
  const upserts = draft.map(toRow).filter((row) => !same(current.get(rowKey(row)), row));
  const deletes = [...current.values()].filter((row) => !draft.some((d) => rowKey(toRow(d)) === rowKey(row)));
  const dirty = upserts.length > 0 || deletes.length > 0;
  const validPrice = (v: string) => /^\d+(\.\d+)?$/.test(v.trim());
  const ok = draft.every((d) => d.model.trim() && d.effort.trim() && validPrice(d.price_in) && validPrice(d.price_out))
    && new Set(draft.map((d) => rowKey(toRow(d)))).size === draft.length;
  useDirtySignal(edit, open, dirty);

  const save = async () => {
    setBusy(true);
    try {
      for (const row of deletes) await api('/api/settings/execution', { setting: 'delete_row', provider: row.provider, model: row.model });
      for (const row of upserts) await api('/api/settings/execution', { setting: 'row', row });
      say('success', 'execution table saved', `${upserts.length} row${upserts.length === 1 ? '' : 's'} written, ${deletes.length} removed`);
      edit.close();
      await onSaved();
    } catch (err) {
      say('danger', 'execution table save failed', String((err as Error).message || err));
    }
    setBusy(false);
  };
  const update = (i: number, patch: Partial<DraftRow>) => setDraft(draft.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const addRow = () => setDraft([...draft, {
    key: 'new', provider: settings.providers[0]!.value, tier: settings.tiers[0]!, model: '', effort: 'high', price_in: '', price_out: '',
  }]);

  return (
    <div data-testid="execution-table">
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <RecordCardHead editing={open} onEdit={() => edit.open(id, () => setDraft(asDraft(settings.table)))}>
          <span style={settingsCardLabel}>execution table</span>
        </RecordCardHead>
        {!open && settings.table.map((row) => (
          <div key={rowKey(row)} style={{ display: 'flex', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 140 }}>{row.provider} · {row.tier}</span>
            <span>{row.model} · {row.effort} · ${row.price_in} / ${row.price_out}</span>
          </div>
        ))}
        {open && (
          <React.Fragment>
            {draft.map((d, i) => (
              <div key={d.key} data-testid={`execution-row-${d.key}`}
                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, alignItems: 'end', paddingBottom: 8, borderBottom: '1px solid var(--border-default)' }}>
                <Select label="Provider" options={settings.providers.map((p) => p.value)} value={d.provider} onChange={(e) => update(i, { provider: e.target.value })} />
                <Select label="Tier" options={[...settings.tiers]} value={d.tier} onChange={(e) => update(i, { tier: e.target.value })} />
                <Input label="Model" mono value={d.model} onChange={(e) => update(i, { model: e.target.value })} placeholder="alias or model id" />
                <Input label="Effort" mono value={d.effort} onChange={(e) => update(i, { effort: e.target.value })} placeholder="high" />
                <Input label="Price in" mono value={d.price_in} onChange={(e) => update(i, { price_in: e.target.value })} placeholder="USD / MTok" />
                <Input label="Price out" mono value={d.price_out} onChange={(e) => update(i, { price_out: e.target.value })} placeholder="USD / MTok" />
                <Button variant="ghost" size="sm" onClick={() => setDraft(draft.filter((_, j) => j !== i))} aria-label={`remove ${d.provider} ${d.tier} ${d.model}`.trim()}>Remove</Button>
              </div>
            ))}
            {/* ponytail: one unsaved new row at a time (its key is the literal 'new'); key by a counter if adding several per save matters */}
            <Button variant="ghost" size="sm" onClick={addRow} disabled={draft.some((d) => d.key === 'new')}>Add row</Button>
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              a row says "this model meets this tier's quality on this provider" — classify by measured capability, not price.
              prices are USD per MTok. removing every row of a provider × tier just excludes that provider for tasks of that tier.
            </p>
            <EditActions dirty={dirty} ok={ok} busy={busy} saveLabel="Save execution table"
              onSave={save} onCancel={() => edit.close()} />
          </React.Fragment>
        )}
      </Card>
    </div>
  );
}

// The workspace create form (issue #57 phase 3), behind Add on the Workspaces
// screen (#204 決定7) — it takes the same single edit slot a record card does,
// and saves and cancels by the same rules.
function NewWorkspaceForm({ baseDir, say, onCreated, edit }: {
  baseDir: SettingsBaseDir | null;
  say: AppSay;
  onCreated: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, Checkbox, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [mode, setMode] = React.useState('clone');
  const [name, setName] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const [path, setPath] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [prot, setProt] = React.useState(false);
  const ok = registryNameOk(name) && (mode === 'clone' ? !!repo.trim() : mode === 'register' ? !!path.trim() : true);
  const dirty = mode !== 'clone' || !!name.trim() || !!repo.trim() || !!path.trim() || !!notes.trim() || prot;
  useDirtySignal(edit, true, dirty);

  // issue #383: register の門が「人間の生きた dev checkout に見える」と言ったら
  // 409 が返り、ダイアログで受け入れると同じ body が confirm 付きで再送される —
  // 危険な値・削除と同じ二段扉(判定はサーバ単一正本、ADR 0027)
  const { busy, save, dialog } = useDangerousSave(say, async () => { edit.close(); await onCreated(); }, {
    noun: 'workspace',
    confirmKey: 'confirm',
    dialogTitle: 'Register a checkout someone is working in?',
    dialogLead: 'This path looks like a human\'s live development checkout:',
    confirmOf: (err) => {
      const detail = apiErrorDetail(err, 'POST /api/workspaces 409');
      return detail?.confirm_required ? {
        reasons: detail.live_checkout_signals,
        note: detail.clone_landing ? (
          <p style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)' }}>
            The clone entrance would give the board its own checkout at{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{detail.clone_landing}</span> instead —
            one repository, two checkouts.
          </p>
        ) : null,
      } : null;
    },
    confirmLabel: 'Register anyway',
    labels: LIVE_CHECKOUT_SIGNAL_LABEL,
    // creation is idempotent server-side — a failed attempt leaves only
    // orphans the registry never saw, so "just press it again" is honest
    failDetail: 'safe to retry as-is',
  });
  const submit = () =>
    save(async (confirm) => {
      await api('/api/workspaces', {
        mode, name: name.trim(),
        ...(mode === 'clone' ? { repo: repo.trim() } : {}),
        ...(mode === 'register' ? { path: path.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(prot ? { protected: true } : {}),
        ...confirm,
      });
    }, 'added', name.trim());
  const modeOptions = [
    { value: 'clone', label: 'clone a repository' },
    { value: 'create', label: 'create a new local checkout' },
    { value: 'register', label: 'register an existing path' },
  ];
  const modeHint = {
    clone: 'clones into the workspaces directory — the entry stays host-independent',
    create: 'creates a fresh, purely-local git checkout — nothing touches GitHub',
    register: 'points at a checkout already on this host — the one mode that records a path',
  }[mode];

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>add a workspace</span>
      <Select label="Mode" options={modeOptions} value={mode} onChange={(e) => setMode(e.target.value)} />
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{modeHint}</p>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — safe as a directory and a repo name" />
      {/* ADR 0082 決定1: 規約導出の2モードは着地先を人間に一度も見せずに決めていた。
          基点は一覧が返し、名前は区切り文字を含まない検証を既に通っているので、
          結合はここで済む(解決の複製ではなく表示) */}
      {mode !== 'register' && registryNameOk(name) && baseDir && (
        <p data-testid="workspace-landing-preview" style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {mode === 'clone' ? 'will clone to' : 'will create at'} {landingPath(baseDir, name)}
          </span>
          {baseDir.source === 'default' && ' — default; TIDEPOOL_WORKSPACES_DIR is not set on this host'}
        </p>
      )}
      {mode === 'clone' && (
        <Input label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)}
          placeholder="anything git clone accepts — recorded on the entry" />
      )}
      {mode === 'register' && (
        <Input label="Path" value={path} onChange={(e) => setPath(e.target.value)}
          placeholder="an existing checkout on this host" />
      )}
      <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="setup hints for humans — optional" />
      <Checkbox label="protected — changes here always need human approval" checked={prot} onChange={() => setProt(!prot)} />
      <EditActions ok={ok} busy={busy} saveLabel="Add workspace — commits to the registry"
        onSave={submit} onCancel={() => edit.close()} />
      {dialog}
    </Card>
  );
}

// The agent create form (issue #72), NewWorkspaceForm's twin. `name` is its own
// field — it becomes agents/<name>.md and is never editable afterwards; the
// rest is the same draft the record card edits.
function NewAgentForm({ authorityProfiles, providerOptions, hostSkills, hostSkillsDegraded, say, onCreated, edit }: {
  authorityProfiles: string[];
  providerOptions: SettingsOption[];
  hostSkills: string[];
  hostSkillsDegraded: boolean;
  say: AppSay;
  onCreated: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState('');
  const [draft, setDraft] = React.useState(() => ({ ...NEW_AGENT_DRAFT }));
  const set = (key: keyof AgentDraft, value: AgentDraftValue) => setDraft((d) => ({ ...d, [key]: value }) as AgentDraft);
  const [busy, setBusy] = React.useState(false);
  const ok = registryNameOk(name) && !!draft.description.trim() && !!draft.authority && !!draft.provider;
  const dirty = !!name.trim() || agentDraftDirty(draft, NEW_AGENT_DRAFT);
  useDirtySignal(edit, true, dirty);
  // creation offers the empty placeholder the edit form doesn't: a new agent
  // starts without an authority, an existing one always has one
  const authorityCreateOptions = [
    { value: '', label: 'select authority…' },
    ...authorityProfiles.map((n) => ({ value: n, label: n })),
  ];

  const submit = async () => {
    setBusy(true);
    try {
      const created = await api('POST /api/agents', { body: { name: name.trim(), ...agentBody(draft) } });
      // 静かな shadow は作らない(ADR 0117 決定2): 告げるのは応答で、判定ではない
      say('success', 'agent added — committed to the registry',
        created.shadows_built_in
          ? `${name.trim()} — shadows the board's built-in agent of the same name`
          : name.trim());
      edit.close();
      await onCreated();
    } catch (err) {
      // creation is idempotent server-side, same posture as workspace creation
      say('danger', 'agent creation failed — safe to retry as-is', String((err as Error).message || err));
    }
    setBusy(false);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>add an agent</span>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — becomes agents/<name>.md, not renameable later" />
      <AgentFields draft={draft} set={set} authorityOptions={authorityCreateOptions}
        providerOptions={providerOptions}
        hostSkills={hostSkills} hostSkillsDegraded={hostSkillsDegraded} />
      <EditActions ok={ok} busy={busy} saveLabel="Add agent — commits to the registry"
        onSave={submit} onCancel={() => edit.close()} />
    </Card>
  );
}

// The authority profile create form (issue #55 phase 3) — the 409
// confirm_required round trip rides on useProfileSave, same as the edit card.
function NewProfileForm({ agentNames, workspaceNames, say, onCreated, edit }: {
  agentNames: string[];
  workspaceNames: string[];
  say: AppSay;
  onCreated: () => Promise<void> | void;
  edit: SettingsEditSlot;
}) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState('');
  const [guidance, setGuidance] = React.useState('');
  const [assignableTo, setAssignableTo] = React.useState<string[]>([]);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState<string[]>([]);
  const [merge, setMerge] = React.useState('');
  const { busy, save, dialog } = useProfileSave(say, async () => { edit.close(); await onCreated(); }, 'POST /api/profiles 409');
  const dirty = !!name.trim() || !!guidance.trim() || assignableTo.length > 0
    || allowedWorkspaces.length > 0 || !!merge;
  useDirtySignal(edit, true, dirty);

  // 作成扉は4フィールドすべてを常に載せる(ADR 0079 決定1 / ADR 0086 決定3)
  const submit = () => save(
    async (confirm) => {
      await api('/api/profiles', { name: name.trim(), guidance, assignable_to: assignableTo, allowed_workspaces: allowedWorkspaces, merge, ...confirm });
    },
    'created', name.trim(),
  );

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={settingsCardLabel}>add an authority profile</span>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — becomes authority/<name>.yaml, not renameable later" />
      <ProfileFields
        agentNames={agentNames} workspaceNames={workspaceNames}
        guidance={guidance} setGuidance={setGuidance}
        assignableTo={assignableTo} setAssignableTo={setAssignableTo}
        allowedWorkspaces={allowedWorkspaces} setAllowedWorkspaces={setAllowedWorkspaces}
        merge={merge} setMerge={setMerge} />
      <EditActions ok={registryNameOk(name) && !!merge} busy={busy} saveLabel="Add authority profile — commits to the registry"
        onSave={submit} onCancel={() => edit.close()} />
      {dialog}
    </Card>
  );
}

// Settings — the board's admin surface (issue #57 phase 3), restructured by
// #204 into a drilldown: an index of four sections, then a section, then one
// record that opens read-only. Board (display language #46, quiet hours #64,
// pace offsets #126) is the SQLite-backed half; workspaces, agents (#72) and
// authority profiles (#55) are the registry-backed half.
// biome-ignore lint/correctness/noUnusedVariables: rendered by webui/app.tsx — one concatenated bundle
function SettingsScreen({ say, registerLeaveGuard }: {
  say: AppSay;
  registerLeaveGuard: (guard: ((move: () => void) => boolean) | null) => void;
}) {
  const { Button, Card, NavRow, ScreenHeader } = window.TidepoolDesignSystem_8a0ead;

  // The three board-wide preferences (display language #46, quiet hours #64,
  // pace offsets #126 / ADR 0030) are loaded here and saved by their own cards
  // on the Board screen — this level only holds the values the index summarises.
  const [displayLanguage, setDisplayLanguage] = React.useState('');
  // options come straight from GET (display-language.ts's canonical list) —
  // the UI never hardcodes the language list, so a board that adds a language
  // needs no WebUI change (issue #115).
  const [displayLanguageOptions, setDisplayLanguageOptions] = React.useState<string[]>([]);
  const [displayLanguageLoaded, setDisplayLanguageLoaded] = React.useState(false);
  const loadDisplayLanguage = async () => {
    const { language, options } = await api('GET /api/settings/display-language');
    setDisplayLanguage(language);
    setDisplayLanguageOptions([...options]);
    setDisplayLanguageLoaded(true);
  };
  React.useEffect(() => { loadDisplayLanguage(); }, []);

  // quiet hours: start/end are editable; tz is shown but only ever changed via
  // POST /api/settings/timezone (ADR 0022), which this screen never calls.
  const [quietHoursStart, setQuietHoursStart] = React.useState('');
  const [quietHoursEnd, setQuietHoursEnd] = React.useState('');
  const [quietHoursTz, setQuietHoursTz] = React.useState('');
  const [quietHoursLoaded, setQuietHoursLoaded] = React.useState(false);
  const loadQuietHours = async () => {
    const { start, end, tz } = await api('GET /api/settings/quiet-hours');
    setQuietHoursStart(start);
    setQuietHoursEnd(end);
    setQuietHoursTz(tz);
    setQuietHoursLoaded(true);
  };
  React.useEffect(() => { loadQuietHours(); }, []);

  const [providerPaceOffsets, setProviderPaceOffsets] = React.useState<WireContract['GET /api/settings/provider-pace-offsets']['offsets'] | null>(null); // null → still loading
  const loadPaceOffsets = async () => {
    const result = await api('GET /api/settings/provider-pace-offsets');
    setProviderPaceOffsets(result.offsets);
  };
  React.useEffect(() => { loadPaceOffsets(); }, []);

  // execution settings (issue #545): table + defaults + the option lists, one GET
  const [executionSettings, setExecutionSettings] = React.useState<SettingsExecution | null>(null); // null → still loading
  const loadExecutionSettings = async () => {
    setExecutionSettings(await api('GET /api/settings/execution'));
  };
  React.useEffect(() => { loadExecutionSettings(); }, []);

  const [memorySettings, setMemorySettings] = React.useState<WireContract['GET /api/settings/memory'] | null>(null); // null → still loading
  const loadMemorySettings = async () => {
    setMemorySettings(await api('GET /api/settings/memory'));
  };
  React.useEffect(() => { loadMemorySettings(); }, []);

  const [metaReviewSettings, setMetaReviewSettings] = React.useState<WireContract['GET /api/settings/meta-review'] | null>(null); // null → still loading
  const loadMetaReviewSettings = async () => {
    setMetaReviewSettings(await api('GET /api/settings/meta-review'));
  };
  React.useEffect(() => { loadMetaReviewSettings(); }, []);

  // ADR 0093 決定5: read-only. null → still loading; the card only appears once
  // the board has answered, so "not logged in" is never shown speculatively.
  const [githubLoggedIn, setGithubLoggedIn] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    api('GET /api/settings/github')
      .then(({ loggedIn }) => setGithubLoggedIn(loggedIn))
      .catch(() => setGithubLoggedIn(null));
  }, []);

  // issue #273: 末尾の loading… カスケードには足さない —— これが読めなくても残りの
  // 設定は読めるので、board 全体を loading… に張り付かせない([] は「生成ゼロ」)
  const [translateUsage, setTranslateUsage] = React.useState<WireContract['GET /api/translate/usage']['records'] | null>(null); // null → still loading
  // 失敗はカードを消さずに面へ出す —— 読めなかったことが見えないと、この顔を
  // 足した理由(記録があることと検知されることは別)がそのまま欠ける
  const [translateUsageFailed, setTranslateUsageFailed] = React.useState(false);
  React.useEffect(() => {
    api('GET /api/translate/usage')
      .then(({ records }) => setTranslateUsage(records))
      .catch(() => setTranslateUsageFailed(true));
  }, []);


  const [workspaces, setWorkspaces] = React.useState<SettingsWorkspace[] | null>(null); // null → still loading
  // ADR 0082 決定1: 規約導出の着地先を合成するための基点 — { path, source }。
  // 読めていないうち(ロード中・503)は null で、着地先は一切見せない
  const [baseDir, setBaseDir] = React.useState<SettingsBaseDir | null>(null);
  const [unavailable, setUnavailable] = React.useState(false); // 503 — no registry configured
  const load = async () => {
    try {
      const res = await api('GET /api/workspaces');
      setWorkspaces(res.workspaces);
      setBaseDir(res.workspacesBaseDir);
    } catch {
      // 503 (no registry configured) and transport failures read the same:
      // there is nothing to administer from here
      setUnavailable(true);
      setWorkspaces([]);
    }
  };
  React.useEffect(() => { load(); }, []);

  const [agents, setAgents] = React.useState<SettingsAgent[] | null>(null); // null → still loading
  const [authorityProfiles, setAuthorityProfiles] = React.useState<string[]>([]);
  // the provider select's value+label options, server-supplied on the same GET
  // (registry.ts's PROVIDER_OPTIONS) so the client never hard-codes the enum
  const [providerOptions, setProviderOptions] = React.useState<SettingsOption[]>([]);
  const [agentsUnavailable, setAgentsUnavailable] = React.useState(false);
  const loadAgents = async () => {
    try {
      const res = await api('GET /api/agents');
      setAgents(res.agents);
      setAuthorityProfiles(res.authorityProfiles);
      setProviderOptions([...res.providers]);
    } catch {
      setAgentsUnavailable(true);
      setAgents([]);
    }
  };
  React.useEffect(() => { loadAgents(); }, []);

  const [profiles, setProfiles] = React.useState<SettingsProfile[] | null>(null); // null → still loading
  const [profilesUnavailable, setProfilesUnavailable] = React.useState(false);
  const loadProfiles = async () => {
    try {
      const res = await api('GET /api/profiles');
      setProfiles(res.profiles);
    } catch {
      setProfilesUnavailable(true);
      setProfiles([]);
    }
  };
  React.useEffect(() => { loadProfiles(); }, []);

  // the skills picker's candidate source (issue #106): the host's enumerated
  // @host skills, loaded once for both the create form and every AgentCard.
  // Degrades to an empty list — the picker still works on scope words + free
  // entry, so a failed enumeration never blocks editing an agent's skills.
  const [hostSkills, setHostSkills] = React.useState<string[]>([]);
  const [hostSkillsDegraded, setHostSkillsDegraded] = React.useState(false);
  const loadSkills = async () => {
    try {
      const res = await api('GET /api/skills');
      setHostSkills(res.skills);
      setHostSkillsDegraded(res.degraded);
    } catch {
      setHostSkills([]);
      setHostSkillsDegraded(true);
    }
  };
  React.useEffect(() => { loadSkills(); }, []);
  // a created or edited profile must reach the agent Authority dropdown too —
  // that list rides on GET /api/agents (a separate load), so a profile change
  // refreshes both, else the #55 completion path (create profile → referencing
  // agent can spawn) needs a manual page reload
  const refreshAfterProfile = async () => { await loadProfiles(); await loadAgents(); };
  // the profile pickers offer the registry's current agents / workspaces so an
  // assignable_to / allowed_workspaces entry can't name something that doesn't
  // exist — the same lists the cards above already render, reused here
  const agentNames = (agents ?? []).map((a) => a.name);
  const workspaceNames = (workspaces ?? []).map((w) => w.name);

  // name → icon, for rendering an assignable_to entry as the agent's own chip
  const agentIcons: Record<string, string> = {};
  (agents ?? []).forEach((a) => { if (a.icon) agentIcons[a.name] = a.icon; });

  // --- drilldown navigation (issue #204) ----------------------------------
  // stack: [] the index · ['board'] · ['<section>'] · ['<section>', '<name>'].
  // A record is addressed by name, not by list position: the lists reload on
  // every commit, and an index would silently re-point at a different entry.
  const [stack, setStack] = React.useState<string[]>([]);
  // at most one card — record or create form — is in edit mode across the whole
  // surface (決定4): `editing` holds its id, `dirty` whether it has unsaved work
  const [editing, setEditing] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [pending, setPending] = React.useState<{ move: () => void } | null>(null); // a move parked behind the discard dialog
  // read inside `guard`, which the tab guard below keeps across renders
  const unsaved = React.useRef(false);
  unsaved.current = editing !== null && dirty;

  // Runs `move` now, or parks it behind the discard dialog when the open card
  // has unsaved changes. Returns true when it parked it — the tab guard reads
  // that to hold the tab switch until the human answers.
  const guard = (move: () => void) => {
    if (unsaved.current) { setPending({ move }); return true; }
    move();
    return false;
  };
  const closeEdit = () => { setEditing(null); setDirty(false); };
  // the one edit slot, handed to every card that can enter edit mode
  const edit = {
    isOpen: (id: string) => editing === id,
    // `prime` fills the card's draft from the record. It runs with the open,
    // not before it, so a parked open (another card holds unsaved work) primes
    // only once the human has answered the discard dialog.
    open: (id: string, prime?: () => void) => guard(() => { if (prime) prime(); setEditing(id); setDirty(false); }),
    // `close` is the deliberate discard behind Cancel and the exit after a
    // successful save; `requestClose` is for a control that merely folds the
    // card away (the Add toggle), which must not drop a draft silently
    close: closeEdit,
    requestClose: () => guard(closeEdit),
    setDirty,
  };
  const go = (next: string[]) => guard(() => { setStack(next); closeEdit(); });

  // a tab switch unmounts this screen, so it has to ask too (決定4)
  React.useEffect(() => {
    registerLeaveGuard((move) => guard(move));
    return () => registerLeaveGuard(null);
  }, []);

  // The three registry-backed sections, in one shape so the index, the list
  // level and the record level all read a section the same way — including
  // which card it renders, so no level re-tests which section it is in.
  const SECTIONS: {
    workspaces: SettingsSection<SettingsWorkspace>;
    agents: SettingsSection<SettingsAgent>;
    profiles: SettingsSection<SettingsProfile>;
  } = {
    workspaces: {
      title: 'Workspaces', singular: 'workspace', note: 'where tasks run',
      items: workspaces, unavailable,
      footnote: 'edits commit to the registry',
      indexSummary: (items) => `${items.length} · ${items.filter((w) => w.protected).length} protected`,
      rowIdentity: (w) => ({ label: w.name }),
      rowSummary: (w) => w.repo || w.path || '—',
      record: (rec) => <WorkspaceRecord ws={rec} baseDir={baseDir} say={say} onChanged={load} edit={edit} />,
      createForm: () => <NewWorkspaceForm baseDir={baseDir} say={say} onCreated={load} edit={edit} />,
      reload: load,
      deleteNote: 'removes the registry entry only — the checkout on this host is left where it is',
      deleteLead:
        'This workspace is being removed from the registry. The checkout on the host is left untouched — the board just stops knowing about it.',
      // ADR 0087 決定4: 残る checkout の場所は応答が運ぶ(WebUI が組み立てない)
      remove: async (confirm, name) => {
        const { checkout } = await api('DELETE /api/workspaces/:name', { params: { name }, body: confirm });
        return `checkout remains at ${checkout}`;
      },
    },
    agents: {
      title: 'Agents', singular: 'agent', note: 'who does the work',
      items: agents, unavailable: agentsUnavailable,
      footnote: 'edits commit to agents/<name>.md in the registry',
      indexSummary: (items) => `${items.length} agents`,
      rowIdentity: (a) => ({ agentName: a.name, agentIcon: a.icon ?? '' }),
      // the built-in / shadows built-in mark (ADR 0117 決定2) — server-derived
      // (GET /api/agents), never decided here: the display only mirrors which
      // fugu the machine resolves. A built-in has no registry profile to show.
      rowSummary: (a) =>
        a.builtin ? 'built-in' : a.shadowsBuiltIn ? `${a.authority} · shadows built-in` : a.authority,
      record: (rec) => (
        <AgentRecord agent={rec} authorityProfiles={authorityProfiles} providerOptions={providerOptions}
          hostSkills={hostSkills}
          hostSkillsDegraded={hostSkillsDegraded} say={say} onChanged={loadAgents} edit={edit} />
      ),
      createForm: () => (
        <NewAgentForm authorityProfiles={authorityProfiles} providerOptions={providerOptions}
          hostSkills={hostSkills}
          hostSkillsDegraded={hostSkillsDegraded} say={say} onCreated={loadAgents} edit={edit} />
      ),
      reload: loadAgents,
      deleteNote: 'removes agents/<name>.md from the registry — past tasks still read the body at their own commit',
      deleteLead:
        'This agent is being removed from the registry. Its definition stays in git history, but the board stops offering it.',
    },
    profiles: {
      title: 'Authority Profiles', singular: 'authority profile',
      note: 'what the work is allowed to do',
      items: profiles, unavailable: profilesUnavailable,
      footnote: 'edits commit to authority/<name>.yaml in the registry',
      indexSummary: (items) => `${items.length} profiles`,
      rowIdentity: (p) => ({ label: p.name }),
      rowSummary: (p) => (p.assignable_to ?? []).join(', ') || '—',
      record: (rec) => (
        <ProfileRecord profile={rec} agentNames={agentNames} agentIcons={agentIcons}
          workspaceNames={workspaceNames} say={say} onChanged={refreshAfterProfile} edit={edit} />
      ),
      createForm: () => (
        <NewProfileForm agentNames={agentNames} workspaceNames={workspaceNames}
          say={say} onCreated={refreshAfterProfile} edit={edit} />
      ),
      reload: refreshAfterProfile,
      deleteNote: 'removes authority/<name>.yaml from the registry — an agent still pointing at it blocks the delete',
      deleteLead:
        'This authority profile is being removed from the registry. Its file stays in git history, but no agent can be pointed at it again.',
    },
  };
  // one cascade for "unreachable / still loading / here is the count", read by
  // the index (which counts its own way per section) and by each section header
  const sectionSummary = (s: SettingsSection<SettingsRecord>, count: (items: SettingsRecord[]) => string = (items) => `${items.length} registered`) =>
    s.unavailable ? 'no registry configured'
      : s.items === null ? 'loading…'
        : count(s.items);

  const sectionKey = stack[0]!;
  const recordName = stack[1]!;
  const sec: SettingsSection<SettingsRecord> | undefined = SECTIONS[sectionKey as SettingsSectionKey];
  const addId = `new:${sectionKey}`;
  const adding = editing === addId;

  let body;

  if (stack.length === 0) {
    // --- level 1: the index. Each row states its section's current state, so
    // the whole surface reads without opening anything.
    const rows: { key: string; label: string; summary: string; alert?: boolean }[] = [
      {
        key: 'board', label: 'Board',
        summary: displayLanguageLoaded && quietHoursLoaded
          ? `${displayLanguage} · ${quietHoursStart}–${quietHoursEnd}`
          : 'loading…',
      },
      ...(Object.keys(SECTIONS) as SettingsSectionKey[]).map((key) => {
        const s: SettingsSection<SettingsRecord> = SECTIONS[key];
        return { key, label: s.title, summary: sectionSummary(s, s.indexSummary), alert: s.unavailable };
      }),
    ];
    body = (
      <React.Fragment>
        {/* the top of the stack keeps the screen-title shape every other tab
            uses; the levels below it wear ScreenHeader, whose h1 is the same
            size and inherits the same base.css heading treatment */}
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Settings</h1>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            the board's preferences, and the registry it works from
          </p>
        </div>
        <Card padding="0" style={{ overflow: 'hidden' }}>
          {rows.map((r, i) => (
            <NavRow key={r.key} label={r.label} summary={r.summary}
              testId={`settings-section-${r.key}`}
              summaryTone={r.alert ? 'alert' : 'muted'}
              divider={i > 0} first={i === 0} last={i === rows.length - 1}
              onClick={() => go([r.key])} />
          ))}
        </Card>
      </React.Fragment>
    );
  } else if (sectionKey === 'board') {
    // --- level 2 (board): the SQLite-backed preferences, one card each, then
    // the read-only board-state cards under their own subheading (#691)
    body = (
      <React.Fragment>
        <ScreenHeader title="Board" backLabel="Settings" meta="board-wide preferences" onBack={() => go([])} />
        {displayLanguageLoaded && (
          <DisplayLanguageCard language={displayLanguage} options={displayLanguageOptions}
            say={say} onSaved={loadDisplayLanguage} edit={edit} />
        )}
        {quietHoursLoaded && (
          <QuietHoursCard start={quietHoursStart} end={quietHoursEnd} tz={quietHoursTz}
            say={say} onSaved={loadQuietHours} edit={edit} />
        )}
        {providerPaceOffsets && (
          <PaceOffsetsCard offsets={providerPaceOffsets} say={say} onSaved={loadPaceOffsets} edit={edit} />
        )}
        {executionSettings && (
          <React.Fragment>
            <ExecutionDefaultsCard settings={executionSettings} say={say} onSaved={loadExecutionSettings} edit={edit} />
            <ExecutionTableCard settings={executionSettings} say={say} onSaved={loadExecutionSettings} edit={edit} />
          </React.Fragment>
        )}
        {memorySettings && (
          <MemorySettingsCard settings={memorySettings} say={say} onSaved={loadMemorySettings} edit={edit} />
        )}
        {displayLanguageLoaded && (
          <MemoryEntriesCard workspaceNames={workspaceNames} agentNames={agentNames} language={displayLanguage} say={say} edit={edit} />
        )}
        {metaReviewSettings && (
          <MetaReviewSettingsCard settings={metaReviewSettings} say={say} onSaved={loadMetaReviewSettings} edit={edit} />
        )}
        {(!displayLanguageLoaded || !quietHoursLoaded || !providerPaceOffsets || !executionSettings || !memorySettings || !metaReviewSettings) && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>loading…</Card>
        )}
        <p style={settingsFootnote}>applies to every task the board picks up</p>
        {/* read-only state the board holds — not a preference, so outside the footer's claim (#691) */}
        {(githubLoggedIn !== null || translateUsage !== null || translateUsageFailed) && (
          <p style={settingsCardLabel}>board state</p>
        )}
        {githubLoggedIn !== null && <GitHubLoginCard loggedIn={githubLoggedIn} />}
        {(translateUsage !== null || translateUsageFailed) && <TranslateUsageCard records={translateUsage} />}
      </React.Fragment>
    );
  } else if (!sec) {
    body = <ScreenHeader title="Settings" backLabel="Settings" onBack={() => go([])} />;
  } else if (recordName === undefined) {
    // --- level 2 (a registry section): the names, with the create form behind Add
    body = (
      <React.Fragment>
        <ScreenHeader title={sec.title} backLabel="Settings" meta={sectionSummary(sec)} onBack={() => go([])}>
          {!sec.unavailable && sec.items && (
            <Button variant="ghost" size="sm" onClick={() => (adding ? edit.requestClose() : edit.open(addId))}>
              {adding ? 'Close' : 'Add'}
            </Button>
          )}
        </ScreenHeader>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>{sec.note}</p>
        {sec.unavailable && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            no registry configured on this board — {sec.title.toLowerCase()} need one
          </Card>
        )}
        {adding && sec.createForm()}
        {!sec.unavailable && sec.items === null && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>loading…</Card>
        )}
        {!sec.unavailable && sec.items && sec.items.length === 0 && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            none registered yet — Add is above
          </Card>
        )}
        {!sec.unavailable && sec.items && sec.items.length > 0 && (
          <Card padding="0" style={{ overflow: 'hidden' }}>
            {sec.items.map((it, i) => (
              <NavRow key={it.name} {...sec.rowIdentity(it)} summary={sec.rowSummary(it)}
                testId={`settings-record-${sectionKey}-${it.name}`}
                divider={i > 0} first={i === 0} last={i === sec.items!.length - 1}
                onClick={() => go([sectionKey, it.name])} />
            ))}
          </Card>
        )}
        <p style={settingsFootnote}>{sec.footnote}</p>
      </React.Fragment>
    );
  } else {
    // --- level 3: one record, read-only until Edit
    const items = sec.items ?? [];
    const idx = items.findIndex((x) => x.name === recordName);
    const rec = idx === -1 ? null : items[idx];
    body = (
      <React.Fragment>
        <ScreenHeader title={recordName} backLabel={sec.title}
          meta={rec ? `${sec.singular} · ${idx + 1} of ${items.length}` : sec.singular}
          onBack={() => go([sectionKey])} />
        {!rec && sec.items === null && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>loading…</Card>
        )}
        {!rec && sec.items !== null && (
          <Card style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            no longer in the registry — it may have been removed outside the board
          </Card>
        )}
        {rec && sec.record(rec)}
        {/* 編集中は出さない: 未保存のカードを開いたまま消せると、破棄の問い
            (決定4)を素通りする */}
        {/* 組み込みは registry のエントリではないので削除の扉も出さない
            (ADR 0117 決定2)— サーバ側の門は残るが、通らない扉は見せない */}
        {rec && editing === null && !rec.builtin && (
          <DeleteRecord section={sec} sectionKey={sectionKey as SettingsSectionKey} name={recordName} say={say}
            onDeleted={async () => { await sec.reload(); go([sectionKey]); }} />
        )}
        <p style={settingsFootnote}>{sec.footnote}</p>
      </React.Fragment>
    );
  }

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {body}
      <PortalDialog open={!!pending} title="Discard unsaved changes?" onClose={() => setPending(null)}
        footer={
          <React.Fragment>
            <Button variant="secondary" onClick={() => setPending(null)}>Keep editing</Button>
            <Button variant="danger" onClick={() => { const p = pending; setPending(null); closeEdit(); p!.move(); }}>
              Discard
            </Button>
          </React.Fragment>
        }>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          The card you're editing has changes that were never saved. Leaving now drops them.
        </p>
      </PortalDialog>
    </div>
  );
}
