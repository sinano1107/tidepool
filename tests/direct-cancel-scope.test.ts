import { afterEach, expect, it, vi } from "vitest";
import { warnCliAuthExpiry } from "../src/cli-auth.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { closedRootOf } from "../src/landing.js";
import { createBehaviorCandidate, proposeMemoryChange } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import {
  cancelTaskDirectly,
  carriesHumanWords,
  completeTask,
  editTask,
  getTask,
  isArtifactDiscarded,
  listBoard,
  listChildren,
  logDecision,
  nextSlotTask,
  pickupTask,
  registerTask,
  type Task,
  taskHistoryRows,
  taskVerbSwap,
} from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import {
  answerQuestionViaWebui,
  closedRootTree,
  decomposedChild,
  decomposeTaskViaWorker,
  FULL_HANDOFF,
  failureQuestion,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  HUMAN_WEBUI,
  humanDecomposeTaskViaWebui,
} from "./harness.js";

/** 直接 cancel と Edit の範囲(ADR 0198 / 0211)のドメイン層。直接 cancel は「文面の書き手が人間の task、または盤面が登録した
 *  root(question を除く)」、Edit は「文面の書き手が人間の task」。 */
const NOW = new Date("2026-10-05T00:00:00.000Z");

let db: Db;
afterEach(() => db?.close());
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

function metaReview(db: Db): Task {
  registerMetaReview(db, "memory", NOW);
  return getTask(db, listBoard(db).find((task) => task.meta_review_subject === "memory")!.id)!;
}

it("盤面が登録した todo の meta-review は直接 cancel でき、cancelled になって task_cancelled_directly が残る", () => {
  db = openDb(":memory:");
  const review = metaReview(db);

  cancelTaskDirectly(db, review, null, NOW, {}, "webui");

  expect(getTask(db, review.id)!.status).toBe("cancelled");
  expect(listEvents(db, review.id).some((e) => e.kind === "task_cancelled_directly")).toBe(true);
});

it("盤面が登録した meta-review の下で開いている提案 question は、meta-review の直接 cancel で道連れになる", () => {
  db = openDb(":memory:");
  const review = metaReview(db);
  const candidate = createBehaviorCandidate(
    db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    NOW,
  ).entry_id;
  const { question_id } = proposeMemoryChange(db, review.id, { op: "approve", candidate_id: candidate, rationale: "r" }, "auditor", NOW);

  cancelTaskDirectly(db, getTask(db, review.id)!, null, NOW, {}, "webui");

  expect(getTask(db, question_id)!.status).toBe("cancelled");
});

it("盤面が登録した root の question(CLI 認証期限の警告)は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  warnCliAuthExpiry(db, new Date(NOW.getTime() + HOUR), NOW);
  const warning = getTask(db, listBoard(db).find((task) => task.type === "question")!.id)!;

  expect(() => cancelTaskDirectly(db, warning, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, warning.id)!.status).toBe("todo");
});

it("盤面名義の完了時レビュー(統合点の付帯子)は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  completeTask(db, root, FULL_HANDOFF, "deckhand", NOW, "worker");
  const [review] = listChildren(db, root.id);

  expect(review!.type).toBe("review");
  expect(() => cancelTaskDirectly(db, review!, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, review!.id)!.status).toBe("todo");
});

it("盤面名義の RCA review(異議の付帯子)は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "deckhand's call", "deckhand", NOW, "worker");
  startTriage(db, NOW);
  raiseObjection(db, entry, "redo it", NOW);
  commitTriage(db, NOW);
  const rcas = listChildren(db, task.id).filter((child) => child.title.startsWith("rca"));

  expect(rcas).toHaveLength(2);
  for (const rca of rcas) {
    expect(() => cancelTaskDirectly(db, rca, null, NOW, {}, "webui")).toThrow(DomainError);
    expect(getTask(db, rca.id)!.status).toBe("todo");
  }
});

// ADR 0265 決定6 / ADR 0198 の Status 追記: 根が死んだ時点で、付帯子は規則が要求する入力ではなくなる
it("盤面の外で閉じた PR の根の付帯子(異議由来の修理と、盤面名義の RCA review)は直接 cancel できる", async () => {
  const tree = await closedRootTree("direct-cancel-closed-root");
  db = tree.db;

  for (const repair of tree.repairs) {
    cancelTaskDirectly(db, repair, null, NOW, { closedRootOf: closedRootOf(db, () => tree.workspace) }, "webui");
    expect(getTask(db, repair.id)!.status).toBe("cancelled");
  }
});

it("閉じていない根の盤面名義の付帯子(RCA review)は、閉じた根の述語を渡しても直接 cancel を拒否される", async () => {
  const tree = await closedRootTree("direct-cancel-open-root", { closed: false });
  db = tree.db;

  for (const rca of tree.repairs.filter((repair) => repair.type === "review")) {
    expect(() => cancelTaskDirectly(db, rca, null, NOW, { closedRootOf: closedRootOf(db, () => tree.workspace) }, "webui")).toThrow(DomainError);
    expect(getTask(db, rca.id)!.status).toBe("todo");
  }
});

it("盤面が登録した meta-review は Edit を拒否される(Edit の範囲は文面の書き手が人間の task)", () => {
  db = openDb(":memory:");
  const review = metaReview(db);

  expect(() => editTask(db, review, { title: "rewritten" }, NOW, "webui")).toThrow(DomainError);
  expect(getTask(db, review.id)!.title).toBe(review.title);
});

/** agent が decompose で登録した、まだ todo の子(拒否が「実行中」でなく文面の書き手の線から来ることを見るため)。 */
function todoAgentChild(db: Db): Task {
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [child] = decomposeTaskViaWorker(
    db,
    parent,
    { reason: "split", children: [{ title: "agent child", purpose: "p", completion_criteria: "c" }] },
    "deckhand",
    NOW,
  );
  expect(child!.status).toBe("todo");
  return child!;
}

it("agent が decompose で登録した todo の子は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const child = todoAgentChild(db);

  expect(() => cancelTaskDirectly(db, child, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, child.id)!.status).toBe("todo");
});

it("agent が decompose で登録した todo の子は Edit を拒否される", () => {
  db = openDb(":memory:");
  const child = todoAgentChild(db);

  expect(() => editTask(db, child, { title: "rewritten" }, NOW, "webui")).toThrow(DomainError);
  expect(getTask(db, child.id)!.title).toBe("agent child");
});

it("承認で実体化した todo の子は直接 cancel を拒否される", () => {
  db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c", workspace: "repo" }, NOW, ...HUMAN_WEBUI);
  const child = decomposedChild(db, parent, "approved child", "deckhand", NOW);

  expect(() => cancelTaskDirectly(db, child, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, child.id)!.status).toBe("todo");
});

it("承認で実体化した todo の子は Edit を拒否される", () => {
  db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c", workspace: "repo" }, NOW, ...HUMAN_WEBUI);
  const child = decomposedChild(db, parent, "approved child", "deckhand", NOW);

  expect(() => editTask(db, child, { title: "rewritten" }, NOW, "webui")).toThrow(DomainError);
  expect(getTask(db, child.id)!.title).toBe("approved child");
});

it("carriesHumanWords は承認で実体化した子では false、人間の root と人間 decompose の子では true", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "root", purpose: "p", completion_criteria: "c", workspace: "repo" }, NOW, ...HUMAN_WEBUI);
  const humanChild = decomposedChild(db, root, "human child", "human", NOW);
  const approvedChild = decomposedChild(db, root, "approved child", "deckhand", NOW);

  expect(carriesHumanWords(db, root.id)).toBe(true);
  expect(carriesHumanWords(db, humanChild.id)).toBe(true);
  expect(carriesHumanWords(db, approvedChild.id)).toBe(false);
});

// cancel の cascade は修理子を倒し、RCA review は残す(ADR 0268 決定4 / ADR 0271 決定3)

/** 人間が登録した work の判断行に異議を打って commit し、修理子と RCA(self / auditor)を付ける。 */
function objectedAndCommitted(db: Db) {
  const parent = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const entry = logDecision(db, parent, "deckhand's call", "deckhand", NOW, "worker");
  startTriage(db, NOW);
  raiseObjection(db, entry, "redo it", NOW);
  commitTriage(db, NOW, [], new Map());
  const kids = listChildren(db, parent.id);
  return { parent: getTask(db, parent.id)!, repair: kids.find((c) => c.type === "work")!, rcas: kids.filter((c) => c.type === "review") };
}

it.each(["直接 cancel", "failure question の abandon"] as const)(
  "異議 → commit の後の親の%sで、修理子は cancelled、RCA は todo のまま pickup 候補に残り、親の判断ログを読んで完了できる(ADR 0268 決定4 / ADR 0271 決定3)",
  (path) => {
    db = openDb(":memory:");
    const { parent, repair, rcas } = objectedAndCommitted(db);
    expect(rcas.map((rca) => rca.title)).toEqual(["rca (self): t", "rca (auditor): t"]);

    if (path === "直接 cancel") cancelTaskDirectly(db, parent, null, NOW, {}, "webui");
    else answerQuestionViaWebui(db, failureQuestion(db, parent.id, NOW), ["abandon"], NOW);

    expect([parent, repair].map((task) => getTask(db, task.id)!.status)).toEqual(["cancelled", "cancelled"]);
    expect(rcas.map((rca) => getTask(db, rca.id)!.status)).toEqual(["todo", "todo"]);
    expect(rcas.map((rca) => rca.id)).toContain(nextSlotTask(db)?.id);
    for (const rca of rcas) {
      expect(taskHistoryRows(db, parent.id, rca.id).map((row) => row.entry)).toContainEqual(expect.objectContaining({ decision: "deckhand's call" }));
      expect(completeTask(db, getTask(db, rca.id)!, undefined, "auditor", NOW, "worker").status).toBe("done");
    }
  },
);

it.each(["開いた failure question", "資源の quarantine"] as const)("残る RCA の下の%sは、親の直接 cancel を塞がない —— cascade と同じ範囲(ADR 0271 決定3)", (gate) => {
  db = openDb(":memory:");
  const { parent, rcas } = objectedAndCommitted(db);
  const auditorRca = rcas.find((rca) => rca.assignee === null)!;
  const question = gate === "開いた failure question" ? failureQuestion(db, auditorRca.id, NOW) : undefined;
  const quarantined = gate === "資源の quarantine" ? { workspaces: [], assignees: ["fugu"] } : undefined;

  cancelTaskDirectly(db, parent, null, NOW, { auditorName: "fugu", quarantined }, "webui");

  expect(getTask(db, parent.id)!.status).toBe("cancelled");
  for (const task of [auditorRca, question]) if (task) expect(getTask(db, task.id)!.status).toBe("todo");
});

// cancel が祖先に届いた done の work の付帯子: 完了時レビューと人間登録の review 子は倒れ、RCA だけ残る(ADR 0271 決定3)

/** 人間の root A を agent が B・C に分解し(どちらも review_flag)、両方 done にする。B には人間登録の review 子と、
 *  B の判断行への異議で修理子と RCA を付ける。C の完了時レビューは走行中にする。 */
function doneChildrenWithAttachments(db: Db) {
  const target = registerTask(db, { type: "work", title: "A", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [child, sibling] = decomposeTaskViaWorker(
    db,
    target,
    {
      reason: "split",
      children: [
        { title: "B", purpose: "p", completion_criteria: "c", review_flag: true },
        { title: "C", purpose: "p", completion_criteria: "c", review_flag: true },
      ],
    },
    "deckhand",
    NOW,
  );
  const entry = logDecision(db, child!, "deckhand's call", "deckhand", NOW, "worker");
  completeTask(db, child!, FULL_HANDOFF, "deckhand", NOW, "worker");
  completeTask(db, sibling!, FULL_HANDOFF, "deckhand", NOW, "worker");
  const humanReview = registerTask(db, { type: "review", title: "human review", purpose: "p", completion_criteria: "c", parent_id: child!.id }, NOW, ...HUMAN_WEBUI);
  startTriage(db, NOW);
  raiseObjection(db, entry, "redo it", NOW);
  commitTriage(db, NOW, [], new Map());
  const kids = listChildren(db, child!.id);
  const runningReview = pickupTask(db, listChildren(db, sibling!.id)[0]!, "shako", NOW)!;
  return {
    target: getTask(db, target.id)!,
    child: getTask(db, child!.id)!,
    completionReview: kids.find((c) => c.title === "review: B")!,
    humanReview,
    runningReview,
    repair: kids.find((c) => c.type === "work")!,
    rcas: kids.filter((c) => c.title.startsWith("rca")),
  };
}

it.each(["直接 cancel", "自身の failure question の abandon"] as const)(
  "祖先の%sで、done の子の完了時レビュー・人間登録の review 子・走行中の完了時レビュー・修理子は cancelled、RCA は todo のまま pickup 候補に残り、親の判断ログを読んで完了できる(ADR 0271 決定3)",
  (path) => {
    db = openDb(":memory:");
    const { target, child, completionReview, humanReview, runningReview, repair, rcas } = doneChildrenWithAttachments(db);
    expect(rcas).toHaveLength(2);

    if (path === "直接 cancel") cancelTaskDirectly(db, target, null, NOW, {}, "webui");
    else answerQuestionViaWebui(db, failureQuestion(db, target.id, NOW), ["abandon"], NOW);

    expect([target, completionReview, humanReview, runningReview, repair].map((task) => getTask(db, task.id)!.status)).toEqual(Array(5).fill("cancelled"));
    expect(getTask(db, child.id)!.status).toBe("done");
    expect(rcas.map((rca) => getTask(db, rca.id)!.status)).toEqual(["todo", "todo"]);
    expect(rcas.map((rca) => rca.id)).toContain(nextSlotTask(db)?.id);
    for (const rca of rcas) {
      expect(taskHistoryRows(db, child.id, rca.id).map((row) => row.entry)).toContainEqual(expect.objectContaining({ decision: "deckhand's call" }));
      expect(completeTask(db, getTask(db, rca.id)!, undefined, "auditor", NOW, "worker").status).toBe("done");
    }
  },
);

/** 人間の root P を agent が同じ判断で S1・S2 に分解し(S1 は review_flag)、S1 だけ done にする。 */
function doneSiblingOfFailed(db: Db) {
  const parent = registerTask(db, { type: "work", title: "P", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [done, failed] = decomposeTaskViaWorker(
    db,
    parent,
    {
      reason: "split",
      children: [
        { title: "S1", purpose: "p", completion_criteria: "c", review_flag: true },
        { title: "S2", purpose: "p", completion_criteria: "c" },
      ],
    },
    "deckhand",
    NOW,
  );
  completeTask(db, done!, FULL_HANDOFF, "deckhand", NOW, "worker");
  return { parent, done: done!, failed: failed!, review: listChildren(db, done!.id)[0]! };
}

it("兄弟の abandon(親は生きて再計画)では、done の兄弟の完了時レビューは todo のまま残る(ADR 0271 決定3)", () => {
  db = openDb(":memory:");
  const { parent, failed, review } = doneSiblingOfFailed(db);

  answerQuestionViaWebui(db, failureQuestion(db, failed.id, NOW), ["abandon"], NOW);

  expect(getTask(db, failed.id)!.status).toBe("cancelled");
  expect(getTask(db, parent.id)!.status).not.toBe("cancelled");
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("倒れる完了時レビューの下の開いた failure question は祖先の直接 cancel を塞ぎ、残る RCA の下のものは塞がない —— cascade と同じ述語(ADR 0271 決定3)", () => {
  db = openDb(":memory:");
  const falling = doneChildrenWithAttachments(db);
  failureQuestion(db, falling.completionReview.id, NOW);
  const surviving = doneChildrenWithAttachments(db);
  const underRca = failureQuestion(db, surviving.rcas[0]!.id, NOW);

  expect(() => cancelTaskDirectly(db, falling.target, null, NOW, {}, "webui")).toThrow(DomainError);
  expect(getTask(db, falling.target.id)!.status).toBe("todo");
  cancelTaskDirectly(db, surviving.target, null, NOW, {}, "webui");
  expect(getTask(db, surviving.target.id)!.status).toBe("cancelled");
  expect(getTask(db, underRca.id)!.status).toBe("todo");
});

it("倒れる完了時レビューが使う資源の quarantine は祖先の直接 cancel を塞ぐ(ADR 0271 決定3)", () => {
  db = openDb(":memory:");
  const { target } = doneChildrenWithAttachments(db);

  expect(() => cancelTaskDirectly(db, target, null, NOW, { auditorName: "fugu", quarantined: { workspaces: [], assignees: ["fugu"] } }, "webui")).toThrow(DomainError);
  expect(getTask(db, target.id)!.status).toBe("todo");
});

it("決着済みの完了時レビューが使う資源の quarantine は祖先の直接 cancel を塞がない —— cascade が触らないものは塞がない(ADR 0271 決定3)", () => {
  db = openDb(":memory:");
  const { parent, done, review } = doneSiblingOfFailed(db);
  completeTask(db, review, undefined, "fugu", NOW, "worker");

  cancelTaskDirectly(db, parent, null, NOW, { auditorName: "fugu", quarantined: { workspaces: [], assignees: ["fugu"] } }, "webui");

  expect(getTask(db, parent.id)!.status).toBe("cancelled");
  expect([done, review].map((task) => getTask(db, task.id)!.status)).toEqual(["done", "done"]);
});

it("成果が捨てられた task は cancelled の work の祖先を挟む task で、自身だけが cancelled の task・祖先が全部生きている task・兄弟 abandon 後の done の兄弟は当たらない(ADR 0271 決定1)", () => {
  db = openDb(":memory:");
  const { target, child, rcas } = doneChildrenWithAttachments(db);
  expect(isArtifactDiscarded(db, child.id)).toBe(false);

  cancelTaskDirectly(db, target, null, NOW, {}, "webui");

  expect(isArtifactDiscarded(db, child.id)).toBe(true);
  expect(isArtifactDiscarded(db, rcas[0]!.id)).toBe(true);
  expect(isArtifactDiscarded(db, target.id)).toBe(false);

  const { done, failed, review } = doneSiblingOfFailed(db);
  answerQuestionViaWebui(db, failureQuestion(db, failed.id, NOW), ["abandon"], NOW);

  expect(isArtifactDiscarded(db, failed.id)).toBe(false);
  expect(isArtifactDiscarded(db, done.id)).toBe(false);
  expect(isArtifactDiscarded(db, review.id)).toBe(false);
});

it("cancelled の work の祖先を挟む task を親にした work の登録は、registerTask・worker の decompose・人間の decompose のどれからも cancelled の祖先を名指す DomainError で拒まれ、question は通る —— 生きた系譜の task の下は今どおり(ADR 0271 決定2)", () => {
  db = openDb(":memory:");
  const { target, child, rcas } = doneChildrenWithAttachments(db);
  cancelTaskDirectly(db, target, null, NOW, {}, "webui");
  const rca = getTask(db, rcas[0]!.id)!;
  const discarded = new RegExp(`cancel of ancestor "A" \\(${target.id}\\) discarded`);
  const split = { reason: "repair", children: [{ title: "fix", purpose: "p", completion_criteria: "c" }] };

  for (const parent of [child, rca]) {
    for (const [workerId, origin] of [HUMAN_WEBUI, ["auditor", "worker"], [BOARD_WORKER_ID, "board"]] as const) {
      expect(() => registerTask(db, { type: "work", title: "fix", purpose: "p", completion_criteria: "c", parent_id: parent.id }, NOW, workerId, origin)).toThrow(discarded);
    }
  }
  expect(() => decomposeTaskViaWorker(db, rca, split, "auditor", NOW)).toThrow(discarded);
  expect(() => humanDecomposeTaskViaWebui(db, rca, split, NOW)).toThrow(discarded);
  expect(listChildren(db, rca.id)).toEqual([]);
  expect(failureQuestion(db, rca.id, NOW).parent_id).toBe(rca.id);

  const live = registerTask(db, { type: "work", title: "L", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  expect(decomposeTaskViaWorker(db, live, split, "deckhand", NOW)).toHaveLength(1);
});

it("cancelled の work の祖先が系譜に複数あるとき、拒否文は最も root 寄りの祖先を名指す(ADR 0271 決定2)", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "R", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const mid = registerTask(db, { type: "work", title: "M", purpose: "p", completion_criteria: "c", parent_id: root.id }, NOW, ...HUMAN_WEBUI);
  const leaf = registerTask(db, { type: "review", title: "Q", purpose: "p", completion_criteria: "c", parent_id: mid.id }, NOW, ...HUMAN_WEBUI);
  cancelTaskDirectly(db, mid, null, NOW, {}, "webui");
  cancelTaskDirectly(db, getTask(db, root.id)!, null, NOW, {}, "webui");

  expect(() => registerTask(db, { type: "work", title: "fix", purpose: "p", completion_criteria: "c", parent_id: leaf.id }, NOW, BOARD_WORKER_ID, "board")).toThrow(
    new RegExp(`cancel of ancestor "R" \\(${root.id}\\) discarded`),
  );
});

it("task ごとの verb の差し替えは、cancelled の work の祖先を挟む task(祖先の cancel の下・cancelled の task の下の RCA)で分解の verb を伏せ、生きた系譜の task では何も変えない(ADR 0271 決定2)", () => {
  db = openDb(":memory:");
  const { target, rcas } = doneChildrenWithAttachments(db);
  expect(taskVerbSwap(db, rcas[0]!.id)).toEqual({ withheld: [], added: [] });

  cancelTaskDirectly(db, target, null, NOW, {}, "webui");
  const cancelled = registerTask(db, { type: "work", title: "X", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const entry = logDecision(db, cancelled, "deckhand's call", "deckhand", NOW, "worker");
  cancelTaskDirectly(db, cancelled, null, NOW, {}, "webui");
  startTriage(db, NOW);
  raiseObjection(db, entry, "redo it", NOW);
  commitTriage(db, NOW, [], new Map());

  const underCancel = [...rcas, ...listChildren(db, cancelled.id)];
  expect(underCancel.map((task) => task.title)).toEqual(["rca (self): B", "rca (auditor): B", "rca (self): X", "rca (auditor): X"]);
  for (const rca of underCancel) expect(taskVerbSwap(db, rca.id)).toEqual({ withheld: ["decompose", "redecompose"], added: [] });
  const { parent, done, review } = doneSiblingOfFailed(db);
  for (const task of [target, cancelled, parent, done, review]) expect(taskVerbSwap(db, task.id)).toEqual({ withheld: [], added: [] });
});
