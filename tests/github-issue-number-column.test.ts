import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError, getTask, registerTask } from "../src/tasks.js";

it("github_issue_number は登録時に指定した値のまま永続化される(issue #49: issue参照タスクの参照フィールド)", () => {
  const db = openDb(":memory:");

  const registered = registerTask(
    db,
    {
      type: "work",
      workspace: "tidepool",
      github_issue_number: 49,
    },
    new Date(0),
  );

  expect(registered.github_issue_number).toBe(49);

  const reloaded = getTask(db, registered.id);
  expect(reloaded?.github_issue_number).toBe(49);
});

it("github_issue_number を指定しない通常タスクは null のままになる", () => {
  const db = openDb(":memory:");

  const registered = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );

  expect(registered.github_issue_number).toBeNull();
});

it("github_issue_number を指定した登録は workspace を伴わないと拒否される(ADR 0016: issue参照タスクは登録時にworkspaceが確定値)", () => {
  const db = openDb(":memory:");

  expect(() =>
    registerTask(
      db,
      { type: "work", title: "t", purpose: "p", completion_criteria: "c", github_issue_number: 49 },
      new Date(0),
    ),
  ).toThrow(DomainError);
});

it("github_issue_number と title/purpose/completion_criteria を同時に指定した登録は拒否される(ADR 0016: issue参照タスクは内容を一切保存しない — 排他性)", () => {
  const db = openDb(":memory:");

  expect(() =>
    registerTask(
      db,
      {
        type: "work",
        workspace: "tidepool",
        github_issue_number: 49,
        title: "snapshotted title",
      },
      new Date(0),
    ),
  ).toThrow(DomainError);
});
