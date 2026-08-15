import { afterEach, expect, it } from "vitest";
import { InvalidAllowedDomainError, InvalidReviewAllowedCommandError } from "../src/registry.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  RegistrySelfUnprotectError,
  type UpdateWorkspaceInput,
  WorkspaceConfirmationRequiredError,
} from "../src/workspace-create.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

// ADR 0082 決定1: 一覧は基点ディレクトリを属性として一緒に返す —— 規約導出の
// エントリの着地先を client が合成できる唯一の材料である。
it("GET /api/workspaces は設定面向けの一覧ビューを基点ディレクトリごと返す(issue #57 フェーズ3 / ADR 0082)", async () => {
  const list = {
    workspaces: [
      { name: "registry", path: "/srv/registry", protected: true, registrySelf: true },
      { name: "lagoon", repo: "https://github.com/example/lagoon.git", registrySelf: false },
    ],
    workspacesBaseDir: { path: "/mnt/workspaces", source: "configured" as const },
  };
  t = await bootTidepool({ workspaceAdmin: { list: () => list } });

  const res = await api(t.baseUrl, "GET", "/api/workspaces");

  expect(res.status).toBe(200);
  expect(res.json).toEqual(list);
});

it("GET /api/workspaces は registry 未設定なら 503", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/workspaces")).status).toBe(503);
});

it("PATCH /api/workspaces/:name は URL の名前と body を updateWorkspace へ渡し、200 を返す", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    notes: "run npm install",
    protected: true,
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({});
  expect(calls).toEqual([{ name: "lagoon", notes: "run npm install", protected: true }]);
});

it("confirm なしの危険な値は 409 + confirm_required + 理由コード列挙 — UI はこれを見て確認 Dialog に進む", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new WorkspaceConfirmationRequiredError("lagoon", ["unprotect", "review_allowed_commands_set"]);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", { protected: false });

  expect(res.status).toBe(409);
  expect(res.json).toEqual({
    error: expect.any(String),
    confirm_required: true,
    dangerous_values: ["unprotect", "review_allowed_commands_set"],
  });
});

it("PATCH は review_allowed_commands を confirm ごと updateWorkspace へ渡す(ADR 0061 決定1)", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    review_allowed_commands: ["npm test"],
    confirm: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    { name: "lagoon", review_allowed_commands: ["npm test"], confirm: true },
  ]);
});

it("PATCH は allowed_domains を confirm ごと updateWorkspace へ渡す(ADR 0072)", async () => {
  const calls: UpdateWorkspaceInput[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    allowed_domains: ["registry.npmjs.org"],
    confirm: true,
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    { name: "lagoon", allowed_domains: ["registry.npmjs.org"], confirm: true },
  ]);
});

it("文法違反の review_allowed_commands は 400 — confirm では買えない失敗", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new InvalidReviewAllowedCommandError("npm test,rm -rf /", "a comma would inject");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    review_allowed_commands: ["npm test,rm -rf /"],
    confirm: true,
  });

  expect(res.status).toBe(400);
});

it("文法違反の allowed_domains は 400 — confirm では買えない失敗", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new InvalidAllowedDomainError("100.100.100.100", "IP literals are not allowed");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/workspaces/lagoon", {
    allowed_domains: ["100.100.100.100"],
    confirm: true,
  });

  expect(res.status).toBe(400);
});

it("盤面自身の registry エントリの解除は 403(confirm があっても)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      update: async () => {
        throw new RegistrySelfUnprotectError("registry");
      },
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
    workspaceAdmin: {
      update: async () => {
        throw new UnknownWorkspaceError("ghost");
      },
    },
  });

  expect((await api(t.baseUrl, "PATCH", "/api/workspaces/ghost", { notes: "x" })).status).toBe(
    404,
  );
});
