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
      model: undefined,
      effort: undefined,
      advisor: "opus",
      icon: "🐙",
      skills: ["*"],
      systemPrompt: "",
    });
    expect(registry.agents.fugu).toEqual({
      name: "fugu",
      version: "1",
      authority: "auditor",
      description: "Reviews work independently against its completion criteria.",
      model: undefined,
      effort: undefined,
      advisor: "opus",
      icon: "🐡",
      skills: ["@workspace"],
      systemPrompt:
        "Distance from the work is valuable because it reveals different risks.\n" +
        "Judge the result against its completion criteria.\n" +
        "Cite the files, behavior, and records you examined.\n" +
        "Say what you could not verify instead of filling gaps.\n" +
        "If there are no findings, say so.",
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
    expect(existsSync(join(workspace, "README.md"))).toBe(true);
    expect(git(workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(workspace, "rev-list", "--count", "HEAD")).toBe("1");
    expect(result.stdout).toContain('Registry seeded with agent "tako", auditor "fugu", and workspace "sandbox".');
    expect(result.stdout).toContain("First task example");
    expect(result.stdout).toContain("merge question");
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
    expect(existsSync(join(workspacesDir, "lagoon", "README.md"))).toBe(true);
    expect(result.stdout).toContain(
      'Registry seeded with agent "ika", auditor "namako", and workspace "lagoon".',
    );
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
    expect(existsSync(join(root, "tidepool-workspaces", "sandbox", "README.md"))).toBe(true);
  });

  it("prints the same default config and first-task example as the Mac setup guide", async () => {
    const { clone, root } = await emptyRegistryClone();
    const result = runInit(
      cleanEnv({
        HOME: root,
        TIDEPOOL_REGISTRY: clone,
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const guide = readFileSync(join(ROOT, "docs", "mac-first-boot.md"), "utf8");

    for (const line of [
      'Registry seeded with agent "tako", auditor "fugu", and workspace "sandbox".',
      "Title: Resolve the README TODO",
      "Purpose: Replace the TODO in sandbox/README.md with a short description of this workspace.",
      "Completion criteria: README.md contains the description and the task reaches the merge question.",
    ]) {
      expect(result.stdout).toContain(line);
      expect(guide).toContain(line);
    }

    const orderedSteps = [
      "## Prepare the registry on a Mac",
      "gh repo create",
      "git clone",
      "npm run init-registry",
      "npm start",
      "First task example",
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
