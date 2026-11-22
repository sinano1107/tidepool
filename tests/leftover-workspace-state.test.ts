import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { announceHeadRepo } from "../src/workspace.js";
import { createWorkspace } from "../src/workspace-create.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, leaveBaseline, makeWorkspace, type Tidepool } from "./harness.js";
import { commitWorkspaceDeletion, makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

// 削除の途中で残った workspace_state の行の上で登録し直さない —— 出口を名指す(ADR 0401 決定5、issue #3198)

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

async function bootWithRegistry(registryDir: string) {
  const workspacesBaseDir = await tempDir("tidepool-ws-base-");
  t = await bootTidepool({
    workspaceAdmin: { create: (input) => createWorkspace(input, { registry: { dir: registryDir, mode: "purely-local" }, workspacesBaseDir, db: t.db }) },
  });
  return workspacesBaseDir;
}

it("削除の commit の後で基準の行が残った名前の登録は断られ、文が削除の commit と出口を順に名指し、clone を残さない", async () => {
  const reef = await makeWorkspace("reef");
  const registryDir = await makeRegistry({ "workspaces.yaml": `reef:\n  path: ${reef.path}\n` });
  const deletion = commitWorkspaceDeletion(registryDir, "reef");
  const workspacesBaseDir = await bootWithRegistry(registryDir);
  await leaveBaseline(t.db, reef);

  const res = await api(t.baseUrl, "POST", "/api/workspaces", { mode: "create", name: "reef" });

  expect(res.status).toBe(400);
  expect(res.json.error).toBe(
    `workspace "reef" cannot be registered: the board still holds state from an earlier workspace with that name. A deletion of "reef" stopped midway: registry commit ${deletion} removed the entry, but the board kept its state. To clear it, in order: put the entry back in the registry under that name as it was in workspaces.yaml at ${deletion}^, with its repo and head_repo as well as its path (a repo other than the one the board remembers is refused again); accept the open Quarantine question for "reef", if any; delete the workspace through the deletion door; register it again (under a new name to rename it).`,
  );
  expect(existsSync(join(workspacesBaseDir, "reef"))).toBe(false);
});

it("撮りを持たない行(出元 repo を覚えただけ)が残る名前も断られ、削除の commit が無ければ条件つきの文で出口を名指す", async () => {
  const reef = await makeWorkspace("reef");
  const registryDir = await makeRegistry();
  const workspacesBaseDir = await bootWithRegistry(registryDir);
  announceHeadRepo(t.db, reef, "octo/reef-fork");

  const res = await api(t.baseUrl, "POST", "/api/workspaces", { mode: "create", name: "reef" });

  expect(res.status).toBe(400);
  expect(res.json.error).toBe(
    'workspace "reef" cannot be registered: the board still holds state from an earlier workspace with that name. The board found no registry commit from the deletion door for "reef"; the entry was likely removed or renamed by hand. To clear it, in order: put the entry back in the registry under that name as it was before it was removed (in workspaces.yaml at the parent of the commit that removed it, if it was committed), with its repo and head_repo as well as its path (a repo other than the one the board remembers is refused again); accept the open Quarantine question for "reef", if any; delete the workspace through the deletion door; register it again (under a new name to rename it).',
  );
  expect(existsSync(join(workspacesBaseDir, "reef"))).toBe(false);
});
