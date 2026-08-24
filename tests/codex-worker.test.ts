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
import { registerTask } from "../src/tasks.js";
import { FakeClock } from "./fakes.js";
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

async function fixture() {
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
model: gpt-5.6-sol
effort: high
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
    spawn: process.spawn,
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
    expect(call.command).toBe("codex");
    expect(call.cwd).toBe(f.workspace);
    expect(call.env.CODEX_HOME).toBe(f.codexHome);
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
    expect(call.args).toEqual(expect.arrayContaining([
      "--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "-C", f.workspace, "-m", "gpt-5.6-sol",
    ]));
    const config = call.args.filter((_, index) => call.args[index - 1] === "-c").join("\n");
    expect(config).toContain('model_reasoning_effort="high"');
    expect(config).toContain('default_permissions="tidepool-work"');
    expect(config).toContain("api.github.com");
    expect(config).toContain("features.plugins=false");
    expect(config).toContain("features.tool_search=false");
    expect(config).toContain("features.apps=false");
    expect(config).toContain('forced_login_method="chatgpt"');
    expect(config).toContain("project_doc_max_bytes=0");
    expect(config).toContain('web_search="disabled"');
    expect(config).toContain("mcp_servers.tidepool.enabled_tools=");
    expect(config).toContain("get_current_task");
    expect(config).toContain("mcp_servers.tidepool.required=true");
    expect(config).toContain("skills.config=");
    expect(config).toContain(join(f.codexHome, "skills", ".system", "openai-docs"));
    expect(config).toContain(join(f.workspace, ".agents", "skills", "repo-skill"));
    expect(config).toContain("hooks.SubagentStart=");
    expect(config).toContain("hooks.PreToolUse=");
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")?.payload).toMatchObject({
      kind: "worker_spawned",
      harness: "codex",
      cli_version: CLI_VERSION,
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

  it("quarantines only OpenAI pickup when Codex JSONL reports a ChatGPT auth failure", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-auth");
    f.worker.start(value);
    f.process.stdout.write(
      readFileSync(new URL("fixtures/codex-auth-failure.jsonl", import.meta.url), "utf8"),
    );
    f.process.exit(1, null);

    expect(quarantinedAuthProviders(f.db)).toEqual(["openai"]);
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

  it("delivers kill to the retained Codex root and records the signaled exit", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-killed");
    f.worker.start(value);

    f.worker.kill(value.id, "SIGTERM");
    f.process.exit(null, "SIGTERM");

    expect(f.process.killed).toEqual(["SIGTERM"]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: null,
      signal: "SIGTERM",
      usage: null,
    });
  });
});
