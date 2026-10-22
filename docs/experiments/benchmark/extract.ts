import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { type BoardCallUse, listBoardCalls } from "../../../src/board-call-usage.js";
import type { Db } from "../../../src/db.js";
import { latestEventOfTask, listEvents, listEventsOfKinds } from "../../../src/events.js";
import { executionSettingsChangeSchema, interviewTargetSchema } from "../../../src/execution-setting.js";
import { settledByObservation } from "../../../src/landing.js";
import { firstMetaReviewSchema, type MetaReviewSubject, metaReviewSettingsChangeSchema } from "../../../src/meta-review.js";
import { EXTRACTOR_VERSION, projectEpisode } from "../../../src/precedent.js";
import { questionKindOf } from "../../../src/question-kind.js";
import { requiredTextSchema } from "../../../src/required-text-schema.js";
import { listRoutingShadow } from "../../../src/routing-review.js";
import { isSettled } from "../../../src/task-status.js";
import { getTask, interviewRoomPath, isRca, isRepairType, latestPosedProbe, listChildren, listExaminees, type Task } from "../../../src/tasks.js";

/** 実行設定の表の1行。綴りは盤面の表の行を足す変更(`setting: "row"`)の row で、検査もその schema に任せる。 */
const tableRowSchema = z.record(z.string(), z.unknown()).superRefine((row, ctx) => {
  for (const issue of executionSettingsChangeSchema.safeParse({ setting: "row", row }).error?.issues ?? []) {
    ctx.addIssue({ code: "custom", path: issue.path.slice(1), message: issue.message });
  }
});

/** 課題の宣言(`exercises/<name>/exercise.json`)。登録するのは task か Interview のどちらか1つ。 */
const exerciseSchema = z
  .object({
    title: requiredTextSchema,
    readings: z.array(z.enum(["work", "interview", "memory", "routing", "learner", "decompose", "repair"])).min(1),
    /** 着地した保護ブランチの workspace で走らせる期待解のテスト。task の課題には必須。 */
    test: requiredTextSchema.optional(),
    task: z
      .object({
        title: requiredTextSchema,
        purpose: requiredTextSchema,
        completion_criteria: requiredTextSchema,
        workspace: requiredTextSchema,
        tier: requiredTextSchema,
        assignee: requiredTextSchema,
        review_tier: requiredTextSchema.optional(),
      })
      .strict()
      .optional(),
    interview: z
      .object({
        hypothesis: requiredTextSchema,
        tier: requiredTextSchema,
        targets: z.array(interviewTargetSchema).min(1),
        measured_work: requiredTextSchema.optional(),
        workspace: requiredTextSchema.optional(),
      })
      .strict()
      .optional(),
    /** 走行の前に入れる実行設定の表の行。 */
    table_rows: z.array(tableRowSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.task === undefined) === (value.interview === undefined)) {
      ctx.addIssue({ code: "custom", path: ["task"], message: "declare exactly one of task and interview" });
    }
    if (value.task !== undefined && value.test === undefined) {
      ctx.addIssue({ code: "custom", path: ["test"], message: "a task exercise needs its expected-answer test command" });
    }
    // 学習器の shadow 行は推薦する別の候補が要る(#2439 story 24)
    if (value.readings.includes("learner") && (value.table_rows?.length ?? 0) < 2) {
      ctx.addIssue({ code: "custom", path: ["table_rows"], message: "a learner reading needs at least two table rows to recommend between" });
    }
  });

export type Exercise = z.infer<typeof exerciseSchema> & { name: string };

/** 課題ディレクトリの宣言を読み、欠けた欄・未知の値を欄名で名指して拒否する。harness も走行の前にこれを呼ぶ。 */
export function loadExercise(dir: string): Exercise {
  const file = join(dir, "exercise.json");
  const parsed = exerciseSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}:\n${z.prettifyError(parsed.error)}`);
  return { name: basename(dir), ...parsed.data };
}

/** 走行の宣言(`run.json`): 順序を持つ列(ADR 0298 追記 #2449 決定2)。項目は課題(隣の `exercises/` のディレクトリ名)か人間の段 ——
 *  主題の初回の meta-review を起こす(ADR 0300)か、自由文の段。`period_days` は走行の前に盤面へ入れる meta-review の周期。 */
const sequenceSchema = z
  .object({
    period_days: metaReviewSettingsChangeSchema.shape.period_days.optional(),
    items: z
      .array(
        z.discriminatedUnion("human", [
          z.object({ human: z.undefined().optional(), exercise: requiredTextSchema }).strict(),
          z.object({ human: z.literal("first_meta_review"), subject: firstMetaReviewSchema.shape.subject }).strict(),
          z.object({ human: z.literal("step"), instructions: requiredTextSchema }).strict(),
        ]),
      )
      .min(1),
  })
  .strict();

/** 走行の宣言を読み、課題の項目は `exercises/<name>` の宣言に置き換える。欄名を名指して拒否するのは loadExercise と同じ。 */
export function loadSequence(file: string) {
  const parsed = sequenceSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}:\n${z.prettifyError(parsed.error)}`);
  const exercises = join(dirname(file), "exercises");
  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => (item.human === undefined ? { exercise: loadExercise(join(exercises, item.exercise)) } : item)),
  };
}
type SequenceItem = ReturnType<typeof loadSequence>["items"][number];

/** 走行の構成: 4つの軸(tidepool の commit・CLI の pin・表の行・registry の commit、ADR 0298 決定4)。 */
export const runConfigSchema = z
  .object({
    tidepool_commit: requiredTextSchema,
    cli_pins: z.record(z.string(), requiredTextSchema),
    table_rows: z.array(tableRowSchema),
    registry_commit: requiredTextSchema,
  })
  .strict();
export type RunConfig = z.infer<typeof runConfigSchema>;

/** 抽出の入力の1行: 宣言、harness が登録で受け取った root の task id、期待解のテストの exit(走らなかったなら null)。 */
export interface ExerciseRun {
  exercise: Exercise;
  task_id: string;
  test_exit: number | null;
}

/** 人間が Interview の root を retry すると旧い root は cancel され、新しい root が `interview_retried` で旧い root を名指す。
 *  登録で受け取った id から、その後継を辿り切った今の root を返す(retry されていなければ id のまま)。 */
export function currentRoot(db: Db, taskId: string): string {
  const retries = listEventsOfKinds(db, ["interview_retried"]);
  const successor = (id: string) => retries.find((e) => e.payload.kind === "interview_retried" && e.payload.previous_root_id === id)?.task_id ?? null;
  let id = taskId;
  for (let next = successor(id); next !== null; next = successor(id)) id = next;
  return id;
}

/** harness が書く人間の段の記録の1行(`~/bench/human-steps.jsonl`、段が終わったときに書く)。結果は3つ: 人間が済ませた(`done`)、
 *  人間が harness に skip と伝えた(`human_skip`、対照走行)、扉の門が閉じていて待たずに進んだ(`door_closed`、材料 0 件 —— ADR 0300 決定2)。
 *  `waited_on` は済んだ後に待ったもの(初回の meta-review の root、自由文の段なら `board`)。 */
const humanStepSchema = z
  .object({
    item: z.number().int().nonnegative(),
    human: z.enum(["first_meta_review", "step"]),
    subject: firstMetaReviewSchema.shape.subject.optional(),
    outcome: z.enum(["done", "human_skip", "door_closed"]),
    prompted_at: requiredTextSchema,
    finished_at: requiredTextSchema,
    waited_on: requiredTextSchema.nullable(),
  })
  .strict();
type HumanStep = z.infer<typeof humanStepSchema>;

/** 再開の位置(#2503): 列の項目ごとに、盤面の記録から済んだところを導く。課題は harness が登録した root(親を持たず retry の後継でない)を
 *  登録順に宣言の題で対応づけ、retry の後の今の root を返す —— harness の id の控えに頼らないので、登録と控えの間で止まっても2度登録しない。
 *  人間の段は記録した結果と、初回の meta-review なら人間が起こした root。 */
export function sequencePosition(db: Db, items: readonly SequenceItem[], steps: readonly HumanStep[]): Array<{ root: string | null; outcome: HumanStep["outcome"] | null }> {
  const roots = listEventsOfKinds(db, ["task_registered"]).flatMap((e) => {
    const task = e.task_id === null ? undefined : getTask(db, e.task_id);
    return task && task.parent_id === null && !latestEventOfTask(db, task.id, "interview_retried") ? [task] : [];
  });
  return items.map((item, index) => {
    if ("exercise" in item) {
      const title = item.exercise.task?.title ?? item.exercise.title;
      const at = roots.findIndex((task) => task.title === title);
      return { root: at === -1 ? null : currentRoot(db, roots.splice(at, 1)[0]!.id), outcome: null };
    }
    const outcome = steps.find((step) => step.item === index)?.outcome ?? null;
    return { root: item.human === "first_meta_review" ? firstMetaReview(db, item.subject).root : null, outcome };
  });
}

/** 人間の段「初回の meta-review を起こす」の待ち(ADR 0300 決定2): 人間が扉で起こした主題の root(盤面の周期の回ではない —— 経路で
 *  見分ける)と、root とその配下(修理子・RCA・提案 question)がすべて決着したか。起こされていなければ root は null。 */
export function firstMetaReview(db: Db, subject: MetaReviewSubject): { root: string | null; settled: boolean } {
  const registered = listEventsOfKinds(db, ["meta_review_registered"]).find((e) => e.origin !== "board" && e.payload.subject === subject);
  if (registered?.task_id == null) return { root: null, settled: false };
  return { root: registered.task_id, settled: subtree(db, getTask(db, registered.task_id)!).every((task) => isSettled(task.status)) };
}

const VERB_PREFIX = "mcp__tidepool__";

/** root と、その子孫・Interview の受験者(root の子ではない)とその子孫。 */
function subtree(db: Db, root: Task): Task[] {
  const below = [...listChildren(db, root.id), ...(root.type === "interview" ? listExaminees(db, root.id) : [])];
  return [root, ...below.flatMap((task) => subtree(db, task))];
}

/** worker session 1本: 走らせた agent・Harness・費用(worker_exited の値 = Claude の result 行の total_cost_usd、Codex は null)と、
 *  transcript から読んだ盤面の verb の列。transcript は盤面が書く名前(`<task>.<worker_spawned の id>.stream.jsonl`)で開き、
 *  dir を一覧しない —— 同じ dir の `.stderr.log` は秘密を含みうるので開かない。 */
function sessions(db: Db, logDir: string, task: Task) {
  const events = listEvents(db, task.id);
  return events.flatMap((spawned) => {
    if (spawned.payload.kind !== "worker_spawned") return [];
    const exited = events.find((e) => e.payload.kind === "worker_exited" && e.payload.worker_spawned_event_id === spawned.id)?.payload;
    const path = join(logDir, `${task.id}.${spawned.id}.stream.jsonl`);
    const verbs = existsSync(path)
      ? projectEpisode({ transcriptLines: readFileSync(path, "utf8").split("\n"), events, workerSpawnedEventId: spawned.id, extractorVersion: EXTRACTOR_VERSION })
          .actions.filter((a) => a.tool.startsWith(VERB_PREFIX))
          .map((a) => a.tool.slice(VERB_PREFIX.length))
      : null;
    return [
      {
        task_id: task.id,
        agent: spawned.worker_id,
        // 欄の無い古い worker_spawned は Claude —— 投影器(projectEpisode)と同じ読み
        harness: spawned.payload.harness ?? "claude-code",
        cost_usd: exited?.kind === "worker_exited" ? (exited.usage?.estimated_cost_usd ?? null) : null,
        verbs,
      },
    ];
  });
}

/** 費用を Harness(Provider)ごとに足し、費用の無いものは和に入れず数える —— 部分和を全額と読ませない。 */
function tally(entries: ReadonlyArray<{ key: string; cost_usd: number | null }>) {
  const cost_usd: Record<string, number> = {};
  const unpriced: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.cost_usd === null) unpriced[entry.key] = (unpriced[entry.key] ?? 0) + 1;
    else cost_usd[entry.key] = (cost_usd[entry.key] ?? 0) + entry.cost_usd;
  }
  return { cost_usd, unpriced };
}

/** session を Harness の費用1件として tally に渡す形。 */
const priced = (s: { harness: string; cost_usd: number | null }) => ({ key: s.harness, cost_usd: s.cost_usd });

/** group ごとの tally。 */
type Priced = { group: string; key: string; cost_usd: number | null };
const tallyBy = (entries: readonly Priced[]) =>
  Object.fromEntries([...new Set(entries.map((e) => e.group))].map((group) => [group, tally(entries.filter((e) => e.group === group))]));

// ponytail: landing.ts の LANDING_ENDED_KINDS は SQL の断片で export されない —— 着地の事実の種類を足したらここも足す
const LANDINGS = ["local_merge_executed", "pr_merged", "landing_finished", "nothing_to_land"] as const;

/** 人間が盤面の面で見た・異議を打った記録(triage)—— 仕事の時間を伸ばさない。 */
const HUMAN_VIEWING = new Set(["log_entry_displayed", "objection_raised"]);

/** 木の event(人間が見ただけの記録を除く)。 */
const workEvents = (db: Db, tasks: readonly Task[]) => tasks.flatMap((task) => listEvents(db, task.id)).filter((e) => !HUMAN_VIEWING.has(e.kind));

/** 盤面の決着: root の status、root を成果物とする統合レビューの最後の判断(event id 順)、着地の最後の事実。 */
function settlement(db: Db, root: Task, tasks: readonly Task[]) {
  const verdicts = workEvents(db, tasks)
    .flatMap(({ id, payload: p }) =>
      p.kind === "decision_logged" && p.judgment?.kind === "integration_review" && p.judgment.deliverable === root.id ? [{ id, value: p.judgment.value }] : [],
    )
    .sort((a, b) => a.id - b.id);
  const landing = listEvents(db, root.id)
    .filter((e) => (LANDINGS as readonly string[]).includes(e.kind))
    .at(-1);
  return { status: root.status, review_verdict: verdicts.at(-1)?.value ?? null, landing: landing?.kind ?? null };
}

/** 区間の和の長さ(重なりは1度)。 */
function covered(intervals: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const [from, to] of [...intervals].sort(([a], [b]) => a - b)) {
    total += Math.max(0, to - Math.max(from, reach));
    reach = Math.max(reach, to);
  }
  return total;
}

/** 所要時間: root の登録から木の最後の event まで(wall)を、最初の session までの pickup 待ち(queue)、question が人間を
 *  待った時間(登録から閉じるまで —— 回答・観測・cancel の最後の記録、開いたままなら最後まで)、残りの盤面の時間に分ける。 */
function duration(db: Db, root: Task, tasks: readonly Task[]) {
  const events = workEvents(db, tasks);
  const start = Date.parse(root.created_at);
  const end = Math.max(start, ...events.map((e) => Date.parse(e.created_at)));
  const spawn = events.find((e) => e.kind === "worker_spawned");
  const queue = [start, spawn ? Date.parse(spawn.created_at) : end] as const;
  // ponytail: 閉じた時刻は question 自身の最後の記録 —— PR の決着を根に刻む merge question(ADR 0265 決定1)は question に記録が
  // 残らず登録の時刻になる。ベンチマークの workspace はローカル着地なので当たらない。PR の面を測るなら settledByObservation から根を引く
  const waits = tasks
    .filter((task) => task.type === "question")
    .map((q) => [Date.parse(q.created_at), q.status === "todo" ? end : Date.parse(workEvents(db, [q]).at(-1)!.created_at)] as const);
  const human = covered(waits);
  return { wall: end - start, queue: queue[1] - queue[0], human_wait: human, board: end - start - covered([queue, ...waits]) };
}

/** shadow 行すべて。読み口は meta-review の窓で切るので、窓の起点を 0 に置いて続きを辿る(読み手の task id は起点を渡すと読まれない)。 */
function shadowRows(db: Db) {
  const rows = [];
  let next: string | undefined;
  do {
    const page = listRoutingShadow(db, "", next ? { next } : { since_watermark: 0 });
    rows.push(...page.shadow);
    next = page.next;
  } while (next);
  return rows;
}

/** 課題1つの列。着地の question は着地する task の子ではなく、その task を名指す。 */
function exerciseRecord(db: Db, logDir: string, boardTasks: readonly Task[], { exercise, task_id, test_exit }: ExerciseRun) {
  const root = getTask(db, task_id);
  if (!root) throw new Error(`exercise ${exercise.name}: no task ${task_id} on the board`);
  const tree = subtree(db, root);
  const ids = new Set(tree.map((task) => task.id));
  const landingQuestions = boardTasks.filter((q) => {
    if (q.type !== "question") return false;
    const kind = questionKindOf(q);
    return (kind.kind === "local_merge" || kind.kind === "pr_promotion_retry") && ids.has(kind.task_id);
  });
  const tasks = [...tree, ...landingQuestions];
  // 人間の retry で置き換わった前の root の木も費用に入れる(`interview_retried` を遡る)。所要時間・決着は今の root の木で読む
  const replaced: Task[] = [];
  let interviewRetries = 0;
  for (let prev = latestEventOfTask(db, root.id, "interview_retried")?.payload.previous_root_id; prev !== undefined; interviewRetries++) {
    const earlier = getTask(db, prev)!;
    replaced.push(...subtree(db, earlier));
    prev = latestEventOfTask(db, earlier.id, "interview_retried")?.payload.previous_root_id;
  }
  const decomposed = tree.flatMap((t) => (t.type !== "question" && t.based_on_decision !== null ? [{ based_on_decision: t.based_on_decision }] : []));
  // 修理子は異議の束ねが立てる子(登録の記録が異議を運ぶ)のうち RCA でないもの —— 題では見分けない(ADR 0171)
  const repairs: Record<string, number> = {};
  for (const task of tree) {
    if (latestEventOfTask(db, task.id, "task_registered")?.payload.objection_event_ids?.length && !isRca(db, task.id)) repairs[task.type] = (repairs[task.type] ?? 0) + 1;
  }
  // 記録から学ぶ task(RCA review と記憶・routing の修理子)は走行の節に置き、課題の行の費用から外す
  const treeSessions = [...tasks, ...replaced].filter((task) => learningGroup(db, task) === null).flatMap((task) => sessions(db, logDir, task));
  const { cost_usd, unpriced } = tally(treeSessions.map(priced));
  return {
    name: exercise.name,
    title: exercise.title,
    kind: exercise.task ? ("work" as const) : ("optimisation" as const),
    readings: exercise.readings,
    task_id,
    handled: test_exit === null ? null : test_exit === 0,
    settlement: settlement(db, root, tasks),
    duration_ms: duration(db, root, tasks),
    // 費用の無い session(Codex、終わらなかった session)は和に入れず Harness ごとに数える
    cost_usd_by_harness: cost_usd,
    unpriced_sessions_by_harness: unpriced,
    questions: tasks.filter((t) => t.type === "question").map((q) => questionKindOf(q).kind),
    // agent の動き(ADR 0298 追記 #2449 決定4): 分解判断に載る子と分解判断の行の数、異議、修理子、retry(failure question と Interview の root)
    // 権限外の子の承認 question も分解判断を持つ —— 子として数えるのは承認で実体化した子だけ
    children: decomposed.length,
    depth: new Set(decomposed.map((t) => t.based_on_decision)).size,
    objections: listEventsOfKinds(db, ["objection_raised"]).filter((e) => e.task_id !== null && ids.has(e.task_id)).length,
    repairs_by_type: repairs,
    retries:
      interviewRetries +
      [...tasks, ...replaced].filter(
        (q) => q.type === "question" && questionKindOf(q).kind === "failure" && latestEventOfTask(db, q.id, "question_answered")?.payload.answers[0]?.answer === "retry",
      ).length,
    sessions: treeSessions,
  };
}

/** 記録から学ぶ worker session の置き場(ADR 0299 決定5): meta-review は主題ごと、RCA、修理子は type ごと。どれでもなければ null。 */
function learningGroup(db: Db, task: Task): string | null {
  if (task.meta_review_subject !== null) return `meta_review:${task.meta_review_subject}`;
  if (isRca(db, task.id)) return "rca";
  return isRepairType(task.type) ? task.type : null;
}

/** Board call の用途が載る走行の節(ADR 0299 決定5)。`satisfies` で用途を足したら節を決めるまで型が通らない。 */
const SECTION_OF_USE = {
  allocation_review: "learning",
  attribution: "learning",
  behavior_draft: "learning",
  task_draft: "human_surface",
  child_draft: "human_surface",
  handoff_draft: "human_surface",
  issue_inspection: "human_surface",
  translation: "human_surface",
  cli_auth_probe: "observation",
  model_probe: "observation",
} as const satisfies Record<BoardCallUse, "learning" | "human_surface" | "observation">;

/** 走行の支出の節(ADR 0299 決定5): Board call の行は用途ごとに Provider で、記録から学ぶ session は置き場ごとに Harness で足す。
 *  どの課題の木にも、どの節にも入らない worker session は未分類として並べる。 */
function spend(db: Db, logDir: string, boardTasks: readonly Task[], exercises: ReturnType<typeof exerciseRecord>[]) {
  const calls = listBoardCalls(db);
  /** 節の Board call の行(用途ごと)と、節の総和(Provider / Harness ごと)。 */
  const section = (name: (typeof SECTION_OF_USE)[BoardCallUse], sessionEntries: readonly Priced[] = []) => {
    const own = calls.filter((call) => SECTION_OF_USE[call.use] === name).map((call) => ({ group: call.use, key: call.provider, cost_usd: call.usage.estimated_cost_usd }));
    return { total: tally([...own, ...sessionEntries]), board_calls: tallyBy(own) };
  };
  // agent と verb の列は課題の行と同じく session ごとに残す —— 課題の行の sessions は行の費用と一致させるので、ここに並べる
  const learningSessions = boardTasks.flatMap((task) => {
    const group = learningGroup(db, task);
    return group === null ? [] : sessions(db, logDir, task).map((s) => ({ group, ...s }));
  });
  const learning = learningSessions.map((s) => ({ group: s.group, ...priced(s) }));
  const onExercise = new Set(exercises.flatMap((e) => e.sessions.map((s) => s.task_id)));
  return {
    not_included: "Calls without usage and the usage TUI's startup quota check are not included.",
    learning: { ...section("learning", learning), sessions: tallyBy(learning), worker_sessions: learningSessions },
    human_surface: section("human_surface"),
    observation: section("observation"),
    unclassified: boardTasks.filter((task) => !onExercise.has(task.id) && learningGroup(db, task) === null).flatMap((task) => sessions(db, logDir, task)),
  };
}

/** 走行の記録: 課題ごとの列と、4プロセスの判断・人間の段を人間が読む走行ごとの節。 */
export function extract(db: Db, logDir: string, runs: readonly ExerciseRun[], config: RunConfig, humanSteps: readonly HumanStep[]) {
  // 盤面の task すべて(一覧の読み口は決着した木を落とすので、登録の event から引く)
  const boardTasks = listEventsOfKinds(db, ["task_registered"]).flatMap((e) => (e.task_id === null ? [] : [getTask(db, e.task_id)!]));
  const exercises = runs.map((run) => exerciseRecord(db, logDir, boardTasks, run));
  const record = {
    config,
    exercises,
    human_steps: humanSteps,
    spend: spend(db, logDir, boardTasks, exercises),
    decision_rows: boardTasks.flatMap((review) =>
      review.meta_review_subject === null
        ? []
        : listEvents(db, review.id).flatMap((e) =>
            e.payload.kind === "decision_logged"
              ? [{ review_id: review.id, subject: review.meta_review_subject, event_id: e.id, agent: e.worker_id, line: e.payload.line, judgment: e.payload.judgment ?? null }]
              : [],
          ),
    ),
    // 提案(op・pin)と根拠(rationale は question の purpose、detail は項目の本文)、人間の回答。観測で閉じた(陳腐化)ものは印で分ける
    proposals: boardTasks.flatMap((q) => {
      const kind = q.type === "question" ? questionKindOf(q) : null;
      return kind?.kind === "proposal"
        ? [
            {
              question_id: q.id,
              review_id: q.parent_id,
              proposal: kind.proposal,
              rationale: q.purpose,
              detail: q.question_items?.[0]?.detail ?? null,
              answer: latestEventOfTask(db, q.id, "question_answered")?.payload ?? null,
              settled_by_observation: settledByObservation(db, q),
            },
          ]
        : [];
    }),
    shadow: shadowRows(db),
    // 作成は書き手が entry.author、移動・復元の複製と無効化は event の activity が持つ
    memory_writes: listEventsOfKinds(db, ["memory_entry_created", "memory_entry_invalidated"]).flatMap(({ id, payload: p }) =>
      (p.activity ?? (p.kind === "memory_entry_created" ? p.entry.author.activity : undefined)) === "meta_review" ? [{ event_id: id, ...p }] : [],
    ),
    interviews: boardTasks.flatMap((root) =>
      root.type === "interview"
        ? [
            {
              root_id: root.id,
              room: interviewRoomPath(db, root.id) ?? null,
              rubric: latestPosedProbe(db, root.id)?.probe.rubric ?? null,
              scores: listExaminees(db, root.id).flatMap((examinee) => {
                const scored = latestEventOfTask(db, examinee.id, "interview_scored");
                return scored ? [{ examinee_id: examinee.id, outcome: scored.payload.outcome }] : [];
              }),
            },
          ]
        : [],
    ),
  };
  return { record, markdown: summary(exercises, record.spend, humanSteps) };
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;

/** 費用の和と費用の無い数を1セルに(無ければ —)。 */
function costText({ cost_usd, unpriced }: ReturnType<typeof tally>): string {
  const parts = [...Object.entries(cost_usd).map(([key, usd]) => `${key} ${usd.toFixed(2)}`), ...Object.entries(unpriced).map(([key, n]) => `${key} ${n} unpriced`)];
  return parts.length > 0 ? parts.join(", ") : "—";
}

/** 課題ごとの表と走行の支出の節の1行ずつ(Markdown)。4プロセスの節は JSON を読む。 */
function summary(exercises: ReturnType<typeof exerciseRecord>[], spent: ReturnType<typeof spend>, humanSteps: readonly HumanStep[]): string {
  const cell = (v: unknown) => (v === null ? "—" : String(v));
  const rows = exercises.map((e) =>
    [
      e.name,
      e.kind,
      e.handled === null ? "—" : e.handled ? "yes" : "no",
      e.settlement.status,
      cell(e.settlement.review_verdict),
      cell(e.settlement.landing),
      costText({ cost_usd: e.cost_usd_by_harness, unpriced: e.unpriced_sessions_by_harness }),
      minutes(e.duration_ms.wall),
      minutes(e.duration_ms.queue),
      minutes(e.duration_ms.human_wait),
      minutes(e.duration_ms.board),
      e.questions.length,
      e.children,
      e.depth,
      e.objections,
      Object.entries(e.repairs_by_type).map(([type, n]) => `${type} ${n}`).join(", ") || "0",
      e.retries,
    ].join(" | "),
  );
  return [
    "| exercise | kind | handled | status | review | landing | cost_usd | wall | queue | human wait | board | questions | children | depth | objections | repairs | retries |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    `- learning: ${costText(spent.learning.total)}`,
    `- human surface: ${costText(spent.human_surface.total)}`,
    `- observation: ${costText(spent.observation.total)}`,
    `- unclassified sessions: ${spent.unclassified.length}, ${costText(tally(spent.unclassified.map(priced)))}`,
    "",
    ...humanSteps.map(
      (step) =>
        `- human step ${step.item} (${[step.human, step.subject].filter(Boolean).join(" ")}): ${step.outcome}, prompted ${step.prompted_at}, finished ${step.finished_at}, waited on ${cell(step.waited_on)}`,
    ),
    ...(humanSteps.length > 0 ? [""] : []),
    spent.not_included,
    "",
  ].join("\n");
}

/** `run` の input.json: 構成と、課題ごとの宣言のディレクトリ・root の task id・期待解のテストの exit、人間の段の記録。 */
const runInputSchema = z
  .object({
    config: runConfigSchema,
    exercises: z.array(z.object({ dir: requiredTextSchema, task_id: requiredTextSchema, test_exit: z.number().int().nullable() }).strict()),
    human_steps: z.array(humanStepSchema),
  })
  .strict();

/** harness の人間の段の記録(1行1段)。まだ無ければ空。 */
function readHumanSteps(path: string): HumanStep[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => humanStepSchema.parse(JSON.parse(line)));
}

/** 読むだけ —— 盤面の読み口が書き込みに触れたら、ここで落ちる。 */
const readOnly = (path: string) => new Database(path, { readonly: true, fileMustExist: true });

/** `tsx extract.ts check <run.json>` は走行の宣言とその課題を検査するだけ(harness が走行の前に呼ぶ)。
 *  `current-root` は retry の後の今の root の id を印字する(harness が決着待ちの poll ごとに呼ぶ)。
 *  `position` は列の項目ごとの再開の位置を JSON で印字する(harness が列を始める前に呼ぶ)。
 *  `first-meta-review` は人間の段の初回の meta-review の root と決着を JSON で印字する(harness がその段の poll ごとに呼ぶ)。
 *  `run` は record.json と summary.md を書く。どれも盤面と同じ commit の checkout から走らせる。 */
function main([command, ...args]: string[]): void {
  if (command === "check" && args.length === 1) {
    loadSequence(args[0]!);
    return;
  }
  if (command === "current-root" && args.length === 2) {
    console.log(currentRoot(readOnly(args[0]!), args[1]!));
    return;
  }
  if (command === "position" && args.length === 3) {
    console.log(JSON.stringify(sequencePosition(readOnly(args[1]!), loadSequence(args[0]!).items, readHumanSteps(args[2]!))));
    return;
  }
  if (command === "first-meta-review" && args.length === 2) {
    console.log(JSON.stringify(firstMetaReview(readOnly(args[0]!), firstMetaReviewSchema.shape.subject.parse(args[1]))));
    return;
  }
  if (command !== "run" || args.length !== 4) throw new Error(
      "usage: extract.ts check <run.json> | current-root <db> <task-id> | position <run.json> <db> <human-steps.jsonl> | first-meta-review <db> <subject> | run <db> <worker-logs> <input.json> <out-dir>",
    );
  const [dbPath, logDir, inputPath, outDir] = args as [string, string, string, string];
  const parsed = runInputSchema.safeParse(JSON.parse(readFileSync(inputPath, "utf8")));
  if (!parsed.success) throw new Error(`${inputPath}:\n${z.prettifyError(parsed.error)}`);
  const runs = parsed.data.exercises.map(({ dir, task_id, test_exit }) => ({ exercise: loadExercise(dir), task_id, test_exit }));
  const { record, markdown } = extract(readOnly(dbPath), logDir, runs, parsed.data.config, parsed.data.human_steps);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.md"), markdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2));
