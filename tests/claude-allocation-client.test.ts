import { expect, it } from "vitest";
import type { AllocationReviewInput } from "../src/allocation-review.js";
import { ClaudeAllocationClient } from "../src/claude-allocation-client.js";
import { BOARD_CALL_SYSTEM_PROMPT } from "../src/claude-board-call-runner.js";

const input: AllocationReviewInput = {
  verdict: "accepted",
  findings: "## Outcome\n\nfine",
  setting: {
    provider: "anthropic",
    model: "sonnet",
    effort: "high",
    advisor: null,
    source: { tier: "board", provider: "only" },
  },
  tier: "economy",
  usage: null,
  actions: null,
};

const judgment = { allocation: "appropriate", cause: "uncertain", evidence: "clean handoff" };

it("judge は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON 判定を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeAllocationClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ result: `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\`` });
    },
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toEqual(judgment);

  const { args, env } = calls[0]!;
  const argLine = args.join(" ");
  expect(argLine).toContain("--model fable");
  expect(argLine).toContain("--effort high");
  expect(argLine).toContain("--max-turns 1");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  // the input rides in the prompt — the verdict and the setting under judgment
  expect(args[1]).toContain("accepted");
  expect(args[1]).toContain('"model": "sonnet"');
  expect(args[1]).toContain('"tier": "economy"');
  expect(args[1]).toContain("The tier is the quality floor this session ran at, and setting.source.tier identifies who set that floor.");
  // usage / actions / usage.advisor.usage の null は観測なしであって 0 でも「何もしなかった」でもない(ADR 0083 追記10)
  expect(args[1]).toContain(
    'A null usage (the session filed no consumption report), actions (the action counts were not observed), or usage.advisor.usage (the advisor\'s share of the consumption could not be measured) means that value was not observed — never zero, never "did nothing", never zero cost; do not read it as evidence either way.',
  );
  // 上位の token 欄は親スレッドの通常の推論だけで compaction も入らず、Claude の models / cost は subagent・advisor・compaction を含み、
  // Codex の subagent と compaction の消費は観測されない(ADR 0297 決定1・2)
  expect(args[1]).toContain(
    "The token counts in usage cover the worker's main thread only, and leave out context compaction. For Claude, usage.models and usage.estimated_cost_usd include subagents, the advisor and compaction; for Codex, neither subagent nor compaction consumption is observed anywhere, so its counts can be lower than what the session actually used — do not read a small Codex count as evidence the session was cheap.",
  );
  // cause の memory は配分評価の入力に読んだ記憶が無いので載せない(ADR 0166 決定1)
  expect(args[1]).toContain('"cause" (one of capability / task_ambiguity / missing_information / environment / preference / requirement_change / uncertain —');
  // environment は worker の外側の事情で、線は判断の妥当性(ADR 0213 決定1)
  expect(args[1]).toContain(
    "environment is the worker's surroundings — board tooling, network or sandbox trouble, or an upstream change — when the worker's judgment was sound given what it had",
  );
});

it("配分評価は、用途に依らない盤面の system prompt を --system-prompt で渡す(ADR 0296 決定6)", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeAllocationClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ result: `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\`` });
    },
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toEqual(judgment);

  const { args } = calls[0]!;
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(BOARD_CALL_SYSTEM_PROMPT);
});

it("配分評価の prompt の cause の候補に agent_definition / workspace_document は載らない(ADR 0291 決定5)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAllocationClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ result: JSON.stringify(judgment) });
    },
  });

  await client.judge(input, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).not.toContain("agent_definition");
  expect(prompts[0]).not.toContain("workspace_document");
});

it("語彙の外の allocation / cause や JSON でない応答は reject する(未検証の model 出力を events に載せない)", async () => {
  const outOfVocabulary = new ClaudeAllocationClient({
    exec: async () =>
      JSON.stringify({
        result: JSON.stringify({ allocation: "great", cause: "capability", evidence: "e" }),
      }),
  });
  await expect(outOfVocabulary.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();

  const prose = new ClaudeAllocationClient({
    exec: async () => JSON.stringify({ result: "looks appropriate to me" }),
  });
  await expect(prose.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();
});

it("CLI が is_error と共に返した result は診断として運ぶ(issue #306)", async () => {
  const client = new ClaudeAllocationClient({
    exec: async () =>
      JSON.stringify({ is_error: true, result: "Failed to authenticate: OAuth session expired" }),
  });
  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow(
    "Failed to authenticate: OAuth session expired",
  );
});
