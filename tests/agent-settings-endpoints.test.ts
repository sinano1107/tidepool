import { afterEach, expect, it } from "vitest";
import { UnknownAgentError } from "../src/agent.js";
import {
  InvalidAgentIconError,
  UnknownAuthorityProfileError,
  type UpdateAgentInput,
} from "../src/agent-create.js";
import { RegistryCloneBusyError } from "../src/registry-write.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/agents は編集フォーム用の一覧と authority 候補を1往復で返す(issue #71)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      list: () => ({
        agents: [
          {
            name: "tako",
            version: "1",
            authority: "standard",
            description: "General agent",
            icon: "🐙",
            model: undefined,
            effort: undefined,
            systemPrompt: "You are Tako.",
          },
        ],
        authorityProfiles: ["standard", "restricted"],
      }),
    },
  });

  const res = await api(t.baseUrl, "GET", "/api/agents");

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    agents: [
      {
        name: "tako",
        version: "1",
        authority: "standard",
        description: "General agent",
        icon: "🐙",
        model: undefined,
        effort: undefined,
        systemPrompt: "You are Tako.",
      },
    ],
    authorityProfiles: ["standard", "restricted"],
  });
});

it("GET /api/agents は registry 未設定なら 503", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/agents")).status).toBe(503);
});

it("PATCH /api/agents/:name は URL の名前と body を updateAgent へ渡し、200 で pushed を返す", async () => {
  const calls: UpdateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      update: async (input) => {
        calls.push(input);
        return { pushed: true };
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    description: "Updated description",
    systemPrompt: "You are Tako, updated.",
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ pushed: true });
  expect(calls).toEqual([
    {
      name: "tako",
      authority: "standard",
      description: "Updated description",
      systemPrompt: "You are Tako, updated.",
    },
  ]);
});

it("編集対象の未知 name(UnknownAgentError)は 404", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new UnknownAgentError("ghost");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/ghost", {
    authority: "standard",
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(404);
});

it("未知 authority(UnknownAuthorityProfileError)は 400", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new UnknownAuthorityProfileError("ghost");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "ghost",
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(400);
});

it("不正 icon(InvalidAgentIconError)は 400", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new InvalidAgentIconError("ab");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    description: "d",
    icon: "ab",
    systemPrompt: "p",
  });

  expect(res.status).toBe(400);
});

it("registry クローンが busy(RegistryCloneBusyError)なら 409", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new RegistryCloneBusyError("/registry", "HEAD is on 'task/x', not 'main'");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(409);
});

it("その他の外部失敗は 502", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new Error("git push exited 128");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(502);
});
