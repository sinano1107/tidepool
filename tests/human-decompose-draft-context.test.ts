import { afterEach, expect, it } from "vitest";
import { FakeDraftClient } from "./fakes.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("parent_id なしのドラフトには子の文脈が渡らない(ルート登録は今までどおり)", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "do the thing" });
  expect(res.status).toBe(200);
  expect(draftClient.contexts).toEqual([undefined]);
});

it("parent_id 付きのドラフトには親の title/purpose/completion_criteria・既存兄弟の title・分解理由が渡る", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });
  const parent = await registerWork(t, "build the toolchain");
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "existing sibling",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split off the existing sibling",
  });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "handle the edge case",
    parent_id: parent.id,
    decompose_reason: "splitting off the edge case first",
  });

  expect(res.status).toBe(200);
  expect(draftClient.contexts).toEqual([
    {
      parentTitle: "build the toolchain",
      parentPurpose: "purpose of build the toolchain",
      parentCompletionCriteria: "criteria of build the toolchain",
      siblingTitles: ["existing sibling"],
      decomposeReason: "splitting off the edge case first",
    },
  ]);
});

it("分解理由を書かないドラフト依頼は decomposeReason が undefined のまま渡る", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });
  const parent = await registerWork(t, "build the toolchain");

  await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "handle the edge case",
    parent_id: parent.id,
  });

  expect(draftClient.contexts[0]?.decomposeReason).toBeUndefined();
});

it("issue-backed な親への子ドラフトには「#N」プレースホルダーでなく live な issue 内容が渡る(issue-backed 親も特別扱いしない)", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient, workspace: { name: "tidepool", path: "/fake/path" } });
  t.github.scriptIssue(49, {
    title: "login screen bug",
    body: "steps to reproduce",
    comments: [],
  });
  const parent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      github_issue_number: 49,
      workspace: "tidepool",
    })
  ).json;
  expect(parent.title).toBe("#49"); // placeholder confirms it's genuinely issue-backed

  await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "fix the login bug",
    parent_id: parent.id,
  });

  expect(draftClient.contexts[0]?.parentTitle).toBe("login screen bug");
  expect(draftClient.contexts[0]?.parentPurpose).toBe("steps to reproduce");
});

it("存在しない parent_id へのドラフト依頼は 404", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "do the thing",
    parent_id: "no-such-task",
  });
  expect(res.status).toBe(404);
});
