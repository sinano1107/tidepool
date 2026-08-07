// Settings — the board's admin surface: board-wide preferences (display
// language, quiet hours, pace offsets) plus the three registry surfaces
// (workspaces / agents / authority profiles). Structural recreation of
// public/index.html's SettingsScreen for design review — runs on mock data,
// no API calls. Existing-item cards are always-editable inline forms (same
// shape as the real WorkspaceCard/AgentCard/ProfileCard) with a dirty-gated
// "Save changes" button that reports through `onAction` instead of actually
// persisting — this kit doesn't own a registry. Deliberately dropped:
// the real screen's two confirmation flows (removing workspace protection,
// and the two-phase "dangerous value" 409 confirm on authority profiles) —
// those exist to gate a real backend consequence this kit has none of.
const SETTINGS_MERGE_OPTIONS = [
  { value: '', label: 'no automatic merge decision (default)' },
  { value: 'escalate', label: 'escalate — always ask a human before merging' },
  { value: 'auto_if_ci_green', label: 'auto_if_ci_green — merge unattended once CI is green' },
];

const SETTINGS_ICON_SEA = ['🐙', '🦀', '🦐', '🦞', '🦑', '🦪', '🐚', '🐡', '🐠', '🐟', '🐬', '🐳', '🦈', '🦭', '🐢', '🪼', '🪸'];
const SETTINGS_ICON_LAND = ['🦦', '🐕', '🐈', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦅', '🐴', '🦋', '🐝'];

function sameStrings(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

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

// Skills allowlist picker (issue #106 / ADR 0025) — scope words (@workspace,
// @host), enumerated host skills, or "*" for all; free entry for anything the
// picker can't list. Tag color carries the grammar: sun = wildcard, grass = a
// scope word, tide = a plain name/glob. Simplified grammar vs. the real
// skillAddError (drops the plugin-glob-specific messages) but keeps its two
// load-bearing rules: "*" only when alone, offered entries never duplicate.
function SettingsSkillListInput({ candidates, values, onChange }) {
  const { Input, Button, Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [free, setFree] = React.useState('');
  const hasWildcard = values.includes('*');
  const offerable = hasWildcard ? [] : ['@workspace', '@host', ...candidates, '*'].filter((c) => !values.includes(c));
  const options = [
    { value: '', label: offerable.length ? 'add a scope or skill…' : 'no more to add' },
    ...offerable.map((c) => ({ value: c, label: c === '*' ? '* — every skill' : c })),
  ];
  const pick = (e) => { if (e.target.value) onChange([...values, e.target.value]); };
  const addFree = () => {
    const v = free.trim();
    if (!v || hasWildcard || values.includes(v)) return;
    onChange([...values, v]);
    setFree('');
  };
  const tagColor = (v) => (v === '*' ? 'sun' : v.startsWith('@') ? 'grass' : 'tide');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>Skills</SectionLabel>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        which skills this agent may use — a scope (@workspace / @host), an enumerated host skill, "plugin-name:*", or "*" for all. Free entry adds a workspace-specific name the picker can't list.
      </p>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((v) => (
            <button key={v} type="button" title="remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
              <Tag color={tagColor(v)} mono>{v} ✕</Tag>
            </button>
          ))}
        </div>
      )}
      <Select value="" options={options} onChange={pick} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Input value={free} mono onChange={(e) => setFree(e.target.value)}
            placeholder='free entry — e.g. a workspace skill name or "plugin-name:*"' />
        </div>
        <Button variant="secondary" disabled={!free.trim()} onClick={addFree}>Add</Button>
      </div>
    </div>
  );
}

// Shared chip-list shape for "assignable to" / "allowed workspaces" — pick
// from candidates or "*" (wildcard). Mirrors ProfileListInput's tag coloring
// (no grass here — only skills carry scope words).
function SettingsChipListInput({ label, hint, candidates, wildcardHint, values, onChange }) {
  const { Select, Tag } = window.TidepoolDesignSystem_8a0ead;
  const addable = candidates.filter((c) => !values.includes(c));
  const wildcardAddable = !values.includes('*');
  const options = [
    { value: '', label: addable.length || wildcardAddable ? 'add…' : 'no more to add' },
    ...addable.map((c) => ({ value: c, label: c })),
    ...(wildcardAddable ? [{ value: '*', label: `* — ${wildcardHint}` }] : []),
  ];
  const pick = (e) => { if (e.target.value) onChange([...values, e.target.value]); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>{label}</SectionLabel>
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
      <Select value="" options={options} onChange={pick} />
    </div>
  );
}

// Always-editable inline card, WorkspaceCard's shape: name + protection Switch
// up top, repo/path readout, editable Notes with a dirty-gated Save.
function SettingsWorkspaceCard({ ws, onAction }) {
  const { Button, Card, Input, Switch, Tag } = window.TidepoolDesignSystem_8a0ead;
  const [notes, setNotes] = React.useState(ws.notes ?? '');
  const [prot, setProt] = React.useState(!!ws.protected);
  const notesDirty = notes.trim() !== (ws.notes ?? '');
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{ws.name}</span>
        {ws.registrySelf && <Tag color="tide" mono>registry</Tag>}
        {prot && <Tag color="sun">protected</Tag>}
        <div style={{ marginLeft: 'auto' }}>
          <Switch label="protected" checked={prot} disabled={ws.registrySelf && prot}
            onChange={(next) => { setProt(next); onAction(next ? 'protection added' : 'protection removed', ws.name); }} />
        </div>
      </div>
      {(ws.repo || ws.path) && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {ws.repo ?? ws.path}
        </div>
      )}
      {ws.registrySelf && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          the board's own registry clone — protection stays on
        </div>
      )}
      <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="setup hints for humans — e.g. run npm install before first use" />
      {notesDirty && (
        <Button variant="secondary" onClick={() => onAction('notes updated', ws.name)}>
          Save notes — commits to the registry
        </Button>
      )}
    </Card>
  );
}

// Always-editable inline card, AgentCard's shape: chip + icon picker + every
// field the real edit form carries, dirty-gated Save.
function SettingsAgentCard({ agent, authorityProfiles, hostSkills, onAction }) {
  const { Button, Card, Input, Select, AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const [icon, setIcon] = React.useState(agent.icon ?? '');
  const [description, setDescription] = React.useState(agent.desc ?? '');
  const [systemPrompt, setSystemPrompt] = React.useState(agent.systemPrompt ?? '');
  const [authority, setAuthority] = React.useState(agent.authority ?? '');
  const [model, setModel] = React.useState(agent.model ?? '');
  const [effort, setEffort] = React.useState(agent.effort ?? '');
  const [advisor, setAdvisor] = React.useState(agent.advisor ?? '');
  const [skills, setSkills] = React.useState(agent.skills ?? []);
  const authorityOptions = authorityProfiles.map((p) => p.name);
  const dirty =
    icon !== (agent.icon ?? '') ||
    description.trim() !== (agent.desc ?? '') ||
    systemPrompt !== (agent.systemPrompt ?? '') ||
    authority !== (agent.authority ?? '') ||
    model.trim() !== (agent.model ?? '') ||
    effort.trim() !== (agent.effort ?? '') ||
    advisor.trim() !== (agent.advisor ?? '') ||
    !sameStrings(skills, agent.skills ?? []);
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <AgentChip name={agent.name} icon={icon} />
      <SettingsIconPicker value={icon} onChange={setIcon} />
      <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <Input label="Specialty — persona, perspective, or this agent's own steps (optional; the worker protocol itself is injected separately, not written here)"
        multiline rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Select label="Authority" options={authorityOptions} value={authority} onChange={(e) => setAuthority(e.target.value)} />
        <Input label="Model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="adapter default if empty" />
      </div>
      <Input label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)} placeholder="adapter default if empty" />
      <Input label="Advisor model" value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder="no advisor if empty" />
      <SettingsSkillListInput candidates={hostSkills} values={skills} onChange={setSkills} />
      {dirty && (
        <Button variant="secondary" onClick={() => onAction('agent updated', agent.name)}>
          Save changes — commits to the registry
        </Button>
      )}
    </Card>
  );
}

// Always-editable inline card, ProfileCard's shape: name + the same fields
// the create form uses, dirty-gated Save.
function SettingsProfileCard({ profile, agentNames, workspaceNames, onAction }) {
  const { Button, Card, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [guidance, setGuidance] = React.useState(profile.guidance ?? '');
  const [assignableTo, setAssignableTo] = React.useState(profile.assignable_to ?? []);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState(profile.allowed_workspaces ?? []);
  const [merge, setMerge] = React.useState(profile.merge ?? '');
  const dirty =
    guidance !== (profile.guidance ?? '') ||
    !sameStrings(assignableTo, profile.assignable_to ?? []) ||
    !sameStrings(allowedWorkspaces, profile.allowed_workspaces ?? []) ||
    (merge || '') !== (profile.merge ?? '');
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{profile.name}</span>
      <Input label="Guidance — prose injected into the agent's system prompt at spawn"
        multiline rows={4} value={guidance} onChange={(e) => setGuidance(e.target.value)}
        placeholder="how an agent carrying this authority should act" />
      <SettingsChipListInput label="Assignable to"
        hint='who this authority may delegate to — a registered agent or the human, or "*" for any'
        candidates={agentNames.includes('human') ? agentNames : [...agentNames, 'human']} wildcardHint="any agent"
        values={assignableTo} onChange={setAssignableTo} />
      <SettingsChipListInput label="Allowed workspaces"
        hint='which workspaces this authority may act in — pick a registered workspace, or "*" for every one'
        candidates={workspaceNames} wildcardHint="every workspace"
        values={allowedWorkspaces} onChange={setAllowedWorkspaces} />
      <Select label="Merge authority" options={SETTINGS_MERGE_OPTIONS} value={merge} onChange={(e) => setMerge(e.target.value)} />
      {dirty && (
        <Button variant="secondary" onClick={() => onAction('authority profile updated', profile.name)}>
          Save changes — commits to the registry
        </Button>
      )}
    </Card>
  );
}

function SettingsScreen({ data, onAction }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const s = data.settings;
  const agentNames = data.agents.map((a) => a.name);
  const workspaceNames = data.workspaces.map((w) => w.name);

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
  const [agentPrompt, setAgentPrompt] = React.useState('');
  const [agentAuthority, setAgentAuthority] = React.useState('');
  const [agentModel, setAgentModel] = React.useState('');
  const [agentEffort, setAgentEffort] = React.useState('');
  const [agentAdvisor, setAgentAdvisor] = React.useState('');
  // ADR 0025 決定7 / issue #106: the default agent (tako) is ["@workspace"],
  // so a new agent starts there too — a visible field, not a hidden default.
  const [agentSkills, setAgentSkills] = React.useState(['@workspace']);
  const authorityCreateOptions = [
    { value: '', label: 'select authority…' },
    ...data.authorityProfiles.map((p) => ({ value: p.name, label: p.name })),
  ];
  const addAgent = () => {
    onAction('agent added — committed to the registry', agentName.trim());
    setAgentName(''); setAgentIcon(''); setAgentDesc(''); setAgentPrompt('');
    setAgentAuthority(''); setAgentModel(''); setAgentEffort(''); setAgentAdvisor('');
    setAgentSkills(['@workspace']);
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

      {data.workspaces.map((ws) => <SettingsWorkspaceCard key={ws.name} ws={ws} onAction={onAction} />)}
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
      {data.agents.map((agent) => (
        <SettingsAgentCard key={agent.name} agent={agent} authorityProfiles={data.authorityProfiles} hostSkills={data.hostSkills} onAction={onAction} />
      ))}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>add an agent</SectionLabel>
        <Input label="Name" value={agentName} onChange={(e) => setAgentName(e.target.value)}
          placeholder="letters, digits, - _ . — becomes agents/<name>.md, not renameable later" />
        <SettingsIconPicker value={agentIcon} onChange={setAgentIcon} />
        <Input label="Description" value={agentDesc} onChange={(e) => setAgentDesc(e.target.value)}
          placeholder="when a delegating agent should pick this one" />
        <Input label="Specialty — persona, perspective, or this agent's own steps (optional; the worker protocol itself is injected separately, not written here)"
          multiline rows={4} value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select label="Authority" options={authorityCreateOptions} value={agentAuthority} onChange={(e) => setAgentAuthority(e.target.value)} />
          <Input label="Model" value={agentModel} onChange={(e) => setAgentModel(e.target.value)} placeholder="adapter default if empty" />
        </div>
        <Input label="Effort" value={agentEffort} onChange={(e) => setAgentEffort(e.target.value)} placeholder="adapter default if empty" />
        <Input label="Advisor model" value={agentAdvisor} onChange={(e) => setAgentAdvisor(e.target.value)} placeholder="no advisor if empty" />
        <SettingsSkillListInput candidates={data.hostSkills} values={agentSkills} onChange={setAgentSkills} />
        <Button variant="primary" size="lg" full disabled={!agentName.trim() || !agentDesc.trim() || !agentAuthority} onClick={addAgent}>
          Add agent — commits to the registry
        </Button>
      </Card>

      <div style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 'var(--text-lg)', margin: '0 0 2px' }}>Authority Profiles</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>what the work is allowed to do</p>
      </div>
      {data.authorityProfiles.map((p) => (
        <SettingsProfileCard key={p.name} profile={p} agentNames={agentNames} workspaceNames={workspaceNames} onAction={onAction} />
      ))}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>add an authority profile</SectionLabel>
        <Input label="Name" value={profileName} onChange={(e) => setProfileName(e.target.value)}
          placeholder="letters, digits, - _ . — becomes authority/<name>.yaml, not renameable later" />
        <Input label="Guidance — prose injected into the agent's system prompt at spawn"
          multiline rows={4} value={guidance} onChange={(e) => setGuidance(e.target.value)}
          placeholder="how an agent carrying this authority should act" />
        <SettingsChipListInput label="Assignable to"
          hint='who this authority may delegate to — a registered agent or the human, or "*" for any'
          candidates={agentNames.includes('human') ? agentNames : [...agentNames, 'human']} wildcardHint="any agent"
          values={assignableTo} onChange={setAssignableTo} />
        <SettingsChipListInput label="Allowed workspaces"
          hint='which workspaces this authority may act in — pick a registered workspace, or "*" for every one'
          candidates={workspaceNames} wildcardHint="every workspace"
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
