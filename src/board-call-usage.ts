import type { Db } from "./db.js";
import type { ExecutionSettingRow } from "./execution-setting.js";
import type { TranslationUsage } from "./translate.js";

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

/** What a Board call ran on, in the pin's spelling (alias `haiku` / `low` where the call pins one). */
export type BoardCallSetting = Pick<ExecutionSettingRow, "provider" | "model" | "effort">;

/** A Board call that failed after its CLI reported usage (schema mismatch, `is_error` with usage): the turn ran,
 *  so the Provider-neutral caller writes its row before handling the failure (ADR 0299 決定3 / 決定6). */
export class BoardCallUsageError extends Error {
  constructor(
    message: string,
    readonly setting: BoardCallSetting,
    readonly usage: TranslationUsage,
  ) {
    super(message);
  }
}

/** One Board call's usage, one row per call (ADR 0299 決定2). `fragments` is translation's alone. */
export function recordBoardCall(
  db: Db,
  use: BoardCallUse,
  setting: BoardCallSetting,
  usage: TranslationUsage,
  now: Date,
  fragments: number | null = null,
): void {
  db.prepare(
    `INSERT INTO board_calls
       (use, provider, model, effort, fragments, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, estimated_cost_usd, created_at)
     VALUES (@use, @provider, @model, @effort, @fragments, @input_tokens, @output_tokens,
             @cache_read_tokens, @cache_creation_tokens, @estimated_cost_usd, @createdAt)`,
  ).run({ use, ...setting, fragments, ...usage, createdAt: now.toISOString() });
}

export interface BoardCallRecord extends BoardCallSetting {
  use: BoardCallUse;
  fragments: number | null;
  usage: TranslationUsage;
  createdAt: string;
}

type BoardCallRow = Omit<BoardCallRecord, "usage" | "createdAt"> & TranslationUsage & { created_at: string };

/** Oldest `created_at` first; rows sharing one (one request's `now` covers each chunk of one
 *  translation target, issue #688) come back in insertion order. `created_at` is the request's
 *  start, so two overlapping requests can land out of that order (#1006). */
export function listBoardCalls(db: Db): BoardCallRecord[] {
  const rows = db
    .prepare(
      `SELECT use, provider, model, effort, fragments, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, estimated_cost_usd, created_at
         FROM board_calls ORDER BY created_at, rowid`,
    )
    .all() as BoardCallRow[];
  return rows.map(({ use, provider, model, effort, fragments, created_at, ...usage }) => ({
    use,
    provider,
    model,
    effort,
    fragments,
    usage,
    createdAt: created_at,
  }));
}

/** The translation rows in `GET /api/translate/usage`'s shape (settings' translation spend reads only these). */
export function listTranslationUsage(db: Db) {
  return listBoardCalls(db)
    .filter((record) => record.use === "translation")
    .map(({ provider, model, fragments, usage, createdAt }) => ({ provider, model, fragments: fragments!, usage, createdAt }));
}
