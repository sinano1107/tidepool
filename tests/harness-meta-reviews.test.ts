import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeMetaReviews, HUMAN_WEBUI, nextPoll, type Tidepool } from "./harness.js";

/** issue #1633: `completeMetaReviews` は slot の持ち主を先に退けてから meta-review を走らせる(`runNow`)。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("work が slot を握っていても completeMetaReviews は open な meta-review を done にし、work も done になる", async () => {
  t = await bootTidepool();
  const work = registerTask(
    t.db,
    { type: "work", title: "slot holder", purpose: "p", completion_criteria: "c" },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  await nextPoll(t);
  const list = async () => (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  expect((await list()).find((x) => x.id === work.id).status).toBe("in_progress");

  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" })).status).toBe(200);
  const metaReviews = (await list()).filter((x) => x.meta_review_subject && x.status === "todo").map((x) => x.id as string);
  expect(metaReviews.length).toBeGreaterThan(0);

  await completeMetaReviews(t);

  const status = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;
  for (const id of metaReviews) expect(await status(id)).toBe("done");
  expect(await status(work.id)).toBe("done");
});
