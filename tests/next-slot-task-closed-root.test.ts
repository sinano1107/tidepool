import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { closedRootOf } from "../src/landing.js";
import { listQueue, nextSlotTask, registerTask } from "../src/tasks.js";
import { closedRootTree, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI } from "./harness.js";

/** 盤面の外で閉じられた PR の根に塞がれた子(ADR 0265 決定6)は pickup が飛ばし、キューでは skipped に見える。
 *  根の内容が保護ブランチに届けば(ADR 0250 決定1)、同じ子は拾われる。 */
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let db: Db | undefined;
afterEach(() => db?.close());

it("閉じた PR の根の下の未決着の修理と review は pickup に拾われず、後ろの todo が拾われる", async () => {
  const tree = await closedRootTree("closed-root-skip");
  db = tree.db;
  const elsewhere = registerTask(db, { type: "work", title: "elsewhere", purpose: "p", completion_criteria: "c" }, new Date(), ...HUMAN_WEBUI);

  const head = nextSlotTask(db, undefined, undefined, undefined, undefined, undefined, closedRootOf(db, () => tree.workspace));

  expect(head?.id).toBe(elsewhere.id);
});

it("キューでは、閉じた根に塞がれた子は skipped で、理由に閉じた根と PR を持つ", async () => {
  const tree = await closedRootTree("closed-root-queue");
  db = tree.db;

  const rows = listQueue(db, undefined, undefined, undefined, undefined, undefined, closedRootOf(db, () => tree.workspace));

  for (const repair of tree.repairs) {
    expect(rows.find((row) => row.id === repair.id)).toMatchObject({ status: "skipped", closed_root: { task_id: tree.root.id, pr_number: 1 } });
  }
  expect(rows.find((row) => row.id === tree.root.id)?.closed_root).toBeUndefined();
});

it("根の内容が保護ブランチに届いた後(reopen して merge された)は、同じ子が拾われ、キューでも todo に戻る", async () => {
  const tree = await closedRootTree("closed-root-landed");
  db = tree.db;
  git(tree.workspace.path, "merge", "--no-edit", `task/${tree.root.id}`);

  const head = nextSlotTask(db, undefined, undefined, undefined, undefined, undefined, closedRootOf(db, () => tree.workspace));
  const rows = listQueue(db, undefined, undefined, undefined, undefined, undefined, closedRootOf(db, () => tree.workspace));

  expect(tree.repairs.map((repair) => repair.id)).toContain(head?.id);
  for (const repair of tree.repairs) {
    expect(rows.find((row) => row.id === repair.id)).toMatchObject({ status: "todo" });
    expect(rows.find((row) => row.id === repair.id)?.closed_root).toBeUndefined();
  }
});

it("閉じた根の分解子に出た異議の修理と RCA review も、分解子のブランチから閉じた根へ帰るので拾われない", async () => {
  const tree = await closedRootTree("closed-root-decomposed", { decomposed: true });
  db = tree.db;

  const head = nextSlotTask(db, undefined, undefined, undefined, undefined, undefined, closedRootOf(db, () => tree.workspace));
  const rows = listQueue(db, undefined, undefined, undefined, undefined, undefined, closedRootOf(db, () => tree.workspace));

  expect(head).toBeUndefined();
  for (const repair of tree.repairs) {
    expect(rows.find((row) => row.id === repair.id)).toMatchObject({ status: "skipped", closed_root: { task_id: tree.root.id, pr_number: 1 } });
  }
});
