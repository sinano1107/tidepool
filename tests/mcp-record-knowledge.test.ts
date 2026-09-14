import { afterEach, expect, it } from "vitest";
import { approvedMemoryEntries } from "../src/memory.js";
import { bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

/** worker MCP の `record_knowledge`(spec #586 E / issue #590)。検査と event の中身は
 *  ドメイン層(tests/memory.test.ts)が言うので、ここは写像だけ —— スコープ・書き手・
 *  返り値・拒否が tool error になること(ADR 0107 決定3)。 */
let t: Tidepool;
afterEach(() => t?.stop());

const text = (result: any): string => result.content[0].text;

it("record_knowledge は attributed task の workspace をスコープ、worker verb + agent 名を書き手にして書き、entry id と event id を返す", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result = await client.callTool({
      name: "record_knowledge",
      arguments: {
        path: "build/tests",
        title: "Tests need Node 22",
        text: "npm test fails on Node 24.",
        source: { commit: "0a46a46" },
      },
    });
    expect(result.isError).toBeFalsy();
    const { entry_id, event_id } = JSON.parse(text(result));
    expect(approvedMemoryEntries(t.db)).toMatchObject([
      {
        id: entry_id,
        version: event_id,
        scope: "charts",
        author: { activity: "worker_verb", name: t.worker.id },
      },
    ]);
  } finally {
    await client.close();
  }
});

it("record_knowledge の拒否は protocol error ではなく domain error の tool error で返る —— 出所の欠落も schema で弾かない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const missing = await client.callTool({
      name: "record_knowledge",
      arguments: { path: "build/tests", title: "t", text: "x" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("exactly one of event_id or commit");
    expect(approvedMemoryEntries(t.db)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("registry の無い盤面で workspace を指定しないタスクからの record_knowledge は、scope が盤面全体に解決されるので拒否され、記憶は書かれない(issue #623)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result = await client.callTool({
      name: "record_knowledge",
      arguments: {
        path: "build/tests",
        title: "Tests need Node 22",
        text: "npm test fails on Node 24.",
        source: { commit: "0a46a46" },
      },
    });
    expect(result.isError).toBe(true);
    expect(approvedMemoryEntries(t.db)).toEqual([]);
  } finally {
    await client.close();
  }
});
