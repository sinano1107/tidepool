import type { Db } from "./db.js";
import type { RowRefusal, RowRefusalCause } from "./events.js";
import { loadExecutionSettingTable } from "./execution-setting.js";
import { registerQuarantine, tableRowValue } from "./quarantine.js";
import type { Provider } from "./registry.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export const CLI_AUTH_EXPIRY_WARNING_TITLE = "Claude authentication token expires soon";

export type CliAuthResult =
  | { status: "authenticated" }
  | { status: "unauthorized" | "unknown"; reason: string };

export type CliAuthCheck = () => Promise<CliAuthResult>;

/** 行の Quarantine の解除の門(ADR 0184 決定5): その model id を検査し直した判定。Claude CLI を喋る
 *  Provider は最小の1ターン(`refused` は行の拒否の証拠、`unauthorized` は 401)、openai は model 一覧の読み直し
 *  (`refused` は一覧に無い)。 */
export type ModelProbeResult =
  | { status: "runs" }
  | { status: "refused" | "unauthorized" | "unknown"; reason: string };

export type ModelProbe = (model: string) => Promise<ModelProbeResult>;

export const CLI_AUTH_EXPIRY_WARNING_INTERVAL_MS = 30 * 60 * 1000;
const CLI_AUTH_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
const ISO_EXPIRY = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export function resolveCliAuthExpiry(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const expiresAt = new Date(value);
  const date = ISO_EXPIRY.exec(value)?.[1];
  if (
    date === undefined ||
    !Number.isFinite(expiresAt.getTime()) ||
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    console.warn(
      `[cli-auth] invalid TIDEPOOL_CLAUDE_TOKEN_EXPIRES_AT value ${JSON.stringify(value)}; ` +
        "advance expiry warning is disabled",
    );
    return undefined;
  }
  return expiresAt;
}

/** Structured evidence carried from a Claude CLI adapter to the board layer.
 * Callers must never infer this from an error-message substring. */
export class CliAuthError extends Error {}

export function isCliAuthFailureEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && "api_error_status" in value && value.api_error_status === 401;
}

/** 上限到達による中断(CONTEXT.md / ADR 0104 決定2): Provider の側から返る
 *  確定的な上限到達の証拠は `result` envelope の `api_error_status: 429` 一点で
 *  ある。認証の述語と同じ posture で、"session limit" のような文言や stream 中の
 *  `rate_limit_event` からは推測しない。 */
export function isCapInterruptionEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && "api_error_status" in value && value.api_error_status === 429;
}

/** 行の拒否(CONTEXT.md / ADR 0184 決定3・ADR 0187 決定1)の証拠の分類。Provider がその model id を
 *  断った証拠は `result` envelope の `api_error_status: 404` と、CLI の版の古さを名指すサーバの識別子
 *  `api_error_code: claude_code_version_too_old` の2つ。401 / 429 と同じ posture で、HTTP の 400・CLI の
 *  enum の `api_error`・`result` の本文・stderr の `unrecognized_model` からは推測しない。 */
export function rowRefusalCause(value: unknown): RowRefusalCause | null {
  if (typeof value !== "object" || value === null) return null;
  if ("api_error_status" in value && value.api_error_status === 404) return "api_404";
  if ("api_error_code" in value && value.api_error_code === "claude_code_version_too_old") return "cli_version_too_old";
  return null;
}

/** 行の拒否の証拠が Board call の理由に名指すもの(ADR 0184 決定3)。 */
const ROW_REFUSAL_EVIDENCE: Record<RowRefusalCause, string> = {
  api_404: "API error 404 for this model id",
  cli_version_too_old: "API error code claude_code_version_too_old",
};

type RefusedRow = Pick<RowRefusal, "provider" | "model" | "cause">;

/** 表の行で撃つ Board call の result envelope が行の拒否の証拠だったこと(ADR 0202 決定1)。`CliAuthError` と同じく
 *  構造化された証拠で、呼び手は文言から推測しない。 */
export class RowRefusalError extends Error implements RefusedRow {
  constructor(
    readonly provider: Provider,
    readonly model: string,
    override readonly cause: RowRefusalCause,
  ) {
    super(`the ${provider} provider refused the execution-setting row ${provider} / ${model}: ${ROW_REFUSAL_EVIDENCE[cause]}`);
  }
}

/** 行の拒否の Quarantine を立てる共有の一歩(worker の spawn と Board call)。撃った行が表に残っているときだけ立てる ——
 *  表に無い行の Quarantine は直す行が無いまま開き、次の無関係な表の編集が解除の門1(ADR 0184 決定5)で決着させてしまう(#1265)。 */
export function quarantineRefusedRow(db: Db, refusal: RefusedRow, subject: string, now: Date): void {
  if (!loadExecutionSettingTable(db).some((row) => row.provider === refusal.provider && row.model === refusal.model)) return;
  registerQuarantine(
    db,
    "tableRow",
    tableRowValue(refusal.provider, refusal.model),
    `${subject} ended with ${ROW_REFUSAL_EVIDENCE[refusal.cause]}`,
    now,
    refusal.cause,
  );
}

export type BoardCallUse = "attribution" | "allocation review" | "memory draft" | "task draft" | "handoff draft" | "issue inspection";

/** 表の行で撃つ Board call が断られたら行の Quarantine を立て、true を返す(ADR 0202 決定2・5)。true のとき呼び手は
 *  失敗に数えず(決定3)、対象の側には何も書かない。 */
export function quarantineBoardCallRefusal(db: Db, err: unknown, use: BoardCallUse, taskId: string | undefined, now: Date): boolean {
  if (!(err instanceof RowRefusalError)) return false;
  quarantineRefusedRow(db, err, `The ${use} Board call${taskId === undefined ? "" : ` for task ${taskId}`}`, now);
  return true;
}

/** The probe died on its own spend cap, not on an authentication verdict
 * (issue #466) — the envelope's structured marker, so callers never match an
 * error-message substring. */
export function isCliAuthBudgetCapEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && "subtype" in value && value.subtype === "error_max_budget_usd";
}

/** `execFile` rejects on the same non-zero exit that carries Claude's JSON
 * error envelope. Preserve that structured stdout instead of falling back to
 * an error-message substring. */
export function rethrowCliAuthExecFailure(err: unknown): never {
  const envelope = execFailureEnvelope(err);
  if (isCliAuthFailureEnvelope(envelope)) {
    const { result } = envelope as { result?: unknown };
    throw new CliAuthError(typeof result === "string" ? result : "Claude API returned 401");
  }
  throw err;
}

/** 非ゼロ終了の `execFile` の reject が運ぶ stdout の JSON envelope。読めなければ undefined。 */
export function execFailureEnvelope(err: unknown): unknown {
  const stdout =
    typeof err === "object" && err !== null && "stdout" in err
      ? (err as { stdout?: unknown }).stdout
      : undefined;
  const text = typeof stdout === "string" ? stdout : Buffer.isBuffer(stdout) ? stdout.toString() : null;
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function quarantineCliAuthFailure(
  db: Db,
  err: unknown,
  now: Date,
  provider: Provider = "anthropic",
): void {
  if (err instanceof CliAuthError) quarantineCliAuthForProvider(db, provider, now);
}

/** ADR 0098: the machine classification of a 401 routes by the spawn/call-time
 * Provider fact, never by parsing prose from an error. Every Provider is a
 * resource-scoped quarantine; unrelated Provider workers continue. */
export function quarantineCliAuthForProvider(db: Db, provider: Provider, now: Date): void {
  registerQuarantine(db, "providerAuth", provider, "authentication failure", now);
}

export function warnCliAuthExpiry(db: Db, expiresAt: Date | undefined, now: Date): void {
  const expiry = expiresAt?.getTime();
  if (
    expiry === undefined ||
    expiry - now.getTime() > CLI_AUTH_EXPIRY_WARNING_MS ||
    db
      .prepare("SELECT 1 FROM tasks WHERE question_cli_auth_expiry_warning = ? LIMIT 1")
      .get(expiry) !== undefined
  ) {
    return;
  }
  registerTask(
    db,
    {
      type: "question",
      title: CLI_AUTH_EXPIRY_WARNING_TITLE,
      purpose:
        `The configured Claude authentication token expires at ${new Date(expiry).toISOString()}. ` +
        "Rotate it before then to avoid stopping agent pickup:\n\n" +
        "1. Run `claude setup-token` and complete the browser authorization.\n" +
        "2. Update `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/default/tidepool`. Set " +
        "`TIDEPOOL_CLAUDE_TOKEN_EXPIRES_AT` to the new expiry date if you want the next " +
        "advance warning.\n" +
        "3. Restart the service with `sudo systemctl restart tidepool`.\n" +
        "4. Return to this question and record whether rotation is complete.",
      completion_criteria: "The upcoming Claude token expiry has been acknowledged",
      question: [
        {
          title: "What is the token rotation status?",
          options: ["token rotated", "acknowledged — I will rotate it later"],
          recommendation: "token rotated",
        },
      ],
      cli_auth_expiry_warning: expiry,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}
