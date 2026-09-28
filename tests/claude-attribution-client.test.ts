import { expect, it } from "vitest";
import type { AttributionInput } from "../src/attribution.js";
import { ClaudeAttributionClient } from "../src/claude-attribution-client.js";

const input: AttributionInput = {
  entry_id: 7,
  entry: "chose plan B",
  steering: ["plan A was the agreed plan"],
  decision_log: ["chose plan B", "completion report: shipped plan B"],
  memory_read: [],
};

const judgment = { cause: "requirement_change", evidence: "plan A was agreed after the fact" };

it("judge は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON 判定を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeAttributionClient({
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
  // the input rides in the prompt — the objected entry, its steering, the log
  expect(args[1]).toContain("chose plan B");
  expect(args[1]).toContain("plan A was the agreed plan");
});

it("語彙の外の cause や JSON でない応答は reject する(未検証の model 出力を events に載せない)", async () => {
  const outOfVocabulary = new ClaudeAttributionClient({
    exec: async () => JSON.stringify({ result: JSON.stringify({ cause: "laziness", evidence: "e" }) }),
  });
  await expect(outOfVocabulary.judge(input, { model: "fable", effort: "high" })).rejects.toThrow();

  const prose = new ClaudeAttributionClient({
    exec: async () => JSON.stringify({ result: "looks like a preference to me" }),
  });
  await expect(prose.judge(input, { model: "fable", effort: "high" })).rejects.toThrow();
});

it("prompt は cause の memory と、entries を読んだ記憶から名指すことを言い、判定は entries を運ぶ(ADR 0166 決定3)", async () => {
  const prompts: string[] = [];
  const memory = { cause: "memory", evidence: "followed the squash note", entries: [3] };
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ result: JSON.stringify(memory) });
    },
  });

  await expect(
    client.judge({ ...input, memory_read: [{ id: 3, kind: "behavior", title: "Squash", text: "Squash before merge." }] }, { model: "fable", effort: "high" }),
  ).resolves.toEqual(memory);

  expect(prompts[0]).toContain("memory is when a memory entry the worker read before the decision, and followed, was itself wrong");
  expect(prompts[0]).toContain('"entries"');
  expect(prompts[0]).toContain("Squash before merge.");
});
