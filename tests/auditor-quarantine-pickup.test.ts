import { afterEach, expect, it } from "vitest";
import { quarantineAgent } from "../src/agent.js";
import { DEFAULT_AUDITOR_NAME, registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, queueWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

/** Register a standalone review task with no explicit assignee — the same
 *  shape layer 1's completion review / layer 2's independent auditor RCA /
 *  layer 3's meta-review all register with (CONTEXT.md's Review). Placed
 *  without the human door: a door registration is itself a pickup trigger
 *  (ADR 0119 決定2), and this fixture must wait for the quarantine below. */
function registerIndependentReview(t: Tidepool, title: string) {
  return registerTask(
    t.db,
    { type: "review", title, purpose: "independent review", completion_criteria: "root cause lands as a concrete diff" },
    t.clock.now(),
  );
}

it("Auditor が quarantine されている間、defaultAgentName が健全でも独立レビュータスクは pickup されない(issue #42, AC1)", async () => {
  t = await bootTidepool();
  const review = registerIndependentReview(t, "rca (auditor): work A");
  const work = queueWork(t, "unrelated work");

  const db = t.db;
  quarantineAgent(db, DEFAULT_AUDITOR_NAME, new Error("auditor unavailable"), t.clock.now());

  await t.clock.advance(HOUR);

  // the review stays out of the slot while the healthy default-agent task flows
  expect(t.worker.started.map((x: any) => x.id)).toEqual([work.id]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks;
  expect(queue.find((x: any) => x.id === review.id)?.status).toBe("skipped");
  expect(queue.find((x: any) => x.id === work.id)?.status).not.toBe("skipped");
});
