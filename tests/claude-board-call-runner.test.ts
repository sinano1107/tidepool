import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runClaudeBoardCallJson } from "../src/claude-board-call-runner.js";
import type { ExecFn } from "../src/claude-worker.js";
import { CliAuthError, RowRefusalError } from "../src/cli-auth.js";

const ROW = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" } as const;
const call = (exec: ExecFn) => ({ exec, label: "test", prompt: "p", setting: ROW, reasoning: true });
const schema = z.object({ ok: z.boolean() });

describe("Claude の Board call runner", () => {
  it("JSON の答えは result から JSON を取り出して schema で検証し、usage が無ければ usage を返さない", async () => {
    await expect(
      runClaudeBoardCallJson(call(async () => JSON.stringify({ result: "```json\n{\"ok\":true}\n```" })), schema),
    ).resolves.toEqual({ output: { ok: true }, usage: undefined });
  });

  it("答えの JSON の文字列が ``` を含んでも、包む fence の有無によらず JSON を取り出す(#2414 の 20 断片実測)", async () => {
    const textSchema = z.object({ text: z.string() });
    const answer = JSON.stringify({ text: "```ts\nconst x = 1;\n```" });
    for (const result of [answer, `\`\`\`json\n${answer}\n\`\`\``]) {
      await expect(
        runClaudeBoardCallJson(call(async () => JSON.stringify({ result })), textSchema),
      ).resolves.toEqual({ output: { text: "```ts\nconst x = 1;\n```" }, usage: undefined });
    }
  });

  it("封筒が JSON でない・result が文字列でない・schema に合わない答えは reject する", async () => {
    await expect(runClaudeBoardCallJson(call(async () => "not json"), schema)).rejects.toThrow();
    await expect(runClaudeBoardCallJson(call(async () => JSON.stringify({ result: 1 })), schema)).rejects.toThrow(
      "test CLI response missing a string result field",
    );
    await expect(
      runClaudeBoardCallJson(call(async () => JSON.stringify({ result: "{\"ok\":1}" })), schema),
    ).rejects.toThrow();
  });

  it("is_error: true の封筒は result の本文を持つ error で reject する(issue #306 / #652)", async () => {
    const exec = async () => JSON.stringify({ is_error: true, result: "You've hit your session limit" });
    await expect(runClaudeBoardCallJson(call(exec), schema)).rejects.toThrow("You've hit your session limit");
  });

  const refusals = {
    api_404: { is_error: true, api_error_status: 404 },
    cli_version_too_old: { is_error: true, api_error_status: 400, api_error_code: "claude_code_version_too_old", result: "update the CLI" },
  } as const;
  const delivered = {
    "非ゼロ終了の stdout": (envelope: object): ExecFn => async () => {
      throw Object.assign(new Error("Command failed"), { stdout: JSON.stringify(envelope) });
    },
    "ゼロ終了の is_error": (envelope: object): ExecFn => async () => JSON.stringify(envelope),
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

  it("非ゼロ終了の 401 は CliAuthError、それ以外の非ゼロ終了は同じ error のまま reject する", async () => {
    const unauthorized: ExecFn = async () => {
      throw Object.assign(new Error("Command failed"), { stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: "expired" }) });
    };
    await expect(runClaudeBoardCallJson(call(unauthorized), schema)).rejects.toBeInstanceOf(CliAuthError);
    const failed = Object.assign(new Error("Command failed"), { stdout: JSON.stringify({ is_error: true, api_error_status: 500 }) });
    await expect(runClaudeBoardCallJson(call(async () => { throw failed; }), schema)).rejects.toBe(failed);
  });

  it("封筒の usage と total_cost_usd を盤面の usage の形で返す", async () => {
    const exec = async () =>
      JSON.stringify({
        result: '{"ok":true}',
        total_cost_usd: 0.000586,
        usage: { input_tokens: 506, output_tokens: 16, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      });
    await expect(runClaudeBoardCallJson(call(exec), schema)).resolves.toEqual({
      output: { ok: true },
      usage: { input_tokens: 506, output_tokens: 16, cache_read_tokens: 3, cache_creation_tokens: 4, estimated_cost_usd: 0.000586 },
    });
  });
});
