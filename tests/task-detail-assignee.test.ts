import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, managementMcpClient, queueWork, registerQuestion, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const AUDITOR = "keeper-of-the-code";

/** assignee を指定せずに登録した work・review・question と、取り消した work を置く。
 *  取り消しの扉は pickup の契機なので(ADR 0119 決定2)、ほかの行より先に取り消す。 */
async function unsetAssigneeBoard(t: Tidepool) {
  const cancelled = queueWork(t, "cancelled work");
  expect((await api(t.baseUrl, "POST", `/api/tasks/${cancelled.id}/cancel`, {})).status).toBe(200);
  const work = queueWork(t, "unset work");
  const review = registerTask(
    t.db,
    { type: "review", title: "unset review", purpose: "independent review", completion_criteria: "findings filed" },
    t.clock.now(),
  );
  const question = registerQuestion(t, {
    title: "unset question",
    purpose: "a human wants steering input",
    completion_criteria: "answered",
    question: [{ title: "which way", options: ["left", "right"], recommendation: "left" }],
  });
  return {
    cancelled: cancelled.id,
    listed: [
      [work.id, "fake-worker"],
      [review.id, AUDITOR],
      [question.id, "human"],
    ] as const,
  };
}

/** 一覧だけが載せる注釈(着地 question の `landing`)を外した一覧の行。 */
function listedRow(list: any[], id: string) {
  const { landing: _landing, ...row } = list.find((x) => x.id === id);
  return row;
}

it("GET /api/tasks/:id は assignee 未指定のタスクを一覧と同じ解決後の assignee と保存値の raw_assignee で返す(issue #1208)", async () => {
  t = await bootTidepool({ auditorName: AUDITOR });
  const { cancelled, listed } = await unsetAssigneeBoard(t);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  for (const [id, resolved] of listed) {
    const single = (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
    expect(single).toMatchObject({ assignee: resolved, raw_assignee: listedRow(list, id).raw_assignee });
    expect(single).toEqual(listedRow(list, id));
  }

  // 一覧の絞り込みは単体に持ち込まない —— 取り消したタスクも返り、同じ解決を通る
  expect(list.some((x: any) => x.id === cancelled)).toBe(false);
  const single = (await api(t.baseUrl, "GET", `/api/tasks/${cancelled}`)).json;
  expect(single).toMatchObject({ status: "cancelled", assignee: "fake-worker", raw_assignee: null });
});

it("管理MCP の get_task は assignee 未指定のタスクを list_board と同じ assignee・raw_assignee で返す(issue #1208)", async () => {
  t = await bootTidepool({ auditorName: AUDITOR });
  const { cancelled, listed } = await unsetAssigneeBoard(t);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const read = async (name: string, args: Record<string, unknown>): Promise<any> =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
    const list = await read("list_board", {});
    for (const [id, resolved] of listed) {
      const { events: _events, ...single } = await read("get_task", { task_id: id });
      expect(single).toMatchObject({ assignee: resolved, raw_assignee: listedRow(list, id).raw_assignee });
      expect(single).toEqual(listedRow(list, id));
    }
    expect(await read("get_task", { task_id: cancelled })).toMatchObject({
      status: "cancelled",
      assignee: "fake-worker",
      raw_assignee: null,
    });
  } finally {
    await client.close();
  }
});
