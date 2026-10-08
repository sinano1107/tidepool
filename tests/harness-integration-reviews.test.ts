import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import {
  api,
  bootTidepool,
  children,
  completeIntegrationReviews,
  completeViaMcp,
  HUMAN_WEBUI,
  humanDecomposeTaskViaWebui,
  nextPoll,
  type Tidepool,
} from "./harness.js";

/** issue #1401: 子の統合点の review は子の下の付帯子で、親は待たない。唯一の work 子が完了すると親が slot を取るので、
 *  `completeIntegrationReviews` は slot の持ち主を先に退けてから review を走らせる。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("親が slot を取っていても completeIntegrationReviews は子の統合点の review を done にし、親も done になる", async () => {
  t = await bootTidepool();
  const parent = registerTask(
    t.db,
    { type: "work", title: "risky parent", purpose: "p", completion_criteria: "c", risk_flag: true },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  const child = humanDecomposeTaskViaWebui(
    t.db,
    parent,
    { reason: "split", children: [{ title: "risky child", purpose: "p", completion_criteria: "c", risk_flag: true }] },
    t.clock.now(),
  )[0]!;
  await nextPoll(t);
  expect((await completeViaMcp(t, child.id)).isError).not.toBe(true);

  await completeIntegrationReviews(t, child.id);

  const review = (await children(t, child.id)).find((x: any) => x.type === "review");
  expect(review.status).toBe("done");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(tasks.find((x: any) => x.id === parent.id).status).toBe("done");
});
