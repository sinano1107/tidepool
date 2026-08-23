import { afterEach, expect, it } from "vitest";
import type { CreateAgentInput } from "../src/agent-create.js";
import { InvalidAgentIconError, UnknownAuthorityProfileError } from "../src/agent-create.js";
import { InvalidAgentNameError, InvalidAgentProviderError } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/agents は検証済み入力を createAgent オーケストレーションへ渡し、201 を返す(issue #71)", async () => {
  const calls: CreateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      create: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    icon: "🐙",
    advisor: "future-advisor-id",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(201);
  expect(res.json).toEqual({});
  expect(calls).toEqual([
    {
      name: "tako",
      authority: "standard",
      provider: "anthropic",
      skills: ["*"],
      description: "General agent",
      icon: "🐙",
      advisor: "future-advisor-id",
      systemPrompt: "You are Tako.",
    },
  ]);
});

it("createAgent が未設定(registry なしの盤面)なら 503 を返す", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(503);
});

it("スキーマ違反(systemPrompt なし)は 400 で、オーケストレーションを呼ばない", async () => {
  const calls: CreateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      create: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
  });

  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

it("systemPrompt が空文字は 201(ADR 0017: 空 specialty は正規形、issue #75)", async () => {
  const calls: CreateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      create: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "",
  });

  expect(res.status).toBe(201);
  expect(calls).toEqual([
    {
      name: "tako",
      authority: "standard",
      provider: "anthropic",
      skills: ["*"],
      description: "General agent",
      systemPrompt: "",
    },
  ]);
});

it("名前検証違反(InvalidAgentNameError)は 400 でメッセージを返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new InvalidAgentNameError("tako", "an agent with this name already exists");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("tako");
});

it("未知 authority(UnknownAuthorityProfileError)は 400 でメッセージを返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new UnknownAuthorityProfileError("ghost");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "ghost",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("ghost");
});

it("不正 provider(InvalidAgentProviderError)は 400 でメッセージを返す(ADR 0097)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new InvalidAgentProviderError("tako", 'unknown provider "moonshto"');
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "moonshto",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("moonshto");
});

it("不正 icon(InvalidAgentIconError)は 400 でメッセージを返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new InvalidAgentIconError("ab");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    icon: "ab",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("icon");
});

it("registry の push 失敗(RegistryPushFailedError)は致命 — 502 でリトライは冪等(ADR 0052 決定1)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new RegistryPushFailedError("non-fast-forward");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(502);
});

it("その他の外部失敗は 502", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new Error("git push exited 128");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(502);
});
