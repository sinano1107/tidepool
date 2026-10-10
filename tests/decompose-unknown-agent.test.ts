import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("registry に存在しない agent 名を指定した decompose の子は、承認 question にもならず tool error で差し戻される(ADR 0012 / issue #36: workspace 版と対称)", async () => {
  t = await bootTidepool({ agentRegistered: (name) => name === "deckhand" });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up

  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece is delegated to a typo'd agent",
      children: [
        {
          title: "handed to a made-up agent",
          purpose: "apply the change",
          completion_criteria: "change applied",
          assignee: "not-a-real-agent",
        },
      ],
    },
  });
  await client.close();

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("unknown agent");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // neither a work task nor an approval question was registered — the parent
  // stays exactly as it was, ready to retry with a real agent name
  expect(board.find((x: any) => x.title === "handed to a made-up agent")).toBeUndefined();
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
  expect(board.find((x: any) => x.id === parent.id).status).toBe("in_progress");
});

it("registry に存在する agent 名を指定した decompose の子は、authority が許す限り通常どおり登録される", async () => {
  t = await bootTidepool({ agentRegistered: (name) => ["deckhand", "navigator"].includes(name) });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "delegated to a real agent",
      children: [
        {
          title: "handed to navigator",
          purpose: "apply the change",
          completion_criteria: "change applied",
          assignee: "navigator",
        },
      ],
    },
  });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "handed to navigator");
  expect(child).toBeDefined();
  expect(child.assignee).toBe("navigator");
});

it("組み込みに解決される agent を assignee にした decompose の子は、assignable_to の外でも承認 question にならず tool error で差し戻される(ADR 0228 決定1)", async () => {
  t = await bootTidepool({
    agentRegistered: () => true,
    resolvesToBuiltIn: (name) => name === "fugu",
    // assignable_to の外なので、門が無ければ承認 question に変換される
    authority: { name: "narrow", guidance: "g", assignable_to: [], allowed_workspaces: ["*"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "handed to the built-in reviewer",
      children: [{ title: "handed to fugu", purpose: "apply the change", completion_criteria: "change applied", assignee: "fugu" }],
    },
  });
  await client.close();

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("agent fugu is the built-in agent, which runs reviews only");
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});
