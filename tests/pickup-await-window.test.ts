import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, makeWorkspace, queueWork, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// scheduler は head を選んでから issue 本文の取得を await する(issue #972)。その窓で人間の
// 扉が head を書き換えたら、scheduler は pickup を取りやめ、slot を空けたまま次の poll で選び直す
it.each([
  ["assignee を human に付け替えた", (id: string) => api(t.baseUrl, "PATCH", `/api/tasks/${id}`, { assignee: "human" })],
  ["直接 cancel した", (id: string) => api(t.baseUrl, "POST", `/api/tasks/${id}/cancel`, {})],
])("issue 本文の取得中に %s task は走らず、slot は次の task に空いたままになる(issue #972)", async (_, mutate) => {
  t = await bootTidepool({ workspace: await makeWorkspace(dirs, "tidepool") });
  const head = registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 49 }, t.clock.now());
  t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });
  let release!: () => void;
  t.github.scriptIssueGate(new Promise((r) => (release = r)));

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.github.issueFetches.length).toBe(1));
  // 保留するのは scheduler の取得だけ —— 扉の応答が issue を live 表示する取得は通す
  t.github.scriptIssueGate(null);
  expect((await mutate(head.id)).status).toBe(200);
  release();
  await new Promise((r) => setImmediate(r));

  expect(t.worker.started).toEqual([]);

  const next = queueWork(t, "next");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([next.id]);
});
