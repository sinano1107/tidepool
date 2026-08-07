import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_WILDCARD } from "../src/registry.js";
import { AUTHORITY_WILDCARD } from "../src/tasks.js";

const AGENT_MD = `---
name: deckhand
description: General work agent for the tidepool board
version: 0.3.1
authority: standard
skills:
  - "${SKILL_WILDCARD}"
---
You are Deckhand, the tidepool board's general work agent.
Work only through the tidepool MCP verbs.
`;

const AUTHORITY_YAML = `guidance: |
  Prefer reversible actions. Anything irreversible is outside your authority.
assignable_to:
  - "${AUTHORITY_WILDCARD}"
allowed_workspaces:
  - "${AUTHORITY_WILDCARD}"
`;

const WORKSPACES_YAML = `tidepool:
  path: /home/pi/work/tidepool
  repo: https://github.com/sinano1107/tidepool.git
  notes: run npm install before first use
`;

const DEFAULT_REGISTRY_FILES = {
  "agents/deckhand.md": AGENT_MD,
  "authority/standard.yaml": AUTHORITY_YAML,
  "workspaces.yaml": WORKSPACES_YAML,
};

/** The authoring board's committed, disposable registry. Keep this separate
 * from makeRegistry's minimal defaults: most registry tests deliberately need
 * exactly one agent, profile, and workspace. */
export const PREVIEW_REGISTRY_FILES: Record<string, string> = {
  "agents/navigator.md": `---
version: "1"
authority: steward
description: Plans work across the board and keeps handoffs clear.
icon: "🧭"
model: claude-sonnet-5
effort: high
skills:
  - "@workspace"
  - "@host"
---
You are Navigator. Turn ambiguous work into a small, well-routed plan.
`,
  "agents/shipwright.md": `---
version: "1"
authority: builder
description: Builds dependable product changes with careful tests.
icon: "🛠️"
model: claude-sonnet-5
effort: medium
skills:
  - "@workspace"
  - "tdd"
---
You are Shipwright. Build focused changes and leave the working tree ready for review.
`,
  "agents/lookout.md": `---
version: "1"
authority: reviewer
description: Reviews changes for regressions, clarity, and operational risk.
icon: "🔭"
model: claude-sonnet-5
effort: high
skills:
  - "@workspace"
  - "review"
---
You are Lookout. Find the important risks before they reach production.
`,
  "authority/steward.yaml": `guidance: |
  Break uncertain work into clear decisions and keep the board moving.
assignable_to:
  - navigator
  - shipwright
  - lookout
allowed_workspaces:
  - harbor
  - lighthouse
  - tidepool
merge: escalate
`,
  "authority/builder.yaml": `guidance: |
  Make narrow, reversible changes and explain the verification performed.
assignable_to:
  - lookout
allowed_workspaces:
  - harbor
  - lighthouse
merge: escalate
`,
  "authority/reviewer.yaml": `guidance: |
  Review independently and leave concrete, actionable findings.
assignable_to: []
allowed_workspaces:
  - harbor
  - lighthouse
  - tidepool
merge: escalate
`,
  "workspaces.yaml": `harbor:
  path: /workspaces/harbor
  repo: https://github.com/example/harbor.git
  notes: Product application and its integration tests.
lighthouse:
  path: /workspaces/lighthouse
  repo: https://github.com/example/lighthouse.git
  notes: Shared UI components and design-system work.
tidepool:
  path: /workspaces/tidepool
  repo: https://github.com/example/tidepool.git
  notes: Board configuration and operating conventions.
  protected: true
`,
};

/** Build a minimal valid registry clone: one agent, one authority profile,
 *  one workspace, committed so it has a HEAD. */
export async function makeRegistry(
  files: Record<string, string> = {},
  defaults: Record<string, string> = DEFAULT_REGISTRY_FILES,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-registry-"));
  const contents: Record<string, string> = {
    ...defaults,
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
  // ADR 0020: the board reads the registry from committed `main`, so the
  // fixture's default branch must be `main` (git's own default is still
  // `master` on the pinned version).
  git("init", "-b", "main");
  git("add", "-A");
  git("commit", "-m", "registry fixture");
  return dir;
}

/** A realistic registry for a human authoring preview, rebuilt for every run. */
export async function makePreviewRegistry(): Promise<string> {
  return makeRegistry(PREVIEW_REGISTRY_FILES, {});
}
