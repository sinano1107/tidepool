import { afterEach, expect, it, vi } from "vitest";
import { declarePremiseBreach, registerTask } from "../src/tasks.js";
import { api, bootTidepool, decomposeTaskViaWorker, defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, HOUR, HUMAN_WEBUI, makeWorkspace, mcpClient, type Tidepool } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it.each(["decompose", "redecompose"])("%s validates the placement mark and refuses unknown input keys", async (name) => {
  const sandbox = await makeWorkspace("sandbox");
  const registry = await makeWorkspace("registry");
  t = await bootTidepool({ workspace: sandbox, resolveWorkspace: defaultingTo(sandbox, registry) });
  const child = { title: "change registry", purpose: "apply the change", completion_criteria: "change applied" };
  const now = t.clock.now();
  const parent = registerTask(t.db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  if (name === "redecompose") {
    const [prior] = decomposeTaskViaWorker(t.db, parent, { reason: "first plan", children: [{ ...child, title: "original child" }] }, "deckhand", now);
    declarePremiseBreach(t.db, prior!, "the first plan no longer works", "deckhand", now, "worker");
  }
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const reason = "the change targets the registry repo";
    for (const [args, message] of [
      [{ reason, children: [{ ...child, workspace: "registry" }] }, "use place_in_workspace to propose a root in another workspace"],
      [{ reason, children: [{ ...child, extra: true }] }, "extra"],
      [{ reason, children: [child], extra: true }, "extra"],
      [{ reason, children: [{ ...child, place_in_workspace: "not-a-real-workspace" }] }, "unknown workspace: not-a-real-workspace"],
    ] as const) {
      const result: any = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    }

    const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
    expect(board.filter((x: any) => x.parent_id === parent.id && x.type === "question")).toEqual([]);
    expect(board.find((x: any) => x.id === parent.id).status).toBe("in_progress");

    const result: any = await client.callTool({ name, arguments: { reason, children: [{ ...child, place_in_workspace: "registry" }] } });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ child_ids: [], parent_status: "blocked" });
  } finally {
    await client.close();
  }
});
