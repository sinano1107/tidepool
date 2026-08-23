import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AUDITOR_NAME,
  DEFAULT_WORKSPACE_NAME,
} from "../src/defaults.js";
import { loadRegistry } from "../src/registry.js";
import { DEFAULT_AUDITOR_NAME as TASK_DEFAULT_AUDITOR_NAME } from "../src/tasks.js";
import { resolveWorkspacesBaseDir } from "../src/workspace.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function emptyRegistryClone(): Promise<{ clone: string; origin: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "tidepool-init-registry-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "registry");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, clone);
  git(clone, "config", "user.name", "Registry Owner");
  git(clone, "config", "user.email", "owner@example.com");
  return { clone, origin, root };
}

function cleanEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "TIDEPOOL_REGISTRY",
    "TIDEPOOL_WORKSPACES_DIR",
    "TIDEPOOL_WORKSPACE",
    "TIDEPOOL_AGENT",
    "TIDEPOOL_AUDITOR",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runInit(env: NodeJS.ProcessEnv) {
  return spawnSync("npm", ["run", "init-registry"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
}

describe("npm run init-registry", () => {
  it("requires TIDEPOOL_REGISTRY", () => {
    const result = runInit(cleanEnv({}));

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Error: TIDEPOOL_REGISTRY is required\n");
  });

  it("seeds an empty remote with the default registry and an initial workspace", async () => {
    const { clone, origin, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(git(origin, "rev-list", "--count", "main")).toBe("1");
    expect(git(clone, "status", "--short")).toBe("");

    const registry = loadRegistry(clone, "remote-backed");
    expect(Object.keys(registry.agents).sort()).toEqual(["fugu", "tako"]);
    expect(registry.agents.tako).toEqual({
      name: "tako",
      version: "1",
      authority: "standard",
      description: "General work agent for the Tidepool board.",
      provider: "anthropic",
      model: undefined,
      effort: undefined,
      advisor: undefined,
      icon: "🐙",
      skills: ["*"],
      systemPrompt: "",
    });
    expect(registry.agents.fugu).toEqual({
      name: "fugu",
      version: "1",
      authority: "auditor",
      description: "Reviews work independently against its completion criteria.",
      provider: "anthropic",
      model: undefined,
      effort: undefined,
      advisor: undefined,
      icon: "🐡",
      skills: ["@workspace"],
      systemPrompt: "",
    });
    expect(registry.authority.standard).toEqual({
      name: "standard",
      guidance: "Prefer reversible work and escalate decisions outside the stated authority.",
      assignable_to: ["*"],
      allowed_workspaces: ["*"],
      merge: "escalate",
    });
    expect(registry.authority.auditor).toEqual({
      name: "auditor",
      guidance: "",
      assignable_to: [],
      allowed_workspaces: [],
      merge: "escalate",
    });
    expect(registry.workspaces).toEqual({ sandbox: {} });

    const workspace = join(workspacesDir, "sandbox");
    expect(existsSync(join(workspace, "README.md"))).toBe(false);
    expect(git(workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(workspace, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(workspace, "show", "--format=", "--stat")).toBe("");
    expect(result.stdout).toContain('Registry seeded with agent "tako", auditor "fugu", and workspace "sandbox".');
    expect(result.stdout).not.toContain("First task example");
    // merge question は worker が感知できない盤面側の出来事なので completion criteria には書かない
    expect(result.stdout).not.toContain("merge question");
  });

  it("refuses an existing non-git workspace before changing the registry or workspace", async () => {
    const { clone, origin, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");
    const workspace = join(workspacesDir, "sandbox");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "keep.txt"), "human data\n");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${workspace} exists but is not a git repository`);
    expect(git(root, "ls-remote", "--heads", origin)).toBe("");
    expect(git(clone, "status", "--short")).toBe("");
    expect(existsSync(join(workspace, "keep.txt"))).toBe(true);
    expect(existsSync(join(workspace, "README.md"))).toBe(false);
  });

  it("refuses a non-empty origin/main without changing the clone or creating a workspace", async () => {
    const { clone, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");
    await writeFile(join(clone, "existing.txt"), "existing registry\n");
    git(clone, "add", "existing.txt");
    git(clone, "commit", "-m", "Existing registry");
    git(clone, "push", "-u", "origin", "main");
    const before = git(clone, "rev-parse", "HEAD");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Error: origin/main is not empty; init-registry only seeds an empty remote and does not repair an existing registry\n",
    );
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(git(clone, "status", "--short")).toBe("");
    expect(existsSync(workspacesDir)).toBe(false);
  });

  it("refuses a non-empty origin whose commit is on another branch", async () => {
    const { clone, origin, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");
    await writeFile(join(clone, "existing.txt"), "existing registry\n");
    git(clone, "add", "existing.txt");
    git(clone, "commit", "-m", "Existing registry");
    git(clone, "push", "origin", "HEAD:develop");
    const before = git(clone, "rev-parse", "HEAD");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Error: origin is not empty; init-registry only seeds an empty remote and does not repair an existing registry\n",
    );
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(git(root, "ls-remote", "--heads", origin)).toContain("refs/heads/develop");
    expect(existsSync(workspacesDir)).toBe(false);
  });

  it("refuses a local registry commit that has not been pushed", async () => {
    const { clone, origin, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");
    await writeFile(join(clone, "local.txt"), "local registry\n");
    git(clone, "add", "local.txt");
    git(clone, "commit", "-m", "Local registry");
    const before = git(clone, "rev-parse", "HEAD");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${clone} already has a local commit`);
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(git(root, "ls-remote", "--heads", origin)).toBe("");
    expect(existsSync(workspacesDir)).toBe(false);
  });

  it("refuses a dirty empty clone without overwriting local registry files", async () => {
    const { clone, origin, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");
    const localAgent = join(clone, "agents", "tako.md");
    await mkdir(dirname(localAgent), { recursive: true });
    await writeFile(localAgent, "human draft\n");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${clone} has local changes`);
    expect(readFileSync(localAgent, "utf8")).toBe("human draft\n");
    expect(git(root, "ls-remote", "--heads", origin)).toBe("");
    expect(existsSync(workspacesDir)).toBe(false);
  });

  it("refuses a registry clone with no origin before changing either location", async () => {
    const root = await mkdtemp(join(tmpdir(), "tidepool-init-no-origin-"));
    const clone = join(root, "registry");
    const workspacesDir = join(root, "workspaces");
    git(root, "init", "-b", "main", clone);

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`Error: ${clone} has no origin remote\n`);
    expect(git(clone, "status", "--short")).toBe("");
    expect(existsSync(workspacesDir)).toBe(false);
  });

  it("leaves an existing git workspace untouched", async () => {
    const { clone, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");
    const workspace = join(workspacesDir, "sandbox");
    await mkdir(workspace, { recursive: true });
    git(workspace, "init", "-b", "main");
    await writeFile(join(workspace, "keep.txt"), "existing workspace\n");
    git(workspace, "add", "keep.txt");
    git(
      workspace,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Existing workspace",
    );
    const before = git(workspace, "rev-parse", "HEAD");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(before);
    expect(git(workspace, "status", "--short")).toBe("");
    expect(existsSync(join(workspace, "README.md"))).toBe(false);
  });

  it("uses configured agent, auditor, workspace, and workspaces directory values", async () => {
    const { clone, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "configured-workspaces");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
        TIDEPOOL_WORKSPACE: "lagoon",
        TIDEPOOL_AGENT: "ika",
        TIDEPOOL_AUDITOR: "namako",
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    const registry = loadRegistry(clone, "remote-backed");
    expect(Object.keys(registry.agents).sort()).toEqual(["ika", "namako"]);
    expect(registry.workspaces).toEqual({ lagoon: {} });
    expect(existsSync(join(workspacesDir, "lagoon", "README.md"))).toBe(false);
    expect(result.stdout).toContain(
      'Registry seeded with agent "ika", auditor "namako", and workspace "lagoon".',
    );
  });

  it.each([
    ["TIDEPOOL_WORKSPACE", "../escape", "invalid workspace name"],
    ["TIDEPOOL_AGENT", "bad/agent", "invalid agent name"],
    ["TIDEPOOL_AUDITOR", "bad/auditor", "invalid agent name"],
    [
      "TIDEPOOL_AUDITOR",
      "tako",
      "TIDEPOOL_AGENT and TIDEPOOL_AUDITOR must name different agents",
    ],
  ])("refuses unsafe %s values before changing either location", async (key, value, message) => {
    const { clone, origin, root } = await emptyRegistryClone();
    const workspacesDir = join(root, "workspaces");

    const result = runInit(
      cleanEnv({
        TIDEPOOL_REGISTRY: clone,
        TIDEPOOL_WORKSPACES_DIR: workspacesDir,
        [key]: value,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(git(root, "ls-remote", "--heads", origin)).toBe("");
    expect(git(clone, "status", "--short")).toBe("");
    expect(existsSync(workspacesDir)).toBe(false);
  });

  it("uses ~/tidepool-workspaces when TIDEPOOL_WORKSPACES_DIR is absent", async () => {
    const { clone, root } = await emptyRegistryClone();

    const result = runInit(
      cleanEnv({
        HOME: root,
        TIDEPOOL_REGISTRY: clone,
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "tidepool-workspaces", "sandbox", "README.md"))).toBe(false);
  });

  it("prints only boot steps, while the Mac setup guide keeps the trial on its own workspace", async () => {
    const { clone, root } = await emptyRegistryClone();
    const result = runInit(
      cleanEnv({
        HOME: root,
        TIDEPOOL_REGISTRY: clone,
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const guide = readFileSync(join(ROOT, "docs", "mac-first-boot.md"), "utf8");

    expect(result.stdout).toContain('Registry seeded with agent "tako", auditor "fugu", and workspace "sandbox".');
    expect(result.stdout).not.toContain("First task example");

    // 自分の repo を足す段(第2段)は第1段の完走の後に置く(ADR 0090 決定4 — #392 が
    // 着地したので手順としては書かれているが、init-registry の出力は第1段だけを案内する)
    expect(result.stdout).not.toContain("Add your own repository");
    expect(guide.indexOf("## Create a trial workspace")).toBeLessThan(guide.indexOf("## First task"));
    expect(guide).toContain("Mode: `create`");
    expect(guide).toContain("Name: `trial`");
    expect(guide).toContain("`(default workspace)` means `sandbox`");
    expect(guide).toContain("**Workspace** to `trial`");
    expect(guide).toContain("Title: Create the trial README");
    expect(guide).toContain("Purpose: Create README.md with this one-sentence description:");
    expect(guide).toContain("Completion criteria: README.md exists and contains that sentence.");
    expect(guide).toContain('echo "required Tidepool environment is set"');
    expect(guide).toContain("### Publish the trial");
    expect(guide).not.toContain("Publish the sandbox");
    expect(guide.indexOf("## Stage two")).toBeLessThan(guide.indexOf("npm run github-login"));

    const orderedSteps = [
      "## Prepare the registry",
      "gh repo create",
      "git clone git@github.com:YOUR_GITHUB_LOGIN",
      "npm run init-registry",
      "npm start",
      "## Create a trial workspace",
      "## First task",
    ];
    let previous = -1;
    for (const step of orderedSteps) {
      const position = guide.indexOf(step);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
  });
});

describe("shared boot and init defaults", () => {
  it("exports the three pointer defaults and the existing workspace base resolver", () => {
    expect(DEFAULT_AGENT_NAME).toBe("tako");
    expect(DEFAULT_AUDITOR_NAME).toBe("fugu");
    expect(DEFAULT_WORKSPACE_NAME).toBe("sandbox");
    expect(TASK_DEFAULT_AUDITOR_NAME).toBe(DEFAULT_AUDITOR_NAME);
    expect(resolveWorkspacesBaseDir("/tmp/tidepool-workspaces")).toBe(
      "/tmp/tidepool-workspaces",
    );
  });
});
