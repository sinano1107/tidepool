import { afterEach, expect, it } from "vitest";
import { setDisplayLanguage } from "../src/display-language.js";
import { appendEvent } from "../src/events.js";
import { injectionQueryText } from "../src/memory.js";
import { logDecision, registerTask } from "../src/tasks.js";
import { reportProviderUsage } from "../src/throttle.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
import { FakeTranslationClient, healthyOpenai } from "./fakes.js";
import { api, bootTidepool, executionSetting, GIT_FIXTURE_TEST_TIMEOUT, HOUR, HUMAN_WEBUI, makeWorkspace, questions, queueWork, type Tidepool } from "./harness.js";

/** ADR 0175: 人間が登録した task の関連 leaf は、pickup 時に訳した英語の view で引く。盤面境界で見えるのは
 *  「誰の task を訳し、何を start に渡したか」まで —— 記録に刻むことは adapter の seam が言う。 */

let t: Tidepool;
afterEach(() => t?.stop());

it("表示言語 Japanese の盤面で人間が登録した task は、title / purpose / 完了基準を1つの文面として英語へ1回訳し、その view を start に渡す。worker に渡る task の文面は原語のまま", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptTranslation("Fix the tide chart drift");
  t = await bootTidepool({ translationClient });
  const task = queueWork(t, "潮汐グラフのずれを直す");

  await t.clock.advance(HOUR);

  expect(translationClient.calls).toEqual([{ source: injectionQueryText(task), language: "English" }]);
  expect(t.worker.startedQueries).toEqual([{ view: "Fix the tide chart drift" }]);
  expect(t.worker.started[0]).toMatchObject({ title: "潮汐グラフのずれを直す", purpose: task.purpose, completion_criteria: task.completion_criteria });
});

it("表示言語 Japanese の盤面で、異議の材料を持つ盤面名義の RCA review は英訳した view を start に渡す(ADR 0194 決定6)", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptTranslation("Find the root cause of the tide chart drift");
  t = await bootTidepool({ translationClient });
  const now = t.clock.now();
  // 異議された task は人間の担当にして slot に入れない —— slot に入るのは RCA review だけ
  const objected = registerTask(t.db, { type: "work", title: "潮汐グラフ", purpose: "p", completion_criteria: "c", assignee: "human" }, now, "deckhand", "worker");
  const entry = logDecision(t.db, objected, "補正を二重にかけた", "deckhand", now, "worker");
  const objection = appendEvent(t.db, { taskId: objected.id, workerId: HUMAN_WORKER_ID, origin: "webui", payload: { kind: "objection_raised", entry_id: entry, comment: "補正は一度だけ", session_id: 1 }, at: now });
  const review = registerTask(
    t.db,
    { type: "review", title: "rca (auditor): 潮汐グラフ", purpose: "異議: 補正は一度だけ", completion_criteria: "c", parent_id: objected.id, objection_event_ids: [objection] },
    now,
    BOARD_WORKER_ID,
    "board",
  );

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([review.id]);
  expect(translationClient.calls).toEqual([{ source: injectionQueryText(review), language: "English" }]);
  expect(t.worker.startedQueries).toEqual([{ view: "Find the root cause of the tide chart drift" }]);
});

it.each([
  ["decompose の子(agent が登録した task)", (t: Tidepool) => registerTask(t.db, { type: "work", title: "子", purpose: "p", completion_criteria: "c" }, t.clock.now(), "deckhand", "worker")],
  ["盤面が登録した task", (t: Tidepool) => registerTask(t.db, { type: "work", title: "盤面", purpose: "p", completion_criteria: "c" }, t.clock.now(), BOARD_WORKER_ID, "board")],
  [
    "表示言語 English の盤面で人間が登録した task",
    (t: Tidepool) => {
      setDisplayLanguage(t.db, "English");
      return queueWork(t, "人間");
    },
  ],
] as const)("%s は訳さず、start に query を渡さない", async (_, register) => {
  const translationClient = new FakeTranslationClient();
  t = await bootTidepool({ translationClient });
  const task = register(t);

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(translationClient.calls).toEqual([]);
  expect(t.worker.startedQueries).toEqual([undefined]);
});

it("翻訳 client の無い盤面は撃たなかったのと同じ理由 throttled を start に渡し、spawn は成立する", async () => {
  t = await bootTidepool();
  queueWork(t, "潮汐グラフのずれを直す");

  await t.clock.advance(HOUR);

  expect(t.worker.startedQueries).toEqual([{ reason: "throttled" }]);
});

it("Provider anthropic が使えない間は翻訳を撃たず、理由 throttled を start に渡し、spawn は成立する", async () => {
  const translationClient = new FakeTranslationClient();
  // anthropic が止まっていても、openai で走る task は pickup される
  const openai = executionSetting("openai", "gpt-5.6-sol");
  t = await bootTidepool({ translationClient, openaiUsage: healthyOpenai, taskExecutionCandidates: () => [openai] });
  const now = t.clock.now();
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: now,
    windows: [{ window: "session", model: null, usedPercent: 100, durationMs: 5 * HOUR, resetsAt: new Date(now.getTime() + 2 * HOUR), throttled: true, resumesAt: new Date(now.getTime() + 2 * HOUR) }],
  });
  const task = queueWork(t, "潮汐グラフのずれを直す");

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(translationClient.calls).toEqual([]);
  expect(t.worker.startedQueries).toEqual([{ reason: "throttled" }]);
});

it("翻訳が失敗(時間切れを含む)したら理由 failed とメッセージを start に渡し、spawn は成立し、盤面は止まらない", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptFailure(new Error("translation timed out after 30000ms"));
  t = await bootTidepool({ translationClient });
  const task = queueWork(t, "潮汐グラフのずれを直す");

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  expect(t.worker.startedQueries).toEqual([{ reason: "failed", message: "translation timed out after 30000ms" }]);
  expect(await questions(t)).toEqual([]);
});

it("同じ task の2回目の session は cache に当たって翻訳を撃たず、文面を編集した後の pickup は訳し直す", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptTranslation((source) => `EN ${source.length}`);
  t = await bootTidepool({ translationClient });
  const task = queueWork(t, "潮汐グラフのずれを直す");
  // spawn 失敗の question に retry で答えると、同じ task が次の pickup で新しい session になる
  const rerun = async (edit?: () => Promise<unknown>) => {
    t.worker.failSpawn(task.id, "ENOENT", "spawn claude ENOENT");
    await new Promise((resolve) => setImmediate(resolve));
    const question = (await questions(t)).find((q) => q.status === "todo");
    await edit?.();
    await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["retry"] });
    await t.clock.advance(HOUR);
  };

  await t.clock.advance(HOUR);
  await rerun();
  expect(translationClient.calls).toHaveLength(1);
  expect(t.worker.startedQueries[1]).toEqual(t.worker.startedQueries[0]);

  await rerun(() => api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { title: "潮汐グラフのずれを今度こそ直す" }));
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, task.id, task.id]);
  expect(translationClient.calls.map((c) => c.source)).toEqual([injectionQueryText(task), injectionQueryText(t.worker.started[2]!)]);
});

it("issue-backed の task は pickup で取った文面を訳す", { timeout: GIT_FIXTURE_TEST_TIMEOUT }, async () => {
  const translationClient = new FakeTranslationClient();
  t = await bootTidepool({ translationClient, workspace: await makeWorkspace("tidepool") });
  registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 49 }, t.clock.now(), ...HUMAN_WEBUI);
  t.github.scriptIssue(49, { title: "潮汐グラフのずれ", body: "タイムゾーンの補正が二重にかかる", comments: [] });

  await t.clock.advance(HOUR);

  expect(t.worker.started[0]!.title).toBe("潮汐グラフのずれ");
  expect(translationClient.calls).toEqual([{ source: injectionQueryText(t.worker.started[0]!), language: "English" }]);
});
