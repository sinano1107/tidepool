import { execFile } from "node:child_process";
import {
  boardCallEnv,
  MoonshotApiKeyMissingError,
  moonshotCliAuthEnv,
  pinnedModelFlags,
} from "./claude-worker.js";
import { type CliAuthCheck, type CliAuthResult, isCliAuthFailureEnvelope } from "./cli-auth.js";

export interface CliAuthCommandResult {
  exitCode: number | null;
  stdout: string;
}

export type CliAuthCommand = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CliAuthCommandResult>;

const defaultCommand: CliAuthCommand = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (err, stdout) => {
      resolve({
        exitCode: typeof err?.code === "number" ? err.code : err ? null : 0,
        stdout,
      });
    });
  });

/** The real authentication probe (ADR 0070). It makes one minimal model call
 * because `claude auth status` validates only credential origin, not whether
 * the token can authenticate. This is a probe Board call, so it deliberately
 * does not declare an empty tool surface. */
export function createClaudeCliAuthCheck(command: CliAuthCommand = defaultCommand): CliAuthCheck {
  return () =>
    runProbe(
      command,
      [
        ...pinnedModelFlags("haiku", "low"),
        "--max-turns",
        "1",
        "--max-budget-usd",
        "0.01",
        "--safe-mode",
      ],
      boardCallEnv(),
    );
}

/** The moonshot-speaking twin of the probe above (issue #446 / ADR 0097 決定2):
 *  the re-verification a provider-auth Confirmation question's answer fires
 *  before it is accepted. Human-originated, so this is one of ADR 0077's
 *  sanctioned active checks — never on a timer. Same 401 machine judgement;
 *  the only difference is the provider the probe speaks. A missing key file
 *  is already the definitive answer — no credential can authenticate — so it
 *  classifies as unauthorized without spending a billed probe call. */
export function createMoonshotCliAuthCheck(
  keyFile: string | undefined,
  command: CliAuthCommand = defaultCommand,
): CliAuthCheck {
  return async (): Promise<CliAuthResult> => {
    let env: NodeJS.ProcessEnv;
    try {
      env = moonshotCliAuthEnv(keyFile);
    } catch (err) {
      if (err instanceof MoonshotApiKeyMissingError) {
        return { status: "unauthorized", reason: err.message };
      }
      throw err;
    }
    return runProbe(command, ["--max-turns", "1", "--max-budget-usd", "0.01", "--safe-mode"], env);
  };
}

async function runProbe(
  command: CliAuthCommand,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliAuthResult> {
  const observed = await command(
    "claude",
    ["-p", "Reply with the single word OK.", "--output-format", "json", ...extraArgs],
    { cwd: process.cwd(), env },
  );
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(observed.stdout) as Record<string, unknown>;
  } catch {
    return { status: "unknown", reason: "probe did not return a JSON envelope" };
  }
  if (isCliAuthFailureEnvelope(envelope)) {
    return { status: "unauthorized", reason: "API returned 401" };
  }
  if (observed.exitCode === 0 && envelope.is_error !== true && typeof envelope.result === "string") {
    return { status: "authenticated" };
  }
  return { status: "unknown", reason: "probe did not return a successful authentication result" };
}
