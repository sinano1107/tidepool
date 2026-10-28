import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BoardCallUsageError } from "../src/board-call-usage.js";
import { runClaudeBoardCallJson } from "../src/claude-board-call-runner.js";
import type { ExecFn } from "../src/claude-worker.js";
import { CliAuthError, RowRefusalError } from "../src/cli-auth.js";
import { boardCallStream, CLI_ENVELOPE_USAGE, BOARD_CALL_USAGE as USAGE } from "./fakes.js";

const ROW = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" } as const;
const call = (exec: ExecFn) => ({ exec, label: "test", prompt: "p", setting: ROW, reasoning: true });
const schema = z.object({ ok: z.boolean() });
/** usage を報告した封筒 */
const answered = (envelope: object): ExecFn => async () => boardCallStream({ ...envelope, ...CLI_ENVELOPE_USAGE });

// Synthetic pinned-CLI stream shapes; natural Board call refusal is unobserved (#1615).
const swap = { type: "system", subtype: "model_refusal_fallback", original_model: "claude-sonnet-5-5", fallback_model: "claude-opus-4-8", api_refusal_category: "category one" };
const refusal = (id: string, category: string | null) => ({ type: "assistant", parent_tool_use_id: null, message: { id, stop_reason: "refusal", stop_details: { category } } });
const stream = (...lines: object[]) => lines.map((line) => JSON.stringify(line)).join("\n");

it("stream の差し替えと root 拒否を逐語・出た順で返し、同じ message.id の拒否は1つ、最後の result の usage を採る", async () => {
  const stdout = stream(
    { type: "system", subtype: "init" },
    { type: "result", result: '{"ok":false}', ...CLI_ENVELOPE_USAGE, total_cost_usd: 99 },
    swap,
    refusal("first", "verbatim category"),
    refusal("first", "duplicate block"),
    { ...refusal("subagent", "ignored"), parent_tool_use_id: "tool" },
    { ...swap, original_model: "claude-opus-4-8", fallback_model: "verbatim model", scope: "local", api_refusal_category: null },
    refusal("second", null),
    { type: "result", result: '{"ok":true}', ...CLI_ENVELOPE_USAGE },
    { type: "system", subtype: "unrelated" },
  );
  await expect(runClaudeBoardCallJson(call(async () => stdout), schema)).resolves.toEqual({
    output: { ok: true }, usage: USAGE, setting: ROW,
    model_swaps: [
      { from: "claude-sonnet-5-5", to: "claude-opus-4-8", scope: null, category: "category one" },
      { from: "claude-opus-4-8", to: "verbatim model", scope: "local", category: null },
    ],
    refusals: ["verbatim category", null],
  });
});

it("usage を運ぶ失敗は schema 不一致・is_error・非ゼロ終了とも stream の観測を保つ", async () => {
  for (const result of ['{"ok":1}', "not json", "CLI failed"]) {
    const stdout = stream({ type: "result", ...CLI_ENVELOPE_USAGE, total_cost_usd: 99, result: '{"ok":true}' }, swap, refusal("refused", "raw category"), { type: "result", ...CLI_ENVELOPE_USAGE, result, is_error: result === "CLI failed" });
    const exited = Object.assign(new Error("exited"), { stdout: Buffer.from(stdout) });
    for (const exec of [async () => stdout, async () => { throw exited; }]) {
      const err = await runClaudeBoardCallJson(call(exec), schema).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(BoardCallUsageError);
      expect(err).toMatchObject({ setting: ROW, usage: USAGE, model_swaps: [{ from: "claude-sonnet-5-5", to: "claude-opus-4-8", scope: null, category: "category one" }], refusals: ["raw category"] });
    }
  }
});

describe("Claude の Board call runner", () => {
  it("JSON の答えは result から JSON を取り出して schema で検証し、封筒の usage と撃った行と一緒に返す", async () => {
    await expect(
      runClaudeBoardCallJson(call(answered({ result: "```json\n{\"ok\":true}\n```" })), schema),
    ).resolves.toEqual({ output: { ok: true }, usage: USAGE, setting: ROW, model_swaps: [], refusals: [] });
  });

  it("答えを取りに行く呼び出しの封筒に usage が無ければ、呼び出しの失敗にする(ADR 0299 決定4)", async () => {
    await expect(
      runClaudeBoardCallJson(call(async () => boardCallStream({ result: '{"ok":true}' })), schema),
    ).rejects.toThrow("test CLI response missing usage");
  });

  it("usage を報告した封筒の答えが schema に合わなければ、撃った行と usage を運ぶ error を投げる(ADR 0299 決定3)", async () => {
    for (const result of ['{"ok":1}', "not json"]) {
      const err = await runClaudeBoardCallJson(call(answered({ result })), schema).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoardCallUsageError);
      expect(err).toMatchObject({ setting: ROW, usage: USAGE });
    }
  });

  it("usage つきの is_error は、非ゼロ終了で届いても撃った行と usage を運ぶ error を投げる(ADR 0299 決定3、#652)", async () => {
    const envelope = boardCallStream({ is_error: true, result: "You've hit your session limit", ...CLI_ENVELOPE_USAGE });
    const exited: ExecFn = async () => {
      throw Object.assign(new Error("Command failed: claude exited 1"), { stdout: envelope });
    };
    for (const exec of [exited, async () => envelope]) {
      const err = await runClaudeBoardCallJson(call(exec), schema).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoardCallUsageError);
      expect(err).toMatchObject({ setting: ROW, usage: USAGE });
    }
  });

  it("答えの JSON の文字列が ``` を含んでも、包む fence の有無によらず JSON を取り出す(#2414 の 20 断片実測)", async () => {
    const textSchema = z.object({ text: z.string() });
    const answer = JSON.stringify({ text: "```ts\nconst x = 1;\n```" });
    for (const result of [answer, `\`\`\`json\n${answer}\n\`\`\``]) {
      await expect(
        runClaudeBoardCallJson(call(answered({ result })), textSchema),
      ).resolves.toHaveProperty("output", { text: "```ts\nconst x = 1;\n```" });
    }
  });

  it("封筒が JSON でない・result が文字列でない・schema に合わない答えは reject する", async () => {
    await expect(runClaudeBoardCallJson(call(async () => "not json"), schema)).rejects.toThrow();
    await expect(runClaudeBoardCallJson(call(async () => boardCallStream({ result: 1 })), schema)).rejects.toThrow(
      "test CLI response missing a string result field",
    );
    await expect(
      runClaudeBoardCallJson(call(async () => boardCallStream({ result: "{\"ok\":1}" })), schema),
    ).rejects.toThrow();
  });

  it("is_error: true の封筒は result の本文を持つ error で reject する(issue #306 / #652)", async () => {
    const exec = async () => boardCallStream({ is_error: true, result: "You've hit your session limit" });
    await expect(runClaudeBoardCallJson(call(exec), schema)).rejects.toThrow("You've hit your session limit");
  });

  const refusals = {
    api_404: { is_error: true, api_error_status: 404 },
    cli_version_too_old: { is_error: true, api_error_status: 400, api_error_code: "claude_code_version_too_old", result: "update the CLI" },
  } as const;
  const delivered = {
    "非ゼロ終了の stdout": (envelope: object): ExecFn => async () => {
      throw Object.assign(new Error("Command failed"), { stdout: boardCallStream(envelope) });
    },
    "ゼロ終了の is_error": (envelope: object): ExecFn => async () => boardCallStream(envelope),
  } as const;
  for (const [cause, envelope] of Object.entries(refusals)) {
    for (const [how, exec] of Object.entries(delivered)) {
      it(`${cause} が${how}で届くと、cause と撃った行を持つ行の拒否を投げる(ADR 0202 決定1)`, async () => {
        const err = await runClaudeBoardCallJson(call(exec(envelope)), schema).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RowRefusalError);
        expect(err).toMatchObject({ cause, provider: "anthropic", model: "claude-sonnet-5-5" });
      });
    }
  }

  it("401 の封筒は、どちらの経路で届いても CliAuthError で reject する(ADR 0070)", async () => {
    for (const exec of Object.values(delivered)) {
      const err = await runClaudeBoardCallJson(call(exec({ is_error: true, api_error_status: 401, result: "expired" })), schema).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliAuthError);
      expect(err).toHaveProperty("message", "expired");
    }
  });

  it("usage つきの 401 は行を残す error にせず、どちらの経路でも CliAuthError のまま投げる(ADR 0299 決定3)", async () => {
    for (const exec of Object.values(delivered)) {
      const err = await runClaudeBoardCallJson(call(exec({ is_error: true, api_error_status: 401, result: "expired", ...CLI_ENVELOPE_USAGE })), schema).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliAuthError);
      expect(err).not.toBeInstanceOf(BoardCallUsageError);
    }
  });

  it("usage つきの 429 は、どちらの経路で届いても usage を運ばない error で reject する(ADR 0299 追記、#2486)", async () => {
    // tests/fixtures/worker-session-cap-429.stream.jsonl の result 行(2.1.241 の session 上限)の欄
    const capped = {
      is_error: true,
      subtype: "success",
      api_error_status: 429,
      terminal_reason: "api_error",
      num_turns: 1,
      duration_api_ms: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      result: "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
    };
    for (const exec of Object.values(delivered)) {
      const err = await runClaudeBoardCallJson(call(exec(capped)), schema).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BoardCallUsageError);
    }
  });

  it("非ゼロ終了の 401 は CliAuthError、それ以外の非ゼロ終了は同じ error のまま reject する", async () => {
    const unauthorized: ExecFn = async () => {
      throw Object.assign(new Error("Command failed"), { stdout: boardCallStream({ is_error: true, api_error_status: 401, result: "expired" }) });
    };
    await expect(runClaudeBoardCallJson(call(unauthorized), schema)).rejects.toBeInstanceOf(CliAuthError);
    const failed = Object.assign(new Error("Command failed"), { stdout: boardCallStream({ is_error: true, api_error_status: 500 }) });
    await expect(runClaudeBoardCallJson(call(async () => { throw failed; }), schema)).rejects.toBe(failed);
  });

  it("--safe-mode に加えて --setting-sources \"\" を渡し、設定の層を1つも読まない(ADR 0303 決定1)", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_command, args) => {
      calls.push(args);
      return boardCallStream({ result: '{"ok":true}', ...CLI_ENVELOPE_USAGE });
    };
    await runClaudeBoardCallJson(call(exec), schema);
    expect(calls[0]![calls[0]!.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(calls[0]).toContain("--verbose");
    expect(calls[0]).toContain("--safe-mode");
    expect(calls[0]![calls[0]!.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("封筒の usage と total_cost_usd を盤面の usage の形で返す", async () => {
    const exec = async () =>
      boardCallStream({
        result: '{"ok":true}',
        total_cost_usd: 0.000586,
        usage: { input_tokens: 506, output_tokens: 16, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      });
    await expect(runClaudeBoardCallJson(call(exec), schema)).resolves.toHaveProperty("usage", {
      input_tokens: 506,
      output_tokens: 16,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      estimated_cost_usd: 0.000586,
    });
  });
});
