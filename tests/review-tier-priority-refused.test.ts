import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listBoard, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

const BASE = { purpose: "p", completion_criteria: "c" } as const;

it.each([
  ["tier", { tier: "frontier" }],
  ["priority", { priority: "quality" }],
] as const)("review task への %s は登録時に DomainError で拒否され、task は作られない(ADR 0111 追記10)", (_, field) => {
  const db = openDb(":memory:");
  const register = () => registerTask(db, { type: "review", title: "r", ...BASE, ...field }, new Date(0), ...HUMAN_WEBUI);
  expect(register).toThrow(DomainError);
  expect(register).toThrow(/review_tier/);
  expect(listBoard(db)).toHaveLength(0);
  db.close();
});
