import { afterEach, expect, it } from "vitest";
import type { CreateAgentInput } from "../src/agent-create.js";
import { InvalidAgentIconError, UnknownAuthorityProfileError } from "../src/agent-create.js";
import { InvalidAgentNameError } from "../src/registry.js";
import { RegistryCloneBusyError } from "../src/registry-write.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/agents は検証済み入力を createAgent オーケストレーションへ渡し、201 で pushed を返す(issue #71)", async () => {
  const calls: CreateAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      create: async (input) => {
        calls.push(input);
        return { pushed: true };
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    description: "General agent",
    icon: "🐙",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(201);
  expect(res.json).toEqual({ pushed: true });
  expect(calls).toEqual([
    {
      name: "tako",
      authority: "standard",
      description: "General agent",
      icon: "🐙",
      systemPrompt: "You are Tako.",
    },
  ]);
});

it("createAgent が未設定(registry なしの盤面)なら 503 を返す", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
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
        return { pushed: true };
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    description: "General agent",
  });

  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
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
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("ghost");
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
    description: "General agent",
    icon: "ab",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(400);
  expect(res.json.error).toContain("icon");
});

it("registry クローンが busy(RegistryCloneBusyError)なら 409 — リトライは冪等なので後で叩き直せばよい", async () => {
  t = await bootTidepool({
    agentAdmin: {
      create: async () => {
        throw new RegistryCloneBusyError("/registry", "HEAD is on 'task/x', not 'main'");
      },
    },
  });

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "tako",
    authority: "standard",
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(409);
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
    description: "General agent",
    systemPrompt: "You are Tako.",
  });

  expect(res.status).toBe(502);
});
