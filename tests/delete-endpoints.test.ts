import { afterEach, expect, it } from "vitest";
import { UnknownAgentError } from "../src/agent.js";
import type { AgentDeletionReferences, DeleteAgentInput } from "../src/agent-create.js";
import {
  DeletionBlockedError,
  DeletionConfirmationRequiredError,
} from "../src/registry-write.js";
import type {
  DeleteWorkspaceInput,
  WorkspaceDeletionReferences,
} from "../src/workspace-create.js";
import { RegistrySelfDeleteError } from "../src/workspace-create.js";
import { AUTH_HEADERS, api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("DELETE /api/agents/:name は名前と confirm を verb へ渡し、200 を返す(issue #205)", async () => {
  const calls: DeleteAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      delete: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/tako", { confirm: true });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "tako", confirm: true }]);
});

it("DELETE /api/agents/:name は未決着タスクの件数と既定 agent 名を参照検査の事実として渡す", async () => {
  const refs: AgentDeletionReferences[] = [];
  t = await bootTidepool({
    workerId: "tako",
    agentAdmin: {
      delete: async (_input, references) => {
        refs.push(references);
      },
    },
  });
  await registerWork(t, "unsettled one", undefined, undefined, "fugu");
  await registerWork(t, "unsettled two", undefined, undefined, "fugu");

  await api(t.baseUrl, "DELETE", "/api/agents/fugu", { confirm: true });

  expect(refs).toEqual([{ unsettledTaskCount: 2, defaultAgentName: "tako" }]);
});

it("DELETE /api/agents/:name は確認なしの拒否を 409 confirm_required に写す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new DeletionConfirmationRequiredError("agent", "tako");
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/tako", {});

  expect(res.status).toBe(409);
  expect(res.json.confirm_required).toBe(true);
  // 削除は「権限を広げる値」ではないので、危険な値の理由コード列には載らない
  expect(res.json.dangerous_values).toBeUndefined();
});

it("本文なしの DELETE も確認の門まで届く(400 のスキーマ拒否で止まらない)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new DeletionConfirmationRequiredError("agent", "tako");
      },
    },
  });

  const res = await fetch(`${t.baseUrl}/api/agents/tako`, {
    method: "DELETE",
    headers: { ...AUTH_HEADERS, "content-type": "application/json" },
  });

  expect(res.status).toBe(409);
});

it("DELETE /api/agents/:name は確認で買えない拒否を 409 blocked と理由で返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new DeletionBlockedError("agent", "tako", [{ code: "unsettled_tasks", count: 3 }]);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/tako", { confirm: true });

  expect(res.status).toBe(409);
  expect(res.json.blocked).toBe(true);
  expect(res.json.reasons).toEqual([{ code: "unsettled_tasks", count: 3 }]);
  expect(res.json.confirm_required).toBeUndefined();
});

it("DELETE /api/agents/:name は未知の agent を 404、未設定を 503 で返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new UnknownAgentError("ghost");
      },
    },
  });
  expect((await api(t.baseUrl, "DELETE", "/api/agents/ghost", { confirm: true })).status).toBe(404);

  await t.stop();
  t = await bootTidepool();
  expect((await api(t.baseUrl, "DELETE", "/api/agents/tako", { confirm: true })).status).toBe(503);
});

it("DELETE /api/workspaces/:name は未決着タスクの件数と既定 workspace 名を渡し、残る checkout の場所を返す", async () => {
  const calls: Array<[DeleteWorkspaceInput, WorkspaceDeletionReferences]> = [];
  t = await bootTidepool({
    workspaceAdmin: {
      delete: async (input, references) => {
        calls.push([input, references]);
        return "/home/pi/work/lagoon";
      },
    },
  });
  await registerWork(t, "unsettled", "lagoon");

  const res = await api(t.baseUrl, "DELETE", "/api/workspaces/lagoon", { confirm: true });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ checkout: "/home/pi/work/lagoon" });
  expect(calls[0]?.[0]).toEqual({ name: "lagoon", confirm: true });
  expect(calls[0]?.[1].unsettledTaskCount).toBe(1);
});

it("DELETE /api/workspaces/:name は盤面自身の registry clone を 403 で拒む", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      delete: async () => {
        throw new RegistrySelfDeleteError("registry");
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/workspaces/registry", { confirm: true });

  expect(res.status).toBe(403);
});

it("DELETE /api/profiles/:name は名前と confirm を verb へ渡し、200 を返す", async () => {
  const calls: unknown[] = [];
  t = await bootTidepool({
    profileAdmin: {
      delete: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/profiles/standard", { confirm: true });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "standard", confirm: true }]);
});
