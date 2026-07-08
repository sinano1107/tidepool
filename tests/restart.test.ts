import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("a restart does not break concurrency=1: the in_progress task still owns the slot", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "interrupted by restart",
    purpose: "occupies the slot across a restart",
    completion_criteria: "n/a",
  });
  const second = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "must keep waiting",
      purpose: "would be a second in_progress task",
      completion_criteria: "n/a",
    })
  ).json;
  await t.clock.advance(HOUR); // first task picked up

  // restart the monolith on the same SQLite file
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${second.id}`)).json.status).toBe("todo");
});
