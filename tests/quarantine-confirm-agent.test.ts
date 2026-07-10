import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { quarantineAgent } from "../src/agent.js";
import { openDb } from "../src/db.js";
import {
  api,
  bootTidepool,
  HOUR,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function registerDelegated(t: Tidepool, title: string, assignee: string): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    assignee,
  });
  return res.json;
}

it("quarantine 済み agent 宛ての todo はキュービューで skipped、ボードでは todo のまま表示される(ADR 0012 / issue #36)", async () => {
  t = await bootTidepool();
  const delegated = await registerDelegated(t, "delegated to navigator", "navigator");
  const other = await registerWork(t, "runs under the default agent");

  const db = openDb(join(t.dir, "board.sqlite"));
  quarantineAgent(db, "navigator", new Error("unknown agent: navigator"), t.clock.now());
  db.close();

  await t.clock.advance(HOUR);

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === delegated.id).status).toBe("skipped");
  expect(queue.find((x: any) => x.id === other.id).status).not.toBe("skipped");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === delegated.id).status).toBe("todo");

  // the other agent's task keeps flowing — quarantine halts only its own resource
  expect(t.worker.started.map((x: any) => x.id)).toEqual([other.id]);
});

it("quarantine question への回答は、その agent 名宛ての todo がまだ残っていれば拒否される(needs_human は1のまま)", async () => {
  t = await bootTidepool();
  const delegated = await registerDelegated(t, "delegated to navigator", "navigator");

  const db = openDb(join(t.dir, "board.sqlite"));
  quarantineAgent(db, "navigator", new Error("unknown agent: navigator"), t.clock.now());
  db.close();

  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = before.find((x: any) => x.type === "question");
  expect(question.question_options).toEqual(["repaired by hand"]);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "repaired by hand",
  });
  expect(res.status).toBe(409);

  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(after.status).toBe("todo");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.id)).not.toContain(delegated.id);
});

it("その agent 名宛ての todo がもう存在しなければ、回答が受理され needs_human が解除され pickup が即時再開する", async () => {
  t = await bootTidepool();
  const delegated = await registerDelegated(t, "delegated to navigator", "navigator");
  const other = await registerWork(t, "waiting behind the quarantine");

  const db = openDb(join(t.dir, "board.sqlite"));
  quarantineAgent(db, "navigator", new Error("unknown agent: navigator"), t.clock.now());
  // the human's own repair: reassign the delegated task away from the
  // quarantined agent name (a plain human move, not the answer itself)
  db.prepare("UPDATE tasks SET assignee = NULL WHERE id = ?").run(delegated.id);
  db.close();

  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = before.find((x: any) => x.type === "question");

  const answerText = "repaired: reassigned the pending task away from navigator";
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: answerText,
  });
  expect(res.status).toBe(200);
  expect(res.json.status).toBe("done");
  expect(res.json.question_answer).toBe(answerText);

  // pickup resumed at once (no need to advance the clock) and took the queue
  // head — `delegated` registered first, so it's the one slot's single seat;
  // `other` stays queued behind it
  expect(t.worker.started.map((x: any) => x.id)).toEqual([delegated.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${other.id}`)).json.status).toBe("todo");
});
