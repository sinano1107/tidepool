import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

function makeResolver(known: string[]) {
  return (name: string | null) => {
    const n = name ?? "sandbox";
    if (!known.includes(n)) throw new UnknownWorkspaceError(n);
    return { name: n, path: `/fake/${n}` } as WorkspaceConfig;
  };
}

it("registry に存在しない workspace 名での登録は 400 で拒否される", async () => {
  t = await bootTidepool({ resolveWorkspace: makeResolver(["sandbox"]) });

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "target a made-up workspace",
    purpose: "purpose",
    completion_criteria: "criteria",
    workspace: "not-a-real-workspace",
  });

  expect(res.status).toBe(400);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board).toEqual([]);
});

it("registry に存在する workspace 名での登録は通常どおり成功する", async () => {
  t = await bootTidepool({ resolveWorkspace: makeResolver(["sandbox", "prod"]) });

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "target a real workspace",
    purpose: "purpose",
    completion_criteria: "criteria",
    workspace: "prod",
  });

  expect(res.status).toBe(201);
  expect(res.json.workspace).toBe("prod");
});
