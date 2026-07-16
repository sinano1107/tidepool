import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  RegistrySelfUnprotectError,
  UnprotectNeedsConfirmationError,
  type UpdateWorkspaceInput,
} from "../src/workspace-create.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/workspaces は設定面向けの一覧ビューを返す(issue #57 フェーズ3)", async () => {
  t = await bootTidepool({
    listWorkspaces: () => [
      { name: "registry", path: "/srv/registry", protected: true, registrySelf: true },
      { name: "lagoon", repo: "https://github.com/example/lagoon.git", registrySelf: false },
    ],
  });

  const res = await api(t.baseUrl, "GET", "/api/workspaces");

  expect(res.status).toBe(200);
  expect(res.json).toEqual([
    { name: "registry", path: "/srv/registry", protected: true, registrySelf: true },
    { name: "lagoon", repo: "https://github.com/example/lagoon.git", registrySelf: false },
  ]);
});

it("GET /api/workspaces は registry 未設定なら 503", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/workspaces")).status).toBe(503);
});

it("PATCH /api/workspaces/:name は URL の名前と body を updateWorkspace へ渡し、200 で pushed を返す", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    updateWorkspace: async (input) => {
      calls.push(input);
      return { pushed: true };
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    notes: "run npm install",
    protected: true,
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ pushed: true });
  expect(calls).toEqual([{ name: "lagoon", notes: "run npm install", protected: true }]);
});

it("confirm なしの protected 解除は 409 + confirm_required — UI はこれを見て確認 Dialog に進む", async () => {
  t = await bootTidepool({
    updateWorkspace: async () => {
      throw new UnprotectNeedsConfirmationError("lagoon");
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { protected: false });

  expect(res.status).toBe(409);
  expect(res.json.confirm_required).toBe(true);
});

it("盤面自身の registry エントリの解除は 403(confirm があっても)", async () => {
  t = await bootTidepool({
    updateWorkspace: async () => {
      throw new RegistrySelfUnprotectError("registry");
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/registry", {
    protected: false,
    confirm: true,
  });

  expect(res.status).toBe(403);
});

it("registry に居ない名前は 404", async () => {
  t = await bootTidepool({
    updateWorkspace: async () => {
      throw new UnknownWorkspaceError("ghost");
    },
  });

  expect((await api(t.baseUrl, "PATCH", "/api/workspaces/ghost", { notes: "x" })).status).toBe(
    404,
  );
});
