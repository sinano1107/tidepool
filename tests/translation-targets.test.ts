import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { recordKnowledge } from "../src/memory.js";
import {
  completeTask,
  declarePremiseBreach,
  logDecision,
  registerTask,
  splitHandoffMarkdown,
} from "../src/tasks.js";
import { reportProviderUsage } from "../src/throttle.js";
import {
  TranslationTargetError,
  translateHandoff,
  translateLogEntries,
  translateLogEntry,
  translateMemoryEntry,
  translateQuestion,
} from "../src/translation.js";
import { getCachedTranslation, hashSource, listTranslationUsage } from "../src/translation-cache.js";
import { FakeTranslationClient } from "./fakes.js";
import { decomposeTaskViaWorker, HUMAN_WEBUI } from "./harness.js";
import { tempDir } from "./temp-dir.js";

let db: Db | undefined;
afterEach(() => db?.close());

async function freshDb(): Promise<Db> {
  const dir = await tempDir("tidepool-translation-targets-");
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
    ...HUMAN_WEBUI,
  );
  const eventId = logDecision(db, task, "decided to use approach A", "tako", NOW, "worker");

  const client = new FakeTranslationClient();
  client.scriptTranslation("アプローチAを採用することにした");

  const outcome = await translateLogEntry(db, client, eventId, "Japanese", NOW);

  expect(outcome).toEqual({
    status: "translated",
    text: "アプローチAを採用することにした",
    cached: false,
  });
  expect(client.calls).toEqual([{ fragments: ["decided to use approach A"], language: "Japanese" }]);
});

it("task_completed イベントの result を解決して翻訳する", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    NOW,
    "human",
    "webui",
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
    "worker",
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

it("premise_breached イベントの宣言の理由を解決して翻訳する", async () => {
  const db = await freshDb();
  const parent = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [child] = decomposeTaskViaWorker(db, parent, { reason: "split", children: [{ title: "a", purpose: "p", completion_criteria: "c" }] }, "tako", NOW);
  declarePremiseBreach(db, child!, "module M is broken", "tako", NOW, "worker");
  const event = listEvents(db, child!.id).find((entry) => entry.kind === "premise_breached");

  const client = new FakeTranslationClient();
  client.scriptTranslation("モジュールMが壊れている");

  const outcome = await translateLogEntry(db, client, event!.id, "Japanese", NOW);

  expect(outcome).toEqual({ status: "translated", text: "モジュールMが壊れている", cached: false });
  expect(client.calls).toEqual([{ fragments: ["module M is broken"], language: "Japanese" }]);
});

it("複数の event id は cache に無い断片だけを1回の呼び出しに載せ、id ごとの訳を要求の順で返す(ADR 0296 決定4)", async () => {
  const db = await freshDb();
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const ids = ["line a", "line b", "line c"].map((line) => logDecision(db, task, line, "tako", NOW, "worker"));
  const client = new FakeTranslationClient();
  await translateLogEntry(db, client, ids[1]!, "Japanese", NOW);

  const outcome = await translateLogEntries(db, client, ids, "Japanese", NOW);

  expect(client.calls.at(-1)).toEqual({ fragments: ["line a", "line c"], language: "Japanese" });
  expect(outcome).toEqual({
    status: "translated",
    entries: [
      { event_id: ids[0], text: "[translated] line a" },
      { event_id: ids[1], text: "[translated] line b" },
      { event_id: ids[2], text: "[translated] line c" },
    ],
  });
});

it("複数の event id がすべて cache 済みなら呼び出しを撃たない", async () => {
  const db = await freshDb();
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const ids = ["line a", "line b"].map((line) => logDecision(db, task, line, "tako", NOW, "worker"));
  const client = new FakeTranslationClient();
  await translateLogEntries(db, client, ids, "Japanese", NOW);

  const outcome = await translateLogEntries(db, client, ids, "Japanese", NOW);

  expect(client.calls).toHaveLength(1);
  expect(outcome).toMatchObject({ status: "translated", entries: [{ event_id: ids[0] }, { event_id: ids[1] }] });
});

it("throttled のとき複数の event id は throttled を返し、何も cache しない", async () => {
  const db = await freshDb();
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const ids = ["line a", "line b"].map((line) => logDecision(db, task, line, "tako", NOW, "worker"));
  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "session",
        model: null,
        usedPercent: 50,
        durationMs: 5 * 60 * 60 * 1000,
        resetsAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      },
    ],
  });
  const client = new FakeTranslationClient();

  const outcome = await translateLogEntries(db, client, ids, "Japanese", NOW);

  expect(outcome).toEqual({ status: "throttled" });
  expect(client.calls).toEqual([]);
  expect(getCachedTranslation(db, hashSource("line a"), "Japanese")).toBeUndefined();
});

it("複数の event id に解決できない id が1つでもあれば TranslationTargetError を投げ、何も撃たない", async () => {
  const db = await freshDb();
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const id = logDecision(db, task, "line a", "tako", NOW, "worker");
  const client = new FakeTranslationClient();

  await expect(translateLogEntries(db, client, [id, 999], "Japanese", NOW)).rejects.toThrow(TranslationTargetError);
  expect(client.calls).toEqual([]);
  expect(getCachedTranslation(db, hashSource("line a"), "Japanese")).toBeUndefined();
});

it("存在しない event id は TranslationTargetError を投げる", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();

  await expect(translateLogEntry(db, client, 999, "Japanese", NOW)).rejects.toThrow(
    TranslationTargetError,
  );
});

it("splitHandoffMarkdown は completeTask の handoff の見出し+本文を復元する", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c", assignee: "human" },
    NOW,
    ...HUMAN_WEBUI,
  );
  const completed = completeTask(db, task, {
    outcome: "sensor reports moisture every 5 minutes",
    deliverables: "src/sensor.ts",
  }, "human", NOW, "worker");

  expect(splitHandoffMarkdown(completed.handoff_doc!)).toEqual([
    { heading: "Outcome vs completion criteria", body: "sensor reports moisture every 5 minutes" },
    { heading: "Deliverable locations", body: "src/sensor.ts" },
  ]);
});

it("splitHandoffMarkdown は completeTask の本文中の `## ` 行(コードブロック内のコメント等)を見出しと誤認しない", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c", assignee: "human" },
    NOW,
    ...HUMAN_WEBUI,
  );
  const completed = completeTask(db, task, {
    outcome: "see the note below",
    deliverables: "```sh\n## this is a shell comment, not a heading\necho hi\n```",
  }, "human", NOW, "worker");

  expect(splitHandoffMarkdown(completed.handoff_doc!)).toEqual([
    { heading: "Outcome vs completion criteria", body: "see the note below" },
    {
      heading: "Deliverable locations",
      body: "```sh\n## this is a shell comment, not a heading\necho hi\n```",
    },
  ]);
});

it("handoff doc の見出し行はモデルに渡さず英語のまま保持し、節の本文だけを1回の呼び出しで翻訳する", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c", assignee: "human" },
    NOW,
    ...HUMAN_WEBUI,
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
    "worker",
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
  expect(client.calls).toEqual([
    { fragments: ["sensor reports moisture every 5 minutes", "src/sensor.ts"], language: "Japanese" },
  ]);
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
    ...HUMAN_WEBUI,
  );
  const client = new FakeTranslationClient();

  await expect(translateHandoff(db, client, task.id, "Japanese", NOW)).rejects.toThrow(
    TranslationTargetError,
  );
});

it("question の purpose と各 item の title/detail を1回の呼び出しで翻訳する(選択肢ラベルは対象外)", async () => {
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
    ...HUMAN_WEBUI,
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
  expect(client.calls).toEqual([
    {
      fragments: ["CI passed, ready to merge?", "merge now?", "CI is green on the latest commit", "notify who?"],
      language: "Japanese",
    },
  ]);
});

function registerQuestionWith(db: Db, purpose: string, titles: string[]) {
  return registerTask(
    db,
    {
      type: "question",
      title: "q",
      purpose,
      completion_criteria: "answered",
      question: titles.map((title) => ({ title, options: ["a", "b"], recommendation: "a" })),
    },
    NOW,
    ...HUMAN_WEBUI,
  );
}

it("キャッシュ済みの断片は呼び出しに載らず、未訳の断片だけが1回で撃たれる", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  await translateQuestion(db, client, registerQuestionWith(db, "shared purpose", ["first?"]).id, "Japanese", NOW);

  const outcome = await translateQuestion(db, client, registerQuestionWith(db, "shared purpose", ["first?", "second?"]).id, "Japanese", NOW);

  expect(client.calls.at(-1)).toEqual({ fragments: ["second?"], language: "Japanese" });
  expect(outcome).toMatchObject({ purpose: "[translated] shared purpose", cached: false });
});

it("断片が上限 20 を超える対象は上限ごとの呼び出しに分けて順に撃ち、呼び出しごとに使用量を1行残す(ADR 0296 決定4)", async () => {
  const db = await freshDb();
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  // 本文に既知の見出しが繰り返し現れれば、handoff は 6 節を超えて分かれる —— 6 + 19 = 25 節
  const extra = Array.from({ length: 19 }, (_, i) => `known issue ${i}\n\n## Known issues not worth a task`).join("\n\n");
  const completed = completeTask(
    db,
    task,
    { outcome: "o", deliverables: "d", decision_refs: "r", dead_ends: "e", resume_context: "c", known_issues: `${extra}\n\nlast issue` },
    "human",
    NOW,
    "worker",
  );
  const client = new FakeTranslationClient();

  const outcome = await translateHandoff(db, client, completed.id, "Japanese", NOW);

  expect(client.calls.map((call) => call.fragments.length)).toEqual([20, 5]);
  expect(listTranslationUsage(db).map((record) => record.fragments)).toEqual([20, 5]);
  expect(outcome).toMatchObject({ status: "translated", cached: false });
});

it("呼び出しが失敗した対象は、どの断片もキャッシュせず使用量の行も残さない(ADR 0296 決定4)", async () => {
  const db = await freshDb();
  const task = registerQuestionWith(db, "purpose", ["item?"]);
  const client = new FakeTranslationClient();
  client.scriptFailure(new Error("translation answer ids do not match the request"));

  await expect(translateQuestion(db, client, task.id, "Japanese", NOW)).rejects.toThrow("ids");
  expect(getCachedTranslation(db, hashSource("purpose"), "Japanese")).toBeUndefined();
  expect(listTranslationUsage(db)).toEqual([]);
});

it("work タスク(question ではない)の翻訳は TranslationTargetError を投げる", async () => {
  const db = await freshDb();
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    NOW,
    ...HUMAN_WEBUI,
  );
  const client = new FakeTranslationClient();

  await expect(translateQuestion(db, client, task.id, "Japanese", NOW)).rejects.toThrow(
    TranslationTargetError,
  );
});

it("記憶のエントリは title と text の両方を1回の呼び出しで翻訳する(ADR 0015 五度目の精密化)", async () => {
  const db = await freshDb();
  // setup のみ: agent 由来の出所 event_id: 1 を実在させる
  registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const { entry_id } = recordKnowledge(
    db,
    { scope: null, path: "build", title: "Use Node 22", text: "Run tests on Node 22.", source: { event_id: 1 }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    NOW,
  );

  const client = new FakeTranslationClient();

  expect(await translateMemoryEntry(db, client, entry_id, "Japanese", NOW)).toEqual({
    status: "translated",
    title: "[translated] Use Node 22",
    text: "[translated] Run tests on Node 22.",
    cached: false,
  });
  expect(client.calls).toEqual([{ fragments: ["Use Node 22", "Run tests on Node 22."], language: "Japanese" }]);
});
