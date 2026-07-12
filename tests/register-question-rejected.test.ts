import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("type: question での POST /api/tasks は 400 で拒否される(issue #38)", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "question",
    title: "human が自分自身に question を作ろうとする",
    purpose: "purpose",
    completion_criteria: "criteria",
    question: [
      {
        title: "どちらにする?",
        options: ["A", "B"],
        recommendation: "A",
      },
    ],
  });

  expect(res.status).toBe(400);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board).toEqual([]);
});
