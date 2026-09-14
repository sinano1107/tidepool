import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getEvent } from "../src/events.js";
import {
  buildMemoryInjection,
  changeMemorySettings,
  createBehaviorCandidate,
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
  return { db, task: registered, record };
}

it("注入節は最上位 INDEX と、task の title / purpose / completion criteria のどれかの語に当たる関連 leaf(title・path・出所の種別・text)を英語で並べる", () => {
  const { db, task, record } = board();
  const chart = record({ path: "tide", title: "Chart source", text: "The chart reads tides.csv." });
  const decision = logDecision(db, task, "chose csv", "deckhand", at);
  const drift = record({ path: "tide/drift", title: "Drift cause", text: "Clock skew causes drift.", event_id: decision });
  record({ path: "deploy", title: "Deploy to the Pi", text: "Run deploy-pi." });

  const injection = buildMemoryInjection(db, task, "tidepool", "deckhand");

  expect(injection.section).toBe(
    [
      "## Memory",
      "",
      "Approved board memory for this workspace. Browse deeper with browse_memory, find more with search_memory, " +
        "and read an entry's full text with read_memory. A fact source is a commit or board event; an inference " +
        "source is an agent's decision — weigh it.",
      "",
      "### Index",
      "",
      "- deploy/",
      "- tide/",
      "",
      "### Relevant entries",
      "",
      `- #${chart} Chart source (path: tide, source: fact)`,
      "  The chart reads tides.csv.",
      `- #${drift} Drift cause (path: tide/drift, source: inference)`,
      "  Clock skew causes drift.",
    ].join("\n"),
  );
  expect(injection.entries.map((e) => e.id).sort()).toEqual([chart, drift].sort());
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
  expect(injection.section).toContain("### Index\n\n- tide/\n\n###");
});

it("approved が1つも見えなければ節を出さず、entries は空", () => {
  const { db, task, record } = board();
  record({ path: "tide", title: "tide elsewhere", scope: "sandbox" });
  expect(buildMemoryInjection(db, task, "tidepool", "deckhand")).toMatchObject({ section: null, entries: [], tokens: 0 });
});

it("上限を超えると、まず leaf 本文を落として title + path だけにし、それでも超えれば関連 leaf を順位の上から半分ずつに減らす。最上位 INDEX は上限を超えても残る", () => {
  const { db, task, record } = board({ title: "tide", purpose: "p", completion_criteria: "c" });
  for (let i = 0; i < 8; i++) record({ path: `tide/n${i}`, title: `Tide note number ${i}`, text: `tide ${"filler ".repeat(100)}` });
  const at = (cap: number) => {
    changeMemorySettings(db, { injection_token_cap: cap }, "webui", new Date("2026-09-14T00:00:00.000Z"));
    return buildMemoryInjection(db, task, "tidepool", "deckhand");
  };

  const full = at(2000);
  expect(full.entries).toHaveLength(8);
  expect(full.section).toContain("filler");

  const titlesOnly = at(300);
  expect(titlesOnly.tokens).toBeLessThanOrEqual(300);
  expect(titlesOnly.entries).toEqual(full.entries);
  expect(titlesOnly.section).not.toContain("filler");

  const halved = at(150);
  expect(halved.tokens).toBeLessThanOrEqual(150);
  expect(halved.entries).toEqual(full.entries.slice(0, 4));
  expect(halved.section).not.toContain("filler");

  const indexOnly = at(1);
  expect(indexOnly.entries).toEqual([]);
  expect(indexOnly.tokens).toBeGreaterThan(1);
  expect(indexOnly.section).toMatch(/### Index\n\n- tide\/$/);
});

it("注入の記録は task 帰属・agent 名義の memory_injected で、worker_spawned の event id・組んだ時点の watermark・entry の id と版・トークン数・計数器の id と版を持つ", () => {
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
