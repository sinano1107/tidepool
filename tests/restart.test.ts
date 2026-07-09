import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("a restart drops the interrupted task into the same failure-escalation path as a watchdog kill, freeing the slot", async () => {
  t = await bootTidepool();
  const first = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "interrupted by restart",
      purpose: "occupies the slot across a restart",
      completion_criteria: "n/a",
    })
  ).json;
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

  // the leftover in_progress task is escalated immediately at boot, no tick needed
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.id === first.id).status).toBe("blocked");
  expect(list.find((x: any) => x.type === "question")).toBeDefined();

  // the slot was freed at boot, so the second task can now proceed
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.id)).toEqual([second.id]);
});
