import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError } from "../src/workspace.js";
import { api, bootTidepool, HOUR, makeWorkspace, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("registry に存在しない workspace 名を指定した decompose の子は、承認 question にもならず tool error で差し戻される", async () => {
  const sandbox = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: (name) => {
      if ((name ?? "sandbox") !== "sandbox") throw new UnknownWorkspaceError(name ?? "sandbox");
      return sandbox;
    },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up

  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece belongs in a typo'd workspace",
      children: [
        {
          title: "run in a made-up workspace",
          purpose: "apply the change",
          completion_criteria: "change applied",
          workspace: "not-a-real-workspace",
        },
      ],
    },
  });
  await client.close();

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("unknown workspace");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // neither a work task nor an approval question was registered — the parent
  // stays exactly as it was, ready to retry with a real workspace name
  expect(board.find((x: any) => x.title === "run in a made-up workspace")).toBeUndefined();
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
  expect(board.find((x: any) => x.id === parent.id).status).toBe("in_progress");
});
