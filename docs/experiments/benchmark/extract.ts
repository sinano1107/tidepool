import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Db } from "../../../src/db.js";
import { latestEventOfTask, listEvents, listEventsOfKinds } from "../../../src/events.js";
import { interviewTargetSchema } from "../../../src/execution-setting.js";
import { EXTRACTOR_VERSION, projectEpisode } from "../../../src/precedent.js";
import { questionKindOf } from "../../../src/question-kind.js";
import { requiredTextSchema } from "../../../src/required-text-schema.js";
import { listRoutingShadow } from "../../../src/routing-review.js";
import { getTask, interviewRoomPath, latestPosedProbe, listChildren, listExaminees, type Task } from "../../../src/tasks.js";

/** 課題の宣言(`exercises/<name>/exercise.json`)。登録するのは task か Interview のどちらか1つ。 */
const exerciseSchema = z
  .object({
    title: requiredTextSchema,
    readings: z.array(z.enum(["work", "interview", "memory", "routing", "learner"])).min(1),
    /** 着地した保護ブランチの workspace で走らせる期待解のテスト。task の課題には必須。 */
    test: requiredTextSchema.optional(),
    task: z
      .object({
        title: requiredTextSchema,
        purpose: requiredTextSchema,
        completion_criteria: requiredTextSchema,
        workspace: requiredTextSchema,
        tier: requiredTextSchema.optional(),
        assignee: requiredTextSchema.optional(),
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
    /** 走行の前に入れる実行設定の表の行。値の検査は入れる先の盤面の扉が言う。 */
    table_rows: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.task === undefined) === (value.interview === undefined)) {
      ctx.addIssue({ code: "custom", path: ["task"], message: "declare exactly one of task and interview" });
    }
    if (value.task !== undefined && value.test === undefined) {
      ctx.addIssue({ code: "custom", path: ["test"], message: "a task exercise needs its expected-answer test command" });
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

/** 抽出の入力の1行: 宣言、harness が登録で受け取った root の task id、期待解のテストの exit(走らなかったなら null)。 */
export interface ExerciseRun {
  exercise: Exercise;
  task_id: string;
  test_exit: number | null;
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

const LANDINGS = ["local_merge_executed", "pr_merged", "landing_finished", "nothing_to_land"] as const;

/** 盤面の決着: root の status、root を成果物とする統合レビューの最後の判断、着地の最後の事実。 */
function settlement(db: Db, root: Task, tasks: readonly Task[]) {
  const verdicts = tasks.flatMap((task) =>
    listEvents(db, task.id).flatMap(({ payload: p }) =>
      p.kind === "decision_logged" && p.judgment?.kind === "integration_review" && p.judgment.deliverable === root.id ? [p.judgment.value] : [],
    ),
  );
  const landing = listEvents(db, root.id)
    .filter((e) => (LANDINGS as readonly string[]).includes(e.kind))
    .at(-1);
  return { status: root.status, review_verdict: verdicts.at(-1) ?? null, landing: landing?.kind ?? null };
}

/** 所要時間: root の登録から木の最後の event まで(wall)を、question が人間を待った時間(登録から回答まで、未回答なら最後まで。
 *  重なった待ちは1度だけ数える)と残りの盤面の時間に分ける。 */
function duration(db: Db, root: Task, tasks: readonly Task[]) {
  const start = Date.parse(root.created_at);
  const end = Math.max(start, ...tasks.flatMap((task) => listEvents(db, task.id).map((e) => Date.parse(e.created_at))));
  const waits = tasks
    .filter((task) => task.type === "question")
    .map((q) => {
      const answered = latestEventOfTask(db, q.id, "question_answered");
      return [Date.parse(q.created_at), answered ? Date.parse(answered.created_at) : end] as const;
    })
    .sort(([a], [b]) => a - b);
  let human = 0;
  let covered = Number.NEGATIVE_INFINITY;
  for (const [from, to] of waits) {
    human += Math.max(0, to - Math.max(from, covered));
    covered = Math.max(covered, to);
  }
  return { wall: end - start, human_wait: human, board: end - start - human };
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

/** 課題1つの列。 */
function exerciseRecord(db: Db, logDir: string, { exercise, task_id, test_exit }: ExerciseRun) {
  const root = getTask(db, task_id);
  if (!root) throw new Error(`exercise ${exercise.name}: no task ${task_id} on the board`);
  const tasks = subtree(db, root);
  const ran = tasks.flatMap((task) => sessions(db, logDir, task));
  const costs = ran.flatMap((s) => (s.cost_usd === null ? [] : [s.cost_usd]));
  return {
    name: exercise.name,
    title: exercise.title,
    readings: exercise.readings,
    task_id,
    handled: test_exit === null ? null : test_exit === 0,
    settlement: settlement(db, root, tasks),
    duration_ms: duration(db, root, tasks),
    cost_usd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    harnesses: [...new Set(ran.map((s) => s.harness))],
    questions: tasks.filter((t) => t.type === "question").map((q) => questionKindOf(q).kind),
    sessions: ran,
  };
}

/** 走行の記録: 課題ごとの列と、4プロセスの判断を人間が読む走行ごとの節。 */
export function extract(db: Db, logDir: string, runs: readonly ExerciseRun[], config: Record<string, unknown>) {
  const exercises = runs.map((run) => exerciseRecord(db, logDir, run));
  // 盤面の task すべて(一覧の読み口は決着した木を落とすので、登録の event から引く)
  const all = listEventsOfKinds(db, ["task_registered"]).flatMap((e) => (e.task_id === null ? [] : [getTask(db, e.task_id)!]));
  const record = {
    config,
    exercises,
    decision_rows: all.flatMap((review) =>
      review.meta_review_subject === null
        ? []
        : listEvents(db, review.id).flatMap((e) =>
            e.payload.kind === "decision_logged"
              ? [{ review_id: review.id, subject: review.meta_review_subject, event_id: e.id, agent: e.worker_id, line: e.payload.line, judgment: e.payload.judgment ?? null }]
              : [],
          ),
    ),
    proposals: all.flatMap((q) =>
      q.question_proposal === null
        ? []
        : [{ question_id: q.id, review_id: q.parent_id, proposal: q.question_proposal, answer: latestEventOfTask(db, q.id, "question_answered")?.payload ?? null }],
    ),
    shadow: shadowRows(db),
    memory_writes: listEventsOfKinds(db, ["memory_entry_created", "memory_entry_invalidated"]).flatMap((e) =>
      e.payload.activity === "meta_review" ? [{ event_id: e.id, ...e.payload }] : [],
    ),
    interviews: all.flatMap((root) =>
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
  return { record, markdown: summary(exercises) };
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;

/** 課題ごとの表(Markdown)。4プロセスの節は JSON を読む。 */
function summary(exercises: ReturnType<typeof exerciseRecord>[]): string {
  const cell = (v: unknown) => (v === null ? "—" : String(v));
  const rows = exercises.map((e) =>
    [
      e.name,
      e.handled === null ? "—" : e.handled ? "yes" : "no",
      e.settlement.status,
      cell(e.settlement.review_verdict),
      cell(e.settlement.landing),
      [cell(e.cost_usd?.toFixed(2) ?? null), ...(e.harnesses.length > 0 ? [`(${e.harnesses.join(", ")})`] : [])].join(" "),
      minutes(e.duration_ms.wall),
      minutes(e.duration_ms.human_wait),
      minutes(e.duration_ms.board),
      e.questions.length,
    ].join(" | "),
  );
  return [
    "| exercise | handled | status | review | landing | cost_usd (harness) | wall | human wait | board | questions |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
  ].join("\n");
}

/** `tsx extract.ts check <exercise-dir>...` は宣言を検査するだけ(harness が走行の前に呼ぶ)。
 *  `tsx extract.ts run <db> <worker-logs> <input.json> <out-dir>` は record.json と summary.md を書く。input.json は
 *  `{ config, exercises: [{ dir, task_id, test_exit }] }`。盤面と同じ commit の checkout から走らせる。 */
function main([command, ...args]: string[]): void {
  if (command === "check") {
    for (const dir of args) loadExercise(dir);
    return;
  }
  if (command !== "run" || args.length !== 4) throw new Error("usage: extract.ts check <exercise-dir>... | extract.ts run <db> <worker-logs> <input.json> <out-dir>");
  const [dbPath, logDir, inputPath, outDir] = args as [string, string, string, string];
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
    config: Record<string, unknown>;
    exercises: Array<{ dir: string; task_id: string; test_exit: number | null }>;
  };
  // 読むだけ —— 盤面の読み口が書き込みに触れたら、ここで落ちる
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const runs = input.exercises.map(({ dir, task_id, test_exit }) => ({ exercise: loadExercise(dir), task_id, test_exit }));
  const { record, markdown } = extract(db, logDir, runs, input.config);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.md"), markdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2));
