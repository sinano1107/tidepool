import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  agentNeedsHuman,
  quarantineAgent,
  resolveAgentOrQuarantine,
  UnknownAgentError,
  verifyAgentRepaired,
  type ResolvedAgent,
} from "../src/agent.js";
import { listBoard } from "../src/tasks.js";

describe("quarantineAgent(ADR 0012 / issue #36: workspace 版の agent 名一般化)", () => {
  it("agent 名を needs-human にマークし、1択の Confirmation question を登録する", () => {
    const db = openDb(":memory:");
    quarantineAgent(db, "navigator", new Error("unknown agent: navigator"), new Date(0));

    expect(agentNeedsHuman(db, "navigator")).toBe(true);
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.question_quarantine_agent).toBe("navigator");
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
      definition: { name: "deckhand", version: "0.0.1", authority: "standard", systemPrompt: "x" },
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
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.question_quarantine_agent).toBe("ghost");
  });
});

describe("verifyAgentRepaired", () => {
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
