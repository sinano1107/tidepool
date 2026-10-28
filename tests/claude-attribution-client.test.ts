import { expect, it } from "vitest";
import { ClaudeAttributionClient } from "../src/claude-attribution-client.js";
import {
  ACTION_CALL_FIELDS,
  ACTION_DECISION_FIELDS,
  ACTIONS_FIELDS,
  AGENT_DEFINITION_FIELDS,
  ATTRIBUTION_INPUT_FIELDS,
  type AttributionInput,
  AUTHORITY_FIELDS,
  MEMORY_ENTRY_FIELDS,
  RCA_FINDING_FIELDS,
  STOP_ATTRIBUTION_INPUT_FIELDS,
  type StopAttributionInput,
} from "../src/retrospective.js";
import { boardCallStream, boardCallSystemPrompt, CLI_ENVELOPE_USAGE } from "./fakes.js";

const input: AttributionInput = {
  entry_id: 7,
  entry: { id: 7, line: "chose plan B" },
  actor: "deckhand",
  steering: ["plan A was the agreed plan"],
  decision_log: [{ id: 7, line: "chose plan B" }, { id: 8, line: "completion report: shipped plan B" }],
  memory_read: [],
  agent_definition: null,
  board_text: [],
  task: null,
};

const judgment = { cause: "requirement_change", evidence: "plan A was agreed after the fact" };

const stopInput: StopAttributionInput = {
  human_stop: { reason: "plan A was agreed after the fact" },
  decision_log: input.decision_log,
  memory_read: [],
  agent_definition: null,
  board_text: [],
  task: null,
  actions: null,
};

it("judge は表の行の model / effort をピン留めし、空のツール面・1ターン・advisor 無しの Board call で JSON 判定を返す", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args, env) => {
      calls.push({ args, env });
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\`` });
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
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: `\`\`\`json\n${JSON.stringify(judgment)}\n\`\`\`` });
    },
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", judgment);

  const { args } = calls[0]!;
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(await boardCallSystemPrompt());
});

it("語彙の外の cause や JSON でない応答は reject する(未検証の model 出力を events に載せない)", async () => {
  const outOfVocabulary = new ClaudeAttributionClient({
    exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ cause: "laziness", evidence: "e" }) }),
  });
  await expect(outOfVocabulary.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();

  const prose = new ClaudeAttributionClient({
    exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: "looks like a preference to me" }),
  });
  await expect(prose.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).rejects.toThrow();
});

it("prompt は cause の memory と、wrong_memory_entries を読んだ記憶から名指すことを言い、判定は wrong_memory_entries を運ぶ(ADR 0166 決定3)", async () => {
  const prompts: string[] = [];
  const memory = { cause: "memory", evidence: "followed the squash note", wrong_memory_entries: [3] };
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(memory) });
    },
  });

  await expect(
    client.judge({ ...input, memory_read: [{ id: 3, kind: "behavior", title: "Squash", text: "Squash before merge." }] }, { provider: "anthropic", model: "fable", effort: "high" }),
  ).resolves.toHaveProperty("output", memory);

  expect(prompts[0]).toContain("memory is when a memory entry the worker read before the decision, and followed, was itself wrong");
  expect(prompts[0]).toContain('"wrong_memory_entries"');
  expect(prompts[0]).toContain("Squash before merge.");
});

it("prompt は evidence を英語で書かせる —— 記録に残る欄の言語を入力や設定に動かさせない(ADR 0303 決定3)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge(input, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain('"evidence" (string — the concrete observations your judgment rests on, in English)');
});

it.each(["judge", "judgeStop"] as const)("%s: memory 以外の判定が wrong_memory_entries を null で返しても判定は失われず、wrong_memory_entries の無い判定として届く", async (method) => {
  const client = new ClaudeAttributionClient({
    exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ ...judgment, wrong_memory_entries: null }) }),
  });

  const answer = method === "judge" ? client.judge(input, { provider: "anthropic", model: "fable", effort: "high" }) : client.judgeStop(stopInput, { provider: "anthropic", model: "fable", effort: "high" });
  await expect(answer).resolves.toHaveProperty("output", judgment);
});

it.each(["judge", "judgeStop"] as const)("%s: memory 以外の判定の空の wrong_memory_entries は schema をそのまま通る", async (method) => {
  const client = new ClaudeAttributionClient({
    exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ ...judgment, wrong_memory_entries: [] }) }),
  });

  const answer = method === "judge" ? client.judge(input, { provider: "anthropic", model: "fable", effort: "high" }) : client.judgeStop(stopInput, { provider: "anthropic", model: "fable", effort: "high" });
  await expect(answer).resolves.toHaveProperty("output", { ...judgment, wrong_memory_entries: [] });
});

it("prompt は environment を worker の外側の事情として判断の妥当性で線を引き、escalate せず迂回・推測したなら capability と言う(ADR 0213 決定1・2)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
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
    exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ cause, evidence: "e" }) }),
  });

  await expect(client.judge(input, { provider: "anthropic", model: "fable", effort: "high" })).resolves.toHaveProperty("output", { cause, evidence: "e" });
});

it("prompt は agent_definition と workspace_document を説明し、組み込みの本文・reviewer / repair の Authority・盤面の文に従った結果・ハーネス同梱の skill は environment、文書は decision log が引いたときだけ、当時版が無ければ agent_definition と答えないと言う(ADR 0291 決定1〜4 / ADR 0314 決定4・5)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge(input, { provider: "anthropic", model: "fable", effort: "high" });

  const prompt = prompts[0]!;
  // ADR 0324 決定3: roster / Authority は agent_definition の入れ子の文で定義し、authority.source は3値とも書く
  expect(prompt).toContain(`agent_definition is when ${ATTRIBUTION_INPUT_FIELDS.agent_definition} was itself wrong`);
  expect(ATTRIBUTION_INPUT_FIELDS.agent_definition).toContain("the worker's agent definition as it stood then (agent_definition: its body, authority and roster as given at its spawn — ");
  expect(prompt).toContain(
    "authority (the Authority section: what the worker may decide and do on its own and what it must escalate instead; null when the worker was given none)",
  );
  expect(prompt).toContain(
    "roster (the Roster section: the workers it could delegate to, one line each — a name and when that worker suits as a delegate; null when the worker was given none)",
  );
  expect(prompt).toContain(
    "authority.source (where that text came from: profile when it is a registry authority profile, reviewer when it is the board's own Authority for review and interview tasks, repair when it is the board's own notice for a repair task)",
  );
  expect(prompt).toContain(
    "when agent_definition.builtin is true the body is board code, and when agent_definition.authority.source is reviewer or repair rather than profile, that Authority is board code: that is environment",
  );
  expect(prompt).toContain("never answer agent_definition when agent_definition is null");
  expect(prompt).toContain("workspace_document is when a skill or document placed in the task's workspace (AGENTS.md, a README, a workspace skill) was itself wrong");
  expect(prompt).toContain("only when the decision log cites that document");
  expect(prompt).toContain(
    "following the board's own text the worker was given (board_text: the board's doctrine, protocol and any further section it was given (such as Interview discipline), as given at its spawn) as written, or a skill bundled with the harness, is environment, while misreading that text is capability",
  );
  expect(prompt).not.toContain("Interview root");
});

it("prompt treats human_stop as the human's account, preserves unanswered reasons and excludes no-longer-needed as a cause", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });

  await client.judge({ ...input, human_stop: { reason: "not yet answered" } }, { provider: "anthropic", model: "fable", effort: "high" });

  expect(prompts[0]).toContain("the human's account of why they stopped the session");
  expect(prompts[0]).toContain("a reason saying the work is no longer needed is not a cause of the objection");
  expect(prompts[0]).toContain("leave an unanswered reason unanswered");
  expect(prompts[0]).toContain('"human_stop": {\n    "reason": "not yet answered"\n  }');
});

it("停止の帰責の prompt は理由を人間の証言と名乗らせ、要らなくなった理由は requirement_change、行動列だけにある挙動は証拠と言い、停止用の入力を描く(ADR 0310 決定2)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });
  const stop: StopAttributionInput = {
    human_stop: { reason: "deleting files outside the workspace" },
    decision_log: [{ id: 7, line: "chose plan B" }],
    memory_read: [],
    agent_definition: null,
    board_text: [],
    task: null,
    actions: { calls: [{ index: 0, tool: "Bash", args: "rm -rf ../other", failed: false }], decisions: [{ id: 7, position: 1, line: "chose plan B" }] },
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

it("停止と異議の帰責の prompt は task を spawn で渡した文面と説明し、capability などをそれに照らし、頼まれたとおりの行動を落ち度と読まず、null の読み方を告げる(ADR 0320 決定3)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });
  const task = "First call get_current_task for task t, then complete this task: wait for the signal\n\nPurpose: wait\nCompletion criteria: the signal file exists";
  const setting = { provider: "anthropic", model: "fable", effort: "high" } as const;

  await client.judge({ ...input, task }, setting);
  await client.judgeStop(stopInput, setting);

  for (const prompt of prompts) {
    expect(prompt).toContain(
      "task is the task text the worker was given at its spawn (its user turn: title, purpose and completion criteria); judge " +
        "capability, task_ambiguity and missing_information against it, and conduct the task asked for is not a shortfall; " +
        "task is null when the session's record could not be read: judge from the rest; environment is",
    );
  }
  expect(prompts[0]).toContain(JSON.stringify(task));
  expect(prompts[1]).toContain('"task": null');
});

it("停止と異議の帰責の prompt は { id, line } の行の id と rca_findings の review / actor を説明し、異議だけが裁く行の actor を説明する(ADR 0322 決定5 / 追記、#2675)", async () => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });
  const setting = { provider: "anthropic", model: "fable", effort: "high" } as const;

  await client.judge(input, setting);
  await client.judgeStop(stopInput, setting);

  for (const prompt of prompts) {
    expect(prompt).toContain("Decision-log lines come as { id, line } rows whose id is the board's entry id: a line naming entry 3 means the row whose id is 3, while memory entry 3 names a memory entry, not a row.");
    expect(prompt).toContain("review is self when the review was assigned to the worker who made the decisions under review — its own account of why it decided, and actor names that worker");
    expect(prompt).toContain("or auditor when it was assigned not to that worker but to the board's reviewer role — an outside account (actor is null)");
  }
  expect(prompts[0]).toContain("The top-level actor is who wrote the objected entry (human when a human wrote it; such an entry has no self review).");
  expect(prompts[1]).not.toContain("The top-level actor is who wrote the objected entry");
  expect(prompts[1]).toContain("actions.decisions places each decision-log line (by its id) at its position");
});

it.each([
  ["judge", [ATTRIBUTION_INPUT_FIELDS]],
  ["judgeStop", [STOP_ATTRIBUTION_INPUT_FIELDS, ACTIONS_FIELDS, ACTION_CALL_FIELDS, ACTION_DECISION_FIELDS]],
] as const)("%s: prompt は入力の型の欄ごとに record の文を含む(ADR 0324 決定1)", async (method, records) => {
  const prompts: string[] = [];
  const client = new ClaudeAttributionClient({
    exec: async (_command, args) => {
      prompts.push(args[1]!);
      return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify(judgment) });
    },
  });
  const setting = { provider: "anthropic", model: "fable", effort: "high" } as const;

  await (method === "judge" ? client.judge(input, setting) : client.judgeStop(stopInput, setting));

  for (const record of [...records, AGENT_DEFINITION_FIELDS, AUTHORITY_FIELDS, MEMORY_ENTRY_FIELDS, RCA_FINDING_FIELDS]) {
    for (const sentence of Object.values(record)) expect(prompts[0]).toContain(sentence);
  }
});
