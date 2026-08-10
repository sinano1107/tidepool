// Settings — the board's admin surface as a drilldown (issue #204): an index
// of four sections, then a section, then one record that opens read-only with
// its form behind Edit. Board holds the board-wide preferences (display
// language, quiet hours, pace offsets); Workspaces / Agents / Authority
// Profiles are the registry-backed sections, each with its create form behind
// Add. Structural recreation of public/index.html's SettingsScreen for design
// review — runs on mock data, no API calls; Save/Add report through `onAction`
// instead of persisting, since this kit owns no registry. Deliberately
// dropped: the real screen's two-phase "dangerous value" 409 confirm dialog
// (workspace protection removal / non-empty review_allowed_commands / broad
// authority profiles, ADR 0061 決定1) — that gates a real backend consequence
// this kit has none of — and the real screen's tab-switch guard, which lives
// in its App shell, not here.
// The in-screen discard guard (leaving an edited card) is recreated.
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

// Free-entry-only chip list for review_allowed_commands (ADR 0061 / issue
// #265) — unlike SettingsChipListInput there is no candidate list: the board
// has no visibility into what commands exist on a host, so this is the free
// entry half of SettingsSkillListInput with the picker dropped.
function SettingsReviewCommandsInput({ values, onChange }) {
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
      <SectionLabel>Review allowed commands</SectionLabel>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        command prefixes a review session in this workspace may run beyond the read-only default. Empty means review stays read-only (confirmed on save if non-empty).
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
          <Input value={free} mono onChange={(e) => setFree(e.target.value)}
            placeholder='command prefix — e.g. "npm test"' />
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

// The head of a record card: identity on the left, Edit on the right while
// viewing. At most one card on the settings surface is in edit mode at a time,
// so the button asks the screen for that slot rather than flipping local state.
function SettingsRecordHead({ children, editing, onEdit }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
      {children}
      {!editing && (
        <div style={{ marginLeft: 'auto' }}>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        </div>
      )}
    </div>
  );
}

// Every edit and create form ends the same way: Save always present but inert
// until the draft is both changed and sendable, Cancel always available so an
// opened card is never a trap.
function SettingsEditActions({ dirty = true, ok = true, saveLabel, onSave, onCancel }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <Button variant="primary" size="lg" full disabled={!dirty || !ok} onClick={onSave}>{saveLabel}</Button>
      <Button variant="ghost" size="lg" full onClick={onCancel}>Cancel</Button>
    </React.Fragment>
  );
}

// Keeps the screen's single edit slot informed of this card's draft state, so
// anything that would leave it can ask before discarding.
function useSettingsDirty(edit, open, dirty) {
  React.useEffect(() => { if (open) edit.setDirty(dirty); }, [open, dirty]);
}

// One workspace as a record card: read-only until Edit, then notes + protection
// as a single draft — the Switch does not commit the moment it is touched.
// repo/path are shown but never editable (they re-point the entry).
function SettingsWorkspaceRecord({ ws, onAction, edit }) {
  const { Card, FieldRow, Input, Switch, Tag } = window.TidepoolDesignSystem_8a0ead;
  const id = `workspace:${ws.name}`;
  const open = edit.isOpen(id);
  const [notes, setNotes] = React.useState(ws.notes ?? '');
  const [prot, setProt] = React.useState(!!ws.protected);
  const [cmds, setCmds] = React.useState(ws.review_allowed_commands ?? []);
  const origin = ws.repo ?? ws.path;
  const dirty = notes.trim() !== (ws.notes ?? '')
    || prot !== !!ws.protected
    || !sameStrings(cmds, ws.review_allowed_commands ?? []);
  useSettingsDirty(edit, open, dirty);
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingsRecordHead editing={open} onEdit={() => edit.open(id, () => {
        setNotes(ws.notes ?? ''); setProt(!!ws.protected); setCmds(ws.review_allowed_commands ?? []);
      })}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{ws.name}</span>
        {ws.registrySelf && <Tag color="tide" mono>registry</Tag>}
        {ws.protected && <Tag color="sun">protected</Tag>}
      </SettingsRecordHead>
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
          <FieldRow label="notes" kind={ws.notes ? 'text' : 'unset'} value={ws.notes ?? ''} unsetLabel="—" />
          <FieldRow label="protected" kind="bool" checked={!!ws.protected}
            onLabel="changes here always need human approval" offLabel="not protected" />
          <FieldRow label="review allowed commands" kind={(ws.review_allowed_commands ?? []).length ? 'tags' : 'unset'}
            tags={ws.review_allowed_commands ?? []} unsetLabel="no extra commands allowed — review stays read-only" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="setup hints for humans — e.g. run npm install before first use" />
          <Switch label="protected — changes here always need human approval" checked={prot}
            disabled={ws.registrySelf && !!ws.protected} onChange={(next) => setProt(next)} />
          <SettingsReviewCommandsInput values={cmds} onChange={setCmds} />
          <SettingsEditActions dirty={dirty} saveLabel="Save — commits to the registry"
            onSave={() => { onAction('workspace updated', ws.name); edit.close(); }}
            onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// The agent fields an edit or a creation resubmits, as one draft. `name` is
// absent on purpose: it is the file name, offered at creation only.
function agentDraftOf(agent) {
  return {
    icon: agent.icon ?? '', description: agent.desc ?? '',
    systemPrompt: agent.systemPrompt ?? '', authority: agent.authority ?? '',
    model: agent.model ?? '', effort: agent.effort ?? '', advisor: agent.advisor ?? '',
    skills: agent.skills ?? [],
  };
}

// ADR 0025 決定7 / issue #106: the default agent (tako) is ["@workspace"], so
// a new agent starts there too — a visible field, not a hidden default.
const NEW_AGENT_DRAFT = {
  icon: '', description: '', systemPrompt: '', authority: '',
  model: '', effort: '', advisor: '', skills: ['@workspace'],
};

// Whether the draft differs from what it was primed with. The skills
// comparison is order-sensitive — a reorder is a real edit.
function agentDraftDirty(d, base) {
  return d.icon !== base.icon
    || d.description.trim() !== base.description
    || d.systemPrompt !== base.systemPrompt
    || d.authority !== base.authority
    || d.model.trim() !== base.model
    || d.effort.trim() !== base.effort
    || d.advisor.trim() !== base.advisor
    || !sameStrings(d.skills, base.skills);
}

// Those fields as controls, shared by the record card and the create form so
// the two never drift.
function SettingsAgentFields({ draft, set, authorityOptions, hostSkills }) {
  const { Input, Select } = window.TidepoolDesignSystem_8a0ead;
  return (
    <React.Fragment>
      <SettingsIconPicker value={draft.icon} onChange={(v) => set('icon', v)} />
      <Input label="Description" value={draft.description} onChange={(e) => set('description', e.target.value)}
        placeholder="when a delegating agent should pick this one" />
      <Input label="Specialty — persona, perspective, or this agent's own steps (optional; the worker protocol itself is injected separately, not written here)"
        multiline rows={4} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Select label="Authority" options={authorityOptions} value={draft.authority} onChange={(e) => set('authority', e.target.value)} />
        <Input label="Model" value={draft.model} onChange={(e) => set('model', e.target.value)} placeholder="adapter default if empty" />
      </div>
      <Input label="Effort" value={draft.effort} onChange={(e) => set('effort', e.target.value)} placeholder="adapter default if empty" />
      <Input label="Advisor model" value={draft.advisor} onChange={(e) => set('advisor', e.target.value)} placeholder="no advisor if empty" />
      <SettingsSkillListInput candidates={hostSkills} values={draft.skills} onChange={(v) => set('skills', v)} />
    </React.Fragment>
  );
}

// One agent as a record card, SettingsWorkspaceRecord's twin: the read half is
// FieldRows, the edit half is the draft above.
function SettingsAgentRecord({ agent, authorityProfiles, hostSkills, onAction, edit }) {
  const { Card, FieldRow, AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const id = `agent:${agent.name}`;
  const open = edit.isOpen(id);
  const [draft, setDraft] = React.useState(() => agentDraftOf(agent));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const authorityOptions = authorityProfiles.map((p) => p.name);
  const dirty = agentDraftDirty(draft, agentDraftOf(agent));
  const ok = !!draft.description.trim() && !!draft.authority;
  useSettingsDirty(edit, open, dirty);
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingsRecordHead editing={open} onEdit={() => edit.open(id, () => setDraft(agentDraftOf(agent)))}>
        <AgentChip name={agent.name} icon={open ? draft.icon : (agent.icon ?? '')} />
      </SettingsRecordHead>
      {!open && (
        <React.Fragment>
          <FieldRow label="description" kind={agent.desc ? 'text' : 'unset'} value={agent.desc ?? ''} unsetLabel="—" />
          <FieldRow label="specialty" kind={agent.systemPrompt ? 'text' : 'unset'} value={agent.systemPrompt ?? ''}
            unsetLabel="no specialty — worker protocol only" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="authority" kind={agent.authority ? 'mono' : 'unset'} value={agent.authority ?? ''} unsetLabel="—" />
            <FieldRow label="model" kind={agent.model ? 'mono' : 'unset'} value={agent.model ?? ''} unsetLabel="adapter default" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow label="effort" kind={agent.effort ? 'mono' : 'unset'} value={agent.effort ?? ''} unsetLabel="adapter default" />
            <FieldRow label="advisor model" kind={agent.advisor ? 'mono' : 'unset'} value={agent.advisor ?? ''} unsetLabel="no advisor" />
          </div>
          <FieldRow label="skills" kind={(agent.skills ?? []).length ? 'tags' : 'unset'} tags={agent.skills ?? []}
            scheme="skills" wildcardHint="every skill" unsetLabel="no skills allowed" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
          <SettingsAgentFields draft={draft} set={set} authorityOptions={authorityOptions} hostSkills={hostSkills} />
          <SettingsEditActions dirty={dirty} ok={ok} saveLabel="Save changes — commits to the registry"
            onSave={() => { onAction('agent updated', agent.name); edit.close(); }}
            onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// One authority profile as a record card, SettingsAgentRecord's twin.
function SettingsProfileRecord({ profile, agentNames, agentIcons, workspaceNames, onAction, edit }) {
  const { Card, FieldRow, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const id = `profile:${profile.name}`;
  const open = edit.isOpen(id);
  const [guidance, setGuidance] = React.useState(profile.guidance ?? '');
  const [assignableTo, setAssignableTo] = React.useState(profile.assignable_to ?? []);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState(profile.allowed_workspaces ?? []);
  const [merge, setMerge] = React.useState(profile.merge ?? '');
  const dirty =
    guidance !== (profile.guidance ?? '') ||
    !sameStrings(assignableTo, profile.assignable_to ?? []) ||
    !sameStrings(allowedWorkspaces, profile.allowed_workspaces ?? []) ||
    (merge || '') !== (profile.merge ?? '');
  useSettingsDirty(edit, open, dirty);
  const startEdit = () => edit.open(id, () => {
    setGuidance(profile.guidance ?? '');
    setAssignableTo(profile.assignable_to ?? []);
    setAllowedWorkspaces(profile.allowed_workspaces ?? []);
    setMerge(profile.merge ?? '');
  });
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingsRecordHead editing={open} onEdit={startEdit}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{profile.name}</span>
      </SettingsRecordHead>
      {!open && (
        <React.Fragment>
          <FieldRow label="guidance" kind={profile.guidance ? 'text' : 'unset'} value={profile.guidance ?? ''} unsetLabel="—" />
          <FieldRow label="assignable to" kind={(profile.assignable_to ?? []).length ? 'tags' : 'unset'}
            tags={profile.assignable_to ?? []} agentIcons={agentIcons} wildcardHint="any agent"
            unsetLabel="nobody — this authority can't be delegated" />
          <FieldRow label="allowed workspaces" kind={(profile.allowed_workspaces ?? []).length ? 'tags' : 'unset'}
            tags={profile.allowed_workspaces ?? []} wildcardHint="every workspace"
            unsetLabel="no workspace — this authority can't act anywhere" />
          <FieldRow label="merge authority" kind={profile.merge ? 'mono' : 'unset'} value={profile.merge ?? ''}
            unsetLabel="no automatic merge decision" />
        </React.Fragment>
      )}
      {open && (
        <React.Fragment>
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
          <SettingsEditActions dirty={dirty} saveLabel="Save changes — commits to the registry"
            onSave={() => { onAction('authority profile updated', profile.name); edit.close(); }}
            onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// The three board-wide preference cards, same viewing/editing rule as a record.
function SettingsBoardCard({ id, label, view, form, dirty, ok, saveLabel, onSave, onStart, edit }) {
  const { Card } = window.TidepoolDesignSystem_8a0ead;
  const open = edit.isOpen(id);
  useSettingsDirty(edit, open, dirty);
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingsRecordHead editing={open} onEdit={() => edit.open(id, onStart)}>
        <SectionLabel>{label}</SectionLabel>
      </SettingsRecordHead>
      {!open && view}
      {open && (
        <React.Fragment>
          {form}
          <SettingsEditActions dirty={dirty} ok={ok} saveLabel={saveLabel}
            onSave={() => { onSave(); edit.close(); }} onCancel={() => edit.close()} />
        </React.Fragment>
      )}
    </Card>
  );
}

// The workspace create form, behind Add on the Workspaces screen — it takes the
// same single edit slot a record card does.
function SettingsNewWorkspaceForm({ onAction, edit }) {
  const { Card, Checkbox, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [mode, setMode] = React.useState('clone');
  const [name, setName] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const [path, setPath] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [prot, setProt] = React.useState(false);
  const dirty = mode !== 'clone' || !!name.trim() || !!repo.trim() || !!path.trim() || !!notes.trim() || prot;
  useSettingsDirty(edit, true, dirty);
  const modeOptions = [
    { value: 'clone', label: 'clone a repository' },
    { value: 'create', label: 'create a new private repository' },
    { value: 'register', label: 'register an existing path' },
  ];
  const modeHint = {
    clone: 'clones into the workspaces directory — the entry stays host-independent',
    create: 'creates a private GitHub repo named after the workspace, then clones it',
    register: 'points at a checkout already on this host — the one mode that records a path',
  }[mode];
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionLabel>add a workspace</SectionLabel>
      <Select label="Mode" options={modeOptions} value={mode} onChange={(e) => setMode(e.target.value)} />
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{modeHint}</p>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — safe as a directory and a repo name" />
      {mode === 'clone' && <Input label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="anything git clone accepts" />}
      {mode === 'register' && <Input label="Path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="an existing checkout on this host" />}
      <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="setup hints for humans — optional" />
      <Checkbox label="protected — changes here always need human approval" checked={prot} onChange={() => setProt(!prot)} />
      <SettingsEditActions ok={!!name.trim()} saveLabel="Add workspace — commits to the registry"
        onSave={() => { onAction('workspace added — committed to the registry', name.trim()); edit.close(); }}
        onCancel={() => edit.close()} />
    </Card>
  );
}

// The agent create form: `name` is its own field — it becomes agents/<name>.md
// and is never editable afterwards; the rest is the draft the record edits.
function SettingsNewAgentForm({ authorityProfiles, hostSkills, onAction, edit }) {
  const { Card, Input } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState('');
  const [draft, setDraft] = React.useState(() => ({ ...NEW_AGENT_DRAFT }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty = !!name.trim() || agentDraftDirty(draft, NEW_AGENT_DRAFT);
  useSettingsDirty(edit, true, dirty);
  // creation offers the empty placeholder the edit form doesn't: a new agent
  // starts without an authority, an existing one always has one
  const authorityCreateOptions = [
    { value: '', label: 'select authority…' },
    ...authorityProfiles.map((p) => ({ value: p.name, label: p.name })),
  ];
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionLabel>add an agent</SectionLabel>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="letters, digits, - _ . — becomes agents/<name>.md, not renameable later" />
      <SettingsAgentFields draft={draft} set={set} authorityOptions={authorityCreateOptions} hostSkills={hostSkills} />
      <SettingsEditActions ok={!!name.trim() && !!draft.description.trim() && !!draft.authority}
        saveLabel="Add agent — commits to the registry"
        onSave={() => { onAction('agent added — committed to the registry', name.trim()); edit.close(); }}
        onCancel={() => edit.close()} />
    </Card>
  );
}

function SettingsNewProfileForm({ agentNames, workspaceNames, onAction, edit }) {
  const { Card, Input, Select } = window.TidepoolDesignSystem_8a0ead;
  const [name, setName] = React.useState('');
  const [guidance, setGuidance] = React.useState('');
  const [assignableTo, setAssignableTo] = React.useState([]);
  const [allowedWorkspaces, setAllowedWorkspaces] = React.useState([]);
  const [merge, setMerge] = React.useState('');
  const dirty = !!name.trim() || !!guidance.trim() || assignableTo.length > 0
    || allowedWorkspaces.length > 0 || !!merge;
  useSettingsDirty(edit, true, dirty);
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionLabel>add an authority profile</SectionLabel>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
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
      <SettingsEditActions ok={!!name.trim()} saveLabel="Add authority profile — commits to the registry"
        onSave={() => { onAction('authority profile added — committed to the registry', name.trim()); edit.close(); }}
        onCancel={() => edit.close()} />
    </Card>
  );
}

const SETTINGS_FOOTNOTE = { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' };

function SettingsScreen({ data, onAction }) {
  const { Button, Card, Dialog, FieldRow, Input, NavRow, ScreenHeader, Select } = window.TidepoolDesignSystem_8a0ead;
  const s = data.settings;
  const agentNames = data.agents.map((a) => a.name);
  const workspaceNames = data.workspaces.map((w) => w.name);
  const agentIcons = {};
  data.agents.forEach((a) => { if (a.icon) agentIcons[a.name] = a.icon; });

  // board-wide preference drafts, held here so a card can cancel back to them
  const [lang, setLang] = React.useState(s.displayLanguage);
  const [qStart, setQStart] = React.useState(s.quietHours.start);
  const [qEnd, setQEnd] = React.useState(s.quietHours.end);
  const [pace, setPace] = React.useState(s.paceOffsets);

  // --- drilldown navigation ------------------------------------------------
  // stack: [] the index · ['board'] · ['<section>'] · ['<section>', '<name>']
  const [stack, setStack] = React.useState([]);
  const [editing, setEditing] = React.useState(null);
  const [dirty, setDirty] = React.useState(false);
  const [pending, setPending] = React.useState(null);
  const unsaved = React.useRef(false);
  unsaved.current = editing !== null && dirty;

  const guard = (move) => {
    if (unsaved.current) { setPending({ move }); return true; }
    move();
    return false;
  };
  const closeEdit = () => { setEditing(null); setDirty(false); };
  const edit = {
    isOpen: (id) => editing === id,
    // `prime` fills the card's draft from the record. It runs with the open,
    // not before it, so a parked open (another card holds unsaved work) primes
    // only once the human has answered the discard dialog.
    open: (id, prime) => guard(() => { if (prime) prime(); setEditing(id); setDirty(false); }),
    // `close` is the deliberate discard behind Cancel and the exit after a
    // save; `requestClose` is for a control that merely folds the card away
    // (the Add toggle), which must not drop a draft silently
    close: closeEdit,
    requestClose: () => guard(closeEdit),
    setDirty,
  };
  const go = (next) => guard(() => { setStack(next); closeEdit(); });

  const SECTIONS = {
    workspaces: {
      title: 'Workspaces', singular: 'workspace', note: 'where tasks run',
      items: data.workspaces, footnote: 'edits commit to the registry',
      indexSummary: (items) => `${items.length} · ${items.filter((w) => w.protected).length} protected`,
      rowIdentity: (w) => ({ label: w.name }),
      rowSummary: (w) => w.repo || w.path || '—',
      record: (rec) => <SettingsWorkspaceRecord ws={rec} onAction={onAction} edit={edit} />,
      createForm: () => <SettingsNewWorkspaceForm onAction={onAction} edit={edit} />,
    },
    agents: {
      title: 'Agents', singular: 'agent', note: 'who does the work',
      items: data.agents, footnote: 'edits commit to agents/<name>.md in the registry',
      indexSummary: (items) => `${items.length} agents`,
      rowIdentity: (a) => ({ agentName: a.name, agentIcon: a.icon ?? '' }),
      rowSummary: (a) => a.authority,
      record: (rec) => (
        <SettingsAgentRecord agent={rec} authorityProfiles={data.authorityProfiles}
          hostSkills={data.hostSkills} onAction={onAction} edit={edit} />
      ),
      createForm: () => (
        <SettingsNewAgentForm authorityProfiles={data.authorityProfiles} hostSkills={data.hostSkills}
          onAction={onAction} edit={edit} />
      ),
    },
    profiles: {
      title: 'Authority Profiles', singular: 'authority profile',
      note: 'what the work is allowed to do',
      items: data.authorityProfiles,
      footnote: 'edits commit to authority/<name>.yaml in the registry',
      indexSummary: (items) => `${items.length} profiles`,
      rowIdentity: (p) => ({ label: p.name }),
      rowSummary: (p) => (p.assignable_to ?? []).join(', ') || '—',
      record: (rec) => (
        <SettingsProfileRecord profile={rec} agentNames={agentNames} agentIcons={agentIcons}
          workspaceNames={workspaceNames} onAction={onAction} edit={edit} />
      ),
      createForm: () => (
        <SettingsNewProfileForm agentNames={agentNames} workspaceNames={workspaceNames}
          onAction={onAction} edit={edit} />
      ),
    },
  };

  const sectionKey = stack[0];
  const recordName = stack[1];
  const sec = SECTIONS[sectionKey];
  const addId = `new:${sectionKey}`;
  const adding = editing === addId;

  let body;

  if (stack.length === 0) {
    const rows = [
      { key: 'board', label: 'Board', summary: `${s.displayLanguage} · ${s.quietHours.start}–${s.quietHours.end}` },
      ...Object.keys(SECTIONS).map((key) => ({
        key, label: SECTIONS[key].title, summary: SECTIONS[key].indexSummary(SECTIONS[key].items),
      })),
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
              divider={i > 0} first={i === 0} last={i === rows.length - 1}
              onClick={() => go([r.key])} />
          ))}
        </Card>
      </React.Fragment>
    );
  } else if (sectionKey === 'board') {
    body = (
      <React.Fragment>
        <ScreenHeader title="Board" backLabel="Settings" meta="board-wide preferences" onBack={() => go([])} />
        <SettingsBoardCard id="board:language" label="display language" edit={edit}
          dirty={lang !== s.displayLanguage} ok={!!lang} saveLabel="Save display language"
          onStart={() => setLang(s.displayLanguage)}
          onSave={() => onAction('display language saved', lang)}
          view={<FieldRow label="language" kind="mono" value={s.displayLanguage} />}
          form={<Select label="Language" options={s.displayLanguageOptions} value={lang} onChange={(e) => setLang(e.target.value)} />} />
        <SettingsBoardCard id="board:quiet-hours" label="quiet hours" edit={edit}
          dirty={qStart !== s.quietHours.start || qEnd !== s.quietHours.end}
          ok={!!qStart.trim() && !!qEnd.trim()} saveLabel="Save quiet hours"
          onStart={() => { setQStart(s.quietHours.start); setQEnd(s.quietHours.end); }}
          onSave={() => onAction('quiet hours saved', `${qStart}–${qEnd}`)}
          view={
            <React.Fragment>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <FieldRow label="start" kind="mono" value={s.quietHours.start} />
                <FieldRow label="end" kind="mono" value={s.quietHours.end} />
              </div>
              <FieldRow label="timezone" kind="mono" value={s.quietHours.tz} />
            </React.Fragment>
          }
          form={
            <React.Fragment>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Input label="Start" mono value={qStart} onChange={(e) => setQStart(e.target.value)} placeholder="HH:MM" />
                <Input label="End" mono value={qEnd} onChange={(e) => setQEnd(e.target.value)} placeholder="HH:MM" />
              </div>
              <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                start after end wraps past midnight (e.g. 23:00–07:00) — that's valid, not an error.
                timezone: {s.quietHours.tz} — change it from the timezone setting, not here.
              </p>
            </React.Fragment>
          } />
        <SettingsBoardCard id="board:pace-offsets" label="pace offsets" edit={edit}
          dirty={['session', 'week', 'fable'].some((k) => String(pace[k]) !== String(s.paceOffsets[k]))}
          ok={['session', 'week', 'fable'].every((k) => /^\d{1,3}$/.test(String(pace[k]).trim()) && Number(pace[k]) <= 100)}
          saveLabel="Save pace offsets"
          onStart={() => setPace(s.paceOffsets)}
          onSave={() => onAction('pace offsets saved', `session ${pace.session}pt · week ${pace.week}pt · fable ${pace.fable}pt`)}
          view={
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {['session', 'week', 'fable'].map((k) => (
                <FieldRow key={k} label={k} kind="mono" value={`${s.paceOffsets[k]} pt`} />
              ))}
            </div>
          }
          form={
            <React.Fragment>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <Input label="Session" mono value={String(pace.session)} onChange={(e) => setPace({ ...pace, session: e.target.value })} placeholder="20" />
                <Input label="Week" mono value={String(pace.week)} onChange={(e) => setPace({ ...pace, week: e.target.value })} placeholder="10" />
                <Input label="Fable" mono value={String(pace.fable)} onChange={(e) => setPace({ ...pace, fable: e.target.value })} placeholder="10" />
              </div>
              <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                your reserved share of each usage window, in points (0–100). the board stays this far
                behind the elapsed-time pace, leaving that slice of the budget for your own sessions.
              </p>
            </React.Fragment>
          } />
        <p style={SETTINGS_FOOTNOTE}>applies to every task the board picks up</p>
      </React.Fragment>
    );
  } else if (recordName === undefined) {
    body = (
      <React.Fragment>
        <ScreenHeader title={sec.title} backLabel="Settings" meta={`${sec.items.length} registered`} onBack={() => go([])}>
          <Button variant="ghost" size="sm" onClick={() => (adding ? edit.requestClose() : edit.open(addId))}>
            {adding ? 'Close' : 'Add'}
          </Button>
        </ScreenHeader>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>{sec.note}</p>
        {adding && sec.createForm()}
        <Card padding="0" style={{ overflow: 'hidden' }}>
          {sec.items.map((it, i) => (
            <NavRow key={it.name} {...sec.rowIdentity(it)} summary={sec.rowSummary(it)}
              divider={i > 0} first={i === 0} last={i === sec.items.length - 1}
              onClick={() => go([sectionKey, it.name])} />
          ))}
        </Card>
        <p style={SETTINGS_FOOTNOTE}>{sec.footnote}</p>
      </React.Fragment>
    );
  } else {
    const idx = sec.items.findIndex((x) => x.name === recordName);
    const rec = sec.items[idx];
    body = (
      <React.Fragment>
        <ScreenHeader title={recordName} backLabel={sec.title}
          meta={`${sec.singular} · ${idx + 1} of ${sec.items.length}`}
          onBack={() => go([sectionKey])} />
        {sec.record(rec)}
        <p style={SETTINGS_FOOTNOTE}>{sec.footnote}</p>
      </React.Fragment>
    );
  }

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {body}
      {ReactDOM.createPortal(
        <Dialog open={!!pending} title="Discard unsaved changes?" onClose={() => setPending(null)}
          footer={
            <React.Fragment>
              <Button variant="secondary" onClick={() => setPending(null)}>Keep editing</Button>
              <Button variant="danger" onClick={() => { const p = pending; setPending(null); closeEdit(); p.move(); }}>
                Discard
              </Button>
            </React.Fragment>
          }>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            The card you're editing has changes that were never saved. Leaving now drops them.
          </p>
        </Dialog>,
        document.body,
      )}
    </div>
  );
}

Object.assign(window, { SettingsScreen });
