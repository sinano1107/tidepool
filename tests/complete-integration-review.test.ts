import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import {
  cancelTaskDirectly,
  completeIntegrationReview,
  completeTask,
  getTask,
  listChildren,
  registerTask,
  type Task,
  taskVerbSwap,
} from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { bootTidepool, FULL_HANDOFF, HUMAN_WEBUI, humanDecomposeTaskViaWebui, mcpClient, NO_FINDINGS, type Tidepool } from "./harness.js";

/** 統合レビューは complete_integration_review で終わる(ADR 0278 決定1〜5 の統合レビュー、issue #2281)。 */

const NOW = new Date("2026-10-19T00:00:00.000Z");
const FINDINGS = NO_FINDINGS.findings;

/** root work を完了させ、盤面が立てた統合レビューと、人間が同じ親を名指して立てた review 子を返す。 */
function reviewed(db = openDb(":memory:")) {
  const work = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  completeTask(db, work, FULL_HANDOFF, "reef-crab", NOW, "worker");
  const review = listChildren(db, work.id).find((child) => child.type === "review")!;
  const humanReview = registerTask(db, { type: "review", title: "look again", purpose: "p", completion_criteria: "c", parent_id: work.id }, NOW, ...HUMAN_WEBUI);
  return { db, work, review, humanReview };
}

/** 統合レビューの指摘を修理子に分解する —— 人間の分解なので子を直に cancel できる(setup)。 */
function repairs(db: ReturnType<typeof openDb>, review: Task, count: number): Task[] {
  return humanDecomposeTaskViaWebui(
    db,
    review,
    { reason: "file the findings", children: Array.from({ length: count }, (_, i) => ({ title: `fix ${i}`, purpose: "p", completion_criteria: "c" })) },
    NOW,
  );
}

const judgmentRows = (db: ReturnType<typeof openDb>, taskId: string) =>
  listEvents(db, taskId).flatMap((e) => (e.payload.kind === "decision_logged" && e.payload.judgment ? [e.payload] : []));

it("統合レビューの verb の差し替えは complete_task を伏せ complete_integration_review を足し、人間が立てた review 子は差し替えない", () => {
  const { db, review, humanReview } = reviewed();

  expect(taskVerbSwap(db, review.id)).toEqual({ withheld: ["complete_task"], added: ["complete_integration_review"] });
  expect(taskVerbSwap(db, humanReview.id)).toEqual({ withheld: [], added: [] });
});

it.each([
  ["worker", "fugu", "worker"],
  ["人間", HUMAN_WORKER_ID, "webui"],
] as const)("統合レビューへの complete_task は %s の扉でも拒まれ、拒否文は complete_integration_review を指し、何も書かない", (_, workerId, origin) => {
  const { db, review } = reviewed();
  const before = listEvents(db, review.id).length;

  expect(() => completeTask(db, review, FULL_HANDOFF, workerId, NOW, origin)).toThrow("complete_integration_review");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("修理子が無く no_findings も無い完了は拒まれ、何も記録されない", () => {
  const { db, review } = reviewed();
  const before = listEvents(db, review.id).length;

  expect(() => completeIntegrationReview(db, review, { findings: FINDINGS }, "fugu", NOW, "worker")).toThrow("no_findings");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("分解でない付帯子の work(異議の修理など)は修理子に数えず、no_findings が無ければ拒まれる", () => {
  const { db, review } = reviewed();
  registerTask(db, { type: "work", title: "attached fix", purpose: "p", completion_criteria: "c", parent_id: review.id }, NOW, ...HUMAN_WEBUI);
  const before = listEvents(db, review.id).length;

  expect(() => completeIntegrationReview(db, getTask(db, review.id)!, { findings: FINDINGS }, "fugu", NOW, "worker")).toThrow("no_findings");
  expect(listEvents(db, review.id)).toHaveLength(before);
});

it("修理子が無く no_findings がある完了は done になり、判断ログに成果物を名指す no_findings の行が1つ、完了の result は findings", () => {
  const { db, work, review } = reviewed();

  const done = completeIntegrationReview(db, review, NO_FINDINGS, "fugu", NOW, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([
    {
      kind: "decision_logged",
      line: `no_findings: deliverable ${work.id} — ${FINDINGS}`,
      judgment: { kind: "integration_review", deliverable: work.id, value: "no_findings", findings: FINDINGS, repairs: [] },
    },
  ]);
  expect(listEvents(db, review.id).find((e) => e.kind === "task_completed")!.payload).toMatchObject({ result: FINDINGS });
});

it.each([
  ["no_findings を渡しても", { no_findings: true as const }],
  ["no_findings が無くても", {}],
])("決着した修理子があれば %s done になり、行の値は repaired で成果物と修理子の id と status を名指す", (_, mark) => {
  const { db, work, review } = reviewed();
  const [fixed, dropped] = repairs(db, review, 2);
  completeTask(db, fixed!, FULL_HANDOFF, "reef-crab", NOW, "worker");
  cancelTaskDirectly(db, dropped!, null, NOW, {}, "webui");

  const done = completeIntegrationReview(db, getTask(db, review.id)!, { findings: FINDINGS, ...mark }, "fugu", NOW, "worker");

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([
    {
      kind: "decision_logged",
      line: `repaired: deliverable ${work.id} (${fixed!.id} done, ${dropped!.id} cancelled) — ${FINDINGS}`,
      judgment: {
        kind: "integration_review",
        deliverable: work.id,
        value: "repaired",
        findings: FINDINGS,
        repairs: [
          { id: fixed!.id, status: "done" },
          { id: dropped!.id, status: "cancelled" },
        ],
      },
    },
  ]);
});

it("未決着の修理子があれば今どおり拒まれ、何も記録されない", () => {
  const { db, review } = reviewed();
  repairs(db, review, 1);
  const before = listEvents(db, review.id).length;

  expect(() => completeIntegrationReview(db, getTask(db, review.id)!, NO_FINDINGS, "fugu", NOW, "worker")).toThrow("unfinished children");
  expect(listEvents(db, review.id)).toHaveLength(before);
});

it("統合レビューでない task と空の findings は拒まれる", () => {
  const { db, review, humanReview } = reviewed();

  expect(() => completeIntegrationReview(db, humanReview, NO_FINDINGS, "fugu", NOW, "worker")).toThrow(
    "only an integration review completes with complete_integration_review",
  );
  expect(() => completeIntegrationReview(db, review, { findings: " ", no_findings: true }, "fugu", NOW, "worker")).toThrow("requires findings");
});

let t: Tidepool;
afterEach(() => t?.stop());

it("接続した統合レビューの tool 一覧には complete_integration_review があり complete_task は無い", async () => {
  t = await bootTidepool();
  const { review } = reviewed(t.db);
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("complete_integration_review");
    expect(names).not.toContain("complete_task");
  } finally {
    await client.close();
  }
});
