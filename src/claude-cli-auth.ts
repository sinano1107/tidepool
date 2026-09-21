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
} from "./cli-auth.js";

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
    runProbe(
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
    return runProbe(command, ["--max-turns", "1", "--max-budget-usd", "0.25", "--safe-mode"], env);
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
  // 予算キャップは呼び出し完了後に判定されるため、認証が起きたか否かは何も語らない —
  // 「認証できなかった」でも「試す前に止まった」でもなく「判定を返す前にキャップへ
  // 当たった」。一般の unknown と区別できる文言にして解除拒否(409)の理由が追える
  // ようにする(issue #466、issue #737)
  if (isCliAuthBudgetCapEnvelope(envelope)) {
    return {
      status: "unknown",
      reason: "probe hit its budget cap before returning an authentication verdict",
    };
  }
  if (observed.exitCode === 0 && envelope.is_error !== true && typeof envelope.result === "string") {
    return { status: "authenticated" };
  }
  return { status: "unknown", reason: "probe did not return a successful authentication result" };
}
