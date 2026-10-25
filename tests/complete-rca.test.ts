import { expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents, taskDecisionLog } from "../src/events.js";
import { listMemoryEntries } from "../src/memory.js";
import { completeRca, proposeFromMaterial } from "../src/retrospective.js";
import { cancelTaskDirectly, completeTask, getTask, listChildren, logDecision, registerTask, type Task, taskVerbSwap } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { FULL_HANDOFF, HUMAN_WEBUI, humanDecomposeTaskViaWebui, judgmentRows, markPickedUp } from "./harness.js";

/** RCA は complete_rca で終わり、propose_from_material の起草は RCA の task に記録を残す(ADR 0278 決定1〜5 の RCA・ADR 0280、issue #2285)。 */

const at = new Date("2026-10-19T00:00:00.000Z");
const draft = { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures." };
const CAUSE = "the fixtures rule was never written down";

/** agent `auditor` が判断した行に cause ごとに異議を打って commit し、盤面が立てた self / auditor の RCA を返す。self の assignee も
 *  auditor なので、2本の RCA の書き手の名前は同じ(ADR 0280 の背景)。cause が null の行は未帰責(uncertain と同じに読む)。 */
function objected(causes: Array<Cause | null>, db: Db = openDb(":memory:")) {
  const work = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c", workspace: "charts" }, at, ...HUMAN_WEBUI);
  const entries = causes.map((_, i) => logDecision(db, work, `call ${i}`, "auditor", at, "worker"));
  startTriage(db, at);
  for (const entry of entries) raiseObjection(db, entry, "redo it", at);
  const judged = entries.flatMap((entry, i) => (causes[i] ? [[entry, { cause: causes[i]!, evidence: "e", wrong_memory_entries: null }] as const] : []));
  commitTriage(db, at, [], new Map(judged));
  const reviews = listChildren(db, work.id).filter((child) => child.type === "review");
  const self = reviews.find((r) => r.title.startsWith("rca (self)"))!;
  const auditor = reviews.find((r) => r.title.startsWith("rca (auditor)"))!;
  return { db, work, entries, self, auditor };
}

const behavior = (db: Db, rca: Task, entry_id: number) => proposeFromMaterial(db, rca.id, { ...draft, material_id: entry_id }, {}, "auditor", at).entry_id;
const knowledge = (db: Db, rca: Task, entry_id: number) =>
  proposeFromMaterial(db, rca.id, { ...draft, material_id: entry_id, as: "knowledge", based_on_decision: logDecision(db, rca, "it was never written", "auditor", at, "worker") }, {}, "auditor", at)
    .entry_id;
const records = (db: Db, rca: Task) => listEvents(db, rca.id).flatMap((e) => (e.payload.kind === "proposed_from_material" ? [e.payload] : []));

it("self と auditor の RCA の verb の差し替えは complete_task を伏せ complete_rca を足し、異議の修理子は差し替えない(祖先の cancel の下は tests/direct-cancel-scope.test.ts)", () => {
  const { db, work, self, auditor } = objected(["capability"]);
  expect(taskVerbSwap(db, self.id)).toEqual({ withheld: ["complete_task"], added: ["complete_rca"] });
  expect(taskVerbSwap(db, auditor.id)).toEqual({ withheld: ["complete_task"], added: ["complete_rca"] });
  expect(taskVerbSwap(db, listChildren(db, work.id).find((c) => c.type === "work")!.id)).toEqual({ withheld: [], added: [] });
});

it.each([
  ["worker", "auditor", "worker"],
  ["人間", HUMAN_WORKER_ID, "webui"],
] as const)("RCA への complete_task は %s の扉でも拒まれ、拒否文は complete_rca を指し、何も書かない", (_, workerId, origin) => {
  const { db, self } = objected(["capability"]);
  const before = listEvents(db, self.id).length;

  expect(() => completeTask(db, self, FULL_HANDOFF, workerId, at, origin)).toThrow("complete_rca");
  expect(listEvents(db, self.id)).toHaveLength(before);
  expect(getTask(db, self.id)!.status).toBe("todo");
});

it("propose_from_material は Behavior candidate でも Knowledge でも、呼んだ RCA にエントリと書いた記憶の記録を1つ残し、記録は判断ログに現れない", () => {
  const { db, entries, self } = objected(["capability", "missing_information"]);
  const candidate = behavior(db, self, entries[0]!);
  const note = knowledge(db, self, entries[1]!);

  expect(records(db, self)).toEqual([
    { kind: "proposed_from_material", material_id: entries[0], memory_event_id: candidate },
    { kind: "proposed_from_material", material_id: entries[1], memory_event_id: note },
  ]);
  expect(taskDecisionLog(db, self.id).map((e) => e.kind)).not.toContain("proposed_from_material");
});

it("店の書き込みが拒まれる起草は記憶も記録も残さない", () => {
  const { db, entries, self } = objected(["capability"]);

  expect(() => proposeFromMaterial(db, self.id, { ...draft, title: " ", material_id: entries[0]! }, {}, "auditor", at)).toThrow("title and text must be non-empty");
  expect(listMemoryEntries(db, {})).toEqual([]);
  expect(records(db, self)).toEqual([]);
});

it("材料のエントリが所見に無い・2つの所見に入る・材料に無いエントリは、id を名指して拒まれ何も記録されない", () => {
  const { db, entries, auditor } = objected(["capability", null, null]);
  const [a, b, c] = entries as [number, number, number];
  const before = listEvents(db, auditor.id).length;

  expect(() =>
    completeRca(
      db,
      auditor,
      { findings: [{ material: [a, 9999], root_cause: CAUSE, no_proposal: true }, { material: [a], root_cause: CAUSE, no_proposal: true }] },
      "auditor",
      at,
      "worker",
    ),
  ).toThrow(`not in this RCA's material: entries 9999; named more than once: entries ${a}; in no finding: entries ${b}, ${c}`);
  expect(listEvents(db, auditor.id)).toHaveLength(before);
  expect(getTask(db, auditor.id)!.status).toBe("todo");
});

it("行為も no_proposal も無い所見は名指して拒まれ、何も記録されない", () => {
  const { db, entries, auditor } = objected([null, null]);
  const before = listEvents(db, auditor.id).length;

  expect(() =>
    completeRca(db, auditor, { findings: [{ material: [entries[0]!], root_cause: CAUSE }, { material: [entries[1]!], root_cause: CAUSE, no_proposal: true }] }, "auditor", at, "worker"),
  ).toThrow(`no act and no no_proposal: entries ${entries[0]}`);
  expect(listEvents(db, auditor.id)).toHaveLength(before);
});

it("所見ごとに型つきの decision_logged が1行: 行為のある所見は書いた記憶を列挙し(no_proposal は受け取って載せない)、行為の無い所見は no_proposal を持ち、完了する", () => {
  const { db, entries, auditor } = objected(["capability", "missing_information", null]);
  const [a, b, c] = entries as [number, number, number];
  const candidate = behavior(db, auditor, a);
  const note = knowledge(db, auditor, b);

  const done = completeRca(
    db,
    auditor,
    {
      findings: [
        { material: [a, b], root_cause: ` ${CAUSE} `, no_proposal: true },
        { material: [c], root_cause: "the comment asks for nothing", no_proposal: true },
      ],
    },
    "auditor",
    at,
    "worker",
  );

  expect(done.status).toBe("done");
  expect(judgmentRows(db, auditor.id)).toEqual([
    {
      kind: "decision_logged",
      line: `entries ${a}, ${b} → behavior candidate #${candidate}, knowledge #${note} — ${CAUSE}`,
      judgment: {
        kind: "rca",
        material: [a, b],
        root_cause: CAUSE,
        memories: [
          { id: candidate, kind: "behavior" },
          { id: note, kind: "knowledge" },
        ],
        repairs: [],
      },
    },
    {
      kind: "decision_logged",
      line: `no_proposal: entries ${c} — the comment asks for nothing`,
      judgment: { kind: "rca", material: [c], root_cause: "the comment asks for nothing", memories: [], repairs: [], no_proposal: true },
    },
  ]);
});

it("同じ異議群の self と auditor の RCA(同じ agent 名)で self だけが起草すると、self は no_proposal 無しで完了でき、auditor は no_proposal で完了して行にその記憶は載らない", () => {
  const { db, entries, self, auditor } = objected(["capability"]);
  const [entry] = entries as [number];
  const candidate = behavior(db, self, entry);

  expect(() => completeRca(db, auditor, { findings: [{ material: [entry], root_cause: CAUSE }] }, "auditor", at, "worker")).toThrow("no act and no no_proposal");
  completeRca(db, auditor, { findings: [{ material: [entry], root_cause: CAUSE, no_proposal: true }] }, "auditor", at, "worker");
  completeRca(db, self, { findings: [{ material: [entry], root_cause: CAUSE }] }, "auditor", at, "worker");

  expect(judgmentRows(db, auditor.id).map((row) => row.line)).toEqual([`no_proposal: entries ${entry} — ${CAUSE}`]);
  expect(judgmentRows(db, self.id).map((row) => row.line)).toEqual([`entries ${entry} → behavior candidate #${candidate} — ${CAUSE}`]);
});

it("Knowledge を書いた所見は no_proposal 無しで完了できる", () => {
  const { db, entries, self } = objected(["missing_information"]);
  const note = knowledge(db, self, entries[0]!);

  completeRca(db, self, { findings: [{ material: [entries[0]!], root_cause: CAUSE }] }, "auditor", at, "worker");

  expect(judgmentRows(db, self.id).map((row) => row.judgment)).toEqual([
    { kind: "rca", material: [entries[0]], root_cause: CAUSE, memories: [{ id: note, kind: "knowledge" }], repairs: [] },
  ]);
});

it("所見が2つで決着した子が2つなら、両方の行に子の id と status が載り、no_proposal は受け取って載せない(RCA 単位の近似、#2279)", () => {
  const { db, entries, auditor } = objected([null, null]);
  const [fixed, dropped] = humanDecomposeTaskViaWebui(
    db,
    auditor,
    { reason: "fix it", children: ["fix", "drop"].map((title) => ({ title, purpose: "p", completion_criteria: "c" })) },
    at,
  );
  completeTask(db, fixed!, FULL_HANDOFF, "auditor", at, "worker");
  cancelTaskDirectly(db, dropped!, null, at, {}, "webui");

  completeRca(db, getTask(db, auditor.id)!, { findings: entries.map((entry) => ({ material: [entry], root_cause: CAUSE, no_proposal: true as const })) }, "auditor", at, "worker");

  expect(judgmentRows(db, auditor.id)).toEqual(
    entries.map((entry) => ({
      kind: "decision_logged",
      line: `entries ${entry} → repair ${fixed!.id}, repair ${dropped!.id} — ${CAUSE}`,
      judgment: {
        kind: "rca",
        material: [entry],
        root_cause: CAUSE,
        memories: [],
        repairs: [
          { id: fixed!.id, status: "done" },
          { id: dropped!.id, status: "cancelled" },
        ],
      },
    })),
  );
});

it("未決着の子があれば拒まれ、判断の行も書かれない —— 行と完了は1つの transaction", () => {
  const { db, entries, auditor } = objected([null]);
  humanDecomposeTaskViaWebui(db, auditor, { reason: "fix it", children: [{ title: "fix", purpose: "p", completion_criteria: "c" }] }, at);
  const before = listEvents(db, auditor.id).length;

  expect(() => completeRca(db, getTask(db, auditor.id)!, { findings: [{ material: [entries[0]!], root_cause: CAUSE }] }, "auditor", at, "worker")).toThrow("unfinished children");
  expect(listEvents(db, auditor.id)).toHaveLength(before);
});

it("RCA でない review・空の root_cause・エントリの無い所見は拒まれる", () => {
  const { db, work, entries, self } = objected(["capability"]);
  markPickedUp(db, work.id, at);
  const review = registerTask(db, { type: "review", title: "look again", purpose: "p", completion_criteria: "c", parent_id: work.id }, at, ...HUMAN_WEBUI);

  expect(() => completeRca(db, review, { findings: [] }, "auditor", at, "worker")).toThrow("only an RCA completes with complete_rca");
  expect(() => completeRca(db, self, { findings: [{ material: entries, root_cause: " ", no_proposal: true }] }, "auditor", at, "worker")).toThrow("root_cause");
  expect(() =>
    completeRca(db, self, { findings: [{ material: entries, root_cause: CAUSE, no_proposal: true }, { material: [], root_cause: CAUSE, no_proposal: true }] }, "auditor", at, "worker"),
  ).toThrow("a finding names no entries");
});
