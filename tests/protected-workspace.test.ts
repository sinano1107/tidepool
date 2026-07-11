import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
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

it("decompose converts a child targeting a protected workspace into an approval question, even when the workspace is within allowed_workspaces", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["registry"] },
    isProtectedWorkspace: (name) => name === "registry",
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "propose an authority profile diff",
      children: [
        {
          title: "widen deckhand's allowed_workspaces",
          purpose: "diff: add sandbox to authority/deckhand.yaml",
          completion_criteria: "a human approves or rejects the diff",
          workspace: "registry",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // the child never lands as a work task, despite "registry" being within
  // this worker's allowed_workspaces
  expect(board.find((x: any) => x.title === "widen deckhand's allowed_workspaces")).toBeUndefined();

  const question = board.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();
  expect(question.question_options).toEqual(["approve", "reject"]);
});

it("a child targeting a non-protected workspace registers directly even when isProtectedWorkspace is configured", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["sandbox"] },
    isProtectedWorkspace: (name) => name === "registry",
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece stays in the sandbox checkout",
      children: [
        {
          title: "tidy the sandbox fixtures",
          purpose: "keep the sandbox data current",
          completion_criteria: "fixtures reflect the latest schema",
          workspace: "sandbox",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "tidy the sandbox fixtures");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});

const MINUTE = 60 * 1000;

it("completing a low-risk task in a protected workspace under auto_if_ci_green asks for merge approval immediately, instead of queueing for auto-merge", async () => {
  const sandbox = await makeWorkspace(dirs, "sandbox");
  const registry = await makeWorkspace(dirs, "registry");
  const workspaces: Record<string, WorkspaceConfig> = { sandbox, registry };
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: (name) => {
      const ws = workspaces[name ?? "sandbox"];
      if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
      return ws;
    },
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
    isProtectedWorkspace: (name) => name === "registry",
  });

  const task = await registerWork(t, "apply the approved diff", "registry");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.baseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  // asked right away — never queued for the unattended poll, despite carrying
  // no risk flag of its own
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const mergeQuestion = board.find(
    (x: any) => x.type === "question" && x.title.startsWith("merge PR"),
  );
  expect(mergeQuestion).toBeDefined();
  expect(mergeQuestion.question_options).toEqual(["merge", "hold"]);

  await t.clock.advance(MINUTE); // the auto-merge poll ticks; nothing was queued
  expect(t.github.merged).toEqual([]);
});
