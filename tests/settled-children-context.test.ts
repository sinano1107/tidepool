import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MIN = 60 * 1000;
const WORK_LIMIT = 90 * MIN;

const escalation = {
  context: "two viable providers, out of my authority",
  questions: [{ title: "which provider?", options: ["a", "b"], recommendation: "a" }],
};

it("get_current_task の history に、回答済み question 子タスクの items/answer が含まれる", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up
  const escalateClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await escalateClient.callTool({ name: "escalate", arguments: escalation });
  await escalateClient.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["b"] });

  // answering with a free slot resumes the parent at once (escalate.test.ts's
  // own "answering unblocks the parent... picks it up at once" behavior)
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.history).toEqual([
      {
        child_outside_the_decomposition: {
          title: escalation.questions[0]!.title,
          purpose: escalation.context,
          completion_criteria: "a human answer is recorded",
          status: "done",
          items: escalation.questions,
          answer: ["b"],
          comment: null,
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

it("get_current_task の history に、完了済み work 子タスクの handoff doc が全文含まれる(統合復帰)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "toolchain");
  await t.clock.advance(HOUR); // parent picked up
  const decomposeClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await decomposeClient.callTool({
    name: "decompose",
    arguments: {
      reason: "split into one child",
      children: [{ title: "lexer", purpose: "purpose", completion_criteria: "criteria" }],
    },
  });
  await decomposeClient.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = list.find((x: any) => x.title === "lexer");
  await t.clock.advance(HOUR); // child picked up
  const completeClient = await mcpClient(t.mcpBaseUrl, child.id);
  await completeClient.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await completeClient.close();

  // the sole child settled — the parent unblocks and resumes on the next tick
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    const doneChild = (await api(t.baseUrl, "GET", `/api/tasks/${child.id}`)).json;
    expect(payload.history).toEqual([
      {
        decision: "split into one child",
        children: [
          {
            title: "lexer",
            purpose: "purpose",
            completion_criteria: "criteria",
            status: "done",
            handoff_doc: doneChild.handoff_doc,
          },
        ],
      },
    ]);
    expect(payload.history[0].children[0].handoff_doc).toContain(FULL_HANDOFF.outcome);
  } finally {
    await client.close();
  }
});

it("get_current_task の history に、cancelled 子タスクの発端 question の title/answer が含まれる(abandon 後の再計画)", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws, watchdog: { timeLimits: { work: WORK_LIMIT }, grace } });

  const plan = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "plan",
      purpose: "plan purpose",
      completion_criteria: "plan criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // plan picked up
  const decomposeClient = await mcpClient(t.mcpBaseUrl, plan.id);
  await decomposeClient.callTool({
    name: "decompose",
    arguments: {
      reason: "split into two children based on the same decision",
      children: [
        { title: "will fail", purpose: "purpose", completion_criteria: "criteria" },
        { title: "sibling", purpose: "purpose", completion_criteria: "criteria" },
      ],
    },
  });
  await decomposeClient.close();

  await t.clock.advance(HOUR); // "will fail" picked up
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");
  await t.clock.advance(90 * MIN); // SIGTERM
  await t.clock.advance(grace); // SIGKILL — failure question registered

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board1.find((x: any) => x.type === "question");

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["abandon"] });

  // abandon resumes the plan (parent) at once — same free-slot pickup as the
  // question-answer path
  const client = await mcpClient(t.mcpBaseUrl, plan.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    const failingChild = payload.history[0].children.find((c: any) => c.title === "will fail");
    const siblingChild = payload.history[0].children.find((c: any) => c.title === "sibling");
    expect(failingChild).toEqual({
      title: "will fail",
      purpose: "purpose",
      completion_criteria: "criteria",
      status: "cancelled",
      origin_question: { title: question.title, answer: ["abandon"] },
    });
    expect(siblingChild).toEqual({
      title: "sibling",
      purpose: "purpose",
      completion_criteria: "criteria",
      status: "cancelled",
      origin_question: { title: question.title, answer: ["abandon"] },
    });
  } finally {
    await client.close();
  }
});

it("get_current_task の history に、未決着(todo)の兄弟も含まれる", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "toolchain 2");
  await t.clock.advance(HOUR); // parent picked up, still holds the slot

  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "split the two independent parts",
      children: [
        { title: "first part", purpose: "first purpose", completion_criteria: "first criteria" },
        { title: "second part", purpose: "second purpose", completion_criteria: "second criteria" },
      ],
    },
  });
  await parentClient.close();
  await t.clock.advance(HOUR);

  const current = t.worker.started.at(-1)!;
  const client = await mcpClient(t.mcpBaseUrl, current.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent.history[0].children.map((child: any) => child.status)).toEqual([
      "in_progress",
      "todo",
    ]);
  } finally {
    await client.close();
  }
});
