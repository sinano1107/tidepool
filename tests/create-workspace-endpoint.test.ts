import { afterEach, expect, it } from "vitest";
import { InvalidWorkspaceNameError } from "../src/registry.js";
import { RegistryCloneBusyError } from "../src/registry-write.js";
import { BoardStateOverlapError, type CreateWorkspaceInput } from "../src/workspace-create.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/workspaces は検証済み入力を createWorkspace オーケストレーションへ渡し、201 で pushed を返す(issue #57)", async () => {
  const calls: CreateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      create: async (input) => {
        calls.push(input);
        return { pushed: true };
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces", {
    mode: "clone",
    name: "lagoon",
    repo: "https://github.com/example/lagoon.git",
    protected: true,
  });

  expect(res.status).toBe(201);
  expect(res.json).toEqual({ pushed: true });
  expect(calls).toEqual([
    {
      mode: "clone",
      name: "lagoon",
      repo: "https://github.com/example/lagoon.git",
      protected: true,
    },
  ]);
});

it("createWorkspace が未設定(registry なしの盤面)なら 503 を返す", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/workspaces", {
    mode: "register",
    name: "sandbox",
    path: "/tmp/sandbox",
  });

  expect(res.status).toBe(503);
});

it("スキーマ違反(clone モードに repo なし)は 400 で、オーケストレーションを呼ばない", async () => {
  const calls: CreateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      create: async (input) => {
        calls.push(input);
        return { pushed: true };
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces", { mode: "clone", name: "lagoon" });

  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

it("名前検証違反(InvalidWorkspaceNameError)は 400 でメッセージを返す", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      create: async () => {
        throw new InvalidWorkspaceNameError("lagoon", "a workspace with this name already exists");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces", {
    mode: "create",
    name: "lagoon",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("lagoon");
});

it("盤面の状態パスと重なる登録(BoardStateOverlapError)は 400 で理由を返す(ADR 0040 / issue #149)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      create: async () => {
        throw new BoardStateOverlapError(
          "workspace path /srv/tidepool overlaps the board's board database (TIDEPOOL_DB)",
        );
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces", {
    mode: "register",
    name: "self",
    path: "/srv/tidepool",
  });

  // 400: 出し直せば通り得る呼び出し側の入力の問題(パスを変える)であって、
  // 盤面が壊れている(502)のでも未設定(503)のでもない
  expect(res.status).toBe(400);
  expect(res.json.error).toContain("board database (TIDEPOOL_DB)");
});

it("registry クローンが busy(RegistryCloneBusyError)なら 409 — リトライは冪等なので後で叩き直せばよい", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      create: async () => {
        throw new RegistryCloneBusyError("/registry", "HEAD is on 'task/x', not 'main'");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces", {
    mode: "create",
    name: "lagoon",
  });

  expect(res.status).toBe(409);
});

it("その他の外部失敗(clone 失敗など)は 502", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      create: async () => {
        throw new Error("git clone exited 128");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/workspaces", {
    mode: "create",
    name: "lagoon",
  });

  expect(res.status).toBe(502);
});
