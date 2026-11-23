import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { listEventsOfKinds } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding, type LandingDeps } from "../src/landing.js";
import { type AuthorityProfile, type MergeDial, UnknownAgentError } from "../src/registry.js";
import { completeTask, getTask, landingSurface, listBoard, registerTask } from "../src/tasks.js";
import { FakeGitHubClient } from "./fakes.js";
import { checkoutTaskBranch, commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeLandingWorkspace, makeWorkspace } from "./harness.js";
import { agentQuarantines, answerMergeQuestion, convergeOn, mergeQuestions, openBoard, profile, pushPrHead, readOnNextTick } from "./landing-fixture.js";

// ADR 0374 決定12・13 / spec #3273 group C(#3295): タスクブランチを持つ人間担当の work は根になり、profile なしで、常に merge question で
// 着地する。domain 層の釘(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

it.each<MergeDial | undefined>(["escalate", "auto_if_ci_green", "external", undefined])("着地の面は 保護 → 人間の根 → dial の順に読む —— 人間の根は dial %s でも merge question で、保護なら保護の理由", (dial) => {
  expect(landingSurface(false, true, dial, 0)).toEqual({ surface: "merge_question", reason: "human_root" });
  expect(landingSurface(true, true, dial, 0)).toEqual({ surface: "merge_question", reason: "protected" });
});

/** registry の盤面: 名前 `tako` だけが解決し、ほかの名前は registry と同じく `UnknownAgentError` で落ちる。 */
const registry = (assignee: string | null): AuthorityProfile => {
  if (assignee === null || assignee === "tako") return profile("auto_if_ci_green");
  throw new UnknownAgentError(assignee);
};

/** タスクブランチを持って人間が完了した根 —— 既定は remote-backed、`local` なら purely-local の workspace。`content` なら保護ブランチに無い
 *  commit を1つ載せる。 */
async function humanRoot(name: string, deps: Partial<LandingDeps> = {}, { content = true, local = false } = {}) {
  const workspace = local ? await makeWorkspace(name) : (await makeLandingWorkspace(name)).workspace;
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, ...deps });
  const root = registerTask(db, { type: "work", title: "by hand", purpose: "p", completion_criteria: "c", assignee: HUMAN_ACTOR_ID }, clock.now(), ...HUMAN_WEBUI);
  checkoutTaskBranch(db, workspace, root.id);
  if (content) commitWork(workspace.path, "feature.txt", "ready\n");
  completeTask(db, getTask(db, root.id)!, FULL_HANDOFF, HUMAN_ACTOR_ID, clock.now(), "webui");
  return { workspace, db, clock, github, landing, root };
}

const textC5Remote = (pr: number) => `"by hand" was completed by a human and PR #${pr} is open. A human-completed root is merged only on your answer. Merge, or hold?`;

it.each([
  ["registry の無い盤面", undefined],
  ["registry の盤面", registry],
  ["全 agent が external の盤面", () => profile("external")],
] as const)("%s でも、人間の根は PR を開いた記録から merge question を持ち、無人 merge キューに入らず、名前 human の agent の Quarantine も立たない —— pr_opened は盤面の名義で origin board(pin C8・C16・C20、ADR 0400 決定2)", async (_, resolveAuthority) => {
  const { workspace, db, github, landing, root } = await humanRoot("landing-human-root", { resolveAuthority });

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: 1 });

  expect(git(workspace.head_repo!, "rev-parse", `refs/heads/task/${root.id}`)).toBe(git(workspace.path, "rev-parse", `refs/heads/task/${root.id}`));
  expect(git(workspace.repo!, "for-each-ref", "refs/heads/task/")).toBe("");

  expect(mergeQuestions(db)).toEqual([{ pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "merge", purpose: textC5Remote(1) }]);
  expect(listEventsOfKinds(db, ["pr_opened"]).map((e) => [e.task_id, e.actor_id, e.origin])).toEqual([[root.id, BOARD_ACTOR_ID, "board"]]);
  expect(agentQuarantines(db)).toEqual([]);
  expect(await readOnNextTick(landing, github)).toEqual([]);
});

it("盤面が記録していない PR が task/<H> の head に在れば、その PR にも merge question が立つ(pin C16)", async () => {
  const { workspace, db, github, landing, root } = await humanRoot("landing-human-root-found", { resolveAuthority: registry });
  pushPrHead(github, workspace, root.id, 7);

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: 7 });

  expect(github.requests).toEqual([]);
  expect(mergeQuestions(db).map((q) => [q.pr, q.purpose])).toEqual([[7, textC5Remote(7)]]);
});

it("保護された workspace の人間の根は、保護の本文の merge question を持つ —— 保護を先に読む(pin C20)", async () => {
  const { db, landing, root } = await humanRoot("landing-human-root-protected", { isProtectedWorkspace: () => true });

  await convergeOn(landing, root.id);

  expect(mergeQuestions(db).map((q) => q.purpose)).toEqual([
    `"by hand" completed and opened PR #1 against a protected workspace — always needs a human merge, regardless of the merge dial. Merge it now?`,
  ]);
});

it("purely-local の保護された workspace の人間の根は、C5 でなく dial の無い根と同じ汎用の本文の local merge question を持つ —— 保護を先に読む", async () => {
  const { workspace, db, landing, root } = await humanRoot("landing-human-root-local-protected", { isProtectedWorkspace: () => true }, { local: true });

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "landed", form: "local_merge_question" });

  expect(listBoard(db).filter((q) => q.question_pending_local_merge_task_id === root.id).map((q) => q.purpose)).toEqual([
    `Workspace "${workspace.name}" is purely-local and has no GitHub merge surface for "by hand". Land its task branch on the protected branch now?`,
  ]);
});

it("着地する内容の無い人間の根は nothing_to_land で終わる", async () => {
  const { github, landing, root } = await humanRoot("landing-human-root-nothing", { resolveAuthority: registry }, { content: false });

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(github.requests).toEqual([]);
});

it("人間の根の merge question は merge の回答の時点で CI を読み、赤なら拒み、hold はいつでも答えられる(ADR 0374 決定13)", async () => {
  const root = await humanRoot("landing-human-root-answer", { resolveAuthority: registry });
  await convergeOn(root.landing, root.root.id);
  root.github.scriptCiStatus("failure");

  await expect(answerMergeQuestion(root)).rejects.toThrow(/CI/);
  const question = getTask(root.db, listBoard(root.db).find((q) => q.question_pending_merge_pr === 1)!.id)!;
  const held = await submitAnswer({ db: root.db, pollNow: () => {}, landing: root.landing, workspace: root.workspace, github: root.github }, question, ["hold"], undefined, () => root.clock.now(), "webui");

  expect(held.status).toBe("done");
  expect(agentQuarantines(root.db)).toEqual([]);
});
