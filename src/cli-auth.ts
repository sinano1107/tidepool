import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export const CLI_AUTH_QUESTION_TITLE = "Claude authentication is unavailable — pickup is stopped";
export const CLI_AUTH_EXPIRY_WARNING_TITLE = "Claude authentication token expires soon";

export type CliAuthResult =
  | { status: "authenticated" }
  | { status: "unauthorized" | "unknown"; reason: string };

export type CliAuthCheck = () => Promise<CliAuthResult>;

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

/** `execFile` rejects on the same non-zero exit that carries Claude's JSON
 * error envelope. Preserve that structured stdout instead of falling back to
 * an error-message substring. */
export function rethrowCliAuthExecFailure(err: unknown): never {
  const stdout =
    typeof err === "object" && err !== null && "stdout" in err
      ? (err as { stdout?: unknown }).stdout
      : undefined;
  const text = typeof stdout === "string" ? stdout : Buffer.isBuffer(stdout) ? stdout.toString() : null;
  if (text !== null) {
    try {
      const envelope = JSON.parse(text) as Record<string, unknown>;
      if (isCliAuthFailureEnvelope(envelope)) {
        throw new CliAuthError(
          typeof envelope.result === "string" ? envelope.result : "Claude API returned 401",
        );
      }
    } catch (parsed) {
      if (parsed instanceof CliAuthError) throw parsed;
    }
  }
  throw err;
}

export function quarantineCliAuthFailure(db: Db, err: unknown, now: Date): void {
  if (err instanceof CliAuthError) quarantineCliAuth(db, now);
}

/** The open Confirmation question is the durable half of the board-wide
 * authentication quarantine. Recovery alone never resumes pickup without
 * human acknowledgement. */
export function openCliAuthQuestion(db: Db): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE question_quarantine_cli_auth IS NOT NULL AND status = 'todo'`,
    )
    .get() as { id: string } | undefined;
}

export function quarantineCliAuth(db: Db, now: Date): void {
  if (openCliAuthQuestion(db)) return;
  registerTask(
    db,
    {
      type: "question",
      title: CLI_AUTH_QUESTION_TITLE,
      purpose:
        "The Claude CLI returned an authentication failure, so the board has stopped all agent " +
        "pickup. Restore authentication on the Pi:\n\n" +
        "1. Run `claude setup-token` and complete the browser authorization.\n" +
        "2. Update `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/default/tidepool`. You may also set " +
        "`TIDEPOOL_CLAUDE_TOKEN_EXPIRES_AT` to enable an advance expiry warning.\n" +
        "3. Restart the service with `sudo systemctl restart tidepool`.\n" +
        "4. Return to this question and answer it.\n\n" +
        "The board checks authentication again before accepting the answer and resumes pickup " +
        "only after the check succeeds.",
      completion_criteria: "Claude authentication has been restored",
      question: [
        {
          title: "Has Claude authentication been restored?",
          options: ["authentication restored"],
          recommendation: "authentication restored",
        },
      ],
      quarantine_cli_auth: true,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
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

/** Periodically checks the configured expiry date. This intentionally makes
 * no Claude call: authentication is detected only on a real use of Claude
 * (ADR 0077). */
export function startCliAuthExpiryWarningTimer(deps: {
  db: Db;
  clock: Clock;
  expiresAt?: Date;
}): () => void {
  return deps.clock.setInterval(
    () => warnCliAuthExpiry(deps.db, deps.expiresAt, deps.clock.now()),
    CLI_AUTH_EXPIRY_WARNING_INTERVAL_MS,
  );
}
