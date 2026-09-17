import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { quarantinedAuthProviders } from "../src/cli-auth.js";
import { type CodexSpawnFn, CodexWorker } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { buildMemoryInjection, recordKnowledge } from "../src/memory.js";
import { registerTask } from "../src/tasks.js";
import { FakeClock, passthroughContainers } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

const CLI_VERSION = "codex-cli 0.147.0";

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

async function fixture(
  onSpawnFailed?: (taskId: string, failure: { error_code: string | null; message: string }) => void,
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
  path: ${workspace}
  allowed_domains:
    - api.github.com
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
      "--ignore-rules", "--strict-config", "-C", f.workspace, "-m", "gpt-5.6-terra",
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
    expect(config).toContain("features.plugins=false");
    expect(config).toContain("features.skill_search=false");
    expect(config).toContain("features.apps=false");
    expect(config).toContain('forced_login_method="chatgpt"');
    expect(config).toContain("project_doc_max_bytes=0");
    expect(config).toContain('web_search="disabled"');
    expect(config).toContain("mcp_servers.tidepool.enabled_tools=");
    expect(config).toContain("get_current_task");
    expect(config).toContain("mcp_servers.tidepool.required=true");
    expect(config).toContain("skills.config=");
    expect(config).toContain(join(f.codexHome, "skills", ".system", "openai-docs", "SKILL.md"));
    expect(config).toContain(join(f.workspace, ".agents", "skills", "repo-skill", "SKILL.md"));
    expect(config).toContain("?task=" + value.id);
    expect(config).toContain("hooks.SubagentStart=");
    expect(config).toContain("hooks.PreToolUse=");
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

  it("主題 memory の meta-review の spawn では enabled_tools が worker の memory verb を専用 verb で置き換え、普通の task は変わらない(ADR 0122 決定2)", async () => {
    const f = await fixture();
    const enabledTools = (index: number) =>
      configValue<string[]>(f.process.calls[index]!.args, "mcp_servers.tidepool.enabled_tools=");
    f.worker.start(task(f.db));
    f.worker.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", title: "Memory meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" },
      new Date("2026-08-24T00:00:00.000Z"),
    ));

    const base = ["get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate", "declare_premise_breach", "continue_decomposition", "redecompose"];
    expect(enabledTools(0)).toEqual([...base, "record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory", "propose_from_objection"]);
    expect(enabledTools(1)).toEqual([
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

  it("the spawned Board-owned hook denies Tidepool MCP only from subagent turns and fails closed", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-hook");
    f.worker.start(value);
    const env = f.process.calls[0]!.env;
    const hook = join(f.codexHome, "tidepool-hooks", "main-thread-mcp.mjs");
    const invoke = (input: object) =>
      execFileSync(process.execPath, [hook], {
        env,
        input: JSON.stringify(input),
        encoding: "utf8",
      });

    expect(env.TIDEPOOL_SUBAGENT_STATE).toContain(f.codexHome);
    expect(invoke({
      hook_event_name: "PreToolUse",
      turn_id: "main-turn",
      tool_name: "mcp__tidepool__complete_task",
    })).toBe("");
    expect(invoke({
      hook_event_name: "SubagentStart",
      turn_id: "sub-turn",
      agent_id: "agent-1",
    })).toBe("");
    expect(JSON.parse(invoke({
      hook_event_name: "PreToolUse",
      turn_id: "sub-turn",
      tool_name: "mcp__tidepool__complete_task",
    }))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    writeFileSync(env.TIDEPOOL_SUBAGENT_STATE!, "not-json");
    expect(JSON.parse(invoke({
      hook_event_name: "PreToolUse",
      turn_id: "main-turn",
      tool_name: "mcp__tidepool__complete_task",
    }))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
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

    expect(quarantinedAuthProviders(f.db)).toEqual([]);
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
