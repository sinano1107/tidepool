// Task registration — brain dump → LLM drafts structured fields → confirm
function RegisterScreen({ data, onRegister }) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const [dump, setDump] = React.useState('');
  const [drafted, setDrafted] = React.useState(false);
  const [risk, setRisk] = React.useState(false);
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>Register</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>dump it — the LLM drafts the fields, you confirm</p>

      <Input multiline rows={4} placeholder="what needs doing, in your own words — sloppy is fine here, sloppy completion criteria are not" value={dump} onChange={(e) => setDump(e.target.value)} />
      <div style={{ height: 12 }}></div>
      {!drafted && <Button variant="primary" size="lg" full disabled={!dump.trim()} onClick={() => setDrafted(true)}>Draft fields</Button>}

      {drafted && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>drafted — edit freely</span>
          <Input label="Title" defaultValue="Add usage-limit gate to hourly poll" />
          <Input label="Purpose" multiline rows={2} defaultValue="Stop starting tasks when any rate-limit window is rejected; resume at resets_at." />
          <Input label="Completion criteria" multiline rows={2} defaultValue="rejected window → nothing starts; skipped shows in queue; immediate poll fires at reset. Covered by an integration test." />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Select label="Assignee" options={data.agents.map((a) => a.name).concat('you')} defaultValue="reef-crab" />
            <Select label="Workspace" options={['tidepool', 'registry', 'skills-fork']} defaultValue="tidepool" />
          </div>
          <Checkbox label="risk flag — request on-completion review" checked={risk} onChange={() => setRisk(!risk)} />
          <Button variant="primary" size="lg" full onClick={() => { onRegister(); setDrafted(false); setDump(''); setRisk(false); }}>Register — appends to queue tail</Button>
        </Card>
      )}
    </div>
  );
}

Object.assign(window, { RegisterScreen });
