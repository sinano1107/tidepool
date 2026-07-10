import { afterEach, expect, it } from "vitest";
import type { AuthorityProfile } from "../src/registry.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

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
  const client = await mcpClient(t.baseUrl, parent.id);
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
  const client = await mcpClient(t.baseUrl, parent.id);
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
