import { type BoardCall, readOutput } from "./board-call.js";
import {
  boardCallEnv,
  MoonshotApiKeyMissingError,
  moonshotCliAuthEnv,
  pinnedModelFlags,
} from "./claude-worker.js";
import {
  type CliAuthCheck,
  type CliAuthResult,
  isCliAuthBudgetCapEnvelope,
  isCliAuthFailureEnvelope,
  type ModelProbe,
  type ModelProbeResult,
  rowRefusalCause,
} from "./cli-auth.js";
import type { RowRefusalCause } from "./events.js";

export interface CliAuthCommandResult {
  exitCode: number | null;
  stdout: string;
}

export type CliAuthCommand = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CliAuthCommandResult>;

// 認証 probe(Claude / moonshot)の上限 —— 最小1ターンのモデル呼び出しが冷えた
// CLI の起動込みで収まる幅に取る。
const CLI_AUTH_PROBE_LIMIT_MS = 60_000;

/** `CliAuthCommand` の本番の実装: 1回を Board call の口に通す(ADR 0136 決定2)。
 *  口が答えを返さなかったときは exit code も stdout も無い観測に写す —— 分類は
 *  「JSON envelope が無い」= 判定不能に倒れ、認証失敗とは読まれない。 */
export const cliAuthCommandThrough =
  (call: BoardCall, kind: string): CliAuthCommand =>
  async (command, args, options) =>
    (await call(
      { kind, command, args, cwd: options.cwd, env: options.env, limitMs: CLI_AUTH_PROBE_LIMIT_MS },
      readOutput,
    )) ?? { exitCode: null, stdout: "" };

/** The real authentication probe (ADR 0070). It makes one minimal model call
 * because `claude auth status` validates only credential origin, not whether
 * the token can authenticate. This is a probe Board call, so it deliberately
 * does not declare an empty tool surface. */
export function createClaudeCliAuthCheck(command: CliAuthCommand): CliAuthCheck {
  return () =>
    runAuthProbe(
      command,
      [
        ...pinnedModelFlags("haiku", "low"),
        "--max-turns",
        "1",
        // 予算は haiku 最小1ターンの実測 $0.0114(2026-09-18 Lima friend-test 実測、claude 2.1.273、
        // list 単価)の約2倍。$0.01 では probe が必ず error_max_budget_usd で止まり quarantine
        // 解除不能になる(issue #737)
        "--max-budget-usd",
        "0.025",
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
  command: CliAuthCommand,
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
    // 予算は kimi-k3[1m] 最小1ターンの実測 $0.057〜$0.122(2026-08-24 ライブ実測、issue #447)
    // の約2倍。$0.01 では probe が必ず error_max_budget_usd で止まり quarantine 解除不能になる(issue #466)
    return runAuthProbe(command, ["--max-turns", "1", "--max-budget-usd", "0.25", "--safe-mode"], env);
  };
}

/** 行の Quarantine の回答時の probe(ADR 0184 決定5): 認証 probe と同じ形に、その id の
 *  `--model` を付ける。予算は認証 probe と同じ値で足りる —— 上限はターンが走った後に判定され、
 *  上限で止まっても「走った」と読む(`runModelProbe`)ので、#466 の解除不能はここでは起きない。 */
export function createClaudeModelProbe(command: CliAuthCommand): ModelProbe {
  return (model) =>
    runModelProbe(
      command,
      [...pinnedModelFlags(model, "low"), "--max-turns", "1", "--max-budget-usd", "0.025", "--safe-mode"],
      boardCallEnv(),
    );
}

/** moonshot の双子。model は worker の spawn と同じく `--model` と `ANTHROPIC_MODEL` の両方に載せる
 *  (どちらが勝っても同じ id を測る)。鍵ファイルが無ければ認証 probe と同じく unauthorized。 */
export function createMoonshotModelProbe(keyFile: string | undefined, command: CliAuthCommand): ModelProbe {
  return async (model) => {
    let env: NodeJS.ProcessEnv;
    try {
      env = { ...moonshotCliAuthEnv(keyFile), ANTHROPIC_MODEL: model };
    } catch (err) {
      if (err instanceof MoonshotApiKeyMissingError) return { status: "unauthorized", reason: err.message };
      throw err;
    }
    return runModelProbe(command, ["--model", model, "--max-turns", "1", "--max-budget-usd", "0.25", "--safe-mode"], env);
  };
}

/** 回答の拒否(409)の本文は「… still cannot run: 」の後にこの理由を載せる。 */
const MODEL_PROBE_REFUSAL_REASON: Record<RowRefusalCause, string> = {
  api_404: "API returned 404 for this model id",
  cli_version_too_old:
    "this board's Claude Code CLI is older than this model requires (API error code claude_code_version_too_old)",
};

async function runModelProbe(
  command: CliAuthCommand,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<ModelProbeResult> {
  const { exitCode, envelope } = await probeEnvelope(command, extraArgs, env);
  if (envelope === null) return { status: "unknown", reason: "probe did not return a JSON envelope" };
  if (isCliAuthFailureEnvelope(envelope)) return { status: "unauthorized", reason: "API returned 401" };
  const refusal = rowRefusalCause(envelope);
  if (refusal !== null) return { status: "refused", reason: MODEL_PROBE_REFUSAL_REASON[refusal] };
  // 予算上限はターンが走った後に判定される(2026-10-01 実測: $0.0001 でも1ターン走って
  // error_max_budget_usd)—— 上限で止まったなら、その id は走った
  if (isCliAuthBudgetCapEnvelope(envelope)) return { status: "runs" };
  if (exitCode === 0 && envelope.is_error !== true && typeof envelope.result === "string") return { status: "runs" };
  return { status: "unknown", reason: "probe did not return a successful result" };
}

async function probeEnvelope(
  command: CliAuthCommand,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; envelope: Record<string, unknown> | null }> {
  const observed = await command(
    "claude",
    ["-p", "Reply with the single word OK.", "--output-format", "json", ...extraArgs],
    { cwd: process.cwd(), env },
  );
  try {
    return { exitCode: observed.exitCode, envelope: JSON.parse(observed.stdout) as Record<string, unknown> };
  } catch {
    return { exitCode: observed.exitCode, envelope: null };
  }
}

async function runAuthProbe(
  command: CliAuthCommand,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliAuthResult> {
  const { exitCode, envelope } = await probeEnvelope(command, extraArgs, env);
  if (envelope === null) {
    return { status: "unknown", reason: "probe did not return a JSON envelope" };
  }
  if (isCliAuthFailureEnvelope(envelope)) {
    return { status: "unauthorized", reason: "API returned 401" };
  }
  // 予算キャップは呼び出し完了後に判定されるため、認証が起きたか否かは何も語らない。
  // 一般の unknown と区別できる文言にして解除拒否(409)の理由が追えるようにする(issue #466、issue #737)
  if (isCliAuthBudgetCapEnvelope(envelope)) {
    return {
      status: "unknown",
      reason: "probe hit its budget cap before returning an authentication verdict",
    };
  }
  if (exitCode === 0 && envelope.is_error !== true && typeof envelope.result === "string") {
    return { status: "authenticated" };
  }
  return { status: "unknown", reason: "probe did not return a successful authentication result" };
}
