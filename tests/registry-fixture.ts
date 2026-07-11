import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_MD = `---
name: deckhand
description: General work agent for the tidepool board
version: 0.3.1
authority: standard
---
You are Deckhand, the tidepool board's general work agent.
Work only through the tidepool MCP verbs.
`;

const AUTHORITY_YAML = `guidance: |
  Prefer reversible actions. Anything irreversible is outside your authority.
assignable_to:
  - "*"
allowed_workspaces:
  - "*"
`;

const WORKSPACES_YAML = `tidepool:
  path: /home/pi/work/tidepool
  repo: https://github.com/sinano1107/tidepool.git
  notes: run npm install before first use
`;

/** Build a minimal valid registry clone: one agent, one authority profile,
 *  one workspace, committed so it has a HEAD. */
export async function makeRegistry(
  files: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-registry-"));
  const contents: Record<string, string> = {
    "agents/deckhand.md": AGENT_MD,
    "authority/standard.yaml": AUTHORITY_YAML,
    "workspaces.yaml": WORKSPACES_YAML,
    ...files,
  };
  for (const [path, body] of Object.entries(contents)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd: dir },
    );
  git("init");
  git("add", "-A");
  git("commit", "-m", "registry fixture");
  return dir;
}
