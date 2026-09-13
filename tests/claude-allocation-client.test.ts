import { expect, it } from "vitest";
import type { AllocationReviewInput } from "../src/allocation-review.js";
import { ClaudeAllocationClient } from "../src/claude-allocation-client.js";

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
  requested_tier: null,
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

  await expect(client.judge(input, { model: "fable", effort: "high" })).resolves.toEqual(judgment);

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
});

it("語彙の外の allocation / cause や JSON でない応答は reject する(未検証の model 出力を events に載せない)", async () => {
  const outOfVocabulary = new ClaudeAllocationClient({
    exec: async () =>
      JSON.stringify({
        result: JSON.stringify({ allocation: "great", cause: "capability", evidence: "e" }),
      }),
  });
  await expect(outOfVocabulary.judge(input, { model: "fable", effort: "high" })).rejects.toThrow();

  const prose = new ClaudeAllocationClient({
    exec: async () => JSON.stringify({ result: "looks appropriate to me" }),
  });
  await expect(prose.judge(input, { model: "fable", effort: "high" })).rejects.toThrow();
});

it("CLI が is_error と共に返した result は診断として運ぶ(issue #306)", async () => {
  const client = new ClaudeAllocationClient({
    exec: async () =>
      JSON.stringify({ is_error: true, result: "Failed to authenticate: OAuth session expired" }),
  });
  await expect(client.judge(input, { model: "fable", effort: "high" })).rejects.toThrow(
    "Failed to authenticate: OAuth session expired",
  );
});
