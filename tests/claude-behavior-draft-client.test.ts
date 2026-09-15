import { expect, it } from "vitest";
import type { BehaviorDraftInput } from "../src/attribution.js";
import { ClaudeBehaviorDraftClient } from "../src/claude-behavior-draft-client.js";

const input: BehaviorDraftInput = {
  entry_id: 7,
  entry: "named the flag --dry",
  steering: ["always spell it --dry-run"],
  decision_log: ["named the flag --dry"],
  index: "- cli/ — how command-line flags are named",
};

const draft = { path: "cli/flags", title: "Spell out flags", text: "Name dry-run flags --dry-run.", addressee: "all" };

it("draft は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON の起草を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ result: JSON.stringify(draft) });
    },
  });

  await expect(client.draft(input, { model: "fable", effort: "high" })).resolves.toEqual(draft);

  const { args, env } = calls[0]!;
  const argLine = args.join(" ");
  expect(argLine).toContain("--model fable");
  expect(argLine).toContain("--effort high");
  expect(argLine).toContain("--max-turns 1");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  expect(args[1]).toContain("always spell it --dry-run");
  expect(args[1]).toContain("how command-line flags are named");
});

it("語彙の外の宛先・欠けた欄・JSON でない応答は reject する(未検証の model 出力を店に載せない)", async () => {
  for (const result of [
    JSON.stringify({ ...draft, addressee: "deckhand" }),
    JSON.stringify({ ...draft, text: "" }),
    "spell it out, I guess",
  ]) {
    const client = new ClaudeBehaviorDraftClient({ exec: async () => JSON.stringify({ result }) });
    await expect(client.draft(input, { model: "fable", effort: "high" })).rejects.toThrow();
  }
});
