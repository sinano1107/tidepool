import type { Db } from "./db.js";
import type { Provider } from "./registry.js";
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

/** 上限到達による中断(CONTEXT.md / ADR 0104 決定2): Provider の側から返る
 *  確定的な上限到達の証拠は `result` envelope の `api_error_status: 429` 一点で
 *  ある。認証の述語と同じ posture で、"session limit" のような文言や stream 中の
 *  `rate_limit_event` からは推測しない。 */
export function isCapInterruptionEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && "api_error_status" in value && value.api_error_status === 429;
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

export function quarantineCliAuthFailure(
  db: Db,
  err: unknown,
  now: Date,
  provider: Provider = "anthropic",
): void {
  if (err instanceof CliAuthError) quarantineCliAuthForProvider(db, provider, now);
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

/** ADR 0098: the machine classification of a 401 routes by the spawn/call-time
 * Provider fact, never by parsing prose from an error. Every Provider is a
 * resource-scoped quarantine; unrelated Provider workers continue. */
export function quarantineCliAuthForProvider(db: Db, provider: Provider, now: Date): void {
  quarantineProviderAuth(db, provider, now);
}

/** The open Confirmation question is the durable half of a provider-scoped
 *  authentication quarantine — same "1 resource, at most 1 open question"
 *  dedup as the board-wide one above. */
function openProviderAuthQuestion(db: Db, provider: Provider): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE question_quarantine_provider_auth = ? AND status = 'todo'`,
    )
    .get(provider) as { id: string } | undefined;
}

/** The providers whose authentication is currently quarantined resource-wide
 *  (ADR 0097 決定2) — the scheduler's pickup gate skips exactly the agents
 *  speaking one of these. The board-wide cliAuth halt is not in this list:
 *  it stops everything through the boardHalts enumeration instead. */
export function quarantinedAuthProviders(db: Db): Provider[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT question_quarantine_provider_auth AS provider FROM tasks
         WHERE question_quarantine_provider_auth IS NOT NULL AND status = 'todo'`,
      )
      .all() as Array<{ provider: Provider }>
  ).map((row) => row.provider);
}

/** Exhaustive repair guidance: adding a Provider is a compile error until its
 * own credential recovery path is written. */
const PROVIDER_AUTH_REPAIR_GUIDANCE: Record<Provider, string> = {
  anthropic:
    "Run `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` in " +
    "`/etc/default/tidepool`, and restart the service.",
  moonshot:
    "Place a valid Moonshot Platform API key in the board's key file " +
    "(`~/.tidepool/moonshot-api-key`, or the path `TIDEPOOL_MOONSHOT_API_KEY_FILE` " +
    "points at), mode 600.",
  openai:
    "Sign in to ChatGPT with `codex login` using the board worker's isolated " +
    "`CODEX_HOME`; API keys are not accepted for the canonical Codex route (ADR 0098).",
};

function quarantineProviderAuth(
  db: Db,
  provider: Provider,
  now: Date,
): void {
  if (openProviderAuthQuestion(db, provider)) return;
  registerTask(
    db,
    {
      type: "question",
      title: providerAuthQuestionTitle(provider),
      purpose:
        `A worker session or Board call returned an authentication failure while speaking the ${provider} ` +
        `provider, so the board has stopped pickup of the agents declared with ` +
        `\`provider: ${provider}\`. Workers and board calls on other providers are unaffected. ` +
        "Restore the credential:\n\n" +
        `1. ${PROVIDER_AUTH_REPAIR_GUIDANCE[provider]}\n` +
        "2. Return to this question and answer it.\n\n" +
        "The board checks authentication again before accepting the answer and resumes " +
        "pickup only after the check succeeds.",
      completion_criteria: `${provider} authentication has been restored`,
      question: [
        {
          title: `Has ${provider} authentication been restored?`,
          options: ["authentication restored"],
          recommendation: "authentication restored",
        },
      ],
      quarantine_provider_auth: provider,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

function providerAuthQuestionTitle(provider: Provider): string {
  return `${provider} authentication is unavailable — pickup of ${provider}-speaking agents is stopped`;
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
