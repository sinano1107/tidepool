import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function registerWork(t: Tidepool, title: string) {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
  });
  return res.json;
}

it("the hourly tick hands the queue head to the worker and marks it in_progress", async () => {
  t = await bootTidepool();
  const first = await registerWork(t, "first in line");
  const second = await registerWork(t, "second in line");

  // deterministic: just under an hour, nothing happens
  await t.clock.advance(HOUR - 1);
  expect(t.worker.started).toEqual([]);

  await t.clock.advance(1);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const byId = Object.fromEntries(list.map((x: any) => [x.id, x]));
  expect(byId[first.id].status).toBe("in_progress");
  expect(byId[first.id].assignee).toBe(t.worker.id);
  expect(byId[second.id].status).toBe("todo");

  // slot is busy (concurrency = 1): the next tick starts nothing new
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${second.id}`)).json.status).toBe("todo");
});
