import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

/** ADR 0052 の remote-backed 盤面の fixture: bare な origin を持ち、`main` を
 *  push 済みの registry clone と、そこへ**人間の merge を模して**書き込むための
 *  publisher clone を返す。
 *
 *  `makeRegistry` に remote を足さないのは ADR 0052 が明示した線である —— 純
 *  ローカル盤面は正当な構成なので、14 ファイルが依存する既定の fixture は remote
 *  を持たないまま無傷で通らなければならない。remote が要るテストだけがこれを使う。 */
export async function makeRemoteBackedRegistry(): Promise<{
  registryDir: string;
  /** origin/main へ直接コミットして push する = リモートで merge が起きた状態を作る。
   *  返すのはリモート `main` の新しい commit hash —— 呼び出し側が「ref がそこまで
   *  動いたか」を見られるようにするため。clone 側の `origin/main` は fetch する
   *  まで動かない(そこが測りたい差である)。 */
  publish: (path: string, body: string, message: string) => string;
}> {
  const registryDir = await makeRegistry();
  const remote = await mkdtemp(join(tmpdir(), "tidepool-registry-remote-"));
  const publisher = await mkdtemp(join(tmpdir(), "tidepool-registry-publisher-"));
  // stderr は piped: push / clone の進捗は成否に関係なく stderr へ出るので、
  // 素通しするとテスト出力が git のノイズで埋まる(registry.ts の GIT_STDIO と同じ規律)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(remote, "init", "--bare", "-b", "main");
  git(registryDir, "remote", "add", "origin", remote);
  git(registryDir, "push", "-u", "origin", "main");
  git(process.cwd(), "clone", "--quiet", remote, publisher);
  return {
    registryDir,
    publish: (path, body, message) => {
      writeFileSync(join(publisher, path), body);
      git(publisher, "add", path);
      git(publisher, "commit", "-m", message);
      git(publisher, "push", "origin", "main");
      return git(publisher, "rev-parse", "HEAD").toString().trim();
    },
  };
}

/** A realistic registry for a human authoring preview, rebuilt for every run. */
export async function makePreviewRegistry(): Promise<string> {
  return makeRegistry(PREVIEW_REGISTRY_FILES, {});
}
