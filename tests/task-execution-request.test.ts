import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError, decomposeTask, getTask, listChildren, registerTask } from "../src/tasks.js";

/** ADR 0107 決定1 のドメイン層 —— 要求2列の受理と拒否を **registerTask /
 *  decomposeTask の戻り値と例外**で言う。入口(JSON API / 管理MCP / worker MCP)は
 *  写像だけを言い、「economy 以外はダメ」を入口ごとに書き直さない(決定3)。 */

it("登録された task は要求2列をそのまま持ち帰る(CONTEXT.md「要求」)", () => {
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier: "frontier", priority: "quality" },
    new Date(0),
  );
  expect(task.tier).toBe("frontier");
  expect(task.priority).toBe("quality");
  expect(getTask(db, task.id)).toMatchObject({ tier: "frontier", priority: "quality" });
});

it("要求を書かない task の2列は null —— 未指定は「既定を選んだ」とは別の値である", () => {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, new Date(0));
  expect(task.tier).toBeNull();
  expect(task.priority).toBeNull();
});

it("issue参照 task にも要求を付けられる(spec #541 User Story 3: 起票時の判断を失わない)", () => {
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 543, tier: "standard", priority: "speed" },
    new Date(0),
  );
  expect(getTask(db, task.id)).toMatchObject({ tier: "standard", priority: "speed" });
});

it("ティアの不正値は登録を拒否する — 表に無いティアで走る task を作らない", () => {
  const db = openDb(":memory:");
  expect(() =>
    registerTask(
      db,
      { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier: "platinum" },
      new Date(0),
    ),
  ).toThrow(DomainError);
});

it("優先順位の不正値も登録を拒否する — 保存するだけの列でも不発の値は持たない", () => {
  const db = openDb(":memory:");
  expect(() =>
    registerTask(
      db,
      { type: "work", title: "t", purpose: "p", completion_criteria: "c", priority: "cheap" },
      new Date(0),
    ),
  ).toThrow(DomainError);
});

it("decompose の子も要求2列を受け、不正値は decompose 全体を拒否する(承認 question へ化ける前に倒す)", () => {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "p", purpose: "p", completion_criteria: "c" }, new Date(0));
  const [child] = decomposeTask(
    db,
    parent,
    {
      reason: "split",
      children: [
        { title: "c1", purpose: "p1", completion_criteria: "cc1", tier: "frontier", priority: "quality" },
      ],
    },
    "agent-a",
    new Date(1),
  );
  expect(child).toMatchObject({ tier: "frontier", priority: "quality" });

  // 承認 question へ化ける子(assignee が authority の外)でも、不正値は
  // registerTask まで届かせない —— 届けば人間が承認した瞬間に初めて倒れる
  expect(() =>
    decomposeTask(
      db,
      parent,
      {
        reason: "split",
        children: [
          { title: "c2", purpose: "p2", completion_criteria: "cc2", assignee: "nobody", tier: "platinum" },
        ],
      },
      "agent-a",
      new Date(2),
      { assignable_to: [] },
    ),
  ).toThrow(DomainError);
});

it("承認 question に化けた子は要求2列を失わない —— 承認で materialize された子がその値で走る", () => {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "p", purpose: "p", completion_criteria: "c" }, new Date(0));
  decomposeTask(
    db,
    parent,
    {
      reason: "split",
      children: [
        { title: "c1", purpose: "p1", completion_criteria: "cc1", assignee: "nobody", tier: "frontier", priority: "cost" },
      ],
    },
    "agent-a",
    new Date(1),
    { assignable_to: [] },
  );
  const question = listChildren(db, parent.id).find((child) => child.type === "question");
  expect(question?.question_pending_child).toMatchObject({
    tier: "frontier",
    priority: "cost",
  });
});
