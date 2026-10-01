import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  cliAuthCommandThrough,
  createClaudeCliAuthCheck,
  createClaudeModelProbe,
  createMoonshotModelProbe,
} from "../src/claude-cli-auth.js";
import { isCapInterruptionEnvelope, isCliAuthFailureEnvelope, rowRefusalCause } from "../src/cli-auth.js";
import { ProcessContainers } from "../src/process-container.js";
import { containerHarness, FakeClock, FakeContainerRuntime, recordingSpawn } from "./fakes.js";
import { tempDir } from "./harness.js";

it("JSON envelope の api_error_status: 401 だけを確定的な認証失敗に分類する(ADR 0070)", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    }),
  }));

  await expect(check()).resolves.toEqual({ status: "unauthorized", reason: "API returned 401" });
});

it("result 文言に401があっても api_error_status が401でなければ認証失敗に分類しない", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      api_error_status: 500,
      result: "a misleading message contains 401",
    }),
  }));

  await expect(check()).resolves.toEqual({
    status: "unknown",
    reason: "probe did not return a successful authentication result",
  });
});

it("api_error_status: 401 と subtype: error_max_budget_usd が同時に立つ envelope は unauthorized を優先する(issue #737)", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      api_error_status: 401,
      subtype: "error_max_budget_usd",
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    }),
  }));

  await expect(check()).resolves.toEqual({ status: "unauthorized", reason: "API returned 401" });
});

it("成功したJSON envelope は認証済みと判定する", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ is_error: false, result: "OK" }),
  }));

  await expect(check()).resolves.toEqual({ status: "authenticated" });
});

it("probe の予算は $0.025 — haiku 最小1ターンの実測($0.0114、issue #737)を $0.01 では必ず踏む", async () => {
  let observedArgs: string[] | undefined;
  const check = createClaudeCliAuthCheck(async (_command, args) => {
    observedArgs = args;
    return { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }) };
  });

  await check();

  const flagIndex = observedArgs?.indexOf("--max-budget-usd") ?? -1;
  expect(flagIndex).toBeGreaterThan(-1);
  expect(observedArgs?.[flagIndex + 1]).toBe("0.025");
});

it("認証 probe は Board call の口を通り、口が答えを返さなければ(上限到達)判定不能に倒れる", async () => {
  const spawn = recordingSpawn();
  const clock = new FakeClock();
  const { boardCall } = containerHarness(new ProcessContainers(new FakeContainerRuntime(spawn.spawn)), clock);
  const result = createClaudeCliAuthCheck(cliAuthCommandThrough(boardCall, "Claude authentication probe"))();
  await vi.waitFor(() => expect(spawn.calls.map((c) => c.command)).toEqual(["claude"]));

  await clock.advance(60_000);

  await expect(result).resolves.toEqual({ status: "unknown", reason: "probe did not return a JSON envelope" });
});

it("error_max_budget_usd エンベロープは unknown のまま、予算超過と判る reason を返す(issue #737)", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      subtype: "error_max_budget_usd",
      result: "Reached max budget ($0.025)",
    }),
  }));

  await expect(check()).resolves.toEqual({
    status: "unknown",
    reason: "probe hit its budget cap before returning an authentication verdict",
  });
});

/** 上限到達による中断(ADR 0104 決定2)の述語。認証の述語と同じ場所・同じ確度で
 *  「envelope の構造化フィールド一点」だけを見る。 */
it("result envelope の api_error_status: 429 だけを上限到達による中断に分類する(ADR 0104 決定2)", () => {
  // #447 のライブ検証(2026-08-24、Claude Code 2.1.241)の逐語
  expect(
    isCapInterruptionEnvelope({
      is_error: true,
      subtype: "success",
      api_error_status: 429,
      terminal_reason: "api_error",
      result: "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
    }),
  ).toBe(true);
});

it("401 / 500 の envelope は上限到達による中断ではない — 認証失敗と混ざらない", () => {
  expect(isCapInterruptionEnvelope({ is_error: true, api_error_status: 401 })).toBe(false);
  expect(isCapInterruptionEnvelope({ is_error: true, api_error_status: 500 })).toBe(false);
  expect(isCliAuthFailureEnvelope({ is_error: true, api_error_status: 429 })).toBe(false);
});

it("api_error_status を伴わない「session limit」の文言からは推測しない", () => {
  expect(
    isCapInterruptionEnvelope({
      is_error: true,
      result: "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
    }),
  ).toBe(false);
  // stream 中の rate_limit_event も判定の根拠にしない(ADR 0104 決定2)
  expect(
    isCapInterruptionEnvelope({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    }),
  ).toBe(false);
  expect(isCapInterruptionEnvelope(null)).toBe(false);
});

/** 行の拒否(CONTEXT.md / ADR 0184 決定3・ADR 0187 決定1)の証拠の分類。401 / 429 と同じ形で、envelope の
 *  構造化フィールド一点だけを見る。 */
it("result envelope の api_error_status: 404 だけを行の拒否に分類する(ADR 0184 決定3)", () => {
  // moonshot(Claude CLI 2.1.286)が未知の id に返した envelope の形(2026-10-01 実測、#1249)
  expect(
    rowRefusalCause({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 404,
      total_cost_usd: 0,
      modelUsage: {},
    }),
  ).toBe("api_404");
  expect(rowRefusalCause({ is_error: true, api_error_status: 401 })).toBeNull();
  expect(rowRefusalCause({ is_error: true, api_error_status: 429 })).toBeNull();
  expect(isCliAuthFailureEnvelope({ is_error: true, api_error_status: 404 })).toBe(false);
  expect(isCapInterruptionEnvelope({ is_error: true, api_error_status: 404 })).toBe(false);
});

it("api_error_status を伴わない文言(result の本文・stderr の unrecognized_model)からは行の拒否と推測しない", () => {
  expect(rowRefusalCause({ is_error: true, result: "API Error: 404 model not found" })).toBeNull();
  // stderr の `[claude-code:unrecognized_model]` は走る `kimi-k3[1m]` でも出る(2026-10-01 実測)
  expect(rowRefusalCause({ is_error: true, result: "[claude-code:unrecognized_model] kimi-k3[1m]" })).toBeNull();
  expect(rowRefusalCause(null)).toBeNull();
});

/** CLI の版が model の最低版に届かない拒否の result 行。2.1.285 以降の実物の result 行は観測していない ——
 *  2.1.286 の result 行の schema から組み立てた(#1267)。`result` の文は 2.1.241 で debug 出力に実測した API の本文。 */
const VERSION_TOO_OLD = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 400,
  api_error_code: "claude_code_version_too_old",
  api_error: "claude_code_version_too_old",
  result:
    "Claude Code 2.1.241 does not support this model; version 2.1.251 or newer is required. " +
    "Run 'claude update', or update the Claude desktop app, then try again.",
  total_cost_usd: 0,
  modelUsage: {},
};

it("result envelope の api_error_code: claude_code_version_too_old を CLI の版の古さに分類する(ADR 0187 決定1)", () => {
  expect(rowRefusalCause(VERSION_TOO_OLD)).toBe("cli_version_too_old");
  expect(isCliAuthFailureEnvelope(VERSION_TOO_OLD)).toBe(false);
  expect(isCapInterruptionEnvelope(VERSION_TOO_OLD)).toBe(false);
});

it("api_error_code を伴わない 400・文言・api_error からは CLI の版の古さと推測しない", () => {
  const { api_error_code: _, ...withoutCode } = VERSION_TOO_OLD;
  // api_error は CLI の enum で、サーバの識別子ではない(ADR 0187 決定1)
  expect(rowRefusalCause(withoutCode)).toBeNull();
  expect(rowRefusalCause({ type: "result", is_error: true, api_error_status: 400 })).toBeNull();
  expect(rowRefusalCause({ type: "result", is_error: true, result: VERSION_TOO_OLD.result })).toBeNull();
  // 2.1.241 は API の details を result 行に載せず、api_error_code も api_error も無い(#1267 の実測)
  expect(
    rowRefusalCause({ type: "result", subtype: "success", is_error: true, api_error_status: 400, result: VERSION_TOO_OLD.result }),
  ).toBeNull();
});

/** 行の Quarantine の回答時の probe(ADR 0184 決定5)。 */
it("行の probe はその id を --model に載せて1ターン走らせ、404 は refused・401 は unauthorized・予算上限は runs(上限はターンの後に判定される)", async () => {
  const envelopes: Array<[number, object]> = [
    [1, { is_error: true, subtype: "success", api_error_status: 404 }],
    [1, { is_error: true, api_error_status: 401 }],
    // 2026-10-01 実測: --max-budget-usd 0.0001 でも claude-fable-5-1 は1ターン走って上限で止まる
    [1, { is_error: true, subtype: "error_max_budget_usd", modelUsage: { "claude-fable-5-1": {} } }],
    [0, { is_error: false, result: "OK" }],
    [1, { is_error: true, api_error_status: 500 }],
  ];
  const args: string[][] = [];
  const probe = createClaudeModelProbe(async (_command, observed) => {
    args.push(observed);
    const [exitCode, envelope] = envelopes[args.length - 1]!;
    return { exitCode, stdout: JSON.stringify(envelope) };
  });

  const results = [];
  for (const _ of envelopes) results.push((await probe("claude-fable-5-1")).status);

  expect(results).toEqual(["refused", "unauthorized", "runs", "runs", "unknown"]);
  expect(args[0]!.join(" ")).toContain("--model claude-fable-5-1");
});

it("行の probe は CLI の版の古さも refused と読み、理由に原因を名指す(ADR 0187 決定3)", async () => {
  const probe = createClaudeModelProbe(async () => ({ exitCode: 1, stdout: JSON.stringify(VERSION_TOO_OLD) }));

  const result = await probe("claude-fable-5-1");

  expect(result.status).toBe("refused");
  expect(result).toMatchObject({ reason: expect.stringContaining("this board's Claude Code CLI is older than this model requires") });
});

it("moonshot の行の probe は --model と ANTHROPIC_MODEL の両方にその id を載せる(worker の spawn と同じ)", async () => {
  const keyFile = join(await tempDir("tidepool-moonshot-key-"), "moonshot-api-key");
  writeFileSync(keyFile, "sk-moonshot-test-key\n", { mode: 0o600 });
  let observed: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const probe = createMoonshotModelProbe(keyFile, async (_command, args, { env }) => {
    observed = { args, env };
    return { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }) };
  });

  expect(await probe("kimi-k2-5")).toEqual({ status: "runs" });
  expect(observed!.args.join(" ")).toContain("--model kimi-k2-5");
  expect(observed!.env.ANTHROPIC_MODEL).toBe("kimi-k2-5");
});
