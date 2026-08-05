import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, registerQuestion, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function registerWork(t: Tidepool, title: string, parent_id?: string) {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    ...(parent_id && { parent_id }),
    ...(parent_id && { decompose_reason: `split ${title} from its parent` }),
  });
  return res.json;
}

it("祖先の未回答 question に held されたタスクは、回答されるまで slot に入らない", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  const child = await registerWork(t, "child", parent.id);
  const question = registerQuestion(t, {
    title: "unrelated decision",
    purpose: "a human wants steering input",
    completion_criteria: "answered",
    parent_id: parent.id,
    question: [{ title: "unrelated decision", options: ["yes", "no"], recommendation: "yes" }],
  });

  // child has no unfinished children of its own — it would be plain 'todo'
  // (and pickable) without the held rule
  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(before.find((x: any) => x.id === child.id).status).toBe("held");

  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["yes"] });

  const after = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(after.find((x: any) => x.id === child.id).status).toBe("todo");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.id)).toEqual([child.id]);
});
