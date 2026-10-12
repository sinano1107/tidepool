import { afterEach, expect, it, vi } from "vitest";
import { quarantineAgent } from "../src/quarantine.js";
import { UnknownAgentError } from "../src/registry.js";
import {
  api,
  bootTidepool,
  commitWork,
  completeViaMcp,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  makeRemoteBackedWorkspace,
  questions,
  queueWork,
  registerWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("quarantine 済み agent 宛ての todo はキュービューで skipped、ボードでは todo のまま表示される(ADR 0012 / issue #36)", async () => {
  t = await bootTidepool();
  const delegated = queueWork(t, "delegated to navigator", undefined, "navigator");
  const other = queueWork(t, "runs under the default agent");

  quarantineAgent(t.db, "navigator", new Error("unknown agent: navigator"), t.clock.now());

  await t.clock.advance(HOUR);

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks;
  expect(queue.find((x: any) => x.id === delegated.id).status).toBe("skipped");
  expect(queue.find((x: any) => x.id === other.id).status).not.toBe("skipped");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === delegated.id).status).toBe("todo");

  // the other agent's task keeps flowing — quarantine halts only its own resource
  expect(t.worker.started.map((x: any) => x.id)).toEqual([other.id]);
});

it("quarantine question への回答は、その agent 名宛ての todo がまだ残っていれば拒否される(quarantine は開いたまま)", async () => {
  t = await bootTidepool();
  const delegated = queueWork(t, "delegated to navigator", undefined, "navigator");

  quarantineAgent(t.db, "navigator", new Error("unknown agent: navigator"), t.clock.now());

  const question = await servedQuarantineQuestion(t, "agent", "navigator");
  expect(question.question_items[0].options).toEqual(["repaired by hand"]);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(409);

  const after = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(after.status).toBe("todo");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.id)).not.toContain(delegated.id);
});

it("その agent 名宛ての todo がもう存在しなければ、回答が受理され pickup が即時再開する", async () => {
  t = await bootTidepool();
  const delegated = queueWork(t, "delegated to navigator", undefined, "navigator");
  const other = queueWork(t, "waiting behind the quarantine");

  quarantineAgent(t.db, "navigator", new Error("unknown agent: navigator"), t.clock.now());
  // the human's own repair: reassign the delegated task away from the
  // quarantined agent name (a plain human move, not the answer itself)
  t.db.prepare("UPDATE tasks SET assignee = NULL WHERE id = ?").run(delegated.id);

  const question = await servedQuarantineQuestion(t, "agent", "navigator");

  const answerText = "repaired: reassigned the pending task away from navigator";
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: [answerText],
  });
  expect(res.status).toBe(200);
  expect(res.json.status).toBe("done");
  expect(res.json.question_answer).toEqual([answerText]);

  // pickup resumed at once (no need to advance the clock) and took the queue
  // head — `delegated` registered first, so it's the one slot's single seat;
  // `other` stays queued behind it
  expect(t.worker.started.map((x: any) => x.id)).toEqual([delegated.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${other.id}`)).json.status).toBe("todo");
});

// issue #1745: エントリがあっても pickup の解決に通らない定義は registry に「戻った」に数えない
it("registry にエントリはあるが定義が成立しない agent 名の quarantine への回答は、その名前宛ての todo が残る限り定義の不成立を名指して拒否される", async () => {
  t = await bootTidepool({
    agentRegistered: () => true,
    agentDefinitionFailure: (name) => (name === "navigator" ? 'unknown tier "x"' : undefined),
  });
  queueWork(t, "delegated to navigator", undefined, "navigator");

  quarantineAgent(t.db, "navigator", new Error('agent navigator: unknown tier "x"'), t.clock.now());

  const question = await servedQuarantineQuestion(t, "agent", "navigator");
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(409);
  expect(res.json.error).toContain(`agent navigator's definition still does not hold (unknown tier "x")`);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");
});

// ADR 0241 決定5・6: quarantine の受理は回答なので収束を突く —— quarantine が抱えていた根は失敗 question を持たないまま着地する
it("PR を開く時点で profile が読めず agent 名の quarantine が抱えていた根は、registry を直して quarantine に答えると、その受理の後の収束で PR が開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("quarantine-confirm-agent-lands");
  let repaired = false;
  t = await bootTidepool({
    workspace,
    resolveAuthority: (assignee) => {
      if (!repaired) throw new UnknownAgentError(assignee!);
      return { name: "standard", guidance: "", merge: "escalate" };
    },
    agentRegistered: () => repaired,
  });
  const work = await registerWork(t, "ship reviewable work");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "v1\n");
  await completeViaMcp(t, work.id);
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === work.id,
  );
  await t.clock.advance(HOUR);
  await completeViaMcp(t, review.id, false);
  const { assignee } = (await api(t.baseUrl, "GET", `/api/tasks/${work.id}`)).json;
  const question = await servedQuarantineQuestion(t, "agent", assignee);
  expect(t.github.requests).toEqual([]);
  expect((await questions(t)).filter((q: any) => q.title.startsWith("PR promotion"))).toEqual([]);

  repaired = true;
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
  expect(res.status).toBe(200);

  await vi.waitFor(() => expect(t.github.requests).toHaveLength(1));
  expect(t.github.requests[0]).toMatchObject({ branch: `task/${work.id}` });
});
