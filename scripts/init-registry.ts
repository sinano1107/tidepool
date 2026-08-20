import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AUDITOR_NAME,
  DEFAULT_WORKSPACE_NAME,
} from "../src/defaults.js";
import { resolveWorkspacesBaseDir } from "../src/workspace.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_ROOT = join(ROOT, "templates", "registry");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

function copyTemplate(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(join(TEMPLATE_ROOT, source)));
}

function main(): void {
  const registryDir = process.env.TIDEPOOL_REGISTRY;
  if (!registryDir) throw new Error("TIDEPOOL_REGISTRY is required");

  const agentName = process.env.TIDEPOOL_AGENT ?? DEFAULT_AGENT_NAME;
  const auditorName = process.env.TIDEPOOL_AUDITOR ?? DEFAULT_AUDITOR_NAME;
  const workspaceName = process.env.TIDEPOOL_WORKSPACE ?? DEFAULT_WORKSPACE_NAME;
  const workspacesDir = resolveWorkspacesBaseDir(process.env.TIDEPOOL_WORKSPACES_DIR);
  const workspaceDir = join(workspacesDir, workspaceName);

  if (existsSync(workspaceDir)) {
    let gitRoot: string;
    try {
      gitRoot = git(workspaceDir, "rev-parse", "--show-toplevel");
    } catch {
      throw new Error(`${workspaceDir} exists but is not a git repository`);
    }
    if (realpathSync(gitRoot) !== realpathSync(workspaceDir)) {
      throw new Error(`${workspaceDir} exists but is not a git repository`);
    }
  }

  try {
    git(registryDir, "remote", "get-url", "origin");
  } catch {
    throw new Error(`${registryDir} has no origin remote`);
  }
  git(registryDir, "fetch", "--quiet", "origin");
  if (gitRefExists(registryDir, "refs/remotes/origin/main")) {
    throw new Error(
      "origin/main is not empty; init-registry only seeds an empty remote and does not repair an existing registry",
    );
  }

  copyTemplate("agents/default-agent.md", join(registryDir, "agents", `${agentName}.md`));
  copyTemplate("agents/auditor-agent.md", join(registryDir, "agents", `${auditorName}.md`));
  copyTemplate("authority/standard.yaml", join(registryDir, "authority", "standard.yaml"));
  copyTemplate("authority/auditor.yaml", join(registryDir, "authority", "auditor.yaml"));
  const workspaces = readFileSync(join(TEMPLATE_ROOT, "workspaces.yaml"), "utf8").replace(
    "__TIDEPOOL_WORKSPACE__",
    workspaceName,
  );
  writeFileSync(join(registryDir, "workspaces.yaml"), workspaces);
  git(
    registryDir,
    "add",
    `agents/${agentName}.md`,
    `agents/${auditorName}.md`,
    "authority/standard.yaml",
    "authority/auditor.yaml",
    "workspaces.yaml",
  );
  git(registryDir, "commit", "-m", "Seed Tidepool registry");
  git(registryDir, "push", "-u", "origin", "HEAD:main");

  if (!existsSync(workspaceDir)) {
    mkdirSync(workspacesDir, { recursive: true });
    git(workspacesDir, "init", "-b", "main", workspaceDir);
    writeFileSync(
      join(workspaceDir, "README.md"),
      `# ${workspaceName}\n\nTODO: Describe what this workspace is for.\n`,
    );
    git(workspaceDir, "add", "README.md");
    const name = git(registryDir, "config", "user.name");
    const email = git(registryDir, "config", "user.email");
    git(
      workspaceDir,
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "-m",
      "Initial workspace",
    );
  }

  process.stdout.write(`Registry seeded with agent "${agentName}", auditor "${auditorName}", and workspace "${workspaceName}".\n\nNext steps:\n1. Start Tidepool with the same environment: npm start\n2. Open the WebUI.\n3. Register the first task below.\n4. Add your own repository from the WebUI workspace registration screen using the clone option when ready.\n\nFirst task example\nTitle: Resolve the README TODO\nPurpose: Replace the TODO in ${workspaceName}/README.md with a short description of this workspace.\nCompletion criteria: README.md contains the description and the task reaches the merge question.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
