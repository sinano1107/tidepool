import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  api,
  attachChild,
  bootTidepool,
  commitWork,
  completeViaMcp,
  HOUR,
  makeWorkspace,
  managementMcpClient,
  questions,
  registerWork,
  type Tidepool,
} from "./harness.js";

type HumanSurface = "webui" | "mcp";

const pools: Tidepool[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function toolPayload(result: any): any {
  return JSON.parse(result.content[0].text);
}

async function cancelFrom(surface: HumanSurface, pool: Tidepool, taskId: string) {
  if (surface === "webui") {
    const result = await api(pool.baseUrl, "POST", `/api/tasks/${taskId}/cancel`, {});
    return result.status === 200
      ? { ok: true as const, task: result.json }
      : { ok: false as const, error: result.json.error };
  }
  const client = await managementMcpClient(pool.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: taskId },
    });
    return result.isError
      ? { ok: false as const, error: result.content[0].text }
      : { ok: true as const, task: toolPayload(result) };
  } finally {
    await client.close();
  }
}

async function editFrom(
  surface: HumanSurface,
  pool: Tidepool,
  taskId: string,
  input: Record<string, unknown>,
) {
  if (surface === "webui") {
    const result = await api(pool.baseUrl, "PATCH", `/api/tasks/${taskId}`, input);
    return result.status === 200
      ? { ok: true as const, task: result.json }
      : { ok: false as const, error: result.json.error };
  }
  const client = await managementMcpClient(pool.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "edit_task",
      arguments: { task_id: taskId, ...input },
    });
    return result.isError
      ? { ok: false as const, error: result.content[0].text }
      : { ok: true as const, task: toolPayload(result) };
  } finally {
    await client.close();
  }
}

async function completeFrom(surface: HumanSurface, pool: Tidepool, taskId: string) {
  if (surface === "webui") {
    const result = await api(pool.baseUrl, "POST", `/api/tasks/${taskId}/complete`, {});
    return result.status === 200
      ? { ok: true as const, task: result.json }
      : { ok: false as const, error: result.json.error };
  }
  const client = await managementMcpClient(pool.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "complete_task",
      arguments: { task_id: taskId },
    });
    return result.isError
      ? { ok: false as const, error: result.content[0].text }
      : { ok: true as const, task: toolPayload(result) };
  } finally {
    await client.close();
  }
}

async function decomposeFrom(
  surface: HumanSurface,
  pool: Tidepool,
  parentId: string,
  reason: string,
  child: {
    title: string;
    purpose: string;
    completion_criteria: string;
    assignee?: string;
    workspace?: string;
  },
) {
  if (surface === "webui") {
    const result = await api(pool.baseUrl, "POST", "/api/tasks", {
      type: "work",
      parent_id: parentId,
      decompose_reason: reason,
      ...child,
    });
    return result.status === 201
      ? { ok: true as const, task: result.json }
      : { ok: false as const, error: result.json.error };
  }
  const client = await managementMcpClient(pool.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "decompose_task",
      arguments: { task_id: parentId, reason, children: [child] },
    });
    if (result.isError) return { ok: false as const, error: result.content[0].text };
    const [childId] = toolPayload(result).child_ids;
    return {
      ok: true as const,
      task: (await api(pool.baseUrl, "GET", `/api/tasks/${childId}`)).json,
    };
  } finally {
    await client.close();
  }
}

async function exerciseCancel(surface: HumanSurface) {
  const queuePool = await bootTidepool();
  pools.push(queuePool);
  const parent = await registerWork(queuePool, `${surface} parent`);
  const child = (
    await api(queuePool.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: `${surface} human child`,
      purpose: "finish the human-only step",
      completion_criteria: "the step is either completed or abandoned",
      assignee: "human",
      parent_id: parent.id,
      decompose_reason: "split the human-only step",
    })
  ).json;
  await queuePool.clock.advance(HOUR);

  const cancelled = await cancelFrom(surface, queuePool, child.id);
  const runningParent = (await api(queuePool.baseUrl, "GET", `/api/tasks/${parent.id}`)).json;
  const rejected = await cancelFrom(surface, queuePool, parent.id);
  const childEvents = (
    await api(queuePool.baseUrl, "GET", `/api/tasks/${child.id}/events`)
  ).json;

  const workspace = await makeWorkspace(dirs, `${surface}-cancel-landing`);
  const landingPool = await bootTidepool({ workspace });
  pools.push(landingPool);
  const root = await registerWork(landingPool, `${surface} landing root`);
  await landingPool.clock.advance(HOUR);
  commitWork(workspace.path, `${surface}.txt`, "finished\n");
  const attached = attachChild(landingPool, root.id, `${surface} attached repair`, "human");
  await completeViaMcp(landingPool, root.id);
  expect(await questions(landingPool)).toEqual([]);

  await cancelFrom(surface, landingPool, attached.id);
  const landing = await questions(landingPool);

  return {
    cancelled: cancelled.ok && cancelled.task.status,
    parent_status: runningParent.status,
    picked_up_parent: queuePool.worker.started.map((task: any) => task.id).includes(parent.id),
    domain_error: rejected.ok ? null : rejected.error,
    origin: childEvents.find((event: any) => event.kind === "task_cancelled_directly")?.origin,
    landing_refired: landing.some(
      (question: any) => question.question_pending_local_merge_task_id === root.id,
    ),
  };
}

it("cancel は WebUI と管理MCPで同じ検証・親queue・祖先着地の再発火を通り、経路を記録する", async () => {
  expect(await exerciseCancel("webui")).toEqual({
    cancelled: "cancelled",
    parent_status: "in_progress",
    picked_up_parent: true,
    domain_error: "an in-progress task cannot be cancelled",
    origin: "webui",
    landing_refired: true,
  });
  expect(await exerciseCancel("mcp")).toEqual({
    cancelled: "cancelled",
    parent_status: "in_progress",
    picked_up_parent: true,
    domain_error: "an in-progress task cannot be cancelled",
    origin: "mcp",
    landing_refired: true,
  });
});

async function exerciseEdit(surface: HumanSurface) {
  const pool = await bootTidepool({
    agentRegistered: (name) => name === "known-agent",
    resolveWorkspace: (name) => {
      if (name === "known-workspace" || name === null) {
        return { name: "known-workspace", path: "/workspaces/known" };
      }
      throw new UnknownWorkspaceError(name);
    },
  });
  pools.push(pool);
  const task = await registerWork(pool, `${surface} editable task`, undefined, undefined, "human");
  const edited = await editFrom(surface, pool, task.id, { title: `${surface} edited task` });
  const unknownAssignee = await editFrom(surface, pool, task.id, { assignee: "unknown-agent" });
  const unknownWorkspace = await editFrom(surface, pool, task.id, {
    workspace: "unknown-workspace",
  });
  await api(pool.baseUrl, "POST", `/api/tasks/${task.id}/complete`, {});
  const settled = await editFrom(surface, pool, task.id, { title: "too late" });
  const events = (await api(pool.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;

  return {
    edited: edited.ok && edited.task.title,
    unknown_assignee: unknownAssignee.ok ? null : unknownAssignee.error,
    unknown_workspace: unknownWorkspace.ok ? null : unknownWorkspace.error,
    domain_error: settled.ok ? null : settled.error,
    origin: events.find((event: any) => event.kind === "task_edited")?.origin,
  };
}

it("edit は WebUI と管理MCPで同じ assignee・workspace・domain 検証を通り、経路を記録する", async () => {
  expect(await exerciseEdit("webui")).toEqual({
    edited: "webui edited task",
    unknown_assignee: "unknown agent: unknown-agent",
    unknown_workspace: "unknown workspace: unknown-workspace",
    domain_error: "a settled task cannot be edited",
    origin: "webui",
  });
  expect(await exerciseEdit("mcp")).toEqual({
    edited: "mcp edited task",
    unknown_assignee: "unknown agent: unknown-agent",
    unknown_workspace: "unknown workspace: unknown-workspace",
    domain_error: "a settled task cannot be edited",
    origin: "mcp",
  });
});

async function exerciseComplete(surface: HumanSurface) {
  const queuePool = await bootTidepool();
  pools.push(queuePool);
  const parent = await registerWork(queuePool, `${surface} complete parent`);
  const child = (
    await api(queuePool.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: `${surface} human completion`,
      purpose: "finish the human-only step",
      completion_criteria: "the step is complete",
      assignee: "human",
      parent_id: parent.id,
      decompose_reason: "split the human-only step",
    })
  ).json;
  await queuePool.clock.advance(HOUR);

  const completed = await completeFrom(surface, queuePool, child.id);
  const runningParent = (await api(queuePool.baseUrl, "GET", `/api/tasks/${parent.id}`)).json;
  const rejected = await completeFrom(surface, queuePool, parent.id);
  const childEvents = (
    await api(queuePool.baseUrl, "GET", `/api/tasks/${child.id}/events`)
  ).json;

  const workspace = await makeWorkspace(dirs, `${surface}-complete-landing`);
  const landingPool = await bootTidepool({ workspace });
  pools.push(landingPool);
  const root = await registerWork(landingPool, `${surface} complete landing root`);
  await landingPool.clock.advance(HOUR);
  commitWork(workspace.path, `${surface}.txt`, "finished\n");
  const attached = attachChild(landingPool, root.id, `${surface} attached review`, "human");
  await completeViaMcp(landingPool, root.id);
  expect(await questions(landingPool)).toEqual([]);

  await completeFrom(surface, landingPool, attached.id);
  const landing = await questions(landingPool);

  return {
    completed: completed.ok && completed.task.status,
    parent_status: runningParent.status,
    picked_up_parent: queuePool.worker.started.map((task: any) => task.id).includes(parent.id),
    domain_error: rejected.ok ? null : rejected.error,
    origin: childEvents.find((event: any) => event.kind === "task_completed")?.origin,
    landing_refired: landing.some(
      (question: any) => question.question_pending_local_merge_task_id === root.id,
    ),
  };
}

it("complete は WebUI と管理MCPで同じ human gate・親queue・祖先着地の再発火を通り、経路を記録する", async () => {
  const domainError =
    "only a human-assignee task can be completed here — agents complete via MCP's complete_task";
  expect(await exerciseComplete("webui")).toEqual({
    completed: "done",
    parent_status: "in_progress",
    picked_up_parent: true,
    domain_error: domainError,
    origin: "webui",
    landing_refired: true,
  });
  expect(await exerciseComplete("mcp")).toEqual({
    completed: "done",
    parent_status: "in_progress",
    picked_up_parent: true,
    domain_error: domainError,
    origin: "mcp",
    landing_refired: true,
  });
});

async function exerciseDecompose(surface: HumanSurface) {
  const pool = await bootTidepool({
    agentRegistered: (name) => name === "known-agent",
    resolveWorkspace: (name) => {
      if (name === "known-workspace" || name === null) {
        return { name: "known-workspace", path: "/workspaces/known" };
      }
      throw new UnknownWorkspaceError(name);
    },
  });
  pools.push(pool);
  const parent = await registerWork(pool, `${surface} decomposable task`, undefined, undefined, "human");
  const child = {
    title: `${surface} child`,
    purpose: "do one independently tracked part",
    completion_criteria: "the part is complete",
  };
  const unknownAssignee = await decomposeFrom(surface, pool, parent.id, "split the work", {
    ...child,
    assignee: "unknown-agent",
  });
  const unknownWorkspace = await decomposeFrom(surface, pool, parent.id, "split the work", {
    ...child,
    workspace: "unknown-workspace",
  });
  const missingReason = await decomposeFrom(surface, pool, parent.id, "", child);
  const registered = await decomposeFrom(surface, pool, parent.id, "split the work", {
    ...child,
    assignee: "known-agent",
    workspace: "known-workspace",
  });
  const events = registered.ok
    ? (await api(pool.baseUrl, "GET", `/api/tasks/${registered.task.id}/events`)).json
    : [];

  return {
    child_registered: registered.ok && registered.task.parent_id === parent.id,
    unknown_assignee: unknownAssignee.ok ? null : unknownAssignee.error,
    unknown_workspace: unknownWorkspace.ok ? null : unknownWorkspace.error,
    domain_error: missingReason.ok ? null : missingReason.error,
    origin: events.find((event: any) => event.kind === "task_registered")?.origin,
  };
}

it("人間 decompose は WebUI と管理MCPで同じ assignee・workspace・分解制約を通り、経路を記録する", async () => {
  expect(await exerciseDecompose("webui")).toEqual({
    child_registered: true,
    unknown_assignee: "unknown agent: unknown-agent",
    unknown_workspace: "unknown workspace: unknown-workspace",
    domain_error: "a decomposition requires a reason",
    origin: "webui",
  });
  expect(await exerciseDecompose("mcp")).toEqual({
    child_registered: true,
    unknown_assignee: "unknown agent: unknown-agent",
    unknown_workspace: "unknown workspace: unknown-workspace",
    domain_error: "a decomposition requires a reason",
    origin: "mcp",
  });
});
