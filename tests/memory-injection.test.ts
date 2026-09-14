import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getEvent } from "../src/events.js";
import {
  buildMemoryInjection,
  changeMemorySettings,
  createBehaviorCandidate,
  defineMemoryBranch,
  invalidateMemoryEntry,
  readMemorySettings,
  recordKnowledge,
  recordMemoryInjection,
} from "../src/memory.js";
import { logDecision, registerTask } from "../src/tasks.js";

const at = new Date("2026-09-14T00:00:00.000Z");

function board(task = { title: "fix tide chart", purpose: "chart drifts", completion_criteria: "tests pass" }) {
  const db = openDb(":memory:");
  const registered = registerTask(db, { type: "work", ...task }, at);
  const record = (over: { path?: string; title?: string; text?: string; scope?: string | null; event_id?: number }) => {
    const { event_id, ...rest } = over;
    return recordKnowledge(
      db,
      {
        scope: "tidepool",
        path: "notes",
        title: "t",
        text: "x",
        source: event_id === undefined ? { commit: "0a46a46" } : { event_id },
        author: { activity: "worker_verb", name: "deckhand" },
        ...rest,
      },
      "worker",
      at,
    ).entry_id;
  };
  const define = (path: string, text: string) =>
    defineMemoryBranch(db, { scope: "tidepool", path, text, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  return { db, task: registered, record, define };
}

it("注入節は全階層の INDEX(枝の名前 + 定義、未定義は (undefined)、深さ優先で深さごとに字下げ)と、task の title / purpose / completion criteria のどれかの語に当たる関連 leaf を本文なしのポインタ(title・path・出所の種別)として英語で並べる", () => {
  const { db, task, record, define } = board();
  const tide = define("tide", "Tide charts and the data that feeds them.");
  const chart = record({ path: "tide", title: "Chart source", text: "The chart reads tides.csv." });
  const decision = logDecision(db, task, "chose csv", "deckhand", at);
  const drift = record({ path: "tide/drift", title: "Drift cause", text: "Clock skew causes drift.", event_id: decision });
  record({ path: "deploy", title: "Deploy to the Pi", text: "Run deploy-pi." });

  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");

  expect(injection.section).toBe(
    [
      "## Memory",
      "",
      "Approved board memory for this workspace. Browse deeper with browse_memory and find more with search_memory. " +
        "A fact source is a commit or board event; an inference source is an agent's decision — weigh it. Each index " +
        "line is a branch and its definition — what is filed under it, or (undefined) — and a closing line, when " +
        "present, counts the relevant entries omitted and the depth the index is shown to; browse or search for the " +
        "rest. Relevant entries are pointers ranked by relevance, without their text: read the ones that bear on " +
        "your task with read_memory before acting.",
      "",
      "### Index",
      "",
      "- deploy/ — (undefined)",
      "- tide/ — Tide charts and the data that feeds them.",
      "  - drift/ — (undefined)",
      "",
      "### Relevant entries",
      "",
      `- #${chart} Chart source (path: tide, source: fact)`,
      `- #${drift} Drift cause (path: tide/drift, source: inference)`,
    ].join("\n"),
  );
  expect(injection).toMatchObject({ index_depth: 2, index_max_depth: 2, omitted: 0 });
  expect(injection.entries[0]).toEqual({ id: tide, version: tide });
  expect(injection.entries.slice(1).map((e) => e.id).sort()).toEqual([chart, drift].sort());
});

it("他 agent 宛の Behavior・他 workspace・candidate・無効化済みは、関連語に当たっても注入されず INDEX にも出ない", () => {
  const { db, task, record } = board();
  const shown = record({ path: "tide", title: "tide shown", text: "tide chart" });
  const boardWide = record({ path: "tide", title: "tide board-wide", text: "tide chart", scope: null });
  record({ path: "sandbox", title: "tide other workspace", text: "tide chart", scope: "sandbox" });
  const invalidated = record({ path: "stale", title: "tide invalidated", text: "tide chart" });
  invalidateMemoryEntry(db, { entry_id: invalidated, reason: "environment" }, "human", "webui", at);
  const behavior = (path: string, addressee: string) =>
    createBehaviorCandidate(
      db,
      { scope: "tidepool", path, title: `tide for ${addressee}`, text: "tide chart", addressee, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
      "board",
      at,
    ).entry_id;
  behavior("candidate", "deckhand");
  const elsewhere = behavior("elsewhere", "someone-else");
  const addressed = behavior("tide", "deckhand");
  // setup のみ: Behavior の承認経路は #358 が置くので、宛先の効き目を見るために行を approved にする
  db.prepare("UPDATE memory_entries SET state = 'approved', version = id WHERE id IN (?, ?)").run(elsewhere, addressed);

  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");

  expect(injection.entries.map((e) => e.id).sort()).toEqual([shown, boardWide, addressed].sort());
  expect(injection.section).toContain("### Index\n\n- tide/ — (undefined)\n\n###");
});

it("英語の自然文の task では、stopword しか共有しない leaf は関連 leaf に入らない(#606 の実測: 4枝 10 leaf → 2件)", () => {
  const { db, task, record } = board({
    title: "Fix the settings tab layout on narrow screens",
    purpose: "The tab is cramped when the window is small, so nobody can use it, and it should be usable",
    completion_criteria: "It renders without overflow at 400px",
  });
  const admin = record({ path: "webui", title: "Settings tab is the admin surface", text: "Admin controls are sections of one tab." });
  const breakpoints = record({ path: "webui", title: "Mobile breakpoints", text: "Below 600px the board column is narrow." });
  record({ path: "webui", title: "Episodes open in a drawer", text: "The drawer is on the right of the board." });
  record({ path: "deploy", title: "Deploy to the Pi", text: "Run deploy-pi from the Mac and it restarts the service." });
  record({ path: "deploy", title: "Funnel is public", text: "The vault is behind Auth0 and it is exposed by Funnel." });
  record({ path: "deploy/vm", title: "Tests run in the VM", text: "The Lima VM is where the suite runs." });
  record({ path: "copy", title: "Japanese copy quality bar", text: "A translated tone is not accepted for the UI." });
  record({ path: "copy", title: "Agent-facing text is English", text: "Prompts and tool descriptions are in English." });
  record({ path: "build", title: "Build uses tsc", text: "The build is tsc with no bundler." });
  record({ path: "build", title: "The landing runs after merge-back", text: "It is on the main branch." });

  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");

  expect(injection.entries.map((e) => e.id).sort()).toEqual([admin, breakpoints].sort());
});

it("title / purpose / completion criteria が stopword だけの task は、関連 leaf なし・INDEX ありの節を組む", () => {
  const { db, task, record } = board({ title: "The", purpose: "it is", completion_criteria: "a" });
  record({ path: "deploy", title: "Deploy to the Pi", text: "It is on the Pi." });

  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");

  expect(injection.entries).toEqual([]);
  expect(injection.section).toContain("### Index\n\n- deploy/ — (undefined)");
  expect(injection.section).not.toContain("### Relevant entries");
});

it("approved が1つも見えなければ節を出さず、entries は空", () => {
  const { db, task, record } = board();
  record({ path: "tide", title: "tide elsewhere", scope: "sandbox" });
  expect(buildMemoryInjection(db, task, "tidepool", "deckhand")).toMatchObject({
    section: null,
    entries: [],
    tokens: 0,
    index_depth: 0,
    index_max_depth: 0,
    omitted: 0,
  });
});

it("上限を超えると 関連 leaf を順位の下から1件ずつ → INDEX を深い階層から1段ずつ の順に削り、最上位 INDEX は上限を超えても残る。印は削ったときだけ末尾に出る", () => {
  const { db, task, record, define } = board({ title: "tide", purpose: "p", completion_criteria: "c" });
  const long = (name: string) => `${name} ${"holds one kind of note ".repeat(10)}`;
  const top = define("tide", long("tide"));
  const middle = define("tide/a", long("a"));
  const deepest = define("tide/a/b", long("b"));
  for (let i = 0; i < 3; i++) record({ path: "tide/a/b", title: `Tide note number ${i}`, text: `tide ${"filler ".repeat(100)}` });
  const inject = (cap: number) => {
    changeMemorySettings(db, { injection_token_cap: cap }, "webui", at);
    return buildMemoryInjection(db, task, "tidepool", "deckhand");
  };
  // 上限を直前のトークン数の1つ下にすると、ちょうど1段だけ削れる
  const next = (previous: { tokens: number }) => inject(previous.tokens - 1);
  const definitions = (...ids: number[]) => ids.map((id) => ({ id, version: id }));

  const full = inject(2000);
  const leaves = full.entries.slice(3);
  expect(leaves).toHaveLength(3);
  expect(full).toMatchObject({ index_depth: 3, index_max_depth: 3, omitted: 0, entries: [...definitions(top, middle, deepest), ...leaves] });
  expect(full.section).not.toContain("filler");
  expect(full.section).not.toMatch(/(omitted|depth \d of \d)$/);

  const oneDropped = next(full);
  expect(oneDropped).toMatchObject({ index_depth: 3, omitted: 1, entries: [...definitions(top, middle, deepest), ...leaves.slice(0, 2)] });
  expect(oneDropped.section).toMatch(/\n\n1 relevant entry omitted$/);

  const twoDropped = next(oneDropped);
  expect(twoDropped).toMatchObject({ index_depth: 3, omitted: 2, entries: [...definitions(top, middle, deepest), ...leaves.slice(0, 1)] });
  expect(twoDropped.section).toMatch(/\n\n2 relevant entries omitted$/);

  const allDropped = next(twoDropped);
  expect(allDropped).toMatchObject({ index_depth: 3, omitted: 3, entries: definitions(top, middle, deepest) });
  expect(allDropped.section).not.toContain("### Relevant entries");
  expect(allDropped.section).toMatch(/\n\n3 relevant entries omitted$/);

  const depth2 = next(allDropped);
  expect(depth2).toMatchObject({ index_depth: 2, index_max_depth: 3, omitted: 3, entries: definitions(top, middle) });
  expect(depth2.section).toMatch(/\n\n3 relevant entries omitted; index shown to depth 2 of 3$/);

  for (const indexOnly of [next(depth2), inject(1)]) {
    expect(indexOnly).toMatchObject({ index_depth: 1, omitted: 3, entries: definitions(top) });
    expect(indexOnly.tokens).toBeGreaterThan(1);
    expect(indexOnly.section).toMatch(/### Index\n\n- tide\/ — .*\n\n3 relevant entries omitted; index shown to depth 1 of 3$/);
  }
});

it("INDEX を浅くせずに関連 leaf だけ落としたときは、印は件数だけ", () => {
  const { db, task, record } = board({ title: "tide", purpose: "p", completion_criteria: "c" });
  for (let i = 0; i < 2; i++) record({ path: "tide", title: `Tide note number ${i}` });
  changeMemorySettings(db, { injection_token_cap: 1 }, "webui", at);
  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");
  expect(injection).toMatchObject({ index_depth: 1, index_max_depth: 1, omitted: 2 });
  expect(injection.section).toMatch(/- tide\/ — \(undefined\)\n\n2 relevant entries omitted$/);
});

it("注入の記録は task 帰属・agent 名義の memory_injected で、worker_spawned の event id・組んだ時点の watermark・entry の id と版・トークン数・INDEX の深さと全深さ・落とした件数・計数器の id と版を持つ", () => {
  const { db, task, record } = board();
  const chart = record({ path: "tide", title: "Chart source", text: "The chart reads tides.csv." });
  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");

  const eventId = recordMemoryInjection(db, task.id, "deckhand", 42, injection, at);

  expect(getEvent(db, eventId)).toMatchObject({
    task_id: task.id,
    worker_id: "deckhand",
    origin: "board",
    payload: {
      kind: "memory_injected",
      worker_spawned_event_id: 42,
      watermark: chart,
      entries: [{ id: chart, version: chart }],
      tokens: injection.tokens,
      index_depth: 1,
      index_max_depth: 1,
      omitted: 0,
      tokenizer: "gpt-tokenizer/o200k_base",
      tokenizer_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    },
  });
  expect(injection.tokens).toBeGreaterThan(0);
});

it("注入上限は未設定なら 2,000 トークンで、変更は読み口に効き、人間名義・task 無しの memory_settings_changed を残す", () => {
  const db = openDb(":memory:");
  expect(readMemorySettings(db)).toEqual({ injection_token_cap: 2000 });

  const eventId = changeMemorySettings(db, { injection_token_cap: 500 }, "webui", at);

  expect(readMemorySettings(db)).toEqual({ injection_token_cap: 500 });
  expect(getEvent(db, eventId)).toMatchObject({
    task_id: null,
    worker_id: "human",
    origin: "webui",
    payload: { kind: "memory_settings_changed", injection_token_cap: 500 },
  });
});
