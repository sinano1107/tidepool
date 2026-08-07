import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, listAgentViews, updateAgent } from "../src/agent-create.js";
import { createProfile, listProfileViews, updateProfile } from "../src/profile-create.js";
import { loadRegistry } from "../src/registry.js";
import { createWorkspace, listWorkspaceViews, updateWorkspace } from "../src/workspace-create.js";
import { bootstrapUrl, bootTidepool } from "./harness.js";
import { makePreviewRegistry } from "./registry-fixture.js";

export interface Preview {
  /** A credential bootstrap URL for the local, disposable preview board. */
  url: string;
  stop: () => Promise<void>;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Boot the settings authoring board on disposable state. It deliberately has
 * no worker process, GitHub identity, production-registry input, or configurable
 * push destination. The only remote is the bare repository made here.
 */
export async function bootPreview(): Promise<Preview> {
  const registryDir = await makePreviewRegistry();
  const remoteDir = await mkdtemp(join(tmpdir(), "tidepool-preview-origin-"));
  const workspacesDir = await mkdtemp(join(tmpdir(), "tidepool-preview-workspaces-"));

  try {
    git(remoteDir, "init", "--bare");
    git(registryDir, "remote", "add", "origin", remoteDir);

    const workspaceDeps = { registryDir, workspacesBaseDir: workspacesDir };
    const agentDeps = { registryDir };
    const profileDeps = { registryDir };
    const board = await bootTidepool({
      workspaceAdmin: {
        create: (input) => createWorkspace(input, workspaceDeps),
        list: () => listWorkspaceViews(workspaceDeps),
        update: (input) => updateWorkspace(input, workspaceDeps),
      },
      agentAdmin: {
        create: (input) => createAgent(input, agentDeps),
        list: () => listAgentViews(agentDeps),
        update: (input) => updateAgent(input, agentDeps),
        authorityProfiles: () => Object.keys(loadRegistry(registryDir).authority),
      },
      profileAdmin: {
        create: (input) => createProfile(input, profileDeps),
        list: () => listProfileViews(profileDeps),
        update: (input) => updateProfile(input, profileDeps),
      },
      hostSkills: async () => ["tdd", "review", "design-sync"],
    });

    return {
      url: bootstrapUrl(board.baseUrl),
      stop: async () => {
        try {
          await board.stop();
        } finally {
          await Promise.all([
            rm(registryDir, { recursive: true, force: true }),
            rm(remoteDir, { recursive: true, force: true }),
            rm(workspacesDir, { recursive: true, force: true }),
          ]);
        }
      },
    };
  } catch (error) {
    await Promise.all([
      rm(registryDir, { recursive: true, force: true }),
      rm(remoteDir, { recursive: true, force: true }),
      rm(workspacesDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
