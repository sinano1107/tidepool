import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { quarantineAgent } from "../src/agent.js";
import { DEFAULT_AUDITOR_NAME } from "../src/tasks.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Register a standalone review task with no explicit assignee — the same
 *  shape layer 1's completion review / layer 2's independent auditor RCA /
 *  layer 3's meta-review all register with (CONTEXT.md's Review). */
async function registerIndependentReview(t: Tidepool, title: string): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "review",
    title,
    purpose: "independent review",
    completion_criteria: "root cause lands as a concrete diff",
  });
  return res.json;
}

it("Auditor が quarantine されている間、defaultAgentName が健全でも独立レビュータスクは pickup されない(issue #42, AC1)", async () => {
  t = await bootTidepool();
  const review = await registerIndependentReview(t, "rca (auditor): work A");
  const work = await registerWork(t, "unrelated work");

  const db = t.db;
  quarantineAgent(db, DEFAULT_AUDITOR_NAME, new Error("auditor unavailable"), t.clock.now());

  await t.clock.advance(HOUR);

  // the review stays out of the slot while the healthy default-agent task flows
  expect(t.worker.started.map((x: any) => x.id)).toEqual([work.id]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks;
  expect(queue.find((x: any) => x.id === review.id)?.status).toBe("skipped");
  expect(queue.find((x: any) => x.id === work.id)?.status).not.toBe("skipped");
});
