import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { escalateTask, getTask, logDecision, registerTask, type Task } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { answerQuestionViaWebui, api, bootTidepool, HOUR, HUMAN_WEBUI, humanDecomposeTaskViaWebui, mcpClient, queueWork, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("未決着・実行中でない親への人間の子追加は成功し、追加した子タスクがそのまま返る", async () => {
  t = await bootTidepool();
  const parent = queueWork(t, "parent");

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose of child",
    completion_criteria: "criteria of child",
    parent_id: parent.id,
    decompose_reason: "split the remaining work",
  });

  expect(res.status).toBe(201);
  expect(res.json.parent_id).toBe(parent.id);
  expect(res.json.title).toBe("child");
  expect(res.json.type).toBe("work");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "child")).toBeDefined();
  expect(board.find((x: any) => x.id === parent.id).status).toBe("blocked");
});

it("分解理由を書くと decision log エントリとして残る", async () => {
  t = await bootTidepool();
  const parent = queueWork(t, "parent");

  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "splitting off the edge case first",
  });

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const decisions = log.entries.filter((e: any) => e.kind === "decision_logged");
  expect(decisions).toHaveLength(1);
  expect(decisions[0].payload.line).toBe("splitting off the edge case first");
});

it("分解理由が空なら登録を拒否し、子も decision log も残さない", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
  });

  expect(res.status).toBe(400);
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries.filter((e: any) => e.kind === "decision_logged")).toEqual([]);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.some((x: any) => x.title === "child")).toBe(false);
});

it("Worker MCP の decompose も空の分解理由を拒否する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "",
      children: [
        { title: "child", purpose: "purpose", completion_criteria: "criteria" },
      ],
    },
  });
  await client.close();

  expect(res.isError).toBe(true);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.some((x: any) => x.title === "child")).toBe(false);
});

it("人間は同じ親に複数回にわたって子を追加できる(agent の子がまだない限り)", async () => {
  t = await bootTidepool();
  const parent = queueWork(t, "parent");

  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "first child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split the first child",
  });
  const second = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "second child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split the second child",
  });

  expect(second.status).toBe(201);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.parent_id === parent.id)).toHaveLength(2);
});

it("存在しない parent_id への子追加は 404", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: "no-such-task",
    decompose_reason: "split the missing parent",
  });

  expect(res.status).toBe(404);
});

const at = new Date("2026-10-02T00:00:00.000Z");

const failureQuestion = (db: Db, parent: Task) =>
  escalateTask(
    db,
    parent,
    { context: "the worker died", questions: [{ title: "failed", options: ["retry", "abandon"], recommendation: "retry" }], cancel_option: "abandon" },
    BOARD_WORKER_ID,
    at,
    "board",
  );

it.each([
  ["未回答の failure question", failureQuestion],
  ["回答済みの failure question", (db: Db, parent: Task): unknown => answerQuestionViaWebui(db, failureQuestion(db, parent), ["retry"], at)],
  [
    "異議が立てた RCA review",
    (db: Db, parent: Task): unknown => {
      const entry = logDecision(db, parent, "deckhand's call", "deckhand", at, "worker");
      startTriage(db, at);
      raiseObjection(db, entry, "redo it", at);
      return commitTriage(db, at);
    },
  ],
] as const)("盤面名義の子(%s)を持つ task にも人間は子を足せる —— agent の分解判断はまだ無い(ADR 0194 決定5)", (_, addBoardChild) => {
  const db = openDb(":memory:");
  const registered = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  addBoardChild(db, registered);
  const parent = getTask(db, registered.id)!;

  const [child] = humanDecomposeTaskViaWebui(db, parent, { reason: "split", children: [{ title: "human's child", purpose: "p", completion_criteria: "c" }] }, at);

  expect(child).toMatchObject({ parent_id: parent.id, title: "human's child" });
});
