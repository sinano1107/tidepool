import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, callAsTask, FULL_HANDOFF, failTeardownMark, HOUR, registerWork, type Tidepool } from "./harness.js";

// issue #2025: 最終 verb の記録と後始末の印は同じ transaction —— 印が落ちれば記録も巻き戻り、印の無い決着済み session は残らない。

let t: Tidepool;
afterEach(() => t?.stop());

/** 盤面の全 task と、その event の全部。 */
async function boardRecord() {
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const events = await Promise.all(tasks.map(async (task: any) => (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json));
  return { tasks, events };
}

const childrenOf = async (id: string) => (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.parent_id === id);

/** verb を呼ぶ task を slot に載せ、その id と(盤面から決まる)verb の引数を返す。 */
type Arrange = () => Promise<{ id: string; args?: Record<string, unknown> }>;

const spec = (title: string) => ({ title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` });

const working: Arrange = async () => {
  const task = await registerWork(t, "T");
  await t.clock.advance(HOUR);
  return { id: task.id };
};

/** 分解済みの T の、走っている子 A。 */
const decomposedChild: Arrange = async () => {
  const { id: parent } = await working();
  await callAsTask(t, parent, "decompose", { reason: "split T", children: [spec("A")] });
  await t.clock.advance(HOUR);
  return { id: (await childrenOf(parent))[0].id };
};

/** 子 A が前提の破綻を宣言し、早期統合復帰した T。 */
const breached: Arrange = async () => {
  const { id: a } = await decomposedChild();
  await callAsTask(t, a, "declare_premise_breach", { reason: "module M is broken" });
  return { id: (await api(t.baseUrl, "GET", "/api/tasks")).json.find((task: any) => task.id === a).parent_id };
};

const opus46 = { provider: "anthropic", model: "claude-opus-4-6", effort: "high", tier: "frontier" };
const POSE = { title: "probe", probe: "write a parser", completion_criteria: "parses", rubric: "tests pass" };

/** 出題前の Interview の root。 */
const interview: Arrange = async () => {
  const root = await api(t.baseUrl, "POST", "/api/tasks", { type: "review", title: "interview", purpose: "p", completion_criteria: "c", interview_targets: [opus46] });
  await t.clock.advance(HOUR);
  return { id: root.json.id };
};

/** 出題し、受験者 C が完了して統合復帰した root。引数は C の採点。 */
const answered: Arrange = async () => {
  const { id: root } = await interview();
  const [c] = JSON.parse((await callAsTask(t, root, "pose_probe", POSE)).content[0].text).child_ids;
  await t.clock.advance(HOUR);
  await callAsTask(t, c, "complete_task", { handoff: FULL_HANDOFF });
  await t.clock.advance(HOUR);
  return { id: root, args: { scores: [{ child_id: c, outcome: "accepted" }], handoff: { outcome: "findings" } } };
};

it.each<[string, Arrange, Record<string, unknown>]>([
  ["complete_task", working, { handoff: FULL_HANDOFF }],
  ["escalate", working, { context: "c", questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }] }],
  ["decompose", working, { reason: "split T", children: [spec("X")] }],
  ["declare_premise_breach", decomposedChild, { reason: "module M is broken" }],
  ["continue_decomposition", breached, { line: "M is fine" }],
  ["redecompose", breached, { reason: "replan", children: [spec("X")] }],
  ["pose_probe", interview, POSE],
  ["complete_interview", answered, {}],
  ["report_broken_probe", async () => ({ id: (await answered()).id }), { reason: "the probe was broken", recommendation: "retry" }],
])("%s: 後始末の印の書き込みが落ちると verb の記録も残らず、タスクは in_progress のまま印も無い", async (verb, arrange, args) => {
  t = await bootTidepool();
  const arranged = await arrange();
  const before = await boardRecord();
  failTeardownMark(t.db); // setup(ADR 0107 決定4)

  const res = await callAsTask(t, arranged.id, verb, { ...arranged.args, ...args });

  // verb は印の書き込みまで届いている(domain の拒否ではない)
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("teardown mark failed");
  expect((await boardRecord()).tasks.find((task: any) => task.id === arranged.id).status).toBe("in_progress");
  expect(await boardRecord()).toEqual(before);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
});
