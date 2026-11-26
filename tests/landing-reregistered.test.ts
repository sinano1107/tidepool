import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding, landingState, rootPrOutcome, settledByObservation } from "../src/landing.js";
import { getTask, listBoard, type Task } from "../src/tasks.js";
import { FakeGitHubClient } from "./fakes.js";
import { checkoutTaskBranch, commitWork, GIT_FIXTURE_TEST_TIMEOUT, makeLandingWorkspace, makeRemoteBackedWorkspace } from "./harness.js";
import { finish, landingWork, openBoard, pushPrHead, recordPrOpenedOutsideConvergence, registeredReef, reRegister } from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定2: 根を指す記録は根の id で持つ。名前を別の repo で登録し直した後、新しい repo の新しい根が旧い根と同じ番号の PR を
// 開いても、merge question・処理中の印・merge の回答・観測決着はそれぞれ自分の根に当たる(spec #3595 の振る舞い 2)。
/** PR #1 を開いて merge question に hold と答えた旧い根の着地を、`reef` の削除の扉が終えて(ADR 0421 決定1)、登録の扉で別の repo の
 *  checkout に登録し直し、新しい repo で新しい根が PR #1 を開いた盤面。旧い根の hold した question は閉じたまま残る。 */
async function reRegisteredWithSameNumber() {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const { workspace: moved } = await makeLandingWorkspace("reef-new");
  const reef = await registeredReef(old);
  const { resolve } = reef;
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github });
  const answer = (questionId: string, option: "merge" | "hold") =>
    submitAnswer(
      { db, pollNow: () => {}, landing, resolveWorkspace: resolve, github, workspacesDir: join(reef.admin.workspacesBaseDir, "workbenches") },
      getTask(db, questionId)!, [option], undefined, () => clock.now(), "webui",
    );

  const oldRoot = finish(db, clock, landingWork(db, clock, "reef"));
  recordPrOpenedOutsideConvergence(db, oldRoot, 1, clock.now(), { authority: { merge: "escalate" }, workspace: old });
  const oldQuestion = mergeQuestionOf(db, oldRoot);
  await answer(oldQuestion, "hold");

  // 盤面は出元 repo(head_repo)へ push する(ADR 0395 決定2)—— 登録し直しは出元 repo も足す
  await reRegister(db, reef, moved, undefined, landing);
  expect(landingState(db, getTask(db, oldRoot.id)!)).toBe("workspace_deleted");

  const workspace = resolve("reef");
  const newRoot = landingWork(db, clock, "reef");
  checkoutTaskBranch(db, workspace, newRoot.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const done = finish(db, clock, newRoot);
  const head = pushPrHead(github, workspace, newRoot.id, 1);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "escalate" }, head, workspace });
  return { db, github, landing, answer, workspace, oldRoot, oldQuestion, newRoot: getTask(db, newRoot.id)! };
}

const openMergeQuestions = (db: Db) => listBoard(db).filter((q) => q.question_pending_merge_pr === 1 && q.status === "todo");
const mergeQuestionOf = (db: Db, root: Task) => openMergeQuestions(db).find((q) => q.question_pending_merge_task_id === root.id)!.id;

it("登録し直した名前で新しい根が旧い根と同じ番号の PR を開いても、merge question は旧い根の question に吸われず、自分の根を持って立つ", async () => {
  const { db, oldQuestion, newRoot } = await reRegisteredWithSameNumber();

  expect(openMergeQuestions(db).map((q) => q.question_pending_merge_task_id)).toEqual([newRoot.id]);
  expect(getTask(db, oldQuestion)).toMatchObject({ status: "done", question_answer: ["hold"] });
  expect(settledByObservation(db, getTask(db, oldQuestion)!)).toBeNull();
});

it("旧い根が同じ番号の PR に処理中の印を持っていても、新しい根の merge question への merge は拒まれず、新しい根の PR を merge して新しい根に刻む", async () => {
  const { db, github, landing, answer, workspace, oldRoot, newRoot } = await reRegisteredWithSameNumber();
  const newQuestion = mergeQuestionOf(db, newRoot);
  const release = landing.takeInFlightMark(oldRoot.id)!;

  await answer(newQuestion, "merge");
  release();

  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
  expect(rootPrOutcome(db, newRoot.id)).toEqual({ state: "MERGED", observed: false, prNumber: 1 });
  expect(rootPrOutcome(db, oldRoot.id)).toBeNull();
});

it("新しい repo で閉じられた PR の決着は、回答の直前の観測で新しい根に刻まれ、新しい根の merge question は観測で閉じたと読める", async () => {
  const { db, github, answer, oldRoot, newRoot } = await reRegisteredWithSameNumber();
  const newQuestion = mergeQuestionOf(db, newRoot);
  github.scriptClosedOutside(1);

  await answer(newQuestion, "hold");

  expect(rootPrOutcome(db, newRoot.id)).toEqual({ state: "CLOSED", observed: true, prNumber: 1 });
  expect(rootPrOutcome(db, oldRoot.id)).toBeNull();
  expect(settledByObservation(db, getTask(db, newQuestion)!)).toBe("pr_close_observed");
});
