import { afterEach, expect, it } from "vitest";
import { recordKnowledge } from "../src/memory.js";
import { bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

/** worker MCP の pull 3動詞(spec #586 D / issue #591)。フィルタ・順位・event の中身は
 *  ドメイン層(tests/memory-pull.test.ts)が言うので、ここは写像だけ —— 帰属 task の
 *  workspace と agent 名で読み、応答形どおりに返し、tool 結果に event id が載る。 */
let t: Tidepool;
afterEach(() => t?.stop());

const body = (result: any) => JSON.parse(result.content[0].text);

it("browse_memory / search_memory / read_memory は attributed task の workspace で読み、応答形どおりに event id つきで返す", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  const record = (scope: string, title: string) =>
    recordKnowledge(
      t.db,
      { scope, path: "build/tests", title, text: "npm test fails on Node 24.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
      "worker",
      t.clock.now(),
    ).entry_id;
  const id = record("charts", "Tests need Node 22");
  record("elsewhere", "Not this workspace");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return body(result);
    };
    expect(await call("browse_memory", {})).toEqual({ prefixes: ["build"], entries: [], truncated: false, event_id: expect.any(Number) });
    expect(await call("browse_memory", { prefix: "build/tests", page: 1 })).toEqual({
      prefixes: [],
      entries: [{ id, title: "Tests need Node 22" }],
      truncated: false,
      event_id: expect.any(Number),
    });
    expect(await call("search_memory", { query: "Node" })).toEqual({
      results: [{ id, title: "Tests need Node 22", path: "build/tests" }],
      truncated: false,
      event_id: expect.any(Number),
    });
    expect(await call("read_memory", { ids: [id] })).toEqual({
      entries: [
        {
          id,
          title: "Tests need Node 22",
          path: "build/tests",
          text: "npm test fails on Node 24.",
          source: { kind: "commit", ref: "0a46a46" },
          source_kind: "fact",
        },
      ],
      event_id: expect.any(Number),
    });
  } finally {
    await client.close();
  }
});
