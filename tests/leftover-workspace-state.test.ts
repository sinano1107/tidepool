import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { loadRegistry } from "../src/registry.js";
import { announceHeadRepo, resolveExecutionWorkspace } from "../src/workspace.js";
import { createWorkspace } from "../src/workspace-create.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, leaveBaseline, makeWorkspace, queueWork, servedQuarantineQuestion, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

// 削除の途中で残った workspace_state の行の上で登録し直さない —— 出口を名指す(ADR 0401 決定5、issue #3198)

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

/** 削除の扉の registry の commit だけを打ち、行の削除の前に盤面が落ちた状態を作る。返すのはその commit。 */
function commitDeletion(registryDir: string, name: string): string {
  const file = join(registryDir, "workspaces.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  doc.delete(name);
  writeFileSync(file, doc.toString());
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qam", `delete workspace ${name} via WebUI`], { cwd: registryDir, stdio: "pipe" });
  return git(registryDir, "rev-parse", "HEAD");
}

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
  const deletion = commitDeletion(registryDir, "reef");
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

it("削除の commit の後で基準の行が残った名前は、他の名前の最初の撮りで B9 の Quarantine を立て、文が削除の commit と出口を名指す", async () => {
  const reef = await makeWorkspace("reef");
  const other = await makeWorkspace("other");
  const registryDir = await makeRegistry({ "workspaces.yaml": `reef:\n  path: ${reef.path}\nother:\n  path: ${other.path}\n` });
  const deletion = commitDeletion(registryDir, "reef");
  const base = await tempDir("tidepool-ws-base-");
  // 合成 root の resolver と同じ読み —— 呼ぶたびに registry を読み直し、名前を registry から引く
  t = await bootTidepool({ workspace: other, resolveWorkspace: (name) => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), "other", name, base) });
  await leaveBaseline(t.db, reef);

  queueWork(t, "first capture of other", "other");
  await t.clock.advance(HOUR);

  await vi.waitFor(async () => expect(await servedQuarantineQuestion(t, "workspace", "reef")).toBeDefined());
  expect((await servedQuarantineQuestion(t, "workspace", "reef")).purpose).toContain(
    `unknown workspace: reef. The board holds a baseline for "reef", so no workspace captures a first baseline until it resolves again. A deletion of "reef" stopped midway: registry commit ${deletion} removed the entry, but the board kept its state. To clear it, in order: put the entry back in the registry under that name as it was in workspaces.yaml at ${deletion}^, with its repo and head_repo as well as its path (a repo other than the one the board remembers is refused again); accept the open Quarantine question for "reef", if any; delete the workspace through the deletion door; register it again (under a new name to rename it). Workspaces`,
  );
});
