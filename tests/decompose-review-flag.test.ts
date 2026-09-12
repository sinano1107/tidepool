import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { appendEvent } from "../src/events.js";
import { FakeClock, FakeContainerRuntime, healthyUsageText } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Complete the slot task via MCP with a full work handoff. */
async function completeVia(t: Tidepool, taskId: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();
}

it("flag の無いルート work の完了でも Auditor 宛ての統合点レビューが生成される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "integration", "greenhouse");
  await t.clock.advance(HOUR);
  await completeVia(t, task.id);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "review" && x.parent_id === task.id)).toMatchObject([
    { assignee: "fugu", raw_assignee: null, workspace: "greenhouse" },
  ]);
  const review = board.find((x: any) => x.type === "review");
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${review.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").origin).toBe("worker");
});

it.each([false, true])(
  "非ルート非 flag の子は risk=%s のときだけ個別レビューされる",
  async (risk) => {
    t = await bootTidepool();
    const parent = (
      await api(t.baseUrl, "POST", "/api/tasks", {
        type: "work",
        title: "parent",
        purpose: "p",
        completion_criteria: "c",
        risk_flag: true,
      })
    ).json;
    const child = (
      await api(t.baseUrl, "POST", "/api/tasks", {
        type: "work",
        parent_id: parent.id,
        decompose_reason: "split",
        title: "child",
        purpose: "p",
        completion_criteria: "c",
        risk_flag: risk,
      })
    ).json;
    await t.clock.advance(HOUR);
    await completeVia(t, child.id);
    expect(
      (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
        (x: any) => x.type === "review" && x.parent_id === child.id,
      ),
    ).toHaveLength(risk ? 1 : 0);
  },
);

it("human task の完了は flag があっても統合点レビューを生成しない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "human work", undefined, true, "human");
  expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/complete`, {})).status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);
});

it("review_by は flag から独立し、指定した reviewer ごとに1本生成する", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "integration",
      purpose: "p",
      completion_criteria: "c",
      review_by: ["security", "standards"],
    })
  ).json;
  expect(task.review_by).toEqual(["security", "standards"]);
  await t.clock.advance(HOUR);
  await completeVia(t, task.id);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(
    board
      .filter((x: any) => x.type === "review" && x.parent_id === task.id)
      .map((x: any) => x.assignee),
  ).toEqual(["security", "standards"]);
});

it("受理は統合点レビューがすべて完了するまで偽で、最後のレビュー完了で真になる", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "integration",
      purpose: "p",
      completion_criteria: "c",
      review_by: ["security", "standards"],
    })
  ).json;
  const accepted = async () => (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.accepted;
  expect(await accepted()).toBe(false);
  await t.clock.advance(HOUR);
  await completeVia(t, task.id);
  expect(await accepted()).toBe(false);
  const reviews = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (x: any) => x.type === "review" && x.parent_id === task.id,
  );
  for (const review of reviews) {
    await t.clock.advance(HOUR);
    const client = await mcpClient(t.mcpBaseUrl, review.id);
    if (review.id === reviews.at(-1).id) {
      await client.callTool({
        name: "decompose",
        arguments: {
          reason: "repair the finding",
          children: [{ title: "repair", purpose: "p", completion_criteria: "c" }],
        },
      });
      await client.close();
      const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
        (x: any) => x.title === "repair",
      );
      await t.clock.advance(HOUR);
      await completeVia(t, repair.id);
      expect(await accepted()).toBe(false);
      await t.clock.advance(HOUR);
    }
    const completionClient = await mcpClient(t.mcpBaseUrl, review.id);
    const result: any = await completionClient.callTool({
      name: "complete_task",
      arguments: {},
    });
    expect(result.isError ?? false).toBe(false);
    await completionClient.close();
    await client.close();
    expect(await accepted()).toBe(review.id === reviews.at(-1).id);
  }
});

it("review の公開注入 context は対象 worker のモデル・価格・実行設定を含まない", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "subject",
      purpose: "p",
      completion_criteria: "c",
      tier: "frontier",
    })
  ).json;
  await t.clock.advance(HOUR);
  const spawned = appendEvent(t.db, {
    taskId: task.id,
    workerId: "reef-crab",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_spawned",
      registry_commit: "commit",
      definition_version: "1",
      advisor: null,
      provider: "anthropic",
      model: "subject-model-secret",
      effort: "high",
      source: { tier: "task", provider: "only" },
      harness: "claude-code",
      cli_version: "1",
    },
  });
  await completeVia(t, task.id);
  appendEvent(t.db, {
    taskId: task.id,
    workerId: "reef-crab",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      stderr_tail: null,
      worker_spawned_event_id: spawned,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_cost_usd: 12.345,
        advisor: null,
      },
    },
  });
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "review",
  );
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const response: any = await client.callTool({
    name: "get_current_task",
    arguments: {},
  });
  await client.close();
  expect(response.isError ?? false).toBe(false);
  const context = JSON.parse(response.content[0].text);
  expect(context.parent).toMatchObject({
    title: "subject",
    completion_criteria: "c",
  });
  expect(JSON.stringify(context)).not.toMatch(
    /subject-model-secret|12\.345|"(?:model|provider|effort|tier|review_tier|source|price|estimated_cost_usd)":/,
  );
});

it("review type への review_flag は登録時に拒否する", async () => {
  t = await bootTidepool();
  const response = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "review",
    title: "audit",
    purpose: "p",
    completion_criteria: "c",
    review_flag: true,
  });
  expect(response.status).toBe(400);
  expect(response.json.error).toMatch(/review/);
});

it("review task の編集でも review_flag を付けられない", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "audit",
      purpose: "p",
      completion_criteria: "c",
    })
  ).json;
  expect(
    (await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_flag: true })).status,
  ).toBe(400);
});

it("review_by の指名は assignable_to で検査され、承認後も指名と tier を保持する(ADR 0031)", async () => {
  t = await bootTidepool({
    authority: { name: "limited", guidance: "", assignable_to: ["reef-crab"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const response: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "independent specialist",
      children: [
        {
          title: "child",
          purpose: "p",
          completion_criteria: "c",
          review_flag: true,
          review_by: ["security"],
          review_tier: "frontier",
        },
      ],
    },
  });
  expect(response.isError ?? false).toBe(false);
  await client.close();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "child")).toBeUndefined();
  const question = board.find((x: any) => x.type === "question");
  expect(question?.purpose).toContain("security");
  expect(
    (
      await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
        answers: ["approve"],
      })
    ).status,
  ).toBe(200);
  expect(
    (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.title === "child"),
  ).toMatchObject({
    review_by: ["security"],
    review_tier: "frontier",
    review_flag: 1,
  });
});

it("登録時に存在しない reviewer の指名は拒否する", async () => {
  t = await bootTidepool({ agentRegistered: (name) => name === "known" });
  expect(
    (
      await api(t.baseUrl, "POST", "/api/tasks", {
        type: "work",
        title: "subject",
        purpose: "p",
        completion_criteria: "c",
        review_by: ["missing"],
      })
    ).status,
  ).toBe(400);
});

it.each([
  {
    reviewTier: "frontier",
    agentTier: "economy",
    model: "fable",
    source: "review_tier",
  },
  {
    reviewTier: undefined,
    agentTier: "standard",
    model: "opus",
    source: "agent",
  },
  {
    reviewTier: undefined,
    agentTier: undefined,
    model: "sonnet",
    source: "board",
  },
])(
  "review 設定は review_tier > agent tier > board ($source)",
  async ({ reviewTier, agentTier, model, source }) => {
    const workspace = await makeWorkspace(dirs, "integration-review-tier");
    const registryDir = await makeRegistry({
      "agents/tako.md": `---\nname: tako\ndescription: Reviewer\nversion: 1.0.0\nauthority: standard\nprovider: anthropic\n${agentTier ? `tier: ${agentTier}\n` : ""}skills: ["*"]\n---\nReview carefully.\n`,
      "workspaces.yaml": `tidepool:\n  path: ${workspace.path}\n`,
    });
    const logDir = await mkdtemp(join(tmpdir(), "review-tier-logs-"));
    dirs.push(registryDir, logDir);
    t = await bootTidepool({
      containerRuntime: new FakeContainerRuntime(() => ({
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {},
        on() {},
      })),
      workerAdapter: ({ db, containers }) => {
        const worker = new ClaudeCodeWorker({
          db,
          containers,
          clock: new FakeClock(),
          registry: { dir: registryDir, mode: "purely-local" },
          agent: "tako",
          workspace: "tidepool",
          mcpUrl: "http://127.0.0.1:1/mcp",
          logDir,
        });
        return {
          id: worker.id,
          start: (task) => worker.start(task),
          gracefulStop: (id) => worker.gracefulStop(id),
          checkUsage: async () => healthyUsageText(t.clock.now()),
        };
      },
    });
    const task = (
      await api(t.baseUrl, "POST", "/api/tasks", {
        type: "review",
        title: "audit",
        purpose: "p",
        completion_criteria: "c",
        assignee: "tako",
        review_tier: reviewTier,
        tier: "frontier",
      })
    ).json;
    await t.clock.advance(HOUR);
    const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
    expect(events.find((e: any) => e.kind === "worker_spawned")?.payload).toMatchObject({
      model,
      effort: "high",
      provider: "anthropic",
      source: { tier: source, provider: "only" },
    });
  },
);

it("decompose の子に review_flag: true を宣言すると、そのまま work タスクとして登録され承認 question に変換されない(ADR 0021, 検査ゼロ)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "child work benefits from an independent review",
      children: [
        {
          title: "wire the moisture sensor",
          purpose: "get readings flowing",
          completion_criteria: "dashboard shows a live number",
          review_flag: true,
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // registered directly as a work task, not converted into an approval question
  const child = board.find((x: any) => x.title === "wire the moisture sensor");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.review_flag).toBe(1);
  expect(
    board.find((x: any) => x.type === "question" && x.parent_id === parent.id),
  ).toBeUndefined();
});

it("decompose で review_flag: true 登録された子の完了時に、既存の layer 1 機構が review 子タスクを自動生成する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "child work benefits from an independent review",
      children: [
        {
          title: "wire the moisture sensor",
          purpose: "get readings flowing",
          completion_criteria: "dashboard shows a live number",
          review_flag: true,
          assignee: "reef-crab",
          review_by: ["security", "standards"],
          review_tier: "frontier",
        },
      ],
    },
  });
  await client.close();

  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.title === "wire the moisture sensor",
  );
  await t.clock.advance(HOUR); // child picked up into the slot
  await completeVia(t, child.id);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const review = board.find((x: any) => x.type === "review" && x.parent_id === child.id);
  expect(review).toBeDefined();
  expect(board.filter((x: any) => x.type === "review" && x.parent_id === child.id)).toMatchObject([
    { assignee: "security", review_tier: "frontier" },
    { assignee: "standards", review_tier: "frontier" },
  ]);
});

it("risk_flag の親超えで承認 question に変換された review_flag: true の子は、承認による具現化でも flag を保持する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "one child touches production data and needs sign-off, and should be reviewed",
      children: [
        {
          title: "migrate the prod table",
          purpose: "backfill the new column",
          completion_criteria: "backfill script has run against prod",
          risk_flag: true,
          review_flag: true,
          review_by: ["security"],
          review_tier: "standard",
        },
      ],
    },
  });
  await client.close();

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // converted to an approval question, not registered directly (risk beyond parent)
  expect(board1.find((x: any) => x.title === "migrate the prod table")).toBeUndefined();
  const question = board1.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["approve"],
  });

  const board2 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board2.find((x: any) => x.title === "migrate the prod table");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.review_flag).toBe(1);
  expect(child.review_by).toEqual(["security"]);
  expect(child.review_tier).toBe("standard");
});
