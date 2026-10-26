import * as fs from "node:fs";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { currentRoot, type Exercise, extract, firstMetaReview, loadExercise, loadSequence, type RunConfig, sequencePosition } from "../docs/experiments/benchmark/extract.js";
import { type BoardCallUse, recordBoardCall } from "../src/board-call-usage.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { registerLocalMergeQuestion } from "../src/landing.js";
import { createBehaviorCandidate, defineMemoryByMetaReview, invalidateMemoryByMetaReview, proposeMemoryChange, recordKnowledge } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { questionKindOf } from "../src/question-kind.js";
import { completeInterview, completeTask, getTask, listBoard, listChildren, logDecision, registerTask, retryInterviewRoot, settleQuestionAsObserved, type Task } from "../src/tasks.js";
import { commitTriage, raiseObjection } from "../src/triage.js";
import {
  answerQuestionViaWebui,
  auditorRcaOn,
  completedWork,
  decomposeTaskViaWorker,
  examineeRootId,
  FULL_HANDOFF,
  failureQuestion,
  HUMAN_WEBUI,
  interviewExaminee,
  judgedMemoryReview,
  judgedRoutingReview,
  judgmentRepairTask,
  openTestInterviewRoom,
  POSED_HEAD,
  poseAccepted,
  QUIET_EXIT,
  routedOpusSessions,
  routingJudgmentRepairTask,
  settleReview,
  settleReviews,
  WORKER_SPAWNED,
} from "./harness.js";

// 抽出が開いたファイルを数える —— 元の実装を包むだけで振る舞いは変えない
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const spied = { readFileSync: vi.fn(real.readFileSync), openSync: vi.fn(real.openSync), createReadStream: vi.fn(real.createReadStream) };
  return { ...real, ...spied, default: { ...real, ...spied } };
});

/** 使い捨ての dir(テストの終わりに消す)。 */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-extract-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 課題ディレクトリを1つ作り、宣言を書いてその path を返す。 */
function exerciseDir(declaration: unknown, name = "planted-defect"): string {
  const dir = join(scratch(), name);
  mkdirSync(dir);
  writeFileSync(join(dir, "exercise.json"), JSON.stringify(declaration));
  return dir;
}

const WORK_EXERCISE = {
  title: "Fix the planted slugify defect",
  readings: ["work", "routing"],
  test: "npm test",
  task: { title: "Fix slugify", purpose: "slugify collapses runs of hyphens", completion_criteria: "the tests pass", workspace: "slugify", tier: "standard", assignee: "deckhand" },
};

/** 表の行1つ(盤面の表の行の綴り)。 */
const ROW = { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 };

it("宣言の loader は課題ディレクトリの exercise.json を読み、名前はディレクトリ名", () => {
  const exercise = loadExercise(exerciseDir(WORK_EXERCISE));

  expect(exercise).toMatchObject({ name: "planted-defect", ...WORK_EXERCISE });
});

it("宣言の loader は必須欄の欠けと未知の読みの種別を、欄名を名指して拒否する", () => {
  const { title: _, ...untitled } = WORK_EXERCISE;
  expect(() => loadExercise(exerciseDir(untitled))).toThrow(/→ at title/);

  const { completion_criteria: __, ...criterialess } = WORK_EXERCISE.task;
  expect(() => loadExercise(exerciseDir({ ...WORK_EXERCISE, task: criterialess }))).toThrow(/→ at task\.completion_criteria/);

  expect(() => loadExercise(exerciseDir({ ...WORK_EXERCISE, readings: ["work", "vibes"] }))).toThrow(/→ at readings\[1\]/);

  // 登録する task も Interview の欄も無い宣言は、何を登録するかが無い
  const { task: ___, ...nothingToRegister } = WORK_EXERCISE;
  expect(() => loadExercise(exerciseDir(nothingToRegister))).toThrow(/→ at task\b/);

  // task の課題は期待解のテストを持つ —— 「対処できた」は課題が決める(ADR 0298 決定5)
  const { test: ____, ...untested } = WORK_EXERCISE;
  expect(() => loadExercise(exerciseDir(untested))).toThrow(/→ at test\b/);

  // 段と担当は登録する task の文面の一部(#2439)
  const { tier: _____, assignee: ______, ...unrouted } = WORK_EXERCISE.task;
  expect(() => loadExercise(exerciseDir({ ...WORK_EXERCISE, task: unrouted }))).toThrow(/→ at task\.tier[\s\S]*→ at task\.assignee/);
});

it("learner の読みを持つ課題は表の行を2つ以上宣言し、行は盤面の表の行の綴りで検査される", () => {
  const learner = { ...WORK_EXERCISE, readings: ["work", "learner"] };
  expect(() => loadExercise(exerciseDir(learner))).toThrow(/→ at table_rows/);
  expect(() => loadExercise(exerciseDir({ ...learner, table_rows: [ROW] }))).toThrow(/→ at table_rows/);
  const { price_in: _, ...unpriced } = ROW;
  expect(() => loadExercise(exerciseDir({ ...WORK_EXERCISE, table_rows: [unpriced] }))).toThrow(/→ at table_rows\[0\]\.price_in/);

  const two = [ROW, { ...ROW, model: "claude-sonnet-5-5" }];
  expect(loadExercise(exerciseDir({ ...learner, table_rows: two }))).toMatchObject({ table_rows: two });
});

it("Interview の課題は人間が出せる登録欄を持ち、期待解のテストは無くてよい", () => {
  const interview = {
    title: "Interview the parser tier",
    readings: ["interview"],
    interview: {
      hypothesis: "sonnet writes the parser as well as opus",
      tier: "standard",
      targets: [{ provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" }],
    },
  };

  expect(loadExercise(exerciseDir(interview))).toMatchObject(interview);
  expect(() =>
    loadExercise(exerciseDir({ ...interview, interview: { ...interview.interview, targets: [{ provider: "anthropic" }] } })),
  ).toThrow(/→ at interview\.targets\[0\]\.model/);
});

/** 走行の宣言 run.json と、その隣の exercises/ に課題を置き、run.json の path を返す。 */
function sequenceFile(sequence: unknown, exercises: Record<string, unknown> = { slugify: WORK_EXERCISE }): string {
  const dir = scratch();
  for (const [name, declaration] of Object.entries(exercises)) {
    mkdirSync(join(dir, "exercises", name), { recursive: true });
    writeFileSync(join(dir, "exercises", name, "exercise.json"), JSON.stringify(declaration));
  }
  writeFileSync(join(dir, "run.json"), JSON.stringify(sequence));
  return join(dir, "run.json");
}

it("走行の宣言の loader は列を宣言の順に読み、課題は隣の exercises/ の宣言で、人間の段はそのまま返す", () => {
  const file = sequenceFile({
    period_days: 1,
    items: [
      { human: "step", instructions: "Object to the meta-review's write row" },
      { exercise: "slugify" },
      { human: "first_meta_review", subject: "memory" },
    ],
  });

  expect(loadSequence(file)).toMatchObject({
    period_days: 1,
    items: [
      { human: "step", instructions: "Object to the meta-review's write row" },
      { exercise: { name: "slugify", ...WORK_EXERCISE } },
      { human: "first_meta_review", subject: "memory" },
    ],
  });
});

it("走行の宣言の loader は欠けた欄・未知の値・未知の課題を名指して拒否する", () => {
  expect(() => loadSequence(sequenceFile({ items: [{ exercise: "slugify" }, { human: "first_meta_review", subject: "vibes" }] }))).toThrow(/→ at items\[1\]\.subject/);
  expect(() => loadSequence(sequenceFile({ items: [{ human: "step" }] }))).toThrow(/→ at items\[0\]\.instructions/);
  expect(() => loadSequence(sequenceFile({ items: [{ human: "interview" }] }))).toThrow(/→ at items\[0\]\.human/);
  expect(() => loadSequence(sequenceFile({ items: [] }))).toThrow(/→ at items/);
  expect(() => loadSequence(sequenceFile({ period_days: 0.5, items: [{ exercise: "slugify" }] }))).toThrow(/→ at period_days/);
  // 列の課題の宣言も同じ loader で検査され、どの課題のどの欄かが出る
  expect(() => loadSequence(sequenceFile({ items: [{ exercise: "slugify" }] }, { slugify: { ...WORK_EXERCISE, readings: ["vibes"] } }))).toThrow(
    /slugify[\\/]exercise\.json[\s\S]*→ at readings\[0\]/,
  );
  expect(() => loadSequence(sequenceFile({ items: [{ exercise: "missing" }] }))).toThrow(/missing/);
});

const AT = new Date("2026-10-22T00:00:00.000Z");
/** 走行の構成(4つの軸)。 */
const CONFIG: RunConfig = { tidepool_commit: "abc123", cli_pins: { claude: "2.1.289", codex: "0.147.0" }, table_rows: [ROW], registry_commit: "def456" };

/** 宣言の形だけを持つ課題(loader を通さない —— 抽出の入力は読み込み済みの宣言)。 */
const exercise = (name: string, over: Partial<Exercise> = {}): Exercise => ({ name, ...WORK_EXERCISE, readings: ["work"], ...over }) as Exercise;
/** Interview の宣言を持つ課題(task は持たない)。 */
const interviewExercise = (name: string): Exercise =>
  ({
    name,
    title: "Interview the parser tier",
    readings: ["interview"],
    interview: { hypothesis: "h", tier: "standard", targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] },
  }) as Exercise;

/** fixture の transcript を、盤面の TranscriptStore と同じ名前(`<task>.<worker_spawned の id>.stream.jsonl`)で worker-logs に置く。 */
function placeTranscript(logs: string, fixture: string, taskId: string, spawnedId: number): void {
  copyFileSync(join(import.meta.dirname, "fixtures", fixture), join(logs, `${taskId}.${spawnedId}.stream.jsonl`));
}

/** 盤面が刻む worker session 1本(worker_spawned と worker_exited)。費用は盤面が result 行の total_cost_usd を写した値で、Codex は null。 */
function session(db: Db, taskId: string, agent: string, harness: "claude-code" | "codex", cost: number | null): number {
  const at = new Date("2026-10-09T00:00:00.000Z");
  const spawned = appendEvent(db, { taskId, actorId: agent, origin: "board", at, payload: { ...WORKER_SPAWNED, harness } });
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: cost, advisor: null, model_swaps: [], refusals: [], models: {} };
  appendEvent(db, { taskId, actorId: agent, origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage } });
  return spawned;
}

const workTask = (db: Db, title: string) => registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c" }, AT, ...HUMAN_WEBUI).id;

/** #386 の Claude の session(2.1.237)と run A(#1231)の Codex の session(0.147.0)を、それぞれ別の task に置いた盤面。 */
function claudeAndCodexBoard(): { db: Db; logs: string; claudeTask: string; codexTask: string } {
  const db = openDb(":memory:");
  const [claudeTask, codexTask] = [workTask(db, "claude"), workTask(db, "codex")] as [string, string];
  // fixture の result 行の total_cost_usd
  const claudeSpawned = session(db, claudeTask, "tako", "claude-code", 0.7102510000000001);
  const codexSpawned = session(db, codexTask, "codex-agent", "codex", null);
  const logs = scratch();
  placeTranscript(logs, "worker-session-2.1.237.stream.jsonl", claudeTask, claudeSpawned);
  placeTranscript(logs, "worker-session-codex-0.147.0.stream.jsonl", codexTask, codexSpawned);
  return { db, logs, claudeTask, codexTask };
}

it("fixture の stream.jsonl(Claude と Codex)から agent ごとの盤面の verb 呼び出し列が出て、費用は Harness 併記で worker_exited の値", () => {
  const { db, logs, claudeTask, codexTask } = claudeAndCodexBoard();

  const { record } = extract(
    db,
    logs,
    [
      { exercise: exercise("claude"), task_id: claudeTask, test_exit: 0 },
      { exercise: exercise("codex"), task_id: codexTask, test_exit: 1 },
    ],
    CONFIG,
    [],
  );

  const [claude, codex] = record.exercises;
  // 盤面の verb だけ —— Write / Agent / Bash は verb ではない
  expect(claude!.sessions).toEqual([
    {
      task_id: claudeTask,
      agent: "tako",
      harness: "claude-code",
      cost_usd: 0.7102510000000001,
      verbs: ["get_current_task", "log_decision", "log_decision", "log_decision", "complete_task"],
    },
  ]);
  expect(claude).toMatchObject({ cost_usd_by_harness: { "claude-code": 0.7102510000000001 }, unpriced_sessions_by_harness: {} });
  // Codex の費用は観測されない(ADR 0297)—— 0 ではなく null
  expect(codex!.sessions).toEqual([
    {
      task_id: codexTask,
      agent: "codex-agent",
      harness: "codex",
      cost_usd: null,
      verbs: ["get_current_task", "read_memory", "log_decision", "read_memory", "search_memory", "complete_task"],
    },
  ]);
  // 費用の無い session は和に入れず数える —— 部分和を全額と読まない
  expect(codex).toMatchObject({ cost_usd_by_harness: {}, unpriced_sessions_by_harness: { codex: 1 } });
});

it("transcript が無い session は verb 列が null で、行は落とさない", () => {
  const { db, claudeTask } = claudeAndCodexBoard();

  const { record } = extract(db, scratch(), [{ exercise: exercise("claude"), task_id: claudeTask, test_exit: 0 }], CONFIG, []);

  expect(record.exercises[0]!.sessions).toMatchObject([{ agent: "tako", verbs: null }]);
});

const note = (db: Db, title: string) =>
  recordKnowledge(db, { scope: null, path: "build", title, text: `${title}.`, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", AT).entry_id;

it("harness の helper で組んだ盤面(task・判断ログ・meta-review の完了・shadow 行・Interview)から、課題の列と走行の節が出る", () => {
  const db = openDb(":memory:");
  // work の課題: 判断ログを書いて完了し、統合レビューが指摘なしで閉じ、ローカルに着地した。question が1つ立った
  const work = completedWork(db, AT, "deckhand");
  logDecision(db, work, "kept the parser pure", "deckhand", AT, "worker");
  settleReviews(db, AT);
  // 子の review の nothing_to_repair より後の判断を root の側に置く —— 木を辿る順(root が先)では古い方が最後に来るので、最後は event id で決まる
  const repaired = { kind: "integration_review" as const, deliverable: work.id, value: "repaired" as const, findings: "f", repairs: [] };
  appendEvent(db, { taskId: work.id, actorId: "fugu", origin: "worker", at: AT, payload: { kind: "decision_logged", line: "repaired", judgment: repaired } });
  appendEvent(db, { taskId: work.id, actorId: "human", origin: "webui", at: AT, payload: { kind: "local_merge_executed", sha: "c0ffee" } });
  failureQuestion(db, work.id, AT);
  // memory meta-review: 店の1件を引退させ、1件の候補を提案し、残りを据え置く
  let kept = 0;
  let retired = 0;
  let candidate = 0;
  let staleCandidate = 0;
  let stale = "";
  const memory = judgedMemoryReview(
    db,
    AT,
    () => {
      kept = note(db, "Keep fixtures");
      retired = note(db, "Stale advice");
      const behavior = (title: string) =>
        createBehaviorCandidate(
          db,
          { scope: null, path: "habits", title, text: `${title}.`, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
          "worker",
          AT,
        ).entry_id;
      candidate = behavior("Split migrations");
      staleCandidate = behavior("Pin the lockfile");
    },
    (review) => {
      invalidateMemoryByMetaReview(db, { entry_id: retired, reason: "environment" }, "fugu", "worker", AT, review.id);
      proposeMemoryChange(db, review.id, { op: "approve", candidate_id: candidate, rationale: "it keeps migrations reviewable" }, "fugu", AT);
      const { question_id } = proposeMemoryChange(db, review.id, { op: "approve", candidate_id: staleCandidate, rationale: "r" }, "fugu", AT);
      stale = question_id;
      defineMemoryByMetaReview(db, { scope: null, path: "build", text: "Build notes.", author: { activity: "meta_review", name: "fugu" } }, "worker", AT, review.id);
    },
  );
  // routing meta-review: 窓に shadow 行1つと opus の session 2つ
  // 2つ目の提案は人間が答える前に観測で閉じた(陳腐化)
  settleQuestionAsObserved(db, stale, { kind: "memory_proposal_stale", question_id: stale, entry_id: staleCandidate, observed_event_id: 1 }, AT);
  const routing = judgedRoutingReview(db, AT, () => routedOpusSessions(db, AT));
  // Interview: 受験者1人が完了し、root が採点した
  const examinee = interviewExaminee(db, AT);
  const root = getTask(db, examineeRootId(db, examinee.id))!;
  openTestInterviewRoom(db, root);
  completeTask(db, getTask(db, examinee.id)!, FULL_HANDOFF, "tako", AT, "worker");
  completeInterview(db, getTask(db, root.id)!, { scores: [{ child_id: examinee.id, verdict: "accepted" }], handoff: { outcome: "the target wrote it" } }, "auditor", AT, "worker");

  const { record } = extract(
    db,
    scratch(),
    [
      { exercise: exercise("work"), task_id: work.id, test_exit: 0 },
      { exercise: interviewExercise("interview"), task_id: root.id, test_exit: null },
    ],
    CONFIG,
    [],
  );

  expect(record.config).toEqual(CONFIG);
  expect(record.exercises[0]).toMatchObject({
    name: "work",
    handled: true,
    settlement: { status: "done", review_verdict: "repaired", landing: "local_merge_executed" },
    questions: ["failure"],
  });
  expect(record.exercises[1]).toMatchObject({ name: "interview", handled: null, settlement: { status: "done", review_verdict: null, landing: null } });

  // meta-review の判断の行すべて(memory と routing)
  const rows = record.decision_rows;
  expect(rows.filter((r) => r.review_id === memory.review.id).map((r) => r.judgment)).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "memory", entry: kept, value: "left_as_is" })]),
  );
  expect(rows.find((r) => r.event_id === routing.row({ learner: true }))).toMatchObject({ subject: "routing", agent: "auditor" });
  // 提案 question: 提案(op・pin)・根拠(rationale と detail)と人間の回答。陳腐化で閉じたものは未回答と分けて印が付く
  expect(record.proposals).toEqual([
    {
      question_id: expect.any(String),
      review_id: memory.review.id,
      proposal: expect.objectContaining({ kind: "memory", op: "approve", candidate_id: candidate }),
      rationale: expect.stringContaining("it keeps migrations reviewable"),
      detail: expect.any(String),
      answer: null,
      settled_by_observation: null,
    },
    expect.objectContaining({ question_id: stale, answer: null, settled_by_observation: "memory_proposal_stale" }),
  ]);
  // learner の shadow 行
  expect(record.shadow).toEqual([
    expect.objectContaining({ recommended: expect.objectContaining({ model: "claude-sonnet-5-5" }), actual: expect.objectContaining({ model: "claude-opus-5-5" }), diverged: true }),
  ]);
  // meta-review が店を直接書き換えた記録
  expect(record.memory_writes).toEqual([
    expect.objectContaining({ kind: "memory_entry_invalidated", entry_id: retired, activity: "meta_review" }),
    expect.objectContaining({ kind: "memory_entry_created", entry: expect.objectContaining({ text: "Build notes." }), event_id: expect.any(Number) }),
  ]);
  // Interview の root の面接室・rubric・採点
  expect(record.interviews).toEqual([
    { root_id: root.id, room: expect.stringContaining("tidepool-rooms-"), rubric: "tests pass", scores: [{ examinee_id: examinee.id, verdict: "accepted" }] },
  ]);
});

it("同じディレクトリに .stderr.log を置いても抽出はそれを開かず、中身は記録に出ない", () => {
  const { db, logs, claudeTask, codexTask } = claudeAndCodexBoard();
  const secret = "SECRET-MARKER-7f3a9c";
  for (const name of fs.readdirSync(logs)) writeFileSync(join(logs, name.replace(".stream.jsonl", ".stderr.log")), `token=${secret}\n`);
  vi.mocked(fs.readFileSync).mockClear();
  vi.mocked(fs.openSync).mockClear();
  vi.mocked(fs.createReadStream).mockClear();

  const { record, markdown } = extract(
    db,
    logs,
    [
      { exercise: exercise("claude"), task_id: claudeTask, test_exit: 0 },
      { exercise: exercise("codex"), task_id: codexTask, test_exit: 0 },
    ],
    CONFIG,
    [],
  );

  const opened = [fs.readFileSync, fs.openSync, fs.createReadStream].flatMap((f) => vi.mocked(f).mock.calls.map(([path]) => String(path)));
  // transcript は開いている(spy が効いている)が、stderr は1本も開いていない
  expect(opened.filter((path) => path.endsWith(".stream.jsonl"))).toHaveLength(2);
  expect(opened.filter((path) => path.endsWith(".stderr.log"))).toEqual([]);
  expect(JSON.stringify(record) + markdown).not.toContain(secret);
});

it("所要時間は登録から木の最後の event までで、pickup 待ち・人間待ち(重なりは1度、観測で閉じた question は閉じた時刻まで)・盤面の時間に分かれ、人間が見ただけの event は伸ばさない", () => {
  const db = openDb(":memory:");
  const minute = (n: number) => new Date(AT.getTime() + n * 60_000);
  const work = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c", assignee: "deckhand" }, minute(0), ...HUMAN_WEBUI);
  // 0〜5 分は pickup 待ち
  appendEvent(db, { taskId: work.id, actorId: "deckhand", origin: "board", at: minute(5), payload: WORKER_SPAWNED });
  const ask = (at: Date) =>
    registerTask(
      db,
      { type: "question", title: "steer", purpose: "p", completion_criteria: "answered", parent_id: work.id, question: [{ title: "which way", options: ["left", "right"], recommendation: "left" }] },
      at,
      "deckhand",
      "worker",
    );
  // 10〜40 分と 30〜50 分の待ち —— 重なりの 30〜40 分は2度数えない
  const first = ask(minute(10));
  const second = ask(minute(30));
  answerQuestionViaWebui(db, first, ["left"], minute(40));
  answerQuestionViaWebui(db, second, ["right"], minute(50));
  // 52〜55 分: 回答なしに観測で閉じた question —— 待ちは閉じた時刻で終わる
  settleQuestionAsObserved(db, ask(minute(52)).id, { kind: "pr_promotion_observed" }, minute(55));
  completeTask(db, getTask(db, work.id)!, FULL_HANDOFF, "deckhand", minute(60), "worker");
  // land question は task の子ではない(盤面の root の question)—— 70〜90 分の待ちも課題の人間待ち
  registerLocalMergeQuestion(db, getTask(db, work.id)!, "land it", minute(70));
  const land = listBoard(db).find((t) => t.type === "question" && questionKindOf(t).kind === "local_merge")!;
  answerQuestionViaWebui(db, getTask(db, land.id)!, ["hold"], minute(90));
  // 120 分に人間が判断ログを見た —— 仕事の時間ではない
  appendEvent(db, { taskId: work.id, actorId: "human", origin: "webui", at: minute(120), payload: { kind: "log_entry_displayed", entry_id: 1 } });

  const { record, markdown } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: work.id, test_exit: 0 }], CONFIG, []);

  expect(record.exercises[0]!.duration_ms).toEqual({ wall: 90 * 60_000, queue: 5 * 60_000, human_wait: 63 * 60_000, board: 22 * 60_000 });
  expect(record.exercises[0]!.questions).toEqual(["escalation", "escalation", "escalation", "local_merge"]);
  // 終わらなかった session は費用が無い —— 和に入らず数で出る
  expect(markdown).toContain("| work | work | yes | done | — | — | claude-code 1 unpriced | 90m | 5m | 63m | 22m | 4 |");
});

it("Interview の root を人間が retry しても、harness が登録で受け取った id は今の root に辿られる(2度の retry も)", () => {
  const db = openDb(":memory:");
  const first = getTask(db, examineeRootId(db, interviewExaminee(db, AT).id))!;
  const second = retryInterviewRoot(db, first, undefined, AT, {}, "webui");
  poseAccepted(db, second, { title: "add a parser", probe: "write a parser", completion_criteria: "the parser works", rubric: "tests pass" }, "auditor", AT, "worker", POSED_HEAD);
  const third = retryInterviewRoot(db, getTask(db, second.id)!, undefined, AT, {}, "webui");

  expect([first.id, second.id, third.id].map((id) => currentRoot(db, id))).toEqual([third.id, third.id, third.id]);
  // retry されていない root はそのまま
  const plain = workTask(db, "plain");
  expect(currentRoot(db, plain)).toBe(plain);
});

it("人間の段の初回の meta-review は、人間が扉で起こした主題の root と、root とその配下がすべて決着したかで読む", () => {
  const db = openDb(":memory:");
  expect(firstMetaReview(db, "routing")).toEqual({ root: null, settled: false });
  // 盤面が起こした回と別の主題の回は、その主題の人間の段の root ではない
  registerMetaReview(db, "routing", AT);
  registerMetaReview(db, "memory", AT, "webui");
  expect(firstMetaReview(db, "routing")).toEqual({ root: null, settled: false });

  const review = registerMetaReview(db, "routing", AT, "webui");
  expect(firstMetaReview(db, "routing")).toEqual({ root: review.id, settled: false });
  settleReview(db, getTask(db, review.id)!, "auditor", AT);
  // root が閉じても、配下の提案 question が開いている間は決着していない
  const proposal = registerTask(
    db,
    { type: "question", title: "adopt", purpose: "p", completion_criteria: "answered", parent_id: review.id, question: [{ title: "adopt it", options: ["yes", "no"], recommendation: "yes" }] },
    AT,
    "auditor",
    "worker",
  );
  expect(firstMetaReview(db, "routing")).toEqual({ root: review.id, settled: false });
  answerQuestionViaWebui(db, proposal, ["yes"], AT);
  expect(firstMetaReview(db, "routing")).toEqual({ root: review.id, settled: true });
});

it("再開の位置は盤面の記録から導く: 課題は登録順に題で root を対応づけて retry の後の今の root を、人間の段は記録した結果と起こされた初回の root を返す", () => {
  const db = openDb(":memory:");
  // 1つ目の課題(Interview): 登録され、人間が root を retry した
  const first = getTask(db, examineeRootId(db, interviewExaminee(db, AT).id))!;
  const retried = retryInterviewRoot(db, first, undefined, AT, {}, "webui");
  // 盤面が起こした meta-review・人間が手で登録した別の題の root は、どの課題にも対応しない
  registerMetaReview(db, "routing", AT);
  workTask(db, "registered by hand");
  // 人間の段の初回の memory meta-review は起こされたが、記録には書かれる前(決着を待つ間に止まった)
  const review = registerMetaReview(db, "memory", AT, "webui");
  // 同じ課題を2度宣言し、登録されたのは1度目だけ
  const work = workTask(db, WORK_EXERCISE.task.title);
  const steps = [{ item: 1, human: "step" as const, outcome: "human_skip" as const, prompted_at: "2026-10-22T00:00:00Z", finished_at: "2026-10-22T00:01:00Z", waited_on: null }];

  const position = sequencePosition(
    db,
    [
      { exercise: { ...interviewExercise("interview"), title: "interview" } },
      { human: "step", instructions: "object to the write row" },
      { human: "first_meta_review", subject: "memory" },
      { exercise: exercise("work") },
      { human: "step", instructions: "not reached" },
      { exercise: exercise("work") },
    ],
    steps,
  );

  expect(position).toEqual([
    { root: retried.id, outcome: null },
    { root: null, outcome: "human_skip" },
    { root: review.id, outcome: null },
    { root: work, outcome: null },
    { root: null, outcome: null },
    { root: null, outcome: null },
  ]);
});

it("記録の走行の節は人間の段を、いつ促し何を待ったかと結果(済み・人間の skip・扉が閉じていた)で持ち、要約に1行ずつ出す", () => {
  const db = openDb(":memory:");
  const work = workTask(db, "the exercise");
  const steps = [
    { item: 0, human: "first_meta_review" as const, subject: "routing" as const, outcome: "door_closed" as const, prompted_at: "2026-10-22T00:00:00Z", finished_at: "2026-10-22T00:00:00Z", waited_on: null },
    { item: 2, human: "first_meta_review" as const, subject: "memory" as const, outcome: "done" as const, prompted_at: "2026-10-22T01:00:00Z", finished_at: "2026-10-22T02:00:00Z", waited_on: "t-review" },
    { item: 3, human: "step" as const, outcome: "human_skip" as const, prompted_at: "2026-10-22T03:00:00Z", finished_at: "2026-10-22T03:05:00Z", waited_on: null },
  ];

  const { record, markdown } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: work, test_exit: 0 }], CONFIG, steps);

  expect(record.human_steps).toEqual(steps);
  expect(markdown).toContain(
    [
      "- human step 0 (first_meta_review routing): door_closed, prompted 2026-10-22T00:00:00Z, finished 2026-10-22T00:00:00Z, waited on —",
      "- human step 2 (first_meta_review memory): done, prompted 2026-10-22T01:00:00Z, finished 2026-10-22T02:00:00Z, waited on t-review",
      "- human step 3 (step): human_skip, prompted 2026-10-22T03:00:00Z, finished 2026-10-22T03:05:00Z, waited on —",
    ].join("\n"),
  );
});

/** 子のうち題が prefix で始まるもの(異議の束ねが立てる修理子・RCA の題)。 */
const childTitled = (db: Db, parentId: string, prefix: string) => listChildren(db, parentId).find((child) => child.title.startsWith(prefix))!;

it("仕事の課題の行は種類 work を持ち、費用から RCA と記憶の修理子の session が外れ、work の修理子の session は残る", () => {
  const db = openDb(":memory:");
  const work = completedWork(db, AT, "deckhand");
  session(db, work.id, "deckhand", "claude-code", 1);
  // 判断の行への異議(capability)で work の修理子と RCA(self・auditor)が立つ
  auditorRcaOn(db, getTask(db, work.id)!, AT, "deckhand");
  // 記憶の書き込みの行への異議で memory_repair が立つ
  const written = recordKnowledge(db, { scope: null, path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", AT, work.id);
  raiseObjection(db, written.event_id, "undo it", AT);
  commitTriage(db, AT);
  session(db, childTitled(db, work.id, "repair:").id, "deckhand", "claude-code", 2);
  session(db, childTitled(db, work.id, "rca (self)").id, "deckhand", "claude-code", 4);
  session(db, childTitled(db, work.id, "rca (auditor)").id, "fugu", "claude-code", 8);
  session(db, childTitled(db, work.id, "memory repair:").id, "deckhand", "codex", null);

  const { record } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: work.id, test_exit: 0 }], CONFIG, []);

  expect(record.exercises[0]).toMatchObject({ kind: "work", cost_usd_by_harness: { "claude-code": 3 } });
  expect(record.exercises[0]!.unpriced_sessions_by_harness).toEqual({});
});

it("課題の行は記録から導く agent の動きの列を持つ: 分けた子の数・分解判断の行の数・異議の数・type 別の修理子の数・retry の数", () => {
  const db = openDb(":memory:");
  const root = getTask(db, workTask(db, "the exercise"))!;
  // 分解判断2つ: root を2つに、その1つ目をさらに1つに
  const [first] = decomposeTaskViaWorker(db, root, { reason: "two deliverables", children: [{ title: "a", purpose: "p", completion_criteria: "c" }, { title: "b", purpose: "p", completion_criteria: "c" }] }, "deckhand", AT) as [Task];
  decomposeTaskViaWorker(db, first, { reason: "one more", children: [{ title: "a1", purpose: "p", completion_criteria: "c" }] }, "deckhand", AT);
  // 判断の行への異議(work の修理子と RCA)と、記憶の書き込みの行への異議(memory_repair)
  auditorRcaOn(db, getTask(db, root.id)!, AT, "deckhand");
  const written = recordKnowledge(db, { scope: null, path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", AT, root.id);
  raiseObjection(db, written.event_id, "undo it", AT);
  commitTriage(db, AT);
  // failure question: 1つは retry、1つは abandon
  answerQuestionViaWebui(db, failureQuestion(db, first.id, AT), ["retry"], AT);
  answerQuestionViaWebui(db, failureQuestion(db, root.id, AT), ["abandon"], AT);

  const { record, markdown } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: root.id, test_exit: 0 }], CONFIG, []);

  expect(record.exercises[0]).toMatchObject({ children: 3, depth: 2, objections: 2, repairs_by_type: { work: 1, memory_repair: 1 }, retries: 1 });
  expect(markdown).toContain("| questions | children | depth | objections | repairs | retries |");
  expect(markdown).toMatch(/\| 3 \| 2 \| 2 \| work 1, memory_repair 1 \| 1 \|\n/);
});

it("権限外の子の承認 question は子に数えず、承認で実体化した子だけを数える(却下した子の分解判断は数えない)", () => {
  const db = openDb(":memory:");
  const root = getTask(db, workTask(db, "the exercise"))!;
  const authority = { name: "standard", guidance: "", assignable_to: ["deckhand"] };
  const outside = (title: string) => ({ title, purpose: "p", completion_criteria: "c", assignee: "fugu" });
  const question = (parent: Task) => listChildren(db, parent.id).find((t) => t.type === "question")!;
  // 分解判断1つ目: 権限内の子1つと、承認する権限外の子1つ
  const [inside] = decomposeTaskViaWorker(db, root, { reason: "one in, one approved", children: [{ title: "in", purpose: "p", completion_criteria: "c" }, outside("approved")] }, "deckhand", AT, { authority }) as [Task];
  answerQuestionViaWebui(db, question(root), ["approve"], AT);
  // 分解判断2つ目: 却下する権限外の子だけ
  decomposeTaskViaWorker(db, inside, { reason: "rejected", children: [outside("rejected")] }, "deckhand", AT, { authority });
  answerQuestionViaWebui(db, question(inside), ["reject"], AT, { comment: "not needed" });

  const { record } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: root.id, test_exit: 0 }], CONFIG, []);

  expect(record.exercises[0]).toMatchObject({ children: 2, depth: 1 });
});

it("リポジトリの run.json は新しい宣言の形で読め、slugify の課題を持つ", () => {
  const sequence = loadSequence(join(import.meta.dirname, "../docs/experiments/benchmark/run.json"));
  expect(sequence.items.map((item) => ("exercise" in item ? item.exercise.name : item.human))).toContain("slugify");
});

it("最適化の課題(Interview)の行は種類 optimisation と、root・受験者・出題の監査の費用を持ち、root への異議から立った RCA は持たない", () => {
  const db = openDb(":memory:");
  const examinee = interviewExaminee(db, AT);
  const root = getTask(db, examineeRootId(db, examinee.id))!;
  const audit = listChildren(db, root.id).find((child) => child.type === "review")!;
  session(db, root.id, "auditor", "claude-code", 1);
  session(db, audit.id, "fugu", "claude-code", 2);
  session(db, examinee.id, "tako", "codex", null);
  auditorRcaOn(db, root, AT);
  session(db, childTitled(db, root.id, "rca (auditor)").id, "fugu", "claude-code", 8);

  const { record } = extract(db, scratch(), [{ exercise: interviewExercise("interview"), task_id: root.id, test_exit: null }], CONFIG, []);

  expect(record.exercises[0]).toMatchObject({ kind: "optimisation", cost_usd_by_harness: { "claude-code": 3 }, unpriced_sessions_by_harness: { codex: 1 } });
  expect(record.spend.learning.sessions.rca).toEqual({ cost_usd: { "claude-code": 8 }, unpriced: {} });
  // 課題の行から外した session も agent ごとに記録に残る
  expect(record.spend.learning.worker_sessions).toEqual([expect.objectContaining({ group: "rca", agent: "fugu", harness: "claude-code", cost_usd: 8 })]);
});

it("人間の retry で置き換わった前の Interview の root の木の session は、その課題の行に入り未分類に落ちない", () => {
  const db = openDb(":memory:");
  const firstExaminee = interviewExaminee(db, AT);
  const first = getTask(db, examineeRootId(db, firstExaminee.id))!;
  session(db, first.id, "auditor", "claude-code", 1);
  session(db, firstExaminee.id, "tako", "claude-code", 2);
  const second = retryInterviewRoot(db, first, undefined, AT, {}, "webui");
  session(db, second.id, "auditor", "claude-code", 4);
  poseAccepted(db, second, { title: "add a parser", probe: "write a parser", completion_criteria: "the parser works", rubric: "tests pass" }, "auditor", AT, "worker", POSED_HEAD);
  const third = retryInterviewRoot(db, getTask(db, second.id)!, undefined, AT, {}, "webui");
  session(db, third.id, "auditor", "claude-code", 8);

  const { record } = extract(db, scratch(), [{ exercise: interviewExercise("interview"), task_id: third.id, test_exit: null }], CONFIG, []);

  expect(record.exercises[0]!.cost_usd_by_harness).toEqual({ "claude-code": 15 });
  expect(record.spend.unclassified).toEqual([]);
  // 人間の retry 2度は課題の行の retry の数
  expect(record.exercises[0]!.retries).toBe(2);
});

it("どの課題の木にもどの節にも入らない worker session は未分類に並ぶ", () => {
  const db = openDb(":memory:");
  const work = workTask(db, "the exercise");
  session(db, work, "deckhand", "claude-code", 1);
  const stray = workTask(db, "registered by hand during the run");
  session(db, stray, "deckhand", "codex", null);

  const { record } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: work, test_exit: 0 }], CONFIG, []);

  expect(record.spend.unclassified).toEqual([{ task_id: stray, agent: "deckhand", harness: "codex", cost_usd: null, verbs: null }]);
});

/** 盤面の記録の module で Board call の行を1つ書く(費用 null は測れない)。 */
const boardCall = (db: Db, use: BoardCallUse, provider: "anthropic" | "openai" | "moonshot", cost: number | null) =>
  recordBoardCall(db, use, { provider, model: "m", effort: "low" }, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: cost }, AT, use === "translation" ? 1 : null);

it("走行の3つの節が Board call の行を用途・Provider ごとに、記録から学ぶ session を主題・type ごとに Harness で出し、費用の無いものは別に数える", () => {
  const db = openDb(":memory:");
  boardCall(db, "allocation_review", "anthropic", 0.5);
  boardCall(db, "attribution", "anthropic", 0.25);
  boardCall(db, "attribution", "anthropic", 0.25);
  boardCall(db, "behavior_draft", "openai", null);
  boardCall(db, "task_draft", "anthropic", 0.125);
  boardCall(db, "child_draft", "openai", null);
  boardCall(db, "translation", "anthropic", 0.0625);
  boardCall(db, "cli_auth_probe", "moonshot", 0.5);
  boardCall(db, "model_probe", "anthropic", null);
  // 仕事の課題の木に立った RCA と、meta-review とその修理子(課題の木の外)
  const work = completedWork(db, AT, "deckhand");
  auditorRcaOn(db, getTask(db, work.id)!, AT, "deckhand");
  session(db, childTitled(db, work.id, "rca (self)").id, "deckhand", "claude-code", 8);
  session(db, childTitled(db, work.id, "rca (auditor)").id, "fugu", "claude-code", 16);
  const memoryRepair = judgmentRepairTask(db, AT);
  session(db, memoryRepair.parent_id!, "fugu", "claude-code", 1);
  session(db, memoryRepair.id, "fugu", "claude-code", 2);
  const routingRepair = routingJudgmentRepairTask(db, AT);
  session(db, routingRepair.parent_id!, "auditor", "codex", null);
  session(db, routingRepair.id, "auditor", "claude-code", 4);

  const { record } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: work.id, test_exit: 0 }], CONFIG, []);

  const { learning, human_surface, observation } = record.spend;
  expect(learning).toEqual({
    board_calls: {
      allocation_review: { cost_usd: { anthropic: 0.5 }, unpriced: {} },
      attribution: { cost_usd: { anthropic: 0.5 }, unpriced: {} },
      behavior_draft: { cost_usd: {}, unpriced: { openai: 1 } },
    },
    sessions: {
      rca: { cost_usd: { "claude-code": 24 }, unpriced: {} },
      // helper の材料の注入が置く session(終わっていない)は費用が無い
      "meta_review:memory": { cost_usd: { "claude-code": 1 }, unpriced: { "claude-code": 1 } },
      memory_repair: { cost_usd: { "claude-code": 2 }, unpriced: {} },
      "meta_review:routing": { cost_usd: {}, unpriced: { "claude-code": 1, codex: 1 } },
      routing_repair: { cost_usd: { "claude-code": 4 }, unpriced: {} },
    },
    total: { cost_usd: { anthropic: 1, "claude-code": 31 }, unpriced: { openai: 1, "claude-code": 2, codex: 1 } },
    // 置き場ごとの和に入った session は1本ずつ並ぶ
    worker_sessions: expect.any(Array),
  });
  // RCA 2・memory meta-review 2(helper の1本を含む)・memory_repair 1・routing meta-review 2(同)・routing_repair 1
  expect(learning.worker_sessions).toHaveLength(8);
  expect(human_surface).toEqual({
    board_calls: {
      task_draft: { cost_usd: { anthropic: 0.125 }, unpriced: {} },
      child_draft: { cost_usd: {}, unpriced: { openai: 1 } },
      translation: { cost_usd: { anthropic: 0.0625 }, unpriced: {} },
    },
    total: { cost_usd: { anthropic: 0.1875 }, unpriced: { openai: 1 } },
  });
  expect(observation).toEqual({
    board_calls: {
      cli_auth_probe: { cost_usd: { moonshot: 0.5 }, unpriced: {} },
      model_probe: { cost_usd: {}, unpriced: { anthropic: 1 } },
    },
    total: { cost_usd: { moonshot: 0.5 }, unpriced: { anthropic: 1 } },
  });
  expect(record.spend.unclassified).toEqual([]);
});

it("記録は含まないものの一文を持ち、Markdown の要約は課題の表に種類の列と、走行の節を1行ずつ持つ", () => {
  const db = openDb(":memory:");
  const work = workTask(db, "the exercise");
  const root = getTask(db, examineeRootId(db, interviewExaminee(db, AT).id))!;
  boardCall(db, "allocation_review", "anthropic", 0.5);
  boardCall(db, "attribution", "openai", null);
  boardCall(db, "translation", "anthropic", 0.25);
  boardCall(db, "model_probe", "moonshot", 0.125);
  auditorRcaOn(db, getTask(db, work)!, AT, "deckhand");
  session(db, childTitled(db, work, "rca (auditor)").id, "fugu", "claude-code", 2);
  session(db, workTask(db, "stray"), "deckhand", "codex", null);

  const { record, markdown } = extract(
    db,
    scratch(),
    [
      { exercise: exercise("work"), task_id: work, test_exit: 0 },
      { exercise: interviewExercise("interview"), task_id: root.id, test_exit: null },
    ],
    CONFIG,
    [],
  );

  expect(record.spend.not_included).toBe("Calls without usage and the usage TUI's startup quota check are not included.");
  expect(markdown).toContain("| exercise | kind | handled |");
  expect(markdown).toContain("| work | work | yes |");
  expect(markdown).toContain("| interview | optimisation | — |");
  expect(markdown).toContain("- learning: anthropic 0.50, claude-code 2.00, openai 1 unpriced\n");
  expect(markdown).toContain("- human surface: anthropic 0.25\n");
  expect(markdown).toContain("- observation: moonshot 0.13\n");
  expect(markdown).toContain("- unclassified sessions: 1, codex 1 unpriced\n");
  expect(markdown).toContain("Calls without usage and the usage TUI's startup quota check are not included.");
});
