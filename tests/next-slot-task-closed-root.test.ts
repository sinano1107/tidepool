import { afterEach, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { closedRootOf } from "../src/landing.js";
import { completeTask, listQueue, nextSlotTask, registerTask } from "../src/tasks.js";
import { closedRootTree, commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, settleReviews } from "./harness.js";

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

it("付帯子の review は、列が NULL でも導出した祖先の workspace の checkout で閉じた根を見る —— 既定の checkout では見ない(ADR 0290 決定5)", async () => {
  const now = new Date("2026-10-16T00:00:00.000Z");
  const reef = await makeWorkspace("reef");
  const other = await makeWorkspace("closed-root-default");
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c", workspace: "reef" }, now, ...HUMAN_WEBUI);
  git(reef.path, "checkout", "-b", `task/${root.id}`);
  commitWork(reef.path, "feature.txt", "ready\n");
  git(reef.path, "checkout", "main");
  completeTask(db, root, FULL_HANDOFF, "deckhand", now, "worker");
  settleReviews(db, now);
  appendEvent(db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: now });
  const review = registerTask(db, { type: "review", title: "second opinion", purpose: "p", completion_criteria: "c", parent_id: root.id }, now, ...HUMAN_WEBUI);

  expect(closedRootOf(db, (name) => (name === "reef" ? reef : other))(review)?.task_id).toBe(root.id);
});
