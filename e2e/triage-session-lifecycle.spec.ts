import { TRIAGE_TIMEOUT } from "../src/triage.js";
import {
  api,
  HOUR,
  mcpClient,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

async function completeAgentWork(t: Tidepool, title: string) {
  const task = await registerWork(t, title);
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "complete_task",
    arguments: {
      handoff: {
        outcome: "criteria met",
        deliverables: "the result",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
    },
  });
  await client.close();
  return task;
}

test("未読のある Triage を描画しても pickup は止まらない(issue #225)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const skimmed = await completeAgentWork(t, "skimmed agent work");
  await registerWork(t, "still pickable after a skim");
  const startsBeforeSkim = t.worker.started.length;

  await page.goto(t.baseUrl);
  await expect(page.getByText("1 decisions made overnight.")).toBeVisible();
  await expect
    .poll(async () => {
      const events = (await api(t.baseUrl, "GET", `/api/tasks/${skimmed.id}/events`)).json;
      return events.some((event: { kind: string }) => event.kind === "log_entry_displayed");
    })
    .toBe(true);

  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
  await t.clock.advance(HOUR);
  expect(t.worker.started.slice(startsBeforeSkim).map((task) => task.title)).toEqual([
    "still pickable after a skim",
  ]);
});

test("流し読みだけの Triage も queue を確認して commit でき、既読カーソルが進む(#279)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await completeAgentWork(t, "skim this completion");
  await registerWork(t, "live queue row");

  await page.goto(t.baseUrl);
  await expect(page.getByText("1 decisions made overnight.")).toBeVisible();
  const before = (await api(t.baseUrl, "GET", "/api/log")).json;

  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await expect(page.getByText("live queue row")).toBeVisible();
  await page.getByRole("button", { name: "Wrap up" }).click();
  await page.getByRole("button", { name: "Commit" }).click();

  await expect(page.getByText("triage committed — no session was open")).toBeVisible();
  await expect
    .poll(async () => (await api(t.baseUrl, "GET", "/api/log")).json.cursor)
    .toBe(before.entries.at(-1).id);
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
});

test("持ち越した scratchpad 行はセッションがなくても 5/5 のコミット画面に現れる(#279)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: "持ち越した苛立ち" });

  await page.goto(t.baseUrl);
  await expect(page.getByText("0 decisions made overnight.")).toBeVisible();
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await page.getByRole("button", { name: "Wrap up" }).click();

  await expect(page.getByText("scratchpad — triage before commit")).toBeVisible();
  await expect(page.getByText("持ち越した苛立ち")).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
});

test("タイムアウト済みの Triage は閉じた時刻と適用済みの操舵を伝える(#279)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await completeAgentWork(t, "timeout 前に表示したログ");
  registerQuestion(t, {
    title: "timeout question",
    purpose: "open a triage session",
    completion_criteria: "the answer is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: /^left/ }).click();
  await expect
    .poll(async () => (await api(t.baseUrl, "GET", "/api/triage")).json.session)
    .not.toBe(null);

  // Refresh once while the session is live so the banner and frozen log
  // snapshot are both present before the timeout races the stale screen.
  await page.getByRole("button", { name: "queue", exact: true }).click();
  await expect(page.getByRole("button", { name: "close triage session" })).toBeVisible();
  await page.getByRole("button", { name: /^triage/ }).click();
  const frozenLastLogId = (await api(t.baseUrl, "GET", "/api/log")).json.entries.at(-1).id;

  await t.clock.advance(TRIAGE_TIMEOUT);
  await completeAgentWork(t, "timeout 後に届いた未表示ログ");

  // The still-rendered banner only closes a live session. It must neither
  // consume the timeout notice nor replace this Triage's frozen log snapshot.
  await page.getByRole("button", { name: "close triage session" }).click();
  await expect(page.getByText("triage session was already closed")).toBeVisible();

  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await page.getByRole("button", { name: "Wrap up" }).click();
  await page.getByRole("button", { name: "Commit" }).click();

  await expect(page.getByText("triage committed — session already timed out")).toBeVisible();
  await expect(
    page.getByText(/session closed at \d{2}:\d{2}; staged steering was already applied/),
  ).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/log")).json.cursor).toBe(frozenLastLogId);
});

test("開いているセッションを Triage の Commit が今閉じたと伝える(#279)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  registerQuestion(t, {
    title: "commit question",
    purpose: "open a triage session",
    completion_criteria: "the answer is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: /^left/ }).click();
  await page.getByRole("button", { name: "Log skim" }).click();
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await page.getByRole("button", { name: "Wrap up" }).click();
  await page.getByRole("button", { name: "Commit" }).click();

  await expect(page.getByText("triage committed — session closed")).toBeVisible();
  await expect(page.getByText(/immediate poll fired/)).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
});

test("本物の commit 失敗では既読カーソルを進めない(#279)", async ({ boot, page }) => {
  const t = await boot();
  await completeAgentWork(t, "failed commit stays unread");

  await page.goto(t.baseUrl);
  const cursorBefore = (await api(t.baseUrl, "GET", "/api/log")).json.cursor;
  const frozenLastLogId = (await api(t.baseUrl, "GET", "/api/log")).json.entries.at(-1).id;
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await completeAgentWork(t, "失敗後の再試行で未表示のまま残すログ");
  await page.route("**/api/triage/close", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "injected server failure" }),
    }),
  );

  await page.getByRole("button", { name: "Wrap up" }).click();
  await page.getByRole("button", { name: "Commit" }).click();

  await expect(
    page.getByText("triage commit failed — nothing applied, cursor NOT advanced"),
  ).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/log")).json.cursor).toBe(cursorBefore);

  await page.unroute("**/api/triage/close");
  await page.getByRole("button", { name: "Commit" }).click();
  await expect(page.getByText("triage committed — no session was open")).toBeVisible();
  await expect
    .poll(async () => (await api(t.baseUrl, "GET", "/api/log")).json.cursor)
    .toBe(frozenLastLogId);
});

test("agent の未読より新しい human エントリも既読 fold に残る(#279)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await completeAgentWork(t, "agent entry stays unread");
  const humanTask = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "human entry stays read",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;
  await api(t.baseUrl, "POST", `/api/tasks/${humanTask.id}/complete`, {
    handoff: { outcome: "human already knows this" },
  });

  await page.goto(t.baseUrl);

  await expect(page.getByText("criteria met")).toBeVisible();
  await expect(page.getByText("human already knows this")).not.toBeVisible();
  await page.getByRole("button", { name: "1 more read decision — show" }).click();
  await expect(page.getByText("human already knows this")).toBeVisible();
});

test("Triage の最初の回答でセッションが開き pickup が止まる(issue #225)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "blocked once steering starts");
  const question = registerQuestion(t, {
    title: "which way?",
    purpose: "choose a direction",
    completion_criteria: "the choice is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  const answer = page.getByRole("button", { name: /^left/ });
  await answer.click();
  await expect
    .poll(async () => (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status)
    .toBe("done");

  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  await page.getByRole("button", { name: "queue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  await api(t.baseUrl, "POST", `/api/tasks/${work.id}/move`, { after: null });
  expect(t.worker.started).toEqual([]);
});

test("開いている triage session 中に queue の ↑ を押すと、停止理由と解除口が全タブで見える(#225 / ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await completeAgentWork(t, "unread agent completion");
  await registerWork(t, "blocked by the active triage");
  await api(t.baseUrl, "POST", "/api/triage/start");
  const cursorBeforeClose = (await api(t.baseUrl, "GET", "/api/log")).json.cursor;

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "queue", exact: true }).click();
  await expect(page.getByText("triage in progress · nothing starts")).toBeVisible();
  await page.getByRole("button", { name: "↑", exact: true }).click();

  await expect(page.getByText("moved to front — pickup blocked")).toBeVisible();
  await expect(page.getByText("triage in progress — close the session to resume")).toBeVisible();
  await expect(page.getByText("triage in progress — pickup is stopped")).toBeVisible();
  await page.getByRole("button", { name: "Board" }).click();
  await expect(page.getByText("triage in progress — pickup is stopped")).toBeVisible();
  await page.getByRole("button", { name: "close triage session" }).click();
  await expect(page.getByText("triage in progress — pickup is stopped")).not.toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/log")).json.cursor).toBe(cursorBeforeClose);
});

test("回答が唯一の項目だった triage も再読み込み後に Commit へ到達できる(#417)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "unblocked by the answer");
  registerQuestion(t, {
    title: "which way?",
    purpose: "choose a direction",
    completion_criteria: "the choice is recorded",
    parent_id: work.id,
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: /^left/ }).click();
  await expect
    .poll(async () => (await api(t.baseUrl, "GET", "/api/triage")).json.session)
    .not.toBe(null);

  await page.reload();
  await expect(page.getByText("Low tide. Go enjoy your coffee.")).not.toBeVisible();
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await page.getByRole("button", { name: "Wrap up" }).click();
  await page.getByRole("button", { name: "Commit" }).click();

  await expect(page.getByText("triage committed — session closed")).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
});
