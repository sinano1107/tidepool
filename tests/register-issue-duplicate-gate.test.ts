import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { cancelTaskDirectly, completeTask, listBoard, registerTask } from "../src/tasks.js";
import { FULL_HANDOFF, HUMAN_WEBUI } from "./harness.js";

const ref = { type: "work" as const, github_issue_number: 49, workspace: "tidepool" };

describe("登録ゲートの重複検査(issue #104): 未決着の同一参照は共存しない", () => {
  it("同じ workspace + issue 番号の未決着タスクがあるうちは登録を拒否し、既存タスクの id を伝える", () => {
    const db = openDb(":memory:");
    const first = registerTask(db, ref, new Date(0), ...HUMAN_WEBUI);

    expect(() => registerTask(db, ref, new Date(1), ...HUMAN_WEBUI)).toThrowError(first.id);
  });

  it("done で決着した参照は再登録を妨げない", () => {
    const db = openDb(":memory:");
    const first = registerTask(db, ref, new Date(0), ...HUMAN_WEBUI);
    completeTask(db, first, FULL_HANDOFF, "reef-crab", new Date(1), "worker");

    const again = registerTask(db, ref, new Date(2), ...HUMAN_WEBUI);
    expect(again.github_issue_number).toBe(49);
  });

  it("cancelled で決着した参照も再登録を妨げない — abandon 後の再挑戦は正当な再登録", () => {
    const db = openDb(":memory:");
    const first = registerTask(db, ref, new Date(0), ...HUMAN_WEBUI);
    cancelTaskDirectly(db, first, null, new Date(1), {}, "webui");

    const again = registerTask(db, ref, new Date(2), ...HUMAN_WEBUI);
    expect(again.github_issue_number).toBe(49);
  });

  it("判定はタスク自身の status — done の親に未決着のレビュー子が残っていても再登録を妨げない", () => {
    const db = openDb(":memory:");
    const first = registerTask(db, { ...ref, review_flag: true }, new Date(0), ...HUMAN_WEBUI);
    completeTask(db, first, FULL_HANDOFF, "reef-crab", new Date(1), "worker");
    // 完了時レビュー子が未決着に残り、ツリーとしては未決着のまま
    const review = listBoard(db).find((c) => c.type === "review" && c.parent_id === first.id);
    expect(review).toBeDefined();

    const again = registerTask(db, ref, new Date(2), ...HUMAN_WEBUI);
    expect(again.github_issue_number).toBe(49);
  });

  it("同一性は workspace 名 + issue 番号の組 — どちらかが違えば別参照として通る", () => {
    const db = openDb(":memory:");
    registerTask(db, ref, new Date(0), ...HUMAN_WEBUI);

    const otherIssue = registerTask(db, { ...ref, github_issue_number: 50 }, new Date(1), ...HUMAN_WEBUI);
    expect(otherIssue.github_issue_number).toBe(50);

    const otherWorkspace = registerTask(db, { ...ref, workspace: "reef" }, new Date(2), ...HUMAN_WEBUI);
    expect(otherWorkspace.workspace).toBe("reef");
  });
});
