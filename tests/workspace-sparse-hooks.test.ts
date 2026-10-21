import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import {
  excludeWorkspaceProjectSettings,
  materializeWorkspaceProjectSettings,
  prepareWorkspaceAtPickup,
  releaseWorkspace,
  restoreWorkspaceProjectSettingsAtBoot,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { FakeContainerRuntime } from "./fakes.js";
import { bootTidepool, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, type Tidepool } from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let db: Db | undefined;
let tidepool: Tidepool | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  await tidepool?.stop();
  tidepool = undefined;
});

it("hooks settings は slot 解放中も sparse のまま親子の WIP に混ぜず、worker 回収後に戻せる", async () => {
  const workspace = await makeWorkspace("sparse-hooks");
  await mkdir(join(workspace.path, ".claude"), { recursive: true });
  const settings = JSON.stringify({ hooks: { PostToolUse: [] } });
  await writeFile(join(workspace.path, ".claude", "settings.json"), settings);
  git(workspace.path, "add", ".claude/settings.json");
  git(workspace.path, "commit", "-m", "share project hooks");
  db = openDb(":memory:");
  const now = new Date("2026-09-04T00:00:00.000Z");
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent work",
      purpose: "provide a child fork source",
      completion_criteria: "parent work is committed",
    },
    now,
    ...HUMAN_WEBUI,
  );

  await prepareWorkspaceAtPickup(db, workspace, parent);
  excludeWorkspaceProjectSettings(db, workspace);
  commitWork(workspace.path, "parent.txt", "parent work\n");
  releaseWorkspace(db, workspace, parent, now);
  expect(() => readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toThrow();

  const child = registerTask(
    db,
    {
      type: "work",
      parent_id: parent.id,
      title: "child work",
      purpose: "continue from the parent",
      completion_criteria: "child WIP is preserved",
    },
    now,
    ...HUMAN_WEBUI,
  );
  await prepareWorkspaceAtPickup(db, workspace, child);
  excludeWorkspaceProjectSettings(db, workspace);
  expect(readFileSync(join(workspace.path, "parent.txt"), "utf8")).toBe("parent work\n");
  writeFileSync(join(workspace.path, "child.txt"), "child work\n");
  releaseWorkspace(db, workspace, child, now);

  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expect(git(workspace.path, "diff", "--name-only", `task/${parent.id}..task/${child.id}`)).toBe(
    "child.txt",
  );
  expect(git(workspace.path, "show", `task/${child.id}:.claude/settings.json`)).toBe(settings);
  expect(() => readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toThrow();
  materializeWorkspaceProjectSettings(db, workspace);
  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);
});

/** 前の盤面 process が隠したまま落ちた形 —— 写しは次の盤面が開く DB に残る(ADR 0293 決定5)。 */
async function hiddenByPreviousBoard(workspace: WorkspaceConfig): Promise<string> {
  const dir = await tempDir("tidepool-test-");
  const previous = openDb(join(dir, "board.sqlite"));
  excludeWorkspaceProjectSettings(previous, workspace);
  previous.close();
  return dir;
}

it("再起動は前 process が残した sparse settings を human side へ戻す", async () => {
  const workspace = await makeWorkspace("sparse-hooks-restart");
  await mkdir(join(workspace.path, ".claude"), { recursive: true });
  const settings = JSON.stringify({ hooks: { PostToolUse: [] } });
  await writeFile(join(workspace.path, ".claude", "settings.json"), settings);
  git(workspace.path, "add", ".claude/settings.json");
  git(workspace.path, "commit", "-m", "share project hooks");
  const dir = await hiddenByPreviousBoard(workspace);

  tidepool = await bootTidepool({
    dir,
    workspace,
    boardState: { paths: [], listWorkspaces: () => [workspace] },
  });

  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);
});

it("再起動時に前 worker の不在を証明できなければ sparse settings を戻さない", async () => {
  const workspace = await makeWorkspace("sparse-hooks-restart-unsafe");
  await mkdir(join(workspace.path, ".claude"), { recursive: true });
  await writeFile(
    join(workspace.path, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PostToolUse: [] } }),
  );
  git(workspace.path, "add", ".claude/settings.json");
  git(workspace.path, "commit", "-m", "share project hooks");
  const dir = await hiddenByPreviousBoard(workspace);
  const containers = new FakeContainerRuntime();
  containers.scriptPreflight("a container from a previous run is still populated");

  tidepool = await bootTidepool({
    dir,
    workspace,
    containerRuntime: containers,
    boardState: { paths: [], listWorkspaces: () => [workspace] },
  });

  expect(() => readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toThrow();
});

/** ADR 0293 の実測と同じ形: `pkg-a/` `pkg-b/` と hooks 持ちの tracked `.claude/settings.json`。 */
async function monorepo(name: string): Promise<WorkspaceConfig> {
  const workspace = await makeWorkspace(name);
  for (const [path, body] of [
    ["pkg-a/a.txt", "a\n"],
    ["pkg-b/b.txt", "b\n"],
    [".claude/settings.json", JSON.stringify({ hooks: { PostToolUse: [] } })],
  ] as const) {
    await mkdir(dirname(join(workspace.path, path)), { recursive: true });
    await writeFile(join(workspace.path, path), body);
  }
  git(workspace.path, "add", ".");
  git(workspace.path, "commit", "-m", "monorepo");
  return workspace;
}

const exists = (workspace: WorkspaceConfig, path: string) => existsSync(join(workspace.path, path));

it("人間の cone は session 中も広がらず settings.json だけ消え、戻すと pattern と cone モードが元どおり(ADR 0293)", async () => {
  const workspace = await monorepo("sparse-cone");
  git(workspace.path, "sparse-checkout", "set", "pkg-a", ".claude");
  db = openDb(":memory:");

  excludeWorkspaceProjectSettings(db, workspace);
  expect(exists(workspace, ".claude/settings.json")).toBe(false);
  expect(exists(workspace, "pkg-a/a.txt")).toBe(true);
  expect(exists(workspace, "pkg-b")).toBe(false);

  materializeWorkspaceProjectSettings(db, workspace);
  expect(git(workspace.path, "sparse-checkout", "list").split("\n")).toEqual([".claude", "pkg-a"]);
  expect(git(workspace.path, "config", "--get", "core.sparseCheckoutCone")).toBe("true");
  expect(exists(workspace, ".claude/settings.json")).toBe(true);
  expect(exists(workspace, "pkg-b")).toBe(false);
});

it("sparse を使わない checkout は戻した後 sparse でなく、盤面の pattern ファイルも残らない(ADR 0293)", async () => {
  const workspace = await monorepo("sparse-none");
  db = openDb(":memory:");

  excludeWorkspaceProjectSettings(db, workspace);
  expect(exists(workspace, ".claude/settings.json")).toBe(false);
  expect(exists(workspace, "pkg-b/b.txt")).toBe(true);

  materializeWorkspaceProjectSettings(db, workspace);
  expect(git(workspace.path, "config", "--type=bool", "--default=false", "--get", "core.sparseCheckout")).toBe("false");
  expect(exists(workspace, ".git/info/sparse-checkout")).toBe(false);
  expect(exists(workspace, ".claude/settings.json")).toBe(true);
});

it("回収前の2本目の除外は写しを書き直さず、1回の戻しで人間の形に戻る(ADR 0293 決定1)", async () => {
  const workspace = await monorepo("sparse-second");
  git(workspace.path, "sparse-checkout", "set", "pkg-a", ".claude");
  db = openDb(":memory:");

  excludeWorkspaceProjectSettings(db, workspace);
  excludeWorkspaceProjectSettings(db, workspace);
  materializeWorkspaceProjectSettings(db, workspace);

  expect(git(workspace.path, "sparse-checkout", "list").split("\n")).toEqual([".claude", "pkg-a"]);
  expect(git(workspace.path, "config", "--get", "core.sparseCheckoutCone")).toBe("true");
});

it("起動時の復元は写しの有無で対象を選ぶ —— S bit は読まない(ADR 0293 決定3)", async () => {
  const hidden = await monorepo("sparse-boot-snapshot");
  const humans = await monorepo("sparse-boot-human");
  // 人間自身の cone が .claude を外している —— settings.json に S bit が立つが、盤面の除外ではない
  git(humans.path, "sparse-checkout", "set", "pkg-a");
  git(hidden.path, "sparse-checkout", "set", "pkg-a", ".claude");
  db = openDb(":memory:");
  excludeWorkspaceProjectSettings(db, hidden);
  // 写しはあるが S bit は無い —— session 中に誰かが sparse-checkout を外した形
  git(hidden.path, "sparse-checkout", "disable");

  restoreWorkspaceProjectSettingsAtBoot(db, () => [hidden, humans], new Date("2026-10-21T00:00:00.000Z"));

  expect(git(hidden.path, "sparse-checkout", "list").split("\n")).toEqual([".claude", "pkg-a"]);
  expect(exists(hidden, ".claude/settings.json")).toBe(true);
  expect(git(humans.path, "sparse-checkout", "list")).toBe("pkg-a");
  expect(exists(humans, ".claude/settings.json")).toBe(false);
  expect(workspaceNeedsHuman(db, humans.name)).toBe(false);
});
