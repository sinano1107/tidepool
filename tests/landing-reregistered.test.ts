import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding, rootPrOutcome, settledByObservation } from "../src/landing.js";
import { getTask, listBoard, registerMergeQuestion, type Task } from "../src/tasks.js";
import { FakeGitHubClient } from "./fakes.js";
import { checkoutTaskBranch, commitWork, GIT_FIXTURE_TEST_TIMEOUT, makeLandingWorkspace, makeRemoteBackedWorkspace } from "./harness.js";
import { finish, landingWork, openBoard, pushPrHead, recordPrOpenedOutsideConvergence, registeredReef, reRegister } from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定2: 根を指す記録は根の id で持つ。名前を別の repo で登録し直した後、新しい repo の新しい根が旧い根と同じ番号の PR を
// 開いても、merge question・処理中の印・merge の回答・観測決着はそれぞれ自分の根に当たる(spec #3595 の振る舞い 2)。
/** PR #1 を開いた旧い根を残して `reef` を削除の扉 → 登録の扉で別の repo の checkout に登録し直し、新しい repo で新しい根が PR #1 を
 *  開いた盤面。旧い根の merge question は登録し直しの後に立つ —— 開いた merge question は workspace を参照する未決着タスクとして
 *  削除の扉を止める(ADR 0087 決定2)。 */
async function reRegisteredWithSameNumber() {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const { workspace: moved } = await makeLandingWorkspace("reef-new");
  const reef = await registeredReef(old);
  const { resolve } = reef;
  const github = new FakeGitHubClient();

  // `external` の根は merge question もキューの行も持たないので、削除の扉を止めずに生き残る(ADR 0370 決定1)
  const oldRoot = finish(db, clock, landingWork(db, clock, "reef"));
  recordPrOpenedOutsideConvergence(db, oldRoot, 1, clock.now(), { authority: { merge: "external" }, workspace: old });

  // 盤面は出元 repo(head_repo)へ push する(ADR 0395 決定2)—— 登録し直しは出元 repo も足す
  await reRegister(db, reef, moved);

  const oldQuestion = registerMergeQuestion(
    db, getTask(db, oldRoot.id)!, { pr: 1, tip: null, outside: null, missingBranches: null, reason: "surface_changed" }, "merge the old root?", "merge", clock.now(),
  );
  const workspace = resolve("reef");
  const newRoot = landingWork(db, clock, "reef");
  checkoutTaskBranch(db, workspace, newRoot.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const done = finish(db, clock, newRoot);
  const head = pushPrHead(github, workspace, newRoot.id, 1);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "escalate" }, head });

  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: resolve, github });
  const answer = (questionId: string, option: "merge" | "hold") =>
    submitAnswer(
      { db, pollNow: () => {}, landing, resolveWorkspace: resolve, github, workspacesDir: join(reef.admin.workspacesBaseDir, "workbenches") },
      getTask(db, questionId)!, [option], undefined, () => clock.now(), "webui",
    );
  return { db, github, landing, answer, workspace, oldRoot, oldQuestion, newRoot: getTask(db, newRoot.id)! };
}

const openMergeQuestions = (db: Db) => listBoard(db).filter((q) => q.question_pending_merge_pr === 1 && q.status === "todo");
const mergeQuestionOf = (db: Db, root: Task) => openMergeQuestions(db).find((q) => q.question_pending_merge_task_id === root.id)!.id;

it("登録し直した名前で新しい根が旧い根と同じ番号の PR を開いても、merge question は旧い根の question に吸われず、自分の根を持って立つ", async () => {
  const { db, oldRoot, oldQuestion, newRoot } = await reRegisteredWithSameNumber();

  expect(openMergeQuestions(db).map((q) => [q.id === oldQuestion, q.question_pending_merge_task_id])).toEqual([
    [true, oldRoot.id],
    [false, newRoot.id],
  ]);
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
