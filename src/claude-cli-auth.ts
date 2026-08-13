import { execFile } from "node:child_process";
import { boardCallEnv, pinnedModelFlags } from "./claude-worker.js";
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
  return async (): Promise<CliAuthResult> => {
    const observed = await command(
      "claude",
      [
        "-p",
        "Reply with the single word OK.",
        "--output-format",
        "json",
        ...pinnedModelFlags("haiku", "low"),
        "--max-turns",
        "1",
        "--max-budget-usd",
        "0.01",
        "--safe-mode",
      ],
      { cwd: process.cwd(), env: boardCallEnv() },
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
  };
}
