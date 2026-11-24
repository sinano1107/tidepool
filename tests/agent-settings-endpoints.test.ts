import { afterEach, expect, it } from "vitest";
import {
  InvalidAgentIconError,
  type UpdateAgentInput,
} from "../src/agent-create.js";
import { InvalidAgentDefinitionError, UnknownAgentError, UnknownAuthorityProfileError } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { api, bootTidepool, managementMcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const tako = {
  name: "tako",
  version: "1",
  authority: "standard",
  provider: "anthropic",
  skills: ["*"],
  description: "General agent",
  icon: "🐙",
  advisor: false,
  unknownFields: [],
  systemPrompt: "You are Tako.",
};

it("GET /api/agents は編集フォーム用の一覧と authority 候補を1往復で返す(issue #71)", async () => {
  t = await bootTidepool({ agentAdmin: { list: () => [tako], authorityProfiles: () => ["standard", "restricted"] } });

  const res = await api(t.baseUrl, "GET", "/api/agents");

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    agents: [tako],
    orphanTiers: [],
    authorityProfiles: ["standard", "restricted"],
    // provider 選択肢(値+表示ラベル)もサーバ供給 — WebUI が PROVIDER_VALUES を
    // 直書きして静かに drift するのを防ぐ(authorityOptions と同じ配線)
    providers: [
      { value: "anthropic", label: "anthropic — Claude models, Anthropic billing" },
      { value: "moonshot", label: "moonshot — Kimi models, Moonshot Platform billing" },
      { value: "openai", label: "openai — Codex models, OpenAI billing" },
    ],
  });
});

it("agent の一覧は HTTP も MCP の list_agents も盤面の既定ティアを添え、registry から消えた agent の行を孤児として返す(ADR 0410 決定5)", async () => {
  const registry = [tako, { ...tako, name: "kimi" }];
  t = await bootTidepool({ agentAdmin: { list: () => registry } });
  for (const [agent, tier] of [["tako", "standard"], ["kimi", "frontier"]]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "agent_tier", agent, tier })).status).toBe(200);
  }
  registry.pop();

  expect((await api(t.baseUrl, "GET", "/api/agents")).json).toMatchObject({ agents: [{ ...tako, tier: "standard" }], orphanTiers: [{ agent: "kimi", tier: "frontier" }] });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const listed = (await client.callTool({ name: "list_agents", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(listed.content[0]!.text)).toMatchObject({
      agents: [{ ...tako, tier: "standard" }],
      orphan_tiers: [{ agent: "kimi", tier: "frontier" }],
    });
  } finally {
    await client.close();
  }
});

it("agent の作成・更新は HTTP でも MCP でも tier を受けず、400 / toolError で断る(ADR 0410 決定3)", async () => {
  const written: unknown[] = [];
  t = await bootTidepool({ agentAdmin: { create: async (input) => void written.push(input), update: async (input) => void written.push(input) } });
  const body = { authority: "standard", provider: "anthropic", skills: ["*"], description: "d", systemPrompt: "p", tier: "frontier" };
  expect((await api(t.baseUrl, "POST", "/api/agents", { ...body, name: "tako" })).status).toBe(400);
  expect((await api(t.baseUrl, "PATCH", "/api/agents/tako", body)).status).toBe(400);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { systemPrompt: system_prompt, ...fields } = body;
    for (const name of ["create_agent", "update_agent"]) {
      expect(((await client.callTool({ name, arguments: { ...fields, system_prompt, name: "tako" } })) as { isError?: boolean }).isError).toBe(true);
    }
  } finally {
    await client.close();
  }
  expect(written).toEqual([]);
});

it("GET /api/agents は registry 未設定なら 503", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/agents")).status).toBe(503);
});

it("PATCH /api/agents/:name は URL の名前と body を updateAgent へ渡し、200 を返す", async () => {
  const calls: UpdateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "Updated description",
    advisor: true,
    systemPrompt: "You are Tako, updated.",
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({});
  expect(calls).toEqual([
    {
      name: "tako",
      authority: "standard",
      provider: "anthropic",
      skills: ["*"],
      description: "Updated description",
      advisor: true,
      systemPrompt: "You are Tako, updated.",
    },
  ]);
});

it("systemPrompt が空文字は 200(ADR 0017: 空 specialty は正規形、issue #75)", async () => {
  const calls: UpdateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "Updated description",
    systemPrompt: "",
  });

  expect(res.status).toBe(200);
  expect(calls).toEqual([
    {
      name: "tako",
      authority: "standard",
      provider: "anthropic",
      skills: ["*"],
      description: "Updated description",
      systemPrompt: "",
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
    provider: "anthropic",
    skills: ["*"],
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
    skills: ["*"],
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
    provider: "anthropic",
    skills: ["*"],
    description: "d",
    icon: "ab",
    systemPrompt: "p",
  });

  expect(res.status).toBe(400);
});

it("body に provider が無い PATCH は 400(必須 — ADR 0097 決定1)", async () => {
  const calls: UpdateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      update: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    skills: ["*"],
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

it("不正 provider(InvalidAgentDefinitionError)は 400(ADR 0097 — 列挙外・advisor 組み合わせ)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new InvalidAgentDefinitionError("tako", 'unknown provider "moonshto"');
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    provider: "moonshto",
    skills: ["*"],
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(400);
});

it("registry の push 失敗(RegistryPushFailedError)は致命 — 502(ADR 0052 決定1)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      update: async () => {
        throw new RegistryPushFailedError("non-fast-forward");
      },
    },
  });

  const res = await api(t.baseUrl, "PATCH", "/api/agents/tako", {
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(502);
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
    provider: "anthropic",
    skills: ["*"],
    description: "d",
    systemPrompt: "p",
  });

  expect(res.status).toBe(502);
});
