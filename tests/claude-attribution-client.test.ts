import { expect, it } from "vitest";
import { ClaudeAttributionClient } from "../src/claude-attribution-client.js";
import type { AttributionInput, StopAttributionInput } from "../src/retrospective.js";
import { boardCallSystemPrompt, CLI_ENVELOPE_USAGE } from "./fakes.js";

const input: AttributionInput = {
  entry_id: 7,
  entry: "chose plan B",
  steering: ["plan A was the agreed plan"],
  decision_log: ["chose plan B", "completion report: shipped plan B"],
  memory_read: [],
  agent_definition: null,
};

const judgment = { cause: "requirement_change", evidence: "plan A was agreed after the fact" };

it("judge は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON 判定を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\`` });
    },
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", judgment);

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
  // the input rides in the prompt — the objected entry, its steering, the log
  expect(args[1]).toContain("chose plan B");
  expect(args[1]).toContain("plan A was the agreed plan");
});

it("帰責の判定は、用途に依らない盤面の system prompt を --system-prompt で渡す(ADR 0296 決定6)", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\`` });
    },
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", judgment);

  const { args } = calls[0]!;
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(await boardCallSystemPrompt());
});

it("語彙の外の cause や JSON でない応答は reject する(未検証の model 出力を events に載せない)", async () => {
  const outOfVocabulary = new ClaudeAttributionClient({
    exec: async () => JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ cause: "laziness", evidence: "e" }) }),
  });
  await expect(outOfVocabulary.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();

  const prose = new ClaudeAttributionClient({
    exec: async () => JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: "looks like a preference to me" }),
  });
  await expect(prose.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();
});

it("prompt は cause の memory と、entries を読んだ記憶から名指すことを言い、判定は entries を運ぶ(ADR 0166 決定3)", async () => {
  const prompts: string[] = [];
  const memory = { cause: "memory", evidence: "followed the squash note", entries: [3] };
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(memory) });
    },
  });

  await expect(
    client.judge({ ...input, memory_read: [{ id: 3, kind: "behavior", title: "Squash", text: "Squash before merge." }] }, { provider: "anthropic", model: "fable", effort: "high" }),
  ).resolves.toHaveProperty("output", memory);

  expect(prompts[0]).toContain("memory is when a memory entry the worker read before the decision, and followed, was itself wrong");
  expect(prompts[0]).toContain('"entries"');
  expect(prompts[0]).toContain("Squash before merge.");
});

it("prompt は evidence を英語で書かせる —— 記録に残る欄の言語を入力や設定に動かさせない(ADR 0303 決定3)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge(input, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain('"evidence" (string — the concrete observations your judgment rests on, in English)');
});

it("memory 以外の判定が entries を null で返しても判定は失われず、entries の無い判定として届く", async () => {
  const client = new ClaudeAttributionClient({
    exec: async () => JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ ...judgment, entries: null }) }),
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", judgment);
});

it("prompt は environment を worker の外側の事情として判断の妥当性で線を引き、escalate せず迂回・推測したなら capability と言う(ADR 0213 決定1・2)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge(input, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain(
    "environment is the worker's surroundings — board tooling, network or sandbox trouble, or an upstream change — when the worker's judgment was sound given what it had",
  );
  expect(prompts[0]).toContain("working around or guessing past such trouble instead of escalating is capability");
});

it.each(["agent_definition", "workspace_document"])("cause %s の判定は語彙の内側として届く(ADR 0291 決定1・3)", async (cause) => {
  const client = new ClaudeAttributionClient({
    exec: async () => JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ cause, evidence: "e" }) }),
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", { cause, evidence: "e" });
});

it("prompt は agent_definition と workspace_document を説明し、組み込みの本文・盤面の protocol 文・ハーネス同梱の skill は environment、文書は decision log が引いたときだけ、当時版が無ければ agent_definition と答えないと言う(ADR 0291 決定1〜4)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge(input, { provider: "anthropic", model: "fable", effort: "high" });

  const prompt = prompts[0]!;
  expect(prompt).toContain("agent_definition is when the worker's agent definition as it stood then (agent_definition: its body, authority and roster) was itself wrong");
  expect(prompt).toContain("when agent_definition.builtin is true the body is board code: that is environment");
  expect(prompt).toContain("never answer agent_definition when agent_definition is null");
  expect(prompt).toContain("workspace_document is when a skill or document placed in the task's workspace (AGENTS.md, a README, a workspace skill) was itself wrong");
  expect(prompt).toContain("only when the decision log cites that document");
  expect(prompt).toContain("following the board's own protocol text injected into every session, or a skill bundled with the harness, is environment");
});

it("prompt treats human_stop as the human's account, preserves unanswered reasons and excludes no-longer-needed as a cause", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge({ ...input, human_stop: { reason: "not yet answered" } }, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain("the human's account of why they stopped the session");
  expect(prompts[0]).toContain('"work no longer needed" is not a cause');
  expect(prompts[0]).toContain("leave an unanswered reason unanswered");
  expect(prompts[0]).toContain('"human_stop": {\n    "reason": "not yet answered"\n  }');
});

it("停止の帰責の prompt は理由を人間の証言と名乗らせ、要らなくなった理由は requirement_change、行動列だけにある挙動は証拠と言い、停止用の入力を描く(ADR 0310 決定2)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return JSON.stringify({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });
  const stop: StopAttributionInput = {
    human_stop: { reason: "deleting files outside the workspace" },
    decision_log: ["chose plan B"],
    memory_read: [],
    agent_definition: null,
    actions: { calls: [{ index: 0, tool: "Bash", args: "rm -rf ../other", failed: false }], decisions: [{ position: 1, line: "chose plan B" }] },
  };

  await expect(client.judgeStop(stop, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", judgment);

  expect(prompts[0]).toContain("human_stop.reason is the human's testimony");
  expect(prompts[0]).toContain("A reason saying the work is no longer needed, or that what was wanted changed, is requirement_change");
  expect(prompts[0]).toContain("What the worker did that appears in actions but not in decision_log is evidence");
  expect(prompts[0]).toContain("memory is when a memory entry the worker read before the stop, and followed, was itself wrong");
  expect(prompts[0]).not.toContain("objected");
  expect(prompts[0]).toContain('"evidence" (string — the concrete observations your judgment rests on, in English)');
  expect(prompts[0]).toContain("deleting files outside the workspace");
  expect(prompts[0]).toContain('"args": "rm -rf ../other"');
});
