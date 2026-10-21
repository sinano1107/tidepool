import { describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { cancelTaskDirectly, completeTask, editTask, logDecision, pickupTask, presentTask, type RegisterTaskInput, registerTask, returnToQueue, type Task } from "../src/tasks.js";
import { listLog } from "../src/triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
import { HUMAN_WEBUI, markPickedUp } from "./harness.js";

// ADR 0290: 付帯子の review は自分の workspace を持たず、列が非 NULL の最も近い祖先に従う(無ければ既定)
const at = new Date(0);
const register = (db: Db, input: Partial<RegisterTaskInput> & Pick<RegisterTaskInput, "type">): Task =>
  registerTask(db, { title: "t", purpose: "p", completion_criteria: "c", ...input }, at, ...HUMAN_WEBUI);
/** 一度 pickup された形の親 —— 人間名義の review 子が付ける(ADR 0292 決定2)。 */
const ran = (db: Db, task: Task): Task => {
  markPickedUp(db, task.id, at);
  return task;
};

describe("付帯子の review の登録(ADR 0290 決定1・2)", () => {
  it("workspace を指定しない付帯子の review も、祖先と同じ名前を明示した付帯子の review も、列は NULL で保存される", () => {
    const db = openDb(":memory:");
    const parent = ran(db, register(db, { type: "work", workspace: "reef" }));

    expect(register(db, { type: "review", parent_id: parent.id }).workspace).toBeNull();
    expect(register(db, { type: "review", parent_id: parent.id, workspace: "reef" }).workspace).toBeNull();
  });

  it("祖先と違う名前の明示は拒まれ、文はルート review を案内する", () => {
    const db = openDb(":memory:");
    const parent = ran(db, register(db, { type: "work", workspace: "reef" }));

    expect(() => register(db, { type: "review", parent_id: parent.id, workspace: "lagoon" })).toThrow(/root review/);
  });

  it("固定済みの祖先が無いときは、どの名前の明示も拒まれる", () => {
    const db = openDb(":memory:");
    const parent = ran(db, register(db, { type: "work" }));

    expect(() => register(db, { type: "review", parent_id: parent.id, workspace: "reef" })).toThrow(DomainError);
  });

  it("列が NULL の分解子を越えて最も近い固定済みの祖先と比べる", () => {
    const db = openDb(":memory:");
    const root = register(db, { type: "work", workspace: "reef" });
    const child = ran(db, register(db, { type: "work", parent_id: root.id }));

    expect(() => register(db, { type: "review", parent_id: child.id, workspace: "lagoon" })).toThrow(DomainError);
    expect(register(db, { type: "review", parent_id: child.id, workspace: "reef" }).workspace).toBeNull();
  });
});

describe("Executor の引けない親への review 子の登録(ADR 0292 決定2)", () => {
  it("完了も pickup も無い親の下の人間名義の review は、assignee の列に値があっても拒まれる", () => {
    const db = openDb(":memory:");
    const parent = register(db, { type: "work", assignee: "deckhand" });

    expect(() => register(db, { type: "review", parent_id: parent.id })).toThrow(DomainError);
  });

  it("盤面名義の review(異議由来の auditor RCA など)は、完了も pickup も無い親の下にも登録できる", () => {
    const db = openDb(":memory:");
    const parent = register(db, { type: "work", assignee: "deckhand" });

    expect(registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_WORKER_ID, "board").parent_id).toBe(parent.id);
  });

  it("pickup 済み(in_progress・todo に戻った)の親と、人間が pickup 無しで完了した親には登録できる", () => {
    const db = openDb(":memory:");
    const running = pickupTask(db, register(db, { type: "work", assignee: "deckhand" }), "deckhand", at)!;
    const returned = pickupTask(db, register(db, { type: "work", assignee: "deckhand" }), "deckhand", at)!;
    returnToQueue(db, returned, { kind: "cap_interrupted" }, at);
    const human = register(db, { type: "work", assignee: HUMAN_WORKER_ID });
    completeTask(db, human, undefined, HUMAN_WORKER_ID, at, "webui");

    for (const parent of [running, returned, human]) {
      expect(register(db, { type: "review", parent_id: parent.id }).parent_id).toBe(parent.id);
    }
  });
});

describe("付帯子の review の pickup の埋め(ADR 0290 決定4)", () => {
  const pickedUp = (db: Db, task: Task) => {
    const picked = pickupTask(db, task, "fugu", at, { workspace: "default-ws" })!;
    return { workspace: picked.workspace, payload: listEvents(db, task.id).find((e) => e.kind === "task_picked_up")?.payload };
  };

  it("列が NULL の分解子を越えて最も近い固定済みの祖先の名前を書き、event に祖先からと記録する", () => {
    const db = openDb(":memory:");
    const root = ran(db, register(db, { type: "work", workspace: "reef" }));
    const direct = register(db, { type: "review", parent_id: root.id });
    const child = ran(db, register(db, { type: "work", parent_id: root.id }));
    const nested = register(db, { type: "review", parent_id: child.id });

    for (const review of [direct, nested]) {
      expect(pickedUp(db, review)).toEqual({ workspace: "reef", payload: { kind: "task_picked_up", workspace_from_ancestor: "reef" } });
    }
  });

  it("固定済みの祖先が無ければ既定の名前を書き、event に既定からと記録する", () => {
    const db = openDb(":memory:");
    const parent = ran(db, register(db, { type: "work" }));
    const review = register(db, { type: "review", parent_id: parent.id });

    expect(pickedUp(db, review)).toEqual({ workspace: "default-ws", payload: { kind: "task_picked_up", resolved_from_default: { workspace: "default-ws" } } });
  });
});

describe("pickup 前の読み手は導出した workspace で読む(ADR 0290 決定5)", () => {
  it("直接 cancel の quarantine の門は、付帯子の review が導出で着く workspace の quarantine で止まる", () => {
    const db = openDb(":memory:");
    const root = register(db, { type: "work", workspace: "reef" });
    const child = ran(db, register(db, { type: "work", parent_id: root.id }));
    register(db, { type: "review", parent_id: child.id });
    const cancel = () =>
      cancelTaskDirectly(db, child, null, at, { defaultWorkspaceName: "sandbox", quarantined: { workspaces: ["reef"], assignees: [] } }, "webui");

    expect(cancel).toThrow(/quarantine/);
  });

  it("人間面の表示は、付帯子の review に導出した名前を見せ、既定に落ちる付帯子の review は空のまま見せる", () => {
    const db = openDb(":memory:");
    const fixed = ran(db, register(db, { type: "work", workspace: "reef" }));
    const unfixed = ran(db, register(db, { type: "work" }));

    expect(presentTask(db, register(db, { type: "review", parent_id: fixed.id })).workspace).toBe("reef");
    expect(presentTask(db, register(db, { type: "review", parent_id: unfixed.id })).workspace).toBeNull();
  });

  it("判断ログの一覧は、付帯子の review の行に導出した名前を見せる", () => {
    const db = openDb(":memory:");
    const parent = ran(db, register(db, { type: "work", workspace: "reef" }));
    const review = register(db, { type: "review", parent_id: parent.id });
    const entry = logDecision(db, review, "looked", "fugu", at, "worker");

    expect(listLog(db, "sandbox").find((e) => e.id === entry)?.workspace).toBe("reef");
  });
});

describe("付帯子の review の Edit(ADR 0290 決定3)", () => {
  it("付帯子の review の workspace は、祖先と同じ名前でも空でも変えられず、ルート review の workspace は今どおり変えられる", () => {
    const db = openDb(":memory:");
    const parent = ran(db, register(db, { type: "work", workspace: "reef" }));
    const child = register(db, { type: "review", parent_id: parent.id });
    const root = register(db, { type: "review", workspace: "reef" });

    for (const workspace of ["reef", ""]) expect(() => editTask(db, child, { workspace }, at, "webui")).toThrow(DomainError);
    expect(editTask(db, root, { workspace: "lagoon" }, at, "webui").workspace).toBe("lagoon");
  });
});
