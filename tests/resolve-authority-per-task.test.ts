import { afterEach, describe, expect, it } from "vitest";
import type { AuthorityProfile } from "../src/registry.js";
import { UNRESOLVABLE_AGENT } from "./fakes.js";
import { api, bootTidepool, HOUR, mcpClient, questions, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function registerAssigned(t: Tidepool, title: string, assignee: string): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    assignee,
  });
  return res.json;
}

const DECKHAND_AUTHORITY: AuthorityProfile = {
  name: "deckhand-authority",
  guidance: "",
  assignable_to: ["deckhand"],
};

const NAVIGATOR_AUTHORITY: AuthorityProfile = {
  name: "navigator-authority",
  guidance: "",
  assignable_to: ["navigator"],
};

function resolveAuthority(assignee: string | null): AuthorityProfile | undefined {
  if (assignee === "deckhand") return DECKHAND_AUTHORITY;
  if (assignee === "navigator") return NAVIGATOR_AUTHORITY;
  return undefined;
}

it("decompose は実行中タスク自身の assignee の authority を都度解決して検査する(ADR 0012 / issue #36): deckhand 宛てタスクは deckhand の assignable_to に従う", async () => {
  t = await bootTidepool({ resolveAuthority });
  const parent = await registerAssigned(t, "deckhand's parent", "deckhand");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "outside deckhand's own assignable_to",
      children: [
        {
          title: "handed to navigator",
          purpose: "p",
          completion_criteria: "c",
          assignee: "navigator",
        },
      ],
    },
  });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // navigator is outside deckhand's assignable_to — converted to a question
  expect(board.find((x: any) => x.title === "handed to navigator")).toBeUndefined();
  const question = board.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();
});

it("navigator 宛てタスクは navigator 自身の authority(deckhand とは別プロファイル)に従う — 固定の単一 authority では区別できない挙動", async () => {
  t = await bootTidepool({ resolveAuthority });
  const parent = await registerAssigned(t, "navigator's parent", "navigator");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "within navigator's own assignable_to",
      children: [
        {
          title: "kept with navigator",
          purpose: "p",
          completion_criteria: "c",
          assignee: "navigator",
        },
      ],
    },
  });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // navigator is within navigator's OWN assignable_to — registers directly,
  // with no approval question (proves navigator's profile applied, not
  // deckhand's, which would have rejected this same assignee)
  const child = board.find((x: any) => x.title === "kept with navigator");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});

// ADR 0224: spawn 後に assignee が registry から消えた/定義が壊れたとき、authority を読む verb は
// 無制限に落ちず拒まれ、agent 名の quarantine が立つ。slot は保たれ escalate は通る。

const spec = (title: string) => ({ title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}`, assignee: "deckhand" });

async function call(t: Tidepool, taskId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** `drift()` までは resolveAuthority と同じに解決し、その後は assignee の解決が `fail` で投げる。 */
function driftingResolver(fail: (name: string) => Error) {
  let drifted = false;
  return {
    resolveAuthority: (assignee: string | null) => {
      if (drifted) throw fail(assignee ?? "tako");
      return resolveAuthority(assignee);
    },
    drift: () => {
      drifted = true;
    },
  };
}

async function expectRefusedAndQuarantined(t: Tidepool, taskId: string, verb: string, args: Record<string, unknown>) {
  const refused = await call(t, taskId, verb, args);
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("do not need to escalate");

  expect((await questions(t)).map((q) => [q.question_quarantine_kind, q.question_quarantine_value])).toEqual([
    ["agent", "deckhand"],
  ]);

  const escalated = await call(t, taskId, "escalate", {
    context: "the plan needs a human call",
    questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
  });
  expect(escalated.isError ?? false).toBe(false);
}

describe.each(UNRESOLVABLE_AGENT)("assignee の authority が %s で解決できないとき", (_, fail) => {
  it("list_agents は拒まれ、agent 名の quarantine が立ち、続く escalate は通る", async () => {
    const resolver = driftingResolver(fail);
    t = await bootTidepool({ resolveAuthority: resolver.resolveAuthority });
    const parent = await registerAssigned(t, "deckhand's task", "deckhand");
    await t.clock.advance(HOUR);
    resolver.drift();

    await expectRefusedAndQuarantined(t, parent.id, "list_agents", {});
  });

  it("decompose は拒まれて子を作らず、agent 名の quarantine が立ち、続く escalate は通る", async () => {
    const resolver = driftingResolver(fail);
    t = await bootTidepool({ resolveAuthority: resolver.resolveAuthority });
    const parent = await registerAssigned(t, "deckhand's task", "deckhand");
    await t.clock.advance(HOUR);
    resolver.drift();

    await expectRefusedAndQuarantined(t, parent.id, "decompose", { reason: "split", children: [spec("X")] });
    const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
    expect(board.find((x: any) => x.title === "X")).toBeUndefined();
  });

  it("redecompose は拒まれて旧い子を破棄せず新しい子も作らず、agent 名の quarantine が立ち、続く escalate は通る", async () => {
    const resolver = driftingResolver(fail);
    t = await bootTidepool({ resolveAuthority: resolver.resolveAuthority });
    const parent = await registerAssigned(t, "deckhand's task", "deckhand");
    await t.clock.advance(HOUR);
    const decomposed = await call(t, parent.id, "decompose", { reason: "split", children: [spec("A")] });
    const [a] = JSON.parse(decomposed.content[0].text).child_ids;
    await t.clock.advance(HOUR);
    expect((await call(t, a, "declare_premise_breach", { reason: "module M is broken" })).isError ?? false).toBe(false);
    expect(t.worker.started.map((x) => x.title)).toEqual(["deckhand's task", "A", "deckhand's task"]);
    resolver.drift();

    await expectRefusedAndQuarantined(t, parent.id, "redecompose", { reason: "replan", children: [spec("X")] });
    const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
    expect(board.find((x: any) => x.title === "X")).toBeUndefined();
    expect(board.find((x: any) => x.id === a).status).not.toBe("cancelled");
  });
});
