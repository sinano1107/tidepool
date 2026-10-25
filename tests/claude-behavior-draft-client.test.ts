import { expect, it } from "vitest";
import { ClaudeBehaviorDraftClient } from "../src/claude-behavior-draft-client.js";
import type { BehaviorDraftInput } from "../src/retrospective.js";
import { boardCallSystemPrompt, CLI_ENVELOPE_USAGE } from "./fakes.js";

const input: BehaviorDraftInput = {
  entry_id: 7,
  entry: "named the flag --dry",
  steering: ["always spell it --dry-run"],
  decision_log: ["named the flag --dry"],
  memory_read: [],
  agent_definition: null,
  index: "- cli/ — how command-line flags are named",
};

const draft = { path: "cli/flags", title: "Spell out flags", text: "Name dry-run flags --dry-run.", addressee: "all" };

it("draft は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON の起草を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });

  await expect(client.draft(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", draft);

  const { args, env } = calls[0]!;
  const argLine = args.join(" ");
  expect(argLine).toContain("--model fable");
  expect(argLine).toContain("--effort high");
  expect(argLine).toContain("--max-turns 1");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  // ADR 0303 決定1: host / repo の設定の層を1つも読まない
  expect(args).toContain("--safe-mode");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  expect(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  expect(args[1]).toContain("always spell it --dry-run");
  expect(args[1]).toContain("how command-line flags are named");
});

it("Behavior candidate の起草は、用途に依らない盤面の system prompt を --system-prompt で渡す(ADR 0296 決定6)", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });

  await expect(client.draft(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", draft);

  const { args } = calls[0]!;
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(await boardCallSystemPrompt());
});

it("prompt は path / title / text を英語で書かせる —— 索引の階層に英語以外を混ぜない(ADR 0303 決定3)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });

  await client.draft(input, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain('"path" (string — a "/"-separated hierarchy in English, such as build/tests;');
  expect(prompts[0]).toContain('"title" (string — a short name for the rule, in English)');
  expect(prompts[0]).toContain('"text" (string — the rule itself, in English,');
});

it("語彙の外の宛先・欠けた欄・JSON でない応答は reject する(未検証の model 出力を店に載せない)", async () => {
  for (const result of [
    JSON.stringify({ ...draft, addressee: "deckhand" }),
    JSON.stringify({ ...draft, text: "" }),
    "spell it out, I guess",
  ]) {
    const client = new ClaudeBehaviorDraftClient({ exec: async () => JSON.stringify({ ...CLI_ENVELOPE_USAGE, result }) });
    await expect(client.draft(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();
  }
});

it("prompt treats human_stop as the human's account, preserves unanswered reasons and excludes no-longer-needed as a cause", async () => {
  const prompts: string[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });

  await client.draft({ ...input, human_stop: { reason: "not yet answered" } }, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain("the human's account of why they stopped the session");
  expect(prompts[0]).toContain('"work no longer needed" is not a cause');
  expect(prompts[0]).toContain("leave an unanswered reason unanswered");
  expect(prompts[0]).toContain('"human_stop": {\n    "reason": "not yet answered"\n  }');
});
