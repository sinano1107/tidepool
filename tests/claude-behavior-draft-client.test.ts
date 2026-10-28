import { expect, it } from "vitest";
import { ClaudeBehaviorDraftClient } from "../src/claude-behavior-draft-client.js";
import type { BehaviorDraftInput, StopBehaviorDraftInput } from "../src/retrospective.js";
import { boardCallStream, boardCallSystemPrompt, CLI_ENVELOPE_USAGE } from "./fakes.js";

const input: BehaviorDraftInput = {
  entry_id: 7,
  entry: { id: 7, line: "named the flag --dry" },
  actor: "deckhand",
  steering: ["always spell it --dry-run"],
  decision_log: [{ id: 7, line: "named the flag --dry" }],
  memory_read: [],
  agent_definition: null,
  board_text: [],
  task: null,
  index: "- cli/ — how command-line flags are named",
};

const draft = { path: "cli/flags", title: "Spell out flags", text: "Name dry-run flags --dry-run.", addressee: "all" };

it("draft は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON の起草を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
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
  // 起草も judge と同じ当時版と盤面の文を読む(ADR 0314 決定4)
  expect(args[1]).toContain("the worker's agent definition as it stood then (agent_definition: its body, authority and roster");
  expect(args[1]).toContain("(board_text: the board's doctrine, protocol and, for an Interview root, Interview discipline)");
  // 起草も judge と同じく読んだ記憶と書き込みの本文の欄を説明する(#2621)
  expect(args[1]).toContain("the memory entries the worker read before the decision (memory_read)");
  expect(args[1]).toContain("When the input carries written, the objected entry is a memory write the worker applied directly");
});

it("Behavior candidate の起草は、用途に依らない盤面の system prompt を --system-prompt で渡す(ADR 0296 決定6)", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
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
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
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
    const client = new ClaudeBehaviorDraftClient({ exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result }) });
    await expect(client.draft(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();
  }
});

it("prompt treats human_stop as the human's account, preserves unanswered reasons and excludes no-longer-needed as a cause", async () => {
  const prompts: string[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });

  await client.draft({ ...input, human_stop: { reason: "not yet answered" } }, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain("the human's account of why they stopped the session");
  expect(prompts[0]).toContain("a reason saying the work is no longer needed is not a cause of the objection");
  expect(prompts[0]).toContain("leave an unanswered reason unanswered");
  expect(prompts[0]).toContain('"human_stop": {\n    "reason": "not yet answered"\n  }');
});

it("停止からの起草の prompt は理由を人間の証言として描き、判断ログ・行動列・RCA の所見から1つの規則を書かせ、停止用の入力を描く(ADR 0310 決定4)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });
  const stop: StopBehaviorDraftInput = {
    human_stop: { reason: "deleting files outside the workspace" },
    decision_log: [{ id: 7, line: "chose plan B" }],
    memory_read: [],
    agent_definition: null,
    board_text: [],
    task: null,
    actions: { calls: [{ index: 0, tool: "Bash", args: "rm -rf ../other", failed: false }], decisions: [{ id: 7, position: 1, line: "chose plan B" }] },
    rca_findings: [{ review: "auditor", task_id: "r", actor: null, entries: [{ id: 10, line: "stop 9 → no guard on rm" }] }],
    index: "- workspace/ — where agents may write",
  };

  await expect(client.draftFromStop(stop, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", draft);

  expect(prompts[0]).toContain("A human stopped a running worker session; human_stop.reason is the human's testimony of why");
  expect(prompts[0]).toContain("the memory entries the worker read before the stop (memory_read)");
  expect(prompts[0]).toContain("its action sequence (actions)");
  expect(prompts[0]).toContain("When the input carries rca_findings, the root-cause reviews of the stop have settled: draft from what they found");
  expect(prompts[0]).toContain('"addressee" ("worker" when the rule is for the worker who ran the session');
  expect(prompts[0]).not.toContain("objected");
  expect(prompts[0]).toContain('"args": "rm -rf ../other"');
  expect(prompts[0]).toContain("where agents may write");
});

it("停止と異議の起草の prompt は task を spawn で渡した文面と説明し、null の読み方を告げる(ADR 0320 決定3)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });
  const setting = { provider: "anthropic", model: "fable", effort: "high" } as const;
  const stopInput: StopBehaviorDraftInput = { human_stop: { reason: "r" }, decision_log: [], memory_read: [], agent_definition: null, board_text: [], task: null, actions: null, index: null };

  await client.draft({ ...input, task: "Purpose: rename the flag" }, setting);
  await client.draftFromStop(stopInput, setting);

  for (const prompt of prompts) {
    expect(prompt).toContain(
      "the task text it was given (task: its user turn at its spawn — title, purpose and completion criteria; null when not recorded)",
    );
  }
  expect(prompts[0]).toContain('"task": "Purpose: rename the flag"');
  expect(prompts[1]).toContain('"task": null');
});

it("停止と異議の起草の prompt は { id, line } の行の id と rca_findings の review / actor を説明し、異議だけが裁く行の actor を説明する(ADR 0322 決定5 / 追記、#2675)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeBehaviorDraftClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(draft) });
    },
  });
  const setting = { provider: "anthropic", model: "fable", effort: "high" } as const;
  const stop: StopBehaviorDraftInput = {
    human_stop: { reason: "deleting files outside the workspace" },
    decision_log: [{ id: 7, line: "chose plan B" }],
    memory_read: [],
    agent_definition: null,
    board_text: [],
    task: null,
    actions: null,
    index: null,
  };

  await client.draft(input, setting);
  await client.draftFromStop(stop, setting);

  for (const prompt of prompts) {
    expect(prompt).toContain("Decision-log lines come as { id, line } rows whose id is the board's entry id: a line naming entry 3 means the row whose id is 3.");
    expect(prompt).toContain("review is self when the worker who made the decisions under review wrote it — its own account, and actor names that worker");
    expect(prompt).toContain("or auditor when an independent reviewer who made none of them wrote it (actor is null)");
  }
  expect(prompts[0]).toContain("actor is the worker who wrote the objected entry: a self review whose actor is that worker is its own account of the entry");
  expect(prompts[1]).not.toContain("objected");
  expect(prompts[1]).toContain("actions.decisions places each decision-log line (by its id) at its position");
});
