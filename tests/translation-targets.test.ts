import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import {
  completeTask,
  logDecision,
  registerTask,
  renderHandoffMarkdown,
  splitHandoffMarkdown,
} from "../src/tasks.js";
import {
  TranslationTargetError,
  translateHandoff,
  translateLogEntry,
  translateQuestion,
} from "../src/translation.js";
import { FakeTranslationClient } from "./fakes.js";

let db: Db | undefined;
afterEach(() => db?.close());

async function freshDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-translation-targets-"));
  db = openDb(join(dir, "board.sqlite"));
  return db;
}

const NOW = new Date("2026-07-21T00:00:00Z");

it("decision_logged イベントの line を解決して翻訳する", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    NOW,
  );
  const eventId = logDecision(db, task, "decided to use approach A", "tako", NOW);

  const client = new FakeTranslationClient();
  client.scriptTranslation("アプローチAを採用することにした");

  const outcome = await translateLogEntry(db, client, eventId, "Japanese", NOW);

  expect(outcome).toEqual({
    status: "translated",
    text: "アプローチAを採用することにした",
    cached: false,
  });
  expect(client.calls).toEqual([{ source: "decided to use approach A", language: "Japanese" }]);
});

it("task_completed イベントの result を解決して翻訳する", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    NOW,
    "human",
  );
  const completed = completeTask(
    db,
    task,
    {
      outcome: "sensor reports moisture every 5 minutes",
      deliverables: "n/a",
      decision_refs: "n/a",
      dead_ends: "n/a",
      resume_context: "n/a",
      known_issues: "n/a",
    },
    "human",
    NOW,
  );
  const event = listEvents(db, completed.id).find((entry) => entry.kind === "task_completed");
  expect(event).toBeDefined();

  const client = new FakeTranslationClient();
  client.scriptTranslation("センサーは5分ごとに湿度を報告する");

  const outcome = await translateLogEntry(db, client, event!.id, "Japanese", NOW);

  expect(outcome).toEqual({
    status: "translated",
    text: "センサーは5分ごとに湿度を報告する",
    cached: false,
  });
});

it("存在しない event id は TranslationTargetError を投げる", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();

  await expect(translateLogEntry(db, client, 999, "Japanese", NOW)).rejects.toThrow(
    TranslationTargetError,
  );
});

it("splitHandoffMarkdown は renderHandoffMarkdown の見出し+本文を往復して復元する", () => {
  const rendered = renderHandoffMarkdown({
    outcome: "sensor reports moisture every 5 minutes",
    deliverables: "src/sensor.ts",
  });

  expect(splitHandoffMarkdown(rendered)).toEqual([
    { heading: "Outcome vs completion criteria", body: "sensor reports moisture every 5 minutes" },
    { heading: "Deliverable locations", body: "src/sensor.ts" },
  ]);
});

it("splitHandoffMarkdown は本文中の `## ` 行(コードブロック内のコメント等)を見出しと誤認しない", () => {
  const rendered = renderHandoffMarkdown({
    outcome: "see the note below",
    deliverables: "```sh\n## this is a shell comment, not a heading\necho hi\n```",
  });

  expect(splitHandoffMarkdown(rendered)).toEqual([
    { heading: "Outcome vs completion criteria", body: "see the note below" },
    {
      heading: "Deliverable locations",
      body: "```sh\n## this is a shell comment, not a heading\necho hi\n```",
    },
  ]);
});

it("handoff doc の見出し行はモデルに渡さず英語のまま保持し、本文だけ翻訳する", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c", assignee: "human" },
    NOW,
  );
  const completed = completeTask(
    db,
    task,
    {
      outcome: "sensor reports moisture every 5 minutes",
      deliverables: "src/sensor.ts",
    },
    "human",
    NOW,
  );

  const client = new FakeTranslationClient();
  client.scriptTranslation((source) =>
    source === "sensor reports moisture every 5 minutes"
      ? "センサーは5分ごとに湿度を報告する"
      : "src/sensor.ts(訳文)",
  );

  const outcome = await translateHandoff(db, client, completed.id, "Japanese", NOW);

  expect(outcome).toEqual({
    status: "translated",
    doc:
      "## Outcome vs completion criteria\n\nセンサーは5分ごとに湿度を報告する\n\n" +
      "## Deliverable locations\n\nsrc/sensor.ts(訳文)",
    cached: false,
  });
  // headings were never sent to the translation client (scaffolding — ADR
  // 0015's precision addendum: handoff の見出し is board scaffolding, not
  // agent prose)
  expect(client.calls.map((c) => c.source)).not.toContain("Outcome vs completion criteria");
});

it("handoff_doc を持たないタスクは TranslationTargetError を投げる", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    {
      type: "question",
      title: "t",
      purpose: "p",
      completion_criteria: "c",
      question: [{ title: "q", options: ["a", "b"], recommendation: "a" }],
    },
    NOW,
  );
  const client = new FakeTranslationClient();

  await expect(translateHandoff(db, client, task.id, "Japanese", NOW)).rejects.toThrow(
    TranslationTargetError,
  );
});

it("question の purpose と各 item の title/detail を翻訳する(選択肢ラベルは対象外)", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    {
      type: "question",
      title: "merge decision",
      purpose: "CI passed, ready to merge?",
      completion_criteria: "answered",
      question: [
        {
          title: "merge now?",
          detail: "CI is green on the latest commit",
          options: ["merge", "hold"],
          recommendation: "merge",
        },
        { title: "notify who?", options: ["nobody", "everyone"], recommendation: "nobody" },
      ],
    },
    NOW,
  );

  const client = new FakeTranslationClient();
  const JA: Record<string, string> = {
    "CI passed, ready to merge?": "CIが通った、mergeしていい?",
    "merge now?": "今mergeする?",
    "CI is green on the latest commit": "最新コミットでCIはgreen",
    "notify who?": "誰に通知する?",
  };
  client.scriptTranslation((source) => JA[source] ?? `[??] ${source}`);

  const outcome = await translateQuestion(db, client, task.id, "Japanese", NOW);

  expect(outcome).toEqual({
    status: "translated",
    purpose: "CIが通った、mergeしていい?",
    items: [
      { title: "今mergeする?", detail: "最新コミットでCIはgreen" },
      { title: "誰に通知する?", detail: undefined },
    ],
    cached: false,
  });
  // options/recommendation never reach the translation client (CONTEXT.md
  // scope exclusion: 選択肢ラベル is never a translation target)
  const sentSources = client.calls.map((c) => c.source);
  expect(sentSources).not.toContain("merge");
  expect(sentSources).not.toContain("hold");
});

it("work タスク(question ではない)の翻訳は TranslationTargetError を投げる", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    NOW,
  );
  const client = new FakeTranslationClient();

  await expect(translateQuestion(db, client, task.id, "Japanese", NOW)).rejects.toThrow(
    TranslationTargetError,
  );
});
