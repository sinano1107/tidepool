import { describe, expect, it } from "vitest";
import {
  agentNeedsHuman,
  quarantineAgent,
  type ResolvedAgent,
  resolveAgentOrQuarantine,
  verifyAgentRepaired,
} from "../src/agent.js";
import { type Db, openDb } from "../src/db.js";
import { InvalidAgentDefinitionError, UnknownAgentError } from "../src/registry.js";
import { cancelTaskDirectly, completeTask, editTask, listBoard, pickupTask, registerTask, type TaskType } from "../src/tasks.js";
import { FULL_HANDOFF, HUMAN_WEBUI, quarantineQuestion, queuedForAutoMerge } from "./harness.js";

describe("quarantineAgent(ADR 0012 / issue #36: workspace 版の agent 名一般化)", () => {
  it("agent 名を needs-human にマークし、1択の Confirmation question を登録する", () => {
    const db = openDb(":memory:");
    quarantineAgent(db, "navigator", new Error("unknown agent: navigator"), new Date(0));

    expect(agentNeedsHuman(db, "navigator")).toBe(true);
    const question = quarantineQuestion(db, "agent", "navigator");
    expect(question?.question_items?.[0]?.options).toEqual(["repaired by hand"]);
    expect(question?.question_items?.[0]?.recommendation).toBe("repaired by hand");
  });

  it("同一 agent 名への2度目の quarantine は question を増やさず、既存 question に再発火の cause イベントを追記する", () => {
    const db = openDb(":memory:");
    quarantineAgent(db, "navigator", new Error("first failure"), new Date(0));
    quarantineAgent(db, "navigator", new Error("second, unrelated failure"), new Date(1));

    const questions = listBoard(db).filter((t) => t.type === "question");
    expect(questions).toHaveLength(1);
    expect(agentNeedsHuman(db, "navigator")).toBe(true);
  });
});

describe("resolveAgentOrQuarantine", () => {
  it("resolve が解決できるときはその ResolvedAgent をそのまま返し、quarantine は起きない", () => {
    const db = openDb(":memory:");
    const resolved: ResolvedAgent = {
      name: "deckhand",
      definition: {
        name: "deckhand",
        version: "0.0.1",
        authority: "standard",
        description: "d",
        provider: [{ name: "anthropic", advisor: false }],
        retiredFields: [],
        skills: ["*"],
        systemPrompt: "x",
      },
      profile: { name: "standard", guidance: "g" },
    };
    const result = resolveAgentOrQuarantine(db, () => resolved, "deckhand", new Date(0));
    expect(result).toEqual(resolved);
    expect(listBoard(db)).toEqual([]);
  });

  it("resolve が UnknownAgentError を投げるときは、その名前を quarantine して undefined を返す", () => {
    const db = openDb(":memory:");
    const resolve = () => {
      throw new UnknownAgentError("ghost");
    };
    const result = resolveAgentOrQuarantine(db, resolve, "ghost", new Date(0));
    expect(result).toBeUndefined();
    expect(agentNeedsHuman(db, "ghost")).toBe(true);
  });

  it("resolve が InvalidAgentDefinitionError を投げるときも同じ agent 名 quarantine に乗る(ADR 0097 決定3 — 新しい quarantine 種別は作らない)", () => {
    const db = openDb(":memory:");
    const resolve = () => {
      throw new InvalidAgentDefinitionError(
        "deckhand",
        'provider "moonshot" does not offer an advisor — a definition declaring one does not stand (ADR 0097 決定3)',
      );
    };
    const result = resolveAgentOrQuarantine(db, resolve, "deckhand", new Date(0));
    expect(result).toBeUndefined();
    expect(agentNeedsHuman(db, "deckhand")).toBe(true);
    const question = quarantineQuestion(db, "agent", "deckhand");
    expect(question?.purpose).toContain("moonshot");
  });
});

const NOW = new Date("2026-10-09T00:00:00.000Z");

function register(db: Db, type: TaskType, assignee: string | undefined, parentId?: string) {
  return registerTask(
    db,
    {
      type,
      title: "pending",
      purpose: "p",
      completion_criteria: "c",
      assignee,
      parent_id: parentId,
      ...(type === "question" && {
        question: [{ title: "q", options: ["a", "b"], recommendation: "a" }],
      }),
    },
    NOW,
    ...HUMAN_WEBUI,
  );
}

// 解除の規則(ADR 0012 / 0217 決定4 / 0224 決定4)はここで1度だけ、message 込みで述べる(ADR 0107)。
describe("verifyAgentRepaired", () => {
  it.each([
    ["work", undefined, "tako", "tako", "shako", true],
    ["review", undefined, "shako", "tako", "shako", true],
    ["work", undefined, "shako", "tako", "shako", false],
    ["review", undefined, "tako", "tako", "shako", false],
    ["question", undefined, "tako", "tako", "shako", false],
    ["question", "tako", "tako", "tako", "shako", false],
    ["work", undefined, "tako", undefined, undefined, false],
    ["review", undefined, "shako", undefined, undefined, false],
    ["work", "tako", "tako", undefined, undefined, true],
    ["review", "shako", "shako", undefined, undefined, true],
    ["work", "specialist", "tako", "tako", "shako", false],
  ] as const)("todo %s (assignee=%s) の %s への依存を型ごとのポインタ(%s / %s)で検査する", (type, assignee, name, defaultAgentName, auditorName, dependent) => {
    const db = openDb(":memory:");
    try {
      register(db, type, assignee);
      const verify = () => verifyAgentRepaired(db, name, false, defaultAgentName, auditorName);
      if (dependent) expect(verify).toThrow(/still has unsettled tasks/);
      else expect(verify).not.toThrow();
      expect(() => verifyAgentRepaired(db, name, true, defaultAgentName, auditorName)).not.toThrow();
    } finally {
      db.close();
    }
  });

  // ADR 0228 決定4: 組み込みは review を走らせられるので、名前が組み込みに解決される間(registry に組み込みで
  // ないエントリが無い)は review を依存に数えない —— 数えると work の付け替えで解除が永久に通らない
  it("名前が組み込みに解決される間は、work が残る限り解除できず、work を付け替えれば組み込み宛ての review が残っていても解除できる", () => {
    const db = openDb(":memory:");
    const work = register(db, "work", "fugu");
    register(db, "review", "fugu");
    register(db, "review", undefined);
    const verify = () => verifyAgentRepaired(db, "fugu", false, "tako", "fugu");

    expect(verify).toThrow("agent fugu is not back in the registry and still has unsettled tasks assigned");
    editTask(db, work, { assignee: "tako" }, NOW, "webui");
    expect(verify).not.toThrow();
  });

  it("registry に agent 名が復活していれば、未決着タスクや着地待ちが残っていても解除を認める", () => {
    const db = openDb(":memory:");
    register(db, "work", "navigator");
    queuedForAutoMerge(db, NOW, "navigator");
    expect(() => verifyAgentRepaired(db, "navigator", true)).not.toThrow();
  });

  it("registry に復活しておらず、その名前宛ての未決着タスクが残っていれば拒否する", () => {
    const db = openDb(":memory:");
    register(db, "work", "navigator");

    expect(() => verifyAgentRepaired(db, "navigator", false)).toThrow(
      "agent navigator is not back in the registry and still has unsettled tasks assigned",
    );
  });

  // 数えの規則は tests/landing.test.ts の countTasksAwaitingLanding が持つ。ここは「数えが正なら拒む」だけ。
  it("registry に復活しておらず、着地を待つ完了タスクが残っていれば拒否する", () => {
    const db = openDb(":memory:");
    queuedForAutoMerge(db, NOW, "navigator");

    expect(() => verifyAgentRepaired(db, "navigator", false)).toThrow(
      "agent navigator is not back in the registry and still has 1 completed task(s) awaiting landing on its profile",
    );
  });

  it("registry に復活しておらず、未決着タスクも着地待ちも無ければ解除を認める", () => {
    const db = openDb(":memory:");
    expect(() => verifyAgentRepaired(db, "navigator", false)).not.toThrow();
  });

  // ADR 0224 決定4: 実行中の worker が立てた quarantine は、その worker のタスクが決着するまで解除できない
  it("registry に復活しておらず、その名前宛ての実行中タスクが残っていれば拒否し、決着すれば認める", () => {
    const db = openDb(":memory:");
    const task = pickupTask(db, register(db, "work", "navigator"), "navigator", NOW)!;
    expect(() => verifyAgentRepaired(db, "navigator", false)).toThrow(/still has unsettled tasks/);

    completeTask(db, task, FULL_HANDOFF, "navigator", NOW, "worker");
    expect(() => verifyAgentRepaired(db, "navigator", false)).not.toThrow();
  });

  it("registry に復活しておらず、その名前宛ての blocked タスク(未決着の子を待つ)が残っていれば拒否し、決着すれば認める", () => {
    const db = openDb(":memory:");
    const parent = register(db, "work", "navigator");
    register(db, "work", "deckhand", parent.id);
    expect(() => verifyAgentRepaired(db, "navigator", false)).toThrow(/still has unsettled tasks/);

    cancelTaskDirectly(db, parent, null, NOW, {}, "webui");
    expect(() => verifyAgentRepaired(db, "navigator", false)).not.toThrow();
  });
});
