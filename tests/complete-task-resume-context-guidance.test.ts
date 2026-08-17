import { afterEach, expect, it } from "vitest";
import { bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("complete_task の description が resume_context に着地状態(push/PR/merge)を書かせない指針を含む(issue #303)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "chart a course");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    const completeTask = tools.find((tool) => tool.name === "complete_task")!;
    expect(completeTask.description).toMatch(/resume_context/);
    expect(completeTask.description).toMatch(/push/i);
    expect(completeTask.description).toMatch(/(merge|land)/i);
  } finally {
    await client.close();
  }
});
