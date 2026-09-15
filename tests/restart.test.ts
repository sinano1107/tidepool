import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, queueWork, type Tidepool } from "./harness.js";

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
  // first task picked up at its own registration (ADR 0119 決定2)

  // restart the monolith on the same SQLite file
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  // the leftover in_progress task is escalated immediately at boot, no tick needed
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.id === first.id).status).toBe("blocked");
  expect(list.find((x: any) => x.type === "question")).toBeDefined();

  // the slot was freed at boot, so the boot poll (ADR 0119 決定4) hands the second task over
  expect(t.worker.started.map((x: any) => x.id)).toEqual([second.id]);
});

// ADR 0119 決定4: 起動完了は pickup の契機である —— 毎時のティックは起動直後には走らない
it("todo を持つ盤面で起動すると、tick を進めずに pickup される", async () => {
  t = await bootTidepool();
  const waiting = queueWork(t, "waiting across a restart");
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir });
  // 起動完了の poll は fire-and-forget なので、boot の返りの後ろにある
  await new Promise((resolve) => setImmediate(resolve));

  expect(t.worker.started.map((x) => x.id)).toEqual([waiting.id]);
});
