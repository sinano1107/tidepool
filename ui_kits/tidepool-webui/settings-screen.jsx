// Settings — the board's admin surface: board-wide preferences (display
// language, quiet hours, pace offsets) plus the three registry surfaces
// (workspaces / agents / authority profiles). Structural recreation of
// public/index.html's SettingsScreen for design review — runs on mock data,
// no API calls; add-forms reset after submit and report through `onAction`
// instead of actually growing the lists (this kit doesn't own a registry).
const SETTINGS_MERGE_OPTIONS = [
  { value: '', label: 'no automatic merge decision (default)' },
  { value: 'escalate', label: 'escalate — always ask a human before merging' },
  { value: 'auto_if_ci_green', label: 'auto_if_ci_green — merge unattended once CI is green' },
];

const SETTINGS_ICON_SEA = ['🐙', '🦀', '🦐', '🦞', '🦑', '🦪', '🐚', '🐡', '🐠', '🐟', '🐬', '🐳', '🦈', '🦭', '🐢', '🪼', '🪸'];
const SETTINGS_ICON_LAND = ['🦦', '🐕', '🐈', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦅', '🐴', '🦋', '🐝'];

function SectionLabel({ children }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </span>
  );
}

function SettingsIconPicker({ value, onChange }) {
  const { Input } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>Icon</SectionLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {[...SETTINGS_ICON_SEA, ...SETTINGS_ICON_LAND].map((emoji) => (
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

// Shared chip-list shape for "assignable to" / "allowed workspaces" — pick
// from candidates or "*" (wildcard), free entry for anything not listed.
function SettingsChipListInput({ label, hint, candidates, wildcardHint, values, onChange }) {
  const { Input, Button, Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState('');
  const offerable = [...candidates, '*'].filter((c) => !values.includes(c));
  const options = [
    { value: '', label: offerable.length ? 'add…' : 'no more to add' },
    ...offerable.map((c) => ({ value: c, label: c === '*' ? `* — ${wildcardHint}` : c })),
  ];
  const pick = (e) => { if (e.target.value) onChange([...values, e.target.value]); };
  const addFree = () => {
    if (!free.trim() || values.includes(free.trim())) return;
    onChange([...values, free.trim()]);
    setFree('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>{label}</SectionLabel>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</p>
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
      <Select value="" options={options} onChange={pick} />
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}><Input value={free} mono onChange={(e) => setFree(e.target.value)} placeholder="free entry" /></div>
        <Button variant="secondary" disabled={!free.trim()} onClick={addFree}>Add</Button>
      </div>
    </div>
  );
}

function SettingsWorkspaceRow({ ws }) {
  const { Card, Tag } = window.TidepoolDesignSystem_8a0ead;
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{ws.name}</span>
        {ws.registrySelf && <Tag color="tide" mono>registry</Tag>}
        {ws.protected && <Tag color="sun">protected</Tag>}
      </div>
      {(ws.repo || ws.path) && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {ws.repo ?? ws.path}
        </div>
      )}
      {ws.notes && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{ws.notes}</div>}
    </Card>
  );
}

function SettingsAgentRow({ agent }) {
  const { Card, AgentChip, Tag } = window.TidepoolDesignSystem_8a0ead;
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AgentChip name={agent.name} icon={agent.icon} size="md" />
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{agent.desc}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {agent.authority && <Tag color="tide" mono>{agent.authority}</Tag>}
        {agent.model && <Tag mono>{agent.model}</Tag>}
      </div>
    </Card>
  );
}

function SettingsProfileRow({ profile }) {
  const { Card, Tag } = window.TidepoolDesignSystem_8a0ead;
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{profile.name}</span>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{profile.guidance}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>assignable to</span>
        {profile.assignable_to.map((v) => <Tag key={v} color={v === '*' ? 'sun' : 'tide'} mono>{v}</Tag>)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>workspaces</span>
        {profile.allowed_workspaces.map((v) => <Tag key={v} color={v === '*' ? 'sun' : 'tide'} mono>{v}</Tag>)}
      </div>
    </Card>
  );
}

function SettingsScreen({ data, onAction }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const s = data.settings;

  const [lang, setLang] = React.useState(s.displayLanguage);
  const [qStart, setQStart] = React.useState(s.quietHours.start);
  const [qEnd, setQEnd] = React.useState(s.quietHours.end);
  const [pace, setPace] = React.useState(s.paceOffsets);

  const [wsMode, setWsMode] = React.useState('clone');
  const [wsName, setWsName] = React.useState('');
  const [wsRepo, setWsRepo] = React.useState('');
  const [wsPath, setWsPath] = React.useState('');
  const [wsNotes, setWsNotes] = React.useState('');
  const [wsProtected, setWsProtected] = React.useState(false);
  const wsModeOptions = [
    { value: 'clone', label: 'clone a repository' },
    { value: 'create', label: 'create a new private repository' },
    { value: 'register', label: 'register an existing path' },
  ];
  const wsModeHint = {
    clone: 'clones into the workspaces directory — the entry stays host-independent',
    create: 'creates a private GitHub repo named after the workspace, then clones it',
    register: 'points at a checkout already on this host — the one mode that records a path',
  }[wsMode];
  const addWorkspace = () => {
    onAction('workspace added — committed to the registry', wsName.trim());
    setWsMode('clone'); setWsName(''); setWsRepo(''); setWsPath(''); setWsNotes(''); setWsProtected(false);
  };

  const [agentName, setAgentName] = React.useState('');
  const [agentIcon, setAgentIcon] = React.useState('');
  const [agentDesc, setAgentDesc] = React.useState('');
  const [agentAuthority, setAgentAuthority] = React.useState('');
  const [agentModel, setAgentModel] = React.useState('');
  const authorityCreateOptions = [
    { value: '', label: 'select authority…' },
    ...data.authorityProfiles.map((p) => ({ value: p.name, label: p.name })),
  ];
  const addAgent = () => {
    onAction('agent added — committed to the registry', agentName.trim());
    setAgentName(''); setAgentIcon(''); setAgentDesc(''); setAgentAuthority(''); setAgentModel('');
  };

  const [profileName, setProfileName] = React.useState('');
  const [guidance, setGuidance] = React.useState('');
  const [assignableTo, setAssignableTo] = React.useState([]);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState([]);
  const [merge, setMerge] = React.useState('');
  const addProfile = () => {
    onAction('authority profile added — committed to the registry', profileName.trim());
    setProfileName(''); setGuidance(''); setAssignableTo([]); setAllowedWorkspaces([]); setMerge('');
  };

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Settings</h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
          workspaces — where tasks run
        </p>
      </div>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>display language</SectionLabel>
        <Select label="Language" options={s.displayLanguageOptions} value={lang} onChange={(e) => setLang(e.target.value)} />
        <Button variant="primary" size="lg" full onClick={() => onAction('display language saved', lang)}>Save display language</Button>
      </Card>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>quiet hours</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="Start" mono value={qStart} onChange={(e) => setQStart(e.target.value)} placeholder="HH:MM" />
          <Input label="End" mono value={qEnd} onChange={(e) => setQEnd(e.target.value)} placeholder="HH:MM" />
        </div>
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          start after end wraps past midnight (e.g. 23:00–07:00) — that's valid, not an error.
          timezone: {s.quietHours.tz} — change it from the timezone setting, not here.
        </p>
        <Button variant="primary" size="lg" full onClick={() => onAction('quiet hours saved', `${qStart}–${qEnd}`)}>Save quiet hours</Button>
      </Card>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>pace offsets</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Input label="Session" mono value={String(pace.session)} onChange={(e) => setPace({ ...pace, session: e.target.value })} placeholder="20" />
          <Input label="Week" mono value={String(pace.week)} onChange={(e) => setPace({ ...pace, week: e.target.value })} placeholder="10" />
          <Input label="Fable" mono value={String(pace.fable)} onChange={(e) => setPace({ ...pace, fable: e.target.value })} placeholder="10" />
        </div>
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          your reserved share of each usage window, in points (0–100). the board stays this far
          behind the elapsed-time pace, leaving that slice of the budget for your own sessions.
        </p>
        <Button variant="primary" size="lg" full onClick={() => onAction('pace offsets saved', `session ${pace.session}pt · week ${pace.week}pt · fable ${pace.fable}pt`)}>
          Save pace offsets
        </Button>
      </Card>

      {data.workspaces.map((ws) => <SettingsWorkspaceRow key={ws.name} ws={ws} />)}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>add a workspace</SectionLabel>
        <Select label="Mode" options={wsModeOptions} value={wsMode} onChange={(e) => setWsMode(e.target.value)} />
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{wsModeHint}</p>
        <Input label="Name" value={wsName} onChange={(e) => setWsName(e.target.value)}
          placeholder="letters, digits, - _ . — safe as a directory and a repo name" />
        {wsMode === 'clone' && <Input label="Repository" value={wsRepo} onChange={(e) => setWsRepo(e.target.value)} placeholder="anything git clone accepts" />}
        {wsMode === 'register' && <Input label="Path" value={wsPath} onChange={(e) => setWsPath(e.target.value)} placeholder="an existing checkout on this host" />}
        <Input label="Notes" value={wsNotes} onChange={(e) => setWsNotes(e.target.value)} placeholder="setup hints for humans — optional" />
        <Checkbox label="protected — changes here always need human approval" checked={wsProtected} onChange={() => setWsProtected(!wsProtected)} />
        <Button variant="primary" size="lg" full disabled={!wsName.trim()} onClick={addWorkspace}>Add workspace — commits to the registry</Button>
      </Card>

      <div style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 'var(--text-lg)', margin: '0 0 2px' }}>Agents</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>who does the work</p>
      </div>
      {data.agents.map((agent) => <SettingsAgentRow key={agent.name} agent={agent} />)}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>add an agent</SectionLabel>
        <Input label="Name" value={agentName} onChange={(e) => setAgentName(e.target.value)}
          placeholder="letters, digits, - _ . — becomes agents/<name>.md, not renameable later" />
        <SettingsIconPicker value={agentIcon} onChange={setAgentIcon} />
        <Input label="Description" value={agentDesc} onChange={(e) => setAgentDesc(e.target.value)}
          placeholder="when a delegating agent should pick this one" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select label="Authority" options={authorityCreateOptions} value={agentAuthority} onChange={(e) => setAgentAuthority(e.target.value)} />
          <Input label="Model" value={agentModel} onChange={(e) => setAgentModel(e.target.value)} placeholder="adapter default if empty" />
        </div>
        <Button variant="primary" size="lg" full disabled={!agentName.trim() || !agentDesc.trim() || !agentAuthority} onClick={addAgent}>
          Add agent — commits to the registry
        </Button>
      </Card>

      <div style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 'var(--text-lg)', margin: '0 0 2px' }}>Authority Profiles</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>what the work is allowed to do</p>
      </div>
      {data.authorityProfiles.map((p) => <SettingsProfileRow key={p.name} profile={p} />)}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>add an authority profile</SectionLabel>
        <Input label="Name" value={profileName} onChange={(e) => setProfileName(e.target.value)}
          placeholder="letters, digits, - _ . — becomes authority/<name>.yaml, not renameable later" />
        <Input label="Guidance — prose injected into the agent's system prompt at spawn"
          multiline rows={4} value={guidance} onChange={(e) => setGuidance(e.target.value)}
          placeholder="how an agent carrying this authority should act" />
        <SettingsChipListInput label="Assignable to"
          hint='who this authority may delegate to — a registered agent or the human, or "*" for any'
          candidates={data.agents.map((a) => a.name)} wildcardHint="any agent"
          values={assignableTo} onChange={setAssignableTo} />
        <SettingsChipListInput label="Allowed workspaces"
          hint='which workspaces this authority may act in — pick a registered workspace, or "*" for every one'
          candidates={data.workspaces.map((w) => w.name)} wildcardHint="every workspace"
          values={allowedWorkspaces} onChange={setAllowedWorkspaces} />
        <Select label="Merge authority" options={SETTINGS_MERGE_OPTIONS} value={merge} onChange={(e) => setMerge(e.target.value)} />
        <Button variant="primary" size="lg" full disabled={!profileName.trim()} onClick={addProfile}>
          Add authority profile — commits to the registry
        </Button>
      </Card>
    </div>
  );
}

Object.assign(window, { SettingsScreen });
