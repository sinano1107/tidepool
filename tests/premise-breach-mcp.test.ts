import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const spec = (title: string) => ({ title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` });

async function call(taskId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

it("前提の破綻の宣言が slot を解放して親が早期統合復帰し、親の continue_decomposition / redecompose も slot を解放する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "T");
  await t.clock.advance(HOUR);
  const decomposed = await call(parent.id, "decompose", { reason: "split T", children: [spec("A"), spec("B")] });
  const [a] = JSON.parse(decomposed.content[0].text).child_ids;
  await t.clock.advance(HOUR);

  expect((await call(a, "declare_premise_breach", { reason: "module M is broken" })).isError ?? false).toBe(false);
  await t.clock.advance(HOUR);
  expect((await call(parent.id, "continue_decomposition", { line: "M is fine" })).isError ?? false).toBe(false);
  await t.clock.advance(HOUR);
  expect((await call(a, "declare_premise_breach", { reason: "M is broken after all" })).isError ?? false).toBe(false);
  await t.clock.advance(HOUR);

  // 2度目の宣言は親に戻らず question になる —— B は held のまま、slot に入るものは無い
  expect(t.worker.started.map((x) => x.title)).toEqual(["T", "A", "T", "A"]);
});

it("再分解は旧い子を破棄して新しい子を登録し、slot を解放する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "T");
  await t.clock.advance(HOUR);
  const decomposed = await call(parent.id, "decompose", { reason: "split T", children: [spec("A")] });
  const [a] = JSON.parse(decomposed.content[0].text).child_ids;
  await t.clock.advance(HOUR);
  await call(a, "declare_premise_breach", { reason: "module M is broken" });
  await t.clock.advance(HOUR);

  expect((await call(parent.id, "redecompose", { reason: "replan", children: [spec("X")] })).isError ?? false).toBe(false);
  await t.clock.advance(HOUR);

  expect(t.worker.started.map((x) => x.title)).toEqual(["T", "A", "T", "X"]);
});

it("3つの verb は slot task への帰属を要し、root への宣言と破綻の開いていない親への続行・再分解を tool error で返す", async () => {
  t = await bootTidepool();
  const root = await registerWork(t, "root");
  const other = await registerWork(t, "other");
  await t.clock.advance(HOUR);

  for (const [name, args] of [
    ["declare_premise_breach", { reason: "r" }],
    ["continue_decomposition", { line: "l" }],
    ["redecompose", { reason: "r", children: [spec("X")] }],
  ] as const) {
    const unattributed = await call(other.id, name, args);
    expect(unattributed.isError).toBe(true);
    expect(unattributed.content[0].text).toContain("not attributed");
    const refused = await call(root.id, name, args);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(name === "declare_premise_breach" ? /escalate/ : /no child of this task has an open premise breach/);
  }
});

it("付帯子(分解判断に乗らない子)の宣言は escalate へ案内して拒む", async () => {
  t = await bootTidepool();
  const root = await registerWork(t, "root", undefined, undefined, "human");
  const attached = registerTask(t.db, { type: "work", ...spec("repair"), parent_id: root.id }, t.clock.now());
  await t.clock.advance(HOUR);

  const refused = await call(attached.id, "declare_premise_breach", { reason: "r" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("escalate");
});
