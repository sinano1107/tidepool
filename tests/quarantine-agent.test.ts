import { describe, expect, it } from "vitest";
import {
  agentNeedsHuman,
  quarantineAgent,
  type ResolvedAgent,
  resolveAgentOrQuarantine,
  verifyAgentRepaired,
} from "../src/agent.js";
import { openDb } from "../src/db.js";
import { InvalidAgentDefinitionError, UnknownAgentError } from "../src/registry.js";
import { listBoard } from "../src/tasks.js";
import { quarantineQuestion } from "./harness.js";

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

describe("verifyAgentRepaired", () => {
  it.each([
    ["work", null, "tako", "tako", "shako", true],
    ["review", null, "shako", "tako", "shako", true],
    ["work", null, "shako", "tako", "shako", false],
    ["review", null, "tako", "tako", "shako", false],
    ["question", null, "tako", "tako", "shako", false],
    ["question", "tako", "tako", "tako", "shako", false],
    ["work", null, "tako", undefined, undefined, false],
    ["review", null, "shako", undefined, undefined, false],
    ["work", "tako", "tako", undefined, undefined, true],
    ["review", "shako", "shako", undefined, undefined, true],
    ["work", "specialist", "tako", "tako", "shako", false],
  ] as const)("todo %s (assignee=%s) の %s への依存を型ごとのポインタ(%s / %s)で検査する", (type, assignee, name, defaultAgentName, auditorName, dependent) => {
    const db = openDb(":memory:");
    try {
      db.prepare(
        `INSERT INTO tasks (id, type, status, assignee, title, purpose, completion_criteria, sort_key, created_at)
         VALUES ('pending', ?, 'todo', ?, 'pending', 'p', 'c', 1, '2026-10-09T00:00:00.000Z')`,
      ).run(type, assignee);
      const verify = () => verifyAgentRepaired(db, name, false, defaultAgentName, auditorName);
      if (dependent) expect(verify).toThrow(/still has pending tasks/);
      else expect(verify).not.toThrow();
      expect(() => verifyAgentRepaired(db, name, true, defaultAgentName, auditorName)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("registry に agent 名が復活していれば、todo タスクの有無に関わらず解除を認める", () => {
    const db = openDb(":memory:");
    expect(() => verifyAgentRepaired(db, "navigator", true)).not.toThrow();
  });

  it("registry に復活していなくても、その名前宛ての todo タスクがもう存在しなければ解除を認める", () => {
    const db = openDb(":memory:");
    expect(() => verifyAgentRepaired(db, "navigator", false)).not.toThrow();
  });

  it("registry に復活しておらず、その名前宛ての todo タスクがまだ残っていれば拒否する", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO tasks (id, type, status, assignee, title, purpose, completion_criteria, sort_key, created_at)
       VALUES ('t1', 'work', 'todo', 'navigator', 'still delegated', 'p', 'c', 1, '2026-07-08T00:00:00.000Z')`,
    ).run();

    expect(() => verifyAgentRepaired(db, "navigator", false)).toThrow(/navigator/);
  });
});
