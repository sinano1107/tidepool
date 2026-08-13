import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export const CLI_AUTH_QUESTION_TITLE = "Claude authentication is unavailable — pickup is stopped";
export const CLI_AUTH_EXPIRY_WARNING_TITLE = "Claude authentication token expires soon";

export type CliAuthResult =
  | { status: "authenticated" }
  | { status: "unauthorized" | "unknown"; reason: string };

export type CliAuthCheck = () => Promise<CliAuthResult>;

export const CLI_AUTH_PROBE_INTERVAL_MS = 30 * 60 * 1000;
const CLI_AUTH_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

export function resolveCliAuthExpiry(
  value: string | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): Date | undefined {
  if (value === undefined) return undefined;
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime())) {
    warn(
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
      if (envelope.api_error_status === 401) {
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

export function quarantineCliAuthFailure(db: Db, err: unknown, now: Date): boolean {
  if (!(err instanceof CliAuthError)) return false;
  quarantineCliAuth(db, now);
  return true;
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

function cliAuthExpiryWarningExists(db: Db): boolean {
  return (
    db
      .prepare("SELECT 1 FROM tasks WHERE question_cli_auth_expiry_warning IS NOT NULL LIMIT 1")
      .get() !== undefined
  );
}

export function warnCliAuthExpiry(db: Db, expiresAt: Date | undefined, now: Date): void {
  if (
    expiresAt === undefined ||
    expiresAt.getTime() - now.getTime() > CLI_AUTH_EXPIRY_WARNING_MS ||
    cliAuthExpiryWarningExists(db)
  ) {
    return;
  }
  registerTask(
    db,
    {
      type: "question",
      title: CLI_AUTH_EXPIRY_WARNING_TITLE,
      purpose:
        `The configured Claude authentication token expires at ${expiresAt.toISOString()}. ` +
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
      cli_auth_expiry_warning: true,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

/** Periodic Board-call probe. Only a definitive unauthorized result creates
 * the quarantine; an unknown result is not promoted out of throttle's
 * existing fail-closed posture (ADR 0070). */
export function startCliAuthMonitor(deps: {
  db: Db;
  clock: Clock;
  check: CliAuthCheck;
  expiresAt?: Date;
}): { probeNow: () => Promise<void>; stop: () => void } {
  let running: Promise<void> | null = null;
  const probeNow = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      warnCliAuthExpiry(deps.db, deps.expiresAt, deps.clock.now());
      if (openCliAuthQuestion(deps.db)) return;
      let result: CliAuthResult;
      try {
        result = await deps.check();
      } catch (err) {
        console.warn("[cli-auth] authentication probe failed without a definitive result", err);
        return;
      }
      if (result.status === "unauthorized") quarantineCliAuth(deps.db, deps.clock.now());
    })().finally(() => {
      running = null;
    });
    return running;
  };
  const stop = deps.clock.setInterval(() => void probeNow(), CLI_AUTH_PROBE_INTERVAL_MS);
  return { probeNow, stop };
}
