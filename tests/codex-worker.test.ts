import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_FEATURE_SNAPSHOT,
  type CodexSpawnFn,
  CodexWorker,
  createCodexCapabilityCheck,
  resolveCodexExecutable,
} from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { buildMemoryInjection, recordKnowledge } from "../src/memory.js";
import { openQuarantineValues } from "../src/quarantine.js";
import { registerTask } from "../src/tasks.js";
import type { WorkerExit } from "../src/worker.js";
import { containerHarness, FakeClock, passthroughContainers, recordingSpawn as recordingProcesses } from "./fakes.js";
import { bootTidepool, mcpClient, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

const CLI_VERSION = "codex-cli 0.147.0";

let t: Tidepool;
afterEach(() => t?.stop());

function task(db: ReturnType<typeof openDb>, title = "codex-task") {
  return registerTask(db, {
    type: "work",
    assignee: "codex-agent",
    workspace: "work",
    title,
    purpose: "keep the board correct",
    completion_criteria: "the focused tests pass",
  }, new Date("2026-08-24T00:00:00.000Z"));
}

/** 主題 memory の meta-review task —— enabled_tools と盤面の tool 一覧はこの主題でだけ形が変わる(ADR 0122 決定2)。 */
function metaReviewTask(db: ReturnType<typeof openDb>) {
  return registerTask(db, {
    type: "review",
    assignee: "codex-agent",
    title: "Memory meta-review",
    purpose: "keep the memory store correct",
    completion_criteria: "the store is reviewed",
    meta_review_subject: "memory",
  }, new Date("2026-08-24T00:00:00.000Z"));
}

function recordingSpawn() {
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed: NodeJS.Signals[] = [];
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errors: Array<(error: Error) => void> = [];
  const spawn: CodexSpawnFn = (command, args, options) => {
    calls.push({ command, args, ...options });
    return {
      stdout,
      stderr,
      kill: (signal) => killed.push(signal),
      on(event, listener) {
        if (event === "exit") exits.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        else errors.push(listener as (error: Error) => void);
      },
    };
  };
  return {
    calls,
    stdout,
    stderr,
    killed,
    spawn,
    exit: (code: number | null, signal: NodeJS.Signals | null) => exits.forEach((fn) => fn(code, signal)),
    error: (error: Error) => errors.forEach((fn) => fn(error)),
  };
}

/** `-c <prefix><値>` を読む。値は toml() = JSON.stringify なので JSON.parse で戻す。 */
function configValue<T>(args: string[], prefix: string): T {
  const entry = args.find((arg, i) => args[i - 1] === "-c" && arg.startsWith(prefix))!;
  return JSON.parse(entry.slice(prefix.length)) as T;
}

/** 盤面が書いた文面は `-c developer_instructions=` に載る(ADR 0124 決定2)。 */
const developerInstructions = (args: string[]) => configValue<string>(args, "developer_instructions=");

/** spawn が `-c mcp_servers.tidepool.enabled_tools=` で Codex に宣言した verb 列。 */
const enabledTools = (args: string[]) => configValue<string[]>(args, "mcp_servers.tidepool.enabled_tools=");

async function fixture(
  onSpawnFailed?: (taskId: string, failure: { error_code: string | null; message: string }) => void,
  allowedDomains = "\n  allowed_domains:\n    - api.github.com",
  onWorkerExited?: (taskId: string, exit: WorkerExit) => void,
) {
  const workspace = await mkdtemp(join(tmpdir(), "tidepool-codex-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
  await mkdir(join(workspace, ".agents", "skills", "repo-skill"), { recursive: true });
  await writeFile(join(workspace, ".agents", "skills", "repo-skill", "SKILL.md"), "# Repo skill\n");
  const registry = await makeRegistry({
    "agents/codex-agent.md": `---
name: codex-agent
description: Codex agent
version: 1.2.3
authority: standard
provider: openai
skills: []
---
You are the Codex worker.`,
    "workspaces.yaml": `work:
  path: ${workspace}${allowedDomains}
`,
  });
  const db = openDb(":memory:");
  const process = recordingSpawn();
  const codexHome = await mkdtemp(join(tmpdir(), "tidepool-codex-home-"));
  const logDir = await mkdtemp(join(tmpdir(), "tidepool-codex-logs-"));
  const worker = new CodexWorker({
    db,
    clock: new FakeClock(),
    registry: { dir: registry, mode: "purely-local" },
    agent: "codex-agent",
    workspace: "work",
    workspacesDir: tmpdir(),
    mcpUrl: "http://127.0.0.1:4590/mcp",
    logDir,
    codexHome,
    cliVersion: CLI_VERSION,
    executable: "/opt/tidepool/bin/codex",
    containers: passthroughContainers(process.spawn),
    onSpawnFailed,
    onWorkerExited,
  });
  return { db, worker, process, codexHome, workspace, logDir };
}

describe("CodexWorker (ADR 0098)", () => {
  it("spawns the pinned Codex route with isolated auth home and closed worker surfaces", async () => {
    const f = await fixture();
    const value = task(f.db);
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.GITHUB_TOKEN = "must-not-leak";

    f.worker.start(value);
    delete process.env.OPENAI_API_KEY;
    delete process.env.GITHUB_TOKEN;

    const call = f.process.calls[0]!;
    expect(call.command).toBe("/opt/tidepool/bin/codex");
    expect(call.cwd).toBe(f.workspace);
    expect(call.env.CODEX_HOME).toBe(f.codexHome);
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
    expect(call.args).toEqual(expect.arrayContaining([
      "--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--dangerously-bypass-hook-trust",
      "-C", f.workspace, "-m", "gpt-5.6-terra",
    ]));
    const config = call.args.filter((_, index) => call.args[index - 1] === "-c").join("\n");
    // 前提の破綻と自タスク外の発見の2文(ADR 0121 / issue #631)
    expect(developerInstructions(call.args)).toContain("When the premise of the decomposition decision your task rests on turns out to be false, declare a premise breach rather than working around it or escalating it.");
    expect(developerInstructions(call.args)).toContain("A finding outside your task's scope is not your task: record the decision not to act on it with `log_decision`, and never decompose it into a child.");
    expect(config).toContain('model_reasoning_effort="high"');
    expect(config).toContain('default_permissions="tidepool-work"');
    expect(config).toContain('\":root\"=\"deny\"');
    expect(config).toContain('\":slash_tmp\"=\"deny\"');
    expect(config).toContain("permissions.tidepool-work.workspace_roots=");
    // workspace の allowed_domains が network の許可に載る(ADR 0072 決定1 / issue #763)
    expect(config).toContain('\"api.github.com\"=\"allow\"');
    // 既定拒否(ADR 0135 決定1): snapshot が "false" の名前は全部 `-c` に載る
    const closed = Object.entries(CODEX_FEATURE_SNAPSHOT).filter(([, state]) => state === "false");
    expect(closed.filter(([name]) => !config.includes(`features.${name}=false`)).map(([name]) => name)).toEqual([]);
    expect(config).toContain('forced_login_method="chatgpt"');
    expect(config).toContain("project_doc_max_bytes=0");
    expect(config).toContain('web_search="disabled"');
    expect(config).toContain("mcp_servers.tidepool.enabled_tools=");
    expect(config).toContain("get_current_task");
    expect(config).toContain("mcp_servers.tidepool.required=true");
    expect(config).toContain('mcp_servers.tidepool.default_tools_approval_mode="approve"');
    expect(config).toContain("agents.max_concurrent_threads_per_session=3");
    // snapshot が "true" の名前を盤面は書かない —— 開ける名前は書けば版の宣言になり(ADR 0134 決定2)、
    // `=false` が届かない名前は書いても届かない(ADR 0135 決定4)。例外の2つだけ別経路で明示している:
    // network_proxy は closedSurfaceConfig()、hooks は hookConfig()。
    expect(config).toContain("features.network_proxy=true");
    const unwritten = Object.entries(CODEX_FEATURE_SNAPSHOT)
      .filter(([name, state]) => state === "true" && name !== "network_proxy" && name !== "hooks");
    expect(unwritten.filter(([name]) => config.includes(`features.${name}=`)).map(([name]) => name)).toEqual([]);
    expect(config).toContain("skills.config=");
    expect(config).toContain(join(f.codexHome, "skills", ".system", "openai-docs", "SKILL.md"));
    expect(config).toContain(join(f.workspace, ".agents", "skills", "repo-skill", "SKILL.md"));
    expect(config).toContain("?task=" + value.id);
    expect(config).toContain("features.hooks=true");
    expect(config).toContain('hooks.PreToolUse=[{matcher="mcp__tidepool__.*"');
    // 門は agent_id 1本(ADR 0130 決定1)—— SubagentStart の登録も state file の env も渡らない
    expect(config).not.toContain("hooks.SubagentStart=");
    expect(call.env.TIDEPOOL_SUBAGENT_STATE).toBeUndefined();
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")?.payload).toMatchObject({
      kind: "worker_spawned",
      // ADR 0110 決定3: -m と model_reasoning_effort に渡した値そのもの、および
      // ティアの出所(この agent は tier を書いていないので盤面既定)
      provider: "openai",
      model: "gpt-5.6-terra",
      effort: "high",
      source: { tier: "board", provider: "only" },
      // openai の正準経路は advisor を提供しない(ADR 0098)
      advisor: null,
      harness: "codex",
      cli_version: CLI_VERSION,
    });
  });

  it("allowed_domains を持たない workspace では network の許可は 127.0.0.1 だけのまま(issue #763)", async () => {
    const f = await fixture(undefined, "");
    f.worker.start(task(f.db));

    const call = f.process.calls[0]!;
    const taskTemp = call.env.TMPDIR!;
    expect(call.args).toContain(
      `permissions.tidepool-work.network={"enabled"=true,"domains"={"127.0.0.1"="allow"},"unix_sockets"={${JSON.stringify(taskTemp)}="allow"},"allow_local_binding"=true}`,
    );
  });

  it("review task の spawn にも workspace の allowed_domains が network の許可に載る(issue #763)", async () => {
    const f = await fixture();
    f.worker.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
    ));

    const config = f.process.calls[0]!.args.filter((_, index, args) => args[index - 1] === "-c").join("\n");
    expect(config).toContain('permissions.tidepool-review.network={"enabled"=true,"domains"={"api.github.com"="allow","127.0.0.1"="allow"}');
  });

  it("work task の filesystem 表は workspace の .git を write、.git/hooks と .git/config を read にし、review task の表には .git の行が無い(issue #849 / ADR 0033)", async () => {
    const f = await fixture();
    f.worker.start(task(f.db));
    f.worker.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
    ));

    const filesystem = (args: string[], name: string) =>
      args.find((arg, index) => args[index - 1] === "-c" && arg.startsWith(`permissions.${name}.filesystem=`))!;
    const work = filesystem(f.process.calls[0]!.args, "tidepool-work");
    expect(work).toContain(`${JSON.stringify(join(f.workspace, ".git"))}="write"`);
    expect(work).toContain(`${JSON.stringify(join(f.workspace, ".git", "hooks"))}="read"`);
    expect(work).toContain(`${JSON.stringify(join(f.workspace, ".git", "config"))}="read"`);
    expect(filesystem(f.process.calls[1]!.args, "tidepool-review")).not.toContain(join(f.workspace, ".git"));
  });

  it("preflight の app-server が読む設定のキーは、work / review とも同じ種別の spawn のキーと一致する(ADR 0142 決定2・3)", async () => {
    const f = await fixture();
    f.worker.start(task(f.db));
    f.worker.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
    ));

    // preflight を --version・prompt-input・features list・sandbox 2本・hooks/list と通し、7本目の review 呼び出しまで進める
    const preflight = recordingProcesses();
    const capability = createCodexCapabilityCheck({
      executable: "/opt/tidepool/bin/codex",
      codexHome: f.codexHome,
      workspace: f.workspace,
      allowedDomains: ["api.github.com"],
      call: containerHarness(passthroughContainers(preflight.spawn)).boardCall,
    })();
    for (const i of [0, 1, 2, 3, 4, 5]) {
      await vi.waitFor(() => expect(preflight.calls).toHaveLength(i + 1));
      if (i === 1) preflight.stdout.write("[]");
      if (i === 5) preflight.stdout.write('{"id":1,"result":{}}\n{"id":2,"result":{"data":[]}}\n');
      preflight.emitExitAt(i, 0, null);
    }
    await vi.waitFor(() => expect(preflight.calls).toHaveLength(7));
    preflight.emitExitAt(6, 1, null);
    await capability;

    const keys = (args: string[]) =>
      new Set(args.filter((_, index) => args[index - 1] === "-c").map((entry) => entry.split("=", 1)[0]));
    expect(keys(f.process.calls[0]!.args)).toContain("mcp_servers.tidepool.url");
    expect(keys(preflight.calls[5]!.args)).toEqual(keys(f.process.calls[0]!.args));
    expect(keys(preflight.calls[6]!.args)).toEqual(keys(f.process.calls[1]!.args));
  });

  it("主題 memory の meta-review の spawn では enabled_tools が worker の memory verb を専用 verb で置き換え、普通の task は変わらない(ADR 0122 決定2)", async () => {
    const f = await fixture();
    f.worker.start(task(f.db));
    f.worker.start(metaReviewTask(f.db));

    const base = ["get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate", "declare_premise_breach", "continue_decomposition", "redecompose"];
    expect(enabledTools(f.process.calls[0]!.args)).toEqual([...base, "record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory", "propose_from_objection"]);
    expect(enabledTools(f.process.calls[1]!.args)).toEqual([
      ...base,
      "propose_from_objection",
      "list_memory_candidates",
      "list_memory_behaviors",
      "list_precedents",
      "list_memory_entries",
      "define_memory",
      "fold_memory",
      "move_memory",
      "invalidate_memory",
      "propose_memory_change",
    ]);
  });

  it("盤面の文面は developer_instructions に、task 固有の指示は prompt 引数に置く —— work / review とも同じ配置(ADR 0124 決定1・2)", async () => {
    const f = await fixture();
    const work = task(f.db, "codex-layer-work");
    const review = registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-layer-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
    );
    for (const value of [work, review]) f.worker.start(value);

    for (const [i, value] of [work, review].entries()) {
      const args = f.process.calls[i]!.args;
      const developer = developerInstructions(args);
      expect(developer).toContain("You are the Codex worker.");
      expect(developer).toContain("## Authority");
      expect(developer).toContain("Use only the tidepool MCP verbs to report board decisions and completion.");
      expect(developer).toContain("Board verbs are main-thread only");
      expect(developer).toContain('Spawn subagents with fork_turns: "none"; this session keeps no rollout, so forking the parent thread\'s history always fails.');
      expect(developer).toContain("declare a premise breach");
      expect(developer).not.toContain(value.title);
      expect(developer).not.toContain(value.purpose);
      expect(developer).not.toContain(value.completion_criteria);
      // 次の part と区切り無しに連結するので末尾の空行が文面の一部(ADR 0124 Consequences)
      expect(developer.endsWith("\n\n")).toBe(true);

      const prompt = args.at(-1)!;
      expect(prompt).toContain(`First call get_current_task for task ${value.id}, then complete this task: ${value.title}`);
      expect(prompt).toContain(`Purpose: ${value.purpose}`);
      expect(prompt).toContain(`Completion criteria: ${value.completion_criteria}`);
      expect(prompt).not.toContain("You are the Codex worker.");
      expect(prompt).not.toContain("## Authority");
    }
  });

  it.each([
    ["work", task],
    ["主題 memory の meta-review", metaReviewTask],
  ] as const)("%s task では、spawn が Codex に宣言する enabled_tools と盤面の server が出す verb が集合として一致する(ADR 0125 決定2)", async (_, register) => {
    const f = await fixture();
    f.worker.start(register(f.db));
    t = await bootTidepool();
    const client = await mcpClient(t.mcpBaseUrl, register(t.db).id);
    try {
      // 片方は BOARD_VERBS の並び、片方は registerTool の順。どちらの順序も意味を持たない
      expect(enabledTools(f.process.calls[0]!.args).sort())
        .toEqual((await client.listTools()).tools.map((tool) => tool.name).sort());
    } finally {
      await client.close();
    }
  });

  it("見える approved の記憶があれば work / review task とも注入節を developer_instructions の先頭に置き、worker_spawned の直後に memory_injected を書く。無ければ節を置かず entries 空で残す(spec #586 C / issue #592)", async () => {
    const f = await fixture();
    const bare = task(f.db, "codex-no-memory");
    f.worker.start(bare);
    expect(developerInstructions(f.process.calls[0]!.args)).not.toContain("## Memory");

    recordKnowledge(
      f.db,
      { scope: "work", path: "board", title: "Board correctness", text: "Tests guard the board.", author: { activity: "human", name: "human" } },
      "webui",
      new Date("2026-08-24T00:00:00.000Z"),
    );
    const work = task(f.db, "codex-memory");
    const review = registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "keep the board correct", completion_criteria: "reviewed" },
      new Date("2026-08-24T00:00:00.000Z"),
    );
    for (const [i, value] of [work, review].entries()) {
      f.worker.start(value);
      const { section } = buildMemoryInjection(f.db, value, "work", "codex-agent");
      expect(developerInstructions(f.process.calls[i + 1]!.args).startsWith(`${section}\n\n`)).toBe(true);
    }

    for (const value of [bare, work, review]) {
      const events = listEvents(f.db, value.id);
      const spawned = events.findIndex((e) => e.kind === "worker_spawned");
      expect(events[spawned + 1]?.payload).toMatchObject({ kind: "memory_injected", worker_spawned_event_id: events[spawned]!.id });
    }
    expect(listEvents(f.db, bare.id).find((e) => e.kind === "memory_injected")?.payload).toMatchObject({ entries: [] });
  });

  it("盤面が順位で選んだ openai の設定を渡されれば、anthropic を先頭に持つ agent でも codex で走る(#544 の demo —— spawn 側の再解決は順位1位の anthropic を返して拒否になる)", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-carried-setting");
    f.worker.start(value, {
      provider: "openai",
      model: "gpt-6-astra",
      effort: "high",
      advisor: undefined,
      source: { tier: "task", provider: "rank" },
    });
    expect(f.process.calls[0]!.args).toEqual(
      expect.arrayContaining(["-m", "gpt-6-astra"]),
    );
    expect(
      listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")?.payload,
    ).toMatchObject({
      provider: "openai",
      model: "gpt-6-astra",
      source: { tier: "task", provider: "rank" },
      harness: "codex",
    });
  });

  it("the spawned Board-owned hook denies a Tidepool MCP call carrying an agent_id and fails closed", async () => {
    const f = await fixture();
    f.worker.start(task(f.db, "codex-hook"));
    const env = f.process.calls[0]!.env;
    const hook = join(f.codexHome, "tidepool-hooks", "main-thread-mcp.mjs");
    const invoke = (input: unknown) =>
      execFileSync(process.execPath, [hook], {
        env,
        input: typeof input === "string" ? input : JSON.stringify(input),
        encoding: "utf8",
      });
    const denied = { hookSpecificOutput: { permissionDecision: "deny" } };

    // subagent の呼び出しには必ず agent_id が載る。main thread では key ごと出ない(ADR 0130 決定1)
    expect(JSON.parse(invoke({
      hook_event_name: "PreToolUse",
      agent_id: "agent-1",
      tool_name: "mcp__tidepool__complete_task",
    }))).toMatchObject(denied);
    expect(invoke({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__tidepool__complete_task",
    })).toBe("");
    // 門が選ぶのは盤面 verb だけ —— subagent の他の tool は素通しする
    expect(invoke({
      hook_event_name: "PreToolUse",
      agent_id: "agent-1",
      tool_name: "shell",
    })).toBe("");
    // 空の agent_id も subagent の識別子 —— 真偽ではなく key の有無で見る
    expect(JSON.parse(invoke({
      hook_event_name: "PreToolUse",
      agent_id: "",
      tool_name: "mcp__tidepool__complete_task",
    }))).toMatchObject(denied);
    // 執行されない門は fail-open にしない: 解釈できない入力はすべて deny
    expect(JSON.parse(invoke("not-json"))).toMatchObject(denied);
    expect(JSON.parse(invoke({ hook_event_name: "SessionStart" }))).toMatchObject(denied);
  });

  it("normalizes a successful Codex JSONL fixture into the durable session event", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-success");
    f.worker.start(value);

    const jsonl = readFileSync(new URL("fixtures/codex-success.jsonl", import.meta.url), "utf8");
    f.process.stdout.write(jsonl);
    f.process.exit(0, null);

    const exited = listEvents(f.db, value.id).find((event) => event.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
        estimated_cost_usd: null,
        advisor: null,
      },
    });
    const spawned = listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")!;
    expect(
      readFileSync(join(f.logDir, `${value.id}.${spawned.id}.stream.jsonl`), "utf8"),
    ).toBe(jsonl);
  });

  it("does not infer OpenAI auth quarantine from Codex JSONL prose", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-auth");
    f.worker.start(value);
    f.process.stdout.write(
      readFileSync(new URL("fixtures/codex-auth-failure.jsonl", import.meta.url), "utf8"),
    );
    f.process.exit(1, null);

    expect(openQuarantineValues(f.db, "providerAuth")).toEqual([]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: 1,
      usage: null,
    });
  });

  it("records an ordinary nonzero exit and a successful exit with missing usage without inventing usage", async () => {
    for (const [id, code, stderr] of [
      ["codex-failed", 2, "model unavailable\n"],
      ["codex-missing-usage", 0, ""],
    ] as const) {
      const f = await fixture();
      const value = task(f.db, id);
      f.worker.start(value);
      f.process.stderr.write(stderr);
      f.process.exit(code, null);

      expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
        kind: "worker_exited",
        exit_code: code,
        signal: null,
        stderr_tail: stderr.trim() || null,
        usage: null,
      });
    }
  });

  it("spawn 自体の失敗(syscall が \"spawn\" で始まる)は盤面側の一撃を呼び、spawn 族でない error は呼ばず spawn_failed も書かない(ADR 0118)", async () => {
    const calls: Array<[string, { error_code: string | null; message: string }]> = [];
    const f = await fixture((taskId, failure) => calls.push([taskId, failure]));
    const value = task(f.db, "codex-spawn-enoent");
    f.worker.start(value);

    f.process.error(Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }));
    expect(calls).toEqual([]);
    expect(listEvents(f.db, value.id).some((e) => e.kind === "spawn_failed")).toBe(false);
    f.process.error(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT", syscall: "spawn codex" }));
    expect(calls).toEqual([[value.id, { error_code: "ENOENT", message: "spawn codex ENOENT" }]]);
  });

  it("root の exit は worker_exited を書いて強制回収を撃ったあとで、盤面側の一撃に exit code / signal / stderr 末尾を渡す(ADR 0145)", async () => {
    const calls: Array<[string, WorkerExit, { exitedRecorded: boolean; forced: boolean }]> = [];
    const f = await fixture(undefined, undefined, (taskId, exit) =>
      calls.push([taskId, exit, {
        exitedRecorded: listEvents(f.db, taskId).some((e) => e.kind === "worker_exited"),
        forced: f.process.killed.includes("SIGKILL"),
      }]),
    );
    const value = task(f.db, "codex-exit-without-report");
    f.worker.start(value);
    f.process.stderr.write("boom\n");
    f.process.exit(null, "SIGSEGV");

    expect(calls).toEqual([
      [value.id, { exit_code: null, signal: "SIGSEGV", stderr_tail: "boom" }, { exitedRecorded: true, forced: true }],
    ]);
  });

  it("delivers graceful stop to the retained Codex root and records the signaled exit", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-killed");
    f.worker.start(value);

    f.worker.gracefulStop(value.id);
    f.process.exit(null, "SIGINT");

    // 畳み込み停止の SIGINT のあと、root の exit を観測した盤面が容器を強制回収する
    // (ADR 0109 決定4)。passthrough の器ではそれが既に終わった子への SIGKILL に
    // なるが、実機構では「容器に残るものを畳む」操作であり、adapter は signal を
    // 選んでいない(ADR 0099 決定2)。
    expect(f.process.killed).toEqual(["SIGINT", "SIGKILL"]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: null,
      signal: "SIGINT",
      usage: null,
    });
  });
});

describe("resolveCodexExecutable", () => {
  it("PATH に載っているのが symlink でも実体のパスを返す(issue #646)", async () => {
    const base = await mkdtemp(join(tmpdir(), "tidepool-codex-which-"));
    const linkDir = join(base, "link");
    await mkdir(linkDir);
    const realExecutable = join(base, "codex");
    await writeFile(realExecutable, "#!/bin/sh\n", { mode: 0o755 });
    await symlink(realExecutable, join(linkDir, "codex"));

    expect(resolveCodexExecutable(linkDir)).toBe(await realpath(realExecutable));
  });
});
