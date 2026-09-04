import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelTaskDirectly, completeTask, listBoard, registerTask } from "../src/tasks.js";
import { FakeDraftClient } from "./fakes.js";
import { api, bootTidepool, FULL_HANDOFF, type Tidepool } from "./harness.js";

const ref = { type: "work" as const, github_issue_number: 49, workspace: "tidepool" };

describe("登録ゲートの重複検査(issue #104): 未決着の同一参照は共存しない", () => {
  let t: Tidepool;
  beforeEach(async () => {
    t = await bootTidepool();
  });
  afterEach(() => t.stop());

  it("同じ workspace + issue 番号の未決着タスクがあるうちは登録を拒否し、既存タスクの id を伝える", () => {
    const db = t.db;
    const first = registerTask(db, ref, new Date(0));

    expect(() => registerTask(db, ref, new Date(1))).toThrowError(first.id);
  });

  it("done で決着した参照は再登録を妨げない", () => {
    const db = t.db;
    const first = registerTask(db, ref, new Date(0));
    completeTask(db, first, FULL_HANDOFF, "reef-crab", new Date(1));

    const again = registerTask(db, ref, new Date(2));
    expect(again.github_issue_number).toBe(49);
  });

  it("cancelled で決着した参照も再登録を妨げない — abandon 後の再挑戦は正当な再登録", () => {
    const db = t.db;
    const first = registerTask(db, ref, new Date(0));
    cancelTaskDirectly(db, first, null, new Date(1), {});

    const again = registerTask(db, ref, new Date(2));
    expect(again.github_issue_number).toBe(49);
  });

  it("判定はタスク自身の status — done の親に未決着のレビュー子が残っていても再登録を妨げない", () => {
    const db = t.db;
    const first = registerTask(db, { ...ref, review_flag: true }, new Date(0));
    completeTask(db, first, FULL_HANDOFF, "reef-crab", new Date(1));
    // 完了時レビュー子が未決着に残り、ツリーとしては未決着のまま
    const review = listBoard(db).find((c) => c.type === "review" && c.parent_id === first.id);
    expect(review).toBeDefined();

    const again = registerTask(db, ref, new Date(2));
    expect(again.github_issue_number).toBe(49);
  });

  it("同一性は workspace 名 + issue 番号の組 — どちらかが違えば別参照として通る", () => {
    const db = t.db;
    registerTask(db, ref, new Date(0));

    const otherIssue = registerTask(db, { ...ref, github_issue_number: 50 }, new Date(1));
    expect(otherIssue.github_issue_number).toBe(50);

    const otherWorkspace = registerTask(db, { ...ref, workspace: "reef" }, new Date(2));
    expect(otherWorkspace.workspace).toBe("reef");
  });
});

describe("API ゲートの先行実行(issue #104)", () => {
  let t: Tidepool;
  afterEach(() => t?.stop());

  it("重複は GitHub fetch / LLM inspection より前に 400 で弾かれる", async () => {
    const draftClient = new FakeDraftClient();
    t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" }, draftClient });
    t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });
    draftClient.scriptInspection({ ok: true });

    const body = { type: "work", github_issue_number: 49, workspace: "tidepool" };
    const first = await api(t.baseUrl, "POST", "/api/tasks", body);
    expect(first.status).toBe(201);

    const duplicate = await api(t.baseUrl, "POST", "/api/tasks", body);
    expect(duplicate.status).toBe(400);
    expect(duplicate.json.error).toContain(first.json.id);
    // 先行実行の証明: 2度目の登録は LLM inspection まで到達していない
    expect(draftClient.inspected).toHaveLength(1);
  });
});
