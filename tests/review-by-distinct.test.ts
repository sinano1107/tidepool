import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { decomposeTask, editTask, listBoard, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

const BASE = { purpose: "p", completion_criteria: "c" } as const;

it("同じ reviewer を2度含む review_by は登録時に DomainError で拒否され、task は作られない(#1512)", () => {
  const db = openDb(":memory:");
  expect(() =>
    registerTask(db, { type: "work", title: "w", ...BASE, review_by: ["fugu", "fugu"] }, new Date(0), ...HUMAN_WEBUI),
  ).toThrow(DomainError);
  expect(listBoard(db)).toHaveLength(0);
  db.close();
});

it("review_by を同じ reviewer を2度含む値へ Edit すると DomainError で拒否され、保存値は変わらない(#1512)", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", ...BASE, review_by: ["fugu"] }, new Date(0), ...HUMAN_WEBUI);
  expect(() => editTask(db, work, { review_by: ["fugu", "fugu"] }, new Date(1), HUMAN_WEBUI[1])).toThrow(DomainError);
  expect(listBoard(db)[0]?.review_by).toEqual(["fugu"]);
  db.close();
});

it.each([
  ["権限内", undefined],
  ["権限外", { assignable_to: [] }],
])(
  "decompose の子の review_by が同じ reviewer を2度含むと(reviewer が%s)、子も承認 question も作られずに拒否される(#1512)",
  (_, authority) => {
    const db = openDb(":memory:");
    const parent = registerTask(db, { type: "work", title: "p", ...BASE }, new Date(0), ...HUMAN_WEBUI);
    expect(() =>
      decomposeTask(
        db,
        parent,
        { reason: "split", children: [{ title: "c", ...BASE, review_flag: true, review_by: ["fugu", "fugu"] }] },
        "agent-a",
        new Date(1),
        authority,
        undefined,
        "worker",
      ),
    ).toThrow(DomainError);
    expect(listBoard(db).map((t) => t.id)).toEqual([parent.id]);
    db.close();
  },
);
