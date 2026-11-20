import { describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  cancelTaskDirectly,
  countUnsettledTasksReferencing,
  derivedWorkspace,
  nextSlotTask,
  pickupTask,
  presentTask,
  type RegisterTaskInput,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

// ADR 0372 決定1: 空の列は type を問わず「列が埋まっている最も近い祖先 → 無ければ既定」と読む
const at = new Date(0);
const register = (db: Db, input: Partial<RegisterTaskInput> & Pick<RegisterTaskInput, "type">): Task =>
  registerTask(db, { title: "t", purpose: "p", completion_criteria: "c", ...input }, at, ...HUMAN_WEBUI);
/** 列を明示した親と、その下で列が空のまま登録される修理子(異議由来の修理子は異議を受けた task の空の列を写す —— triage の `objected.workspace`)。 */
const repairUnderReef = (db: Db) => {
  const parent = register(db, { type: "work", workspace: "reef" });
  return { parent, child: register(db, { type: "memory_repair", parent_id: parent.id }) };
};

describe("review でない子も列が埋まっている最も近い祖先の workspace に導かれる(ADR 0372 決定1)", () => {
  it("derivedWorkspace は列が空の修理子に祖先の名前を返す", () => {
    const db = openDb(":memory:");
    const { child } = repairUnderReef(db);

    expect(child.workspace).toBeNull();
    expect(derivedWorkspace(db, child)).toBe("reef");
  });

  it("盤面の場所の選択: 祖先の workspace の停止で候補から外れ、pickup は既定でなく祖先の名前を書く", () => {
    const db = openDb(":memory:");
    const { child } = repairUnderReef(db);

    expect(nextSlotTask(db, "sandbox", "deckhand", undefined, { workspaces: ["reef"], assignees: [] })).toBeUndefined();
    expect(pickupTask(db, child, "deckhand", at, { workspace: "sandbox" })?.workspace).toBe("reef");
  });

  it("人間面の表示は祖先の名前を見せる", () => {
    const db = openDb(":memory:");
    const { child } = repairUnderReef(db);

    expect(presentTask(db, child).workspace).toBe("reef");
  });

  it("直接 cancel の quarantine の門は、子が導出で着く workspace の quarantine で止まる", () => {
    const db = openDb(":memory:");
    const { child } = repairUnderReef(db);
    const cancel = () =>
      cancelTaskDirectly(db, child, null, at, { defaultWorkspaceName: "sandbox", quarantined: { workspaces: ["reef"], assignees: [] } }, "webui");

    expect(cancel).toThrow(/quarantine/);
  });

  it("削除の扉は、導出で workspace に着く子も参照に数える(ADR 0234 決定1 / ADR 0290 決定5)", () => {
    const db = openDb(":memory:");
    repairUnderReef(db);

    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(2);
  });
});
