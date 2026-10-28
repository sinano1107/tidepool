import type { Db } from "./db.js";
import type { ModelSwap } from "./events.js";
import type { ExecutionSettingRow } from "./execution-setting.js";

/** The `board_calls` table's closed use vocabulary (ADR 0299 決定1) — the DDL's CHECK spells the same list. */
export type BoardCallUse =
  | "translation"
  | "task_draft"
  | "child_draft"
  | "handoff_draft"
  | "issue_inspection"
  | "allocation_review"
  | "attribution"
  | "behavior_draft"
  | "cli_auth_probe"
  | "model_probe";

/** The uses whose refusal raises a Quarantine — translation and the probes never do (ADR 0202 帰結). */
export type QuarantinableBoardCallUse = Exclude<BoardCallUse, "translation" | "cli_auth_probe" | "model_probe">;

/** Token usage for one Board call, same granularity as claude-worker.ts's worker_exited usage (issue #47).
 *  A null cost is "not measurable", never 0 (ADR 0296 決定5). */
export interface BoardCallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number | null;
}

/** What a Board call ran on, in the pin's spelling (alias `haiku` / `low` where the call pins one). */
export type BoardCallSetting = Pick<ExecutionSettingRow, "provider" | "model" | "effort">;

/** An answer-fetching Board call's answer, with the usage its CLI reported and the setting it ran on —
 *  the Provider-neutral caller writes the row from these (ADR 0299 決定6). */
export interface BoardCallAnswer<T> {
  output: T;
  model_swaps: ModelSwap[];
  refusals: (string | null)[];
  usage: BoardCallUsage;
  setting: BoardCallSetting;
}

/** A Board call that failed after its CLI reported usage (schema mismatch, `is_error` with usage): the turn ran,
 *  so the Provider-neutral caller writes its row before handling the failure (ADR 0299 決定3 / 決定6). */
export class BoardCallUsageError extends Error {
  constructor(
    message: string,
    readonly setting: BoardCallSetting,
    readonly usage: BoardCallUsage,
    readonly model_swaps: ModelSwap[] = [],
    readonly refusals: (string | null)[] = [],
  ) {
    super(message);
  }
}

/** The answer of one answer-fetching Board call, its row written whether the answer came back or the call failed
 *  after its CLI reported usage (ADR 0299 決定3). A failure without usage (row refusal, 401) writes nothing and is rethrown as is. */
export async function recordedAnswer<T>(db: Db, use: BoardCallUse, now: Date, call: Promise<BoardCallAnswer<T>>): Promise<T> {
  try {
    const answer = await call;
    const { output, usage, setting } = answer;
    recordBoardCall(db, use, setting, usage, now, null, answer);
    return output;
  } catch (err) {
    if (err instanceof BoardCallUsageError) recordBoardCall(db, use, err.setting, err.usage, now, null, err);
    throw err;
  }
}

/** One Board call's usage, one row per call (ADR 0299 決定2). `fragments` is translation's alone. */
export function recordBoardCall(
  db: Db,
  use: BoardCallUse,
  setting: BoardCallSetting,
  usage: BoardCallUsage,
  now: Date,
  fragments: number | null = null,
  observations: Pick<BoardCallAnswer<unknown>, "model_swaps" | "refusals"> = { model_swaps: [], refusals: [] },
): void {
  db.prepare(
    `INSERT INTO board_calls
       (use, provider, model, effort, fragments, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, estimated_cost_usd, created_at, model_swaps, refusals)
     VALUES (@use, @provider, @model, @effort, @fragments, @input_tokens, @output_tokens,
             @cache_read_tokens, @cache_creation_tokens, @estimated_cost_usd, @createdAt, @model_swaps, @refusals)`,
  ).run({ use, ...setting, fragments, ...usage, createdAt: now.toISOString(), model_swaps: JSON.stringify(observations.model_swaps), refusals: JSON.stringify(observations.refusals) });
}

export interface BoardCallRecord extends BoardCallSetting {
  model_swaps: ModelSwap[];
  refusals: (string | null)[];
  use: BoardCallUse;
  fragments: number | null;
  usage: BoardCallUsage;
  createdAt: string;
}

type BoardCallRow = Omit<BoardCallRecord, "usage" | "createdAt" | "model_swaps" | "refusals"> & BoardCallUsage & { created_at: string; model_swaps: string; refusals: string };

/** Oldest `created_at` first; rows sharing one (one request's `now` covers each chunk of one
 *  translation target, issue #688) come back in insertion order. `created_at` is the request's
 *  start, so two overlapping requests can land out of that order (#1006). */
export function listBoardCalls(db: Db): BoardCallRecord[] {
  const rows = db
    .prepare(
      `SELECT use, provider, model, effort, fragments, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, estimated_cost_usd, created_at, model_swaps, refusals
         FROM board_calls ORDER BY created_at, rowid`,
    )
    .all() as BoardCallRow[];
  return rows.map(({ use, provider, model, effort, fragments, created_at, model_swaps, refusals, ...usage }) => ({
    use,
    provider,
    model,
    effort,
    fragments,
    usage,
    createdAt: created_at,
    model_swaps: JSON.parse(model_swaps),
    refusals: JSON.parse(refusals),
  }));
}

/** The translation rows in `GET /api/translate/usage`'s shape (settings' translation spend reads only these). */
export function listTranslationUsage(db: Db) {
  return listBoardCalls(db)
    .filter((record) => record.use === "translation")
    .map(({ provider, model, fragments, usage, createdAt }) => ({ provider, model, fragments: fragments!, usage, createdAt }));
}
