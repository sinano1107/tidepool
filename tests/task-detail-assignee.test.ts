import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { 
  api,
  bootTidepool,
  HOUR,HUMAN_WEBUI, 
  managementMcpClient,
  queueChild,
  queueWork,
  registerQuestion,
  type Tidepool,} from "./harness.js";

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
    ...HUMAN_WEBUI,
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

it("GET /api/tasks/:id は assignee 未指定のタスクを一覧と同じ解決後の assignee と保存値の raw_assignee で返す(issue #1208)", async () => {
  t = await bootTidepool({ auditorName: AUDITOR });
  const { cancelled, listed } = await unsetAssigneeBoard(t);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  for (const [id, resolved] of listed) {
    const single = (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
    expect(single).toMatchObject({ assignee: resolved });
    expect(single).toEqual(list.find((x: any) => x.id === id));
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
      expect(single).toMatchObject({ assignee: resolved });
      expect(single).toEqual(list.find((x: any) => x.id === id));
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

const resolution = ({ assignee, raw_assignee, status }: any) => ({ assignee, raw_assignee, status });

it("POST /api/tasks と move の応答は assignee 未指定のタスクを GET /api/tasks/:id と同じ解決で返す(issue #1215)", async () => {
  t = await bootTidepool({ auditorName: AUDITOR });
  // 登録と先頭への move は pickup の契機なので(ADR 0119 決定2)、slot を埋めて行を todo のまま置く
  queueWork(t, "occupies the slot");
  await t.clock.advance(HOUR);

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "unset work",
    purpose: "resolve on every mouth",
    completion_criteria: "the response matches the detail",
  });
  expect(registered.status).toBe(201);
  const detail = async () => resolution((await api(t.baseUrl, "GET", `/api/tasks/${registered.json.id}`)).json);
  expect(resolution(registered.json)).toEqual({ assignee: "fake-worker", raw_assignee: null, status: "todo" });
  expect(resolution(registered.json)).toEqual(await detail());

  const moved = await api(t.baseUrl, "POST", `/api/tasks/${registered.json.id}/move`, { after: null });
  expect(resolution(moved.json)).toEqual(await detail());
});

it("分解済みの親を move した応答の status は保存値ではなく導出された blocked になる(issue #1215)", async () => {
  t = await bootTidepool();
  const parent = queueWork(t, "parent");
  queueChild(t, "child", parent.id);

  const moved = await api(t.baseUrl, "POST", `/api/tasks/${parent.id}/move`, { after: null });
  expect(moved.json.status).toBe("blocked");
});
