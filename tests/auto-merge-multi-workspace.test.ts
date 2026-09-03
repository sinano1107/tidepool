import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createLanding } from "../src/landing.js";
import {
  cancelTask,
  getTask,
  HUMAN_WORKER_ID,
  listPendingAutoMerges,
} from "../src/tasks.js";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  addTaskChange,
  api,
  attachChild,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MINUTE = 60 * 1000;

async function runAutoMergeTick(workspace: WorkspaceConfig) {
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    await createLanding({
      db,
      clock: t.clock,
      resolveWorkspace: () => workspace,
      github: t.github,
    }).tick("auto_merge", t.clock.now());
    return listPendingAutoMerges(db);
  } finally {
    db.close();
  }
}

it("prod workspace の低リスクタスクの auto_if_ci_green poll は、CI チェックと merge を prod の checkout に対して行う", async () => {
  const sandbox = await makeWorkspace(dirs, "sandbox");
  const { workspace: prod } = await makeRemoteBackedWorkspace(dirs, "prod");
  const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: (name) => {
      const ws = registry[name ?? "sandbox"];
      if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
      return ws;
    },
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });

  const task = await registerWork(t, "ship in prod", "prod");
  await t.clock.advance(HOUR);
  addTaskChange(prod.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  // no question — queued for the poll
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);

  t.github.scriptCiStatus("success");
  await t.clock.advance(MINUTE);

  expect(t.github.merged).toEqual([{ path: prod.path, number: 1 }]);
});

it("PR open 後に付いた未決着の付帯子があれば CI を読まず行を残し、決着後の tick で merge する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "attached-gate");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "wait for the attached repair");
  await t.clock.advance(HOUR);
  addTaskChange(workspace.path, task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const attached = attachChild(t, task.id, "repair before unattended merge", "human");

  expect(await runAutoMergeTick(workspace)).toEqual([{ task_id: task.id, pr_number: 1 }]);
  expect(t.github.ciChecks).toEqual([]);
  expect(t.github.merged).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${attached.id}/complete`, {});
  expect(await runAutoMergeTick(workspace)).toEqual([]);
  expect(t.github.ciChecks).toEqual([{ path: workspace.path, number: 1 }]);
  expect(t.github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

it("CI を読んでいる間に付帯子が付いたら merge 直前の門で止まり、次の tick へ残す", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "attached-during-ci");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "recheck the gate after reading CI");
  await t.clock.advance(HOUR);
  addTaskChange(workspace.path, task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  const getCiStatus = t.github.getCiStatus.bind(t.github);
  let attachedId: string | undefined;
  t.github.getCiStatus = async (ref) => {
    const status = await getCiStatus(ref);
    attachedId = attachChild(t, task.id, "repair raised while CI was being read", "human").id;
    return status;
  };

  expect(await runAutoMergeTick(workspace)).toEqual([{ task_id: task.id, pr_number: 1 }]);
  expect(t.github.ciChecks).toEqual([{ path: workspace.path, number: 1 }]);
  expect(t.github.merged).toEqual([]);

  t.github.getCiStatus = getCiStatus;
  await api(t.baseUrl, "POST", `/api/tasks/${attachedId!}/complete`, {});
  expect(await runAutoMergeTick(workspace)).toEqual([]);
  expect(t.github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

it("PR open 後の未束ね異議は CI を読まず行を残し、commit された修理の決着後に merge する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "objection-gate");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "wait for the objected repair");
  await t.clock.advance(HOUR);
  addTaskChange(workspace.path, task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const entry = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json.find(
    (event: any) => event.kind === "task_completed",
  );
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "the completed decision needs a repair before merge",
  });

  expect(await runAutoMergeTick(workspace)).toEqual([{ task_id: task.id, pr_number: 1 }]);
  expect(t.github.ciChecks).toEqual([]);
  expect(t.github.merged).toEqual([]);

  await api(t.baseUrl, "POST", "/api/triage/close");
  const attached = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.parent_id === task.id,
  );
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    for (const child of attached) {
      cancelTask(db, getTask(db, child.id)!, "test-settlement", HUMAN_WORKER_ID, t.clock.now());
    }
  } finally {
    db.close();
  }
  expect(await runAutoMergeTick(workspace)).toEqual([]);
  expect(t.github.ciChecks).toEqual([{ path: workspace.path, number: 1 }]);
  expect(t.github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});
