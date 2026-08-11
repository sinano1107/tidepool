import { api, HOUR, mcpClient, registerQuestion, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("root question(親なし)のカードが盤面のマークとラベル tidepool を描く(issue #220 / #261)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const question = registerQuestion(t, {
    title: "PR promotion failed",
    purpose: "creating a PR for the completed task failed",
    completion_criteria: "a human decides whether to retry PR promotion",
    question: [{ title: "PR promotion failed", options: ["retry", "abandon"], recommendation: "retry" }],
  });

  await page.goto(t.baseUrl);

  const header = page.getByText(question.id).locator("..");
  await expect(header).toContainText("tidepool");
  await expect(header).not.toContainText("—");
  await expect(header.locator("svg").first()).toBeVisible();
});

test("human 名義の decision log エントリが🧍と\"you\"で描かれる、イニシャル h にならない(issue #261)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "issue-261 の human ログを作る", undefined, false, "human");
  await api(t.baseUrl, "POST", `/api/tasks/${work.id}/complete`, {
    handoff: { outcome: "issue-261-human-log-outcome" },
  });
  const agentWork = await registerWork(t, "human ログを既読 fold に残す");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, agentWork.id);
  await client.callTool({ name: "log_decision", arguments: { line: "agent unread seed" } });
  await client.close();

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "1 more read decision — show" }).click();

  const entry = page.locator(".tp-log-entry", { hasText: "issue-261-human-log-outcome" });
  await expect(entry).toContainText("🧍");
  await expect(entry.locator("[title]").first()).toHaveAttribute("title", "you");
});
