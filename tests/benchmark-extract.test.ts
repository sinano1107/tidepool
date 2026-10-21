import * as fs from "node:fs";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { type Exercise, extract, loadExercise } from "../docs/experiments/benchmark/extract.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { registerLocalMergeQuestion } from "../src/landing.js";
import { createBehaviorCandidate, defineMemoryByMetaReview, invalidateMemoryByMetaReview, proposeMemoryChange, recordKnowledge } from "../src/memory.js";
import { completeInterview, completeTask, getTask, listBoard, logDecision, registerTask } from "../src/tasks.js";
import {
  answerQuestionViaWebui,
  completedWork,
  examineeRootId,
  FULL_HANDOFF,
  failureQuestion,
  HUMAN_WEBUI,
  interviewExaminee,
  judgedMemoryReview,
  judgedRoutingReview,
  openTestInterviewRoom,
  QUIET_EXIT,
  routedOpusSessions,
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
  task: { title: "Fix slugify", purpose: "slugify collapses runs of hyphens", completion_criteria: "the tests pass", workspace: "slugify" },
};

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

const AT = new Date("2026-10-22T00:00:00.000Z");

/** 宣言の形だけを持つ課題(loader を通さない —— 抽出の入力は読み込み済みの宣言)。 */
const exercise = (name: string, over: Partial<Exercise> = {}): Exercise => ({ name, ...WORK_EXERCISE, readings: ["work"], ...over }) as Exercise;

/** fixture の transcript を、盤面の TranscriptStore と同じ名前(`<task>.<worker_spawned の id>.stream.jsonl`)で worker-logs に置く。 */
function placeTranscript(logs: string, fixture: string, taskId: string, spawnedId: number): void {
  copyFileSync(join(import.meta.dirname, "fixtures", fixture), join(logs, `${taskId}.${spawnedId}.stream.jsonl`));
}

/** 盤面が刻む worker session 1本(worker_spawned と worker_exited)。費用は盤面が result 行の total_cost_usd を写した値で、Codex は null。 */
function session(db: Db, taskId: string, agent: string, harness: "claude-code" | "codex", cost: number | null): number {
  const at = new Date("2026-10-09T00:00:00.000Z");
  const spawned = appendEvent(db, { taskId, workerId: agent, origin: "board", at, payload: { ...WORKER_SPAWNED, harness } });
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: cost, advisor: null, model_swaps: [], refusals: [], models: {} };
  appendEvent(db, { taskId, workerId: agent, origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage } });
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
    {},
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
  expect(claude).toMatchObject({ cost_usd: 0.7102510000000001, harnesses: ["claude-code"] });
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
  expect(codex).toMatchObject({ cost_usd: null, harnesses: ["codex"] });
});

it("transcript が無い session は verb 列が null で、行は落とさない", () => {
  const { db, claudeTask } = claudeAndCodexBoard();

  const { record } = extract(db, scratch(), [{ exercise: exercise("claude"), task_id: claudeTask, test_exit: 0 }], {});

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
  appendEvent(db, { taskId: work.id, workerId: "human", origin: "webui", at: AT, payload: { kind: "local_merge_executed", sha: "c0ffee" } });
  failureQuestion(db, work.id, AT);
  // memory meta-review: 店の1件を引退させ、1件の候補を提案し、残りを据え置く
  let kept = 0;
  let retired = 0;
  let candidate = 0;
  const memory = judgedMemoryReview(
    db,
    AT,
    () => {
      kept = note(db, "Keep fixtures");
      retired = note(db, "Stale advice");
      candidate = createBehaviorCandidate(
        db,
        { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
        "worker",
        AT,
      ).entry_id;
    },
    (review) => {
      invalidateMemoryByMetaReview(db, { entry_id: retired, reason: "environment" }, "fugu", "worker", AT, review.id);
      proposeMemoryChange(db, review.id, { op: "approve", candidate_id: candidate, rationale: "r" }, "fugu", AT);
      defineMemoryByMetaReview(db, { scope: null, path: "build", text: "Build notes.", author: { activity: "meta_review", name: "fugu" } }, "worker", AT, review.id);
    },
  );
  // routing meta-review: 窓に shadow 行1つと opus の session 2つ
  const routing = judgedRoutingReview(db, AT, () => routedOpusSessions(db, AT));
  // Interview: 受験者1人が完了し、root が採点した
  const examinee = interviewExaminee(db, AT);
  const root = getTask(db, examineeRootId(db, examinee.id))!;
  openTestInterviewRoom(db, root);
  completeTask(db, getTask(db, examinee.id)!, FULL_HANDOFF, "tako", AT, "worker");
  completeInterview(db, getTask(db, root.id)!, { scores: [{ child_id: examinee.id, outcome: "accepted" }], handoff: { outcome: "the target wrote it" } }, "auditor", AT, "worker");

  const { record } = extract(
    db,
    scratch(),
    [
      { exercise: exercise("work"), task_id: work.id, test_exit: 0 },
      { exercise: exercise("interview", { readings: ["interview"] }), task_id: root.id, test_exit: null },
    ],
    { tidepool_commit: "abc123" },
  );

  expect(record.config).toEqual({ tidepool_commit: "abc123" });
  expect(record.exercises[0]).toMatchObject({
    name: "work",
    handled: true,
    settlement: { status: "done", review_verdict: "no_findings", landing: "local_merge_executed" },
    questions: ["failure"],
  });
  expect(record.exercises[1]).toMatchObject({ name: "interview", handled: null, settlement: { status: "done", review_verdict: null, landing: null } });

  // meta-review の判断の行すべて(memory と routing)
  const rows = record.decision_rows;
  expect(rows.filter((r) => r.review_id === memory.review.id).map((r) => r.judgment)).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "memory", entry: kept, value: "left_as_is" })]),
  );
  expect(rows.find((r) => r.event_id === routing.row({ learner: true }))).toMatchObject({ subject: "routing", agent: "auditor" });
  // 提案 question: 提案(op・根拠)と、まだ答えていない人間の回答
  expect(record.proposals).toEqual([
    { question_id: expect.any(String), review_id: memory.review.id, proposal: expect.objectContaining({ kind: "memory", op: "approve", candidate_id: candidate }), answer: null },
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
    { root_id: root.id, room: expect.stringContaining("tidepool-rooms-"), rubric: "tests pass", scores: [{ examinee_id: examinee.id, outcome: "accepted" }] },
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
    {},
  );

  const opened = [fs.readFileSync, fs.openSync, fs.createReadStream].flatMap((f) => vi.mocked(f).mock.calls.map(([path]) => String(path)));
  // transcript は開いている(spy が効いている)が、stderr は1本も開いていない
  expect(opened.filter((path) => path.endsWith(".stream.jsonl"))).toHaveLength(2);
  expect(opened.filter((path) => path.endsWith(".stderr.log"))).toEqual([]);
  expect(JSON.stringify(record) + markdown).not.toContain(secret);
});

it("人間待ちの時間は question の登録と回答の時刻から出て、重なった待ちは1度だけ数え、盤面の時間と分かれる", () => {
  const db = openDb(":memory:");
  const minute = (n: number) => new Date(AT.getTime() + n * 60_000);
  const work = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c", assignee: "deckhand" }, minute(0), ...HUMAN_WEBUI);
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
  completeTask(db, getTask(db, work.id)!, FULL_HANDOFF, "deckhand", minute(60), "worker");
  // land question は task の子ではない(盤面の root の question)—— 70〜90 分の待ちも課題の人間待ち
  registerLocalMergeQuestion(db, getTask(db, work.id)!, "land it", minute(70));
  const land = listBoard(db).find((t) => t.title.startsWith("land completed task"))!;
  answerQuestionViaWebui(db, getTask(db, land.id)!, ["hold"], minute(90));

  const { record, markdown } = extract(db, scratch(), [{ exercise: exercise("work"), task_id: work.id, test_exit: 0 }], {});

  expect(markdown).toContain("| work | yes | done | — | — | — | 90m | 60m | 30m | 3 |");
  expect(record.exercises[0]!.duration_ms).toEqual({ wall: 90 * 60_000, human_wait: 60 * 60_000, board: 30 * 60_000 });
  expect(record.exercises[0]!.questions).toEqual(["escalation", "escalation", "local_merge"]);
});
