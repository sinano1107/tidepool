import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { createLanding } from "../src/landing.js";
import { quarantineStops } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, escalateTask, getTask, listBoard, pickupTask, recordPrOpened, registerTask, type Task } from "../src/tasks.js";
import { markTeardown, runTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { commitRoomCopy, quarantineWorkspace, recordTaskCheckoutTip, releaseWorkspace, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeGitHubClient, fakeHead, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, openTestInterviewRoom, pickUpInterviewRoot, poseAccepted, prepareAtPickup, quarantineQuestion, sessionId, WORKER_SPAWNED } from "./harness.js";

// ADR 0369 決定1〜3・6: 名前の場所の事情で済まなかった解放は、その workspace の Quarantine の受理の検査がやり直す。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const ESCALATION = { context: "need a decision", questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }] };

/** worker が task の checkout で `work.txt` を commit し、`wip` なら `wip.txt` を未 commit で残した session。`parent` なら未決着の親の
 *  work の下で走り、親のタスクブランチは main から立つ。`drifted` の間は名前を解けない。 */
async function sessionWithWork(name: string, { parent = false, wip = true, type = "work" }: { parent?: boolean; wip?: boolean; type?: "work" | "review" } = {}) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace(name);
  const spec = { purpose: "why", completion_criteria: "done", workspace: ws.name } as const;
  const parentId = parent ? registerTask(db, { ...spec, type: "work", title: "parent" }, clock.now(), ...HUMAN_WEBUI).id : undefined;
  if (parentId) git(ws.path, "branch", `task/${parentId}`, "main");
  const registered = registerTask(db, { ...spec, type, title: "owed", parent_id: parentId }, clock.now(), ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, ws, task, { now: clock.now() });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  commitWork(place.path, "work.txt", "work\n");
  if (wip) writeFileSync(join(place.path, "wip.txt"), "wip\n");
  const state = { drifted: false };
  const resolve = (taskWorkspace: string | null): WorkspaceConfig => {
    if (state.drifted) throw new UnknownWorkspaceError(taskWorkspace ?? ws.name);
    return ws;
  };
  const slot = new Slot();
  const deps: TeardownDeps = { db, clock, slot, resolve, pollNow: () => {} };
  return { db, clock, ws, task, place, checkout: place.path, branch: `task/${task.id}`, parentBranch: `task/${parentId}`, state, resolve, slot, deps };
}

type Session = Awaited<ReturnType<typeof sessionWithWork>>;

/** 決着した session の後始末を走らせる(枠を握り、印を立ててから)。 */
async function tearDown(s: Pick<Session, "db" | "clock" | "slot" | "deps" | "task">): Promise<void> {
  markTeardown(s.db, s.task.id, s.clock.now());
  s.slot.occupy(s.task.id, sessionId(s.db, s.task.id));
  s.slot.enterTeardown();
  await runTeardown(s.deps, s.task.id, teardownStep(s.db, s.task.id));
}

/** 開いている workspace の Quarantine に人間が答える(回答の verb と、その検査)。 */
function answerQuarantine(s: Pick<Session, "db" | "clock" | "resolve" | "ws"> & { workspacesDir?: string }, name = s.ws.name) {
  const question = quarantineQuestion(s.db, "workspace", name)!;
  const checks = quarantineChecks({ db: s.db, resolveWorkspace: s.resolve, clock: s.clock, workspacesDir: s.workspacesDir });
  return submitAnswer({ db: s.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: checks }, question, ["repaired by hand"], undefined, () => s.clock.now(), "webui");
}

const released = (db: Db, taskId: string) => listEvents(db, taskId).filter(({ kind }) => kind === "task_checkout_released").map(({ payload }) => payload);

/** 解放が名前の場所の事情で済まないようにし、直す手を返す: 名前が registry から消える(drift)か、名前の場所のタスクブランチを書けない
 *  (残った ref の lock —— 名前の場所の repo の故障)。 */
function breakNamedPlace(s: Session, how: "drift" | "broken"): () => void {
  if (how === "drift") {
    s.state.drifted = true;
    return () => {
      s.state.drifted = false;
    };
  }
  const lock = join(s.ws.path, ".git", "refs", "heads", `${s.branch}.lock`);
  writeFileSync(lock, "");
  return () => rmSync(lock);
}

it.each(["drift", "broken"] as const)("名前の場所の事情(%s)で済まなかったエスカレーションの解放は、修理の後の回答が運ぶ —— 再 pickup の checkout に commit 済みと未 commit の成果がある(ADR 0369 決定1)", async (how) => {
  const s = await sessionWithWork(`owed-${how}`);
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  const repair = breakNamedPlace(s, how);
  await tearDown(s);
  expect(existsSync(s.checkout)).toBe(true);
  expect(released(s.db, s.task.id)).toEqual([]);
  repair();

  await answerQuarantine(s);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
  expect(existsSync(s.checkout)).toBe(false);
  expect(git(s.ws.path, "show", `${s.branch}:work.txt`)).toBe("work");
  expect(git(s.ws.path, "show", `${s.branch}:wip.txt`)).toBe("wip");
  const repicked = await prepareAtPickup(s.db, s.ws, pickupTask(s.db, getTask(s.db, s.task.id)!, "deckhand", s.clock.now())!, { now: s.clock.now() });
  expect(readFileSync(join(repicked.path, "work.txt"), "utf8")).toBe("work\n");
  expect(readFileSync(join(repicked.path, "wip.txt"), "utf8")).toBe("wip\n");
});

// #3147 の場面: 同じ workspace の PR が着地を待ち、landing の poll が後始末より先に drift の Quarantine を立てる
it.each(["auto_merge", "outside_merge"] as const)("%s の poll が先に drift の Quarantine を立てても、修理の後の回答が済まなかった解放を運ぶ(ADR 0369 決定1)", async (poll) => {
  const s = await sessionWithWork(`owed-landing-${poll}`);
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  const waiting = registerTask(s.db, { type: "work", title: "ship", purpose: "why", completion_criteria: "done", workspace: s.ws.name }, s.clock.now(), ...HUMAN_WEBUI);
  recordPrOpened(s.db, waiting, 1, fakeHead(1), "worker", s.clock.now(), { merge: poll === "auto_merge" ? "auto_if_ci_green" : "escalate" }, undefined, "worker");
  const repair = breakNamedPlace(s, "drift");
  await createLanding({ defaultAgentName: "tako", db: s.db, clock: s.clock, resolveWorkspace: s.resolve, github: new FakeGitHubClient() }).tick(poll, s.clock.now());
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeDefined();
  await tearDown(s);
  repair();

  await answerQuarantine(s);

  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
  expect(existsSync(s.checkout)).toBe(false);
  expect(git(s.ws.path, "show", `${s.branch}:work.txt`)).toBe("work");
  expect(git(s.ws.path, "show", `${s.branch}:wip.txt`)).toBe("wip");
});

/** 名前の場所の基準と ref を比べる次の task の pickup(ADR 0351 決定2): 基準に無い ref の移動を名指して止まる。 */
const nextPickup = (s: Session) =>
  prepareAtPickup(s.db, s.ws, registerTask(s.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done", workspace: s.ws.name }, s.clock.now(), ...HUMAN_WEBUI), { now: s.clock.now() });

it("やり直しがまだ名前の場所の事情で落ちれば、回答は理由つきで拒まれ、question も checkout も残り、基準は撮り直されない(ADR 0369 決定3)", async () => {
  const s = await sessionWithWork("owed-still-broken");
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  breakNamedPlace(s, "broken");
  await tearDown(s);
  git(s.ws.path, "branch", "moved-by-hand", "main");

  const answer = answerQuarantine(s);

  await expect(answer).rejects.toThrow(DomainError);
  await expect(answer).rejects.toThrow(`${s.branch}.lock`);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeDefined();
  expect(readFileSync(join(s.checkout, "wip.txt"), "utf8")).toBe("wip\n");
  expect(released(s.db, s.task.id)).toEqual([]);
  await expect(nextPickup(s)).rejects.toThrow("refs/heads/moved-by-hand");
});

it("やり直しが worker の repo の故障で落ちれば、task の失敗にして回答は通る(ADR 0369 決定3 / ADR 0356 決定2)", async () => {
  const s = await sessionWithWork("owed-worker-broken");
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();
  rmSync(join(s.checkout, ".git"), { recursive: true });

  await answerQuarantine(s);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(listEvents(s.db, s.task.id).filter(({ kind }) => kind === "task_checkout_release_failed").map(({ payload }) => payload)).toEqual([
    { kind: "task_checkout_release_failed", path: s.checkout, reason: expect.stringContaining("has no git repository") },
  ]);
  expect(listBoard(s.db).filter((q) => q.parent_id === s.task.id && q.title.startsWith("task checkout could not be released"))).toHaveLength(1);
  expect(existsSync(s.checkout)).toBe(true);
});

/** 完了の門が worker の tip を名前の場所のタスクブランチへ引いて記録し、task を done にした(ADR 0359)。門の記録した tip を返す。 */
function completeThroughGate(s: Session): string {
  recordTaskCheckoutTip(s.db, s.place, s.task.id);
  completeTask(s.db, s.task, FULL_HANDOFF, "deckhand", s.clock.now(), "worker");
  return git(s.ws.path, "rev-parse", s.branch);
}

/** 名前の場所のタスクブランチを人間が動かす: 門の tip の上に commit を積む(`on top`)か、門の tip を含まない main へ戻す(`unreachable`)。 */
function moveTaskBranch(s: Session, how: "on top" | "unreachable"): void {
  if (how === "unreachable") return void git(s.ws.path, "update-ref", `refs/heads/${s.branch}`, "main");
  git(s.ws.path, "switch", "--quiet", s.branch);
  commitWork(s.ws.path, "by-hand.txt", "added during the quarantine\n");
  git(s.ws.path, "switch", "--quiet", "main");
}

it.each(["unmoved", "on top"] as const)("門を通った完了の後始末が drift で飛んでも、回答は checkout を消し、子の merge back が届く(タスクブランチ=%s、ADR 0369 決定1・3)", async (moved) => {
  const s = await sessionWithWork(`owed-completed-${moved.replace(" ", "-")}`, { parent: true, wip: false });
  completeThroughGate(s);
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();
  if (moved === "on top") moveTaskBranch(s, moved);

  await answerQuarantine(s);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
  expect(existsSync(s.checkout)).toBe(false);
  expect(git(s.ws.path, "show", `${s.parentBranch}:work.txt`)).toBe("work");
});

it("門を通った完了の後始末が drift で飛び、Quarantine の間にタスクブランチが門の tip を含まない所へ動けば、回答は両方の sha を示して拒まれ、checkout も基準も残る(ADR 0369 決定3)", async () => {
  const s = await sessionWithWork("owed-completed-unreachable", { parent: true, wip: false });
  const gateTip = completeThroughGate(s);
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();
  moveTaskBranch(s, "unreachable");
  git(s.ws.path, "branch", "moved-by-hand", "main");

  const answer = answerQuarantine(s);

  await expect(answer).rejects.toThrow(DomainError);
  await expect(answer).rejects.toThrow(`refs changed out of band — was: ${gateTip} refs/heads/${s.branch}, now: ${git(s.ws.path, "rev-parse", "main")} refs/heads/${s.branch}`);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeDefined();
  expect(existsSync(s.checkout)).toBe(true);
  expect(released(s.db, s.task.id)).toEqual([]);
  await expect(nextPickup(s)).rejects.toThrow("refs/heads/moved-by-hand");
});

it("session の間にタスクブランチが門の tip を含まない所へ動いた完了は、ref が tip を含み直すまで回答が拒まれ、含み直せば checkout が消える(ADR 0369 決定3・7)", async () => {
  const s = await sessionWithWork("owed-completed-moved-in-session", { wip: false });
  const gateTip = completeThroughGate(s);
  moveTaskBranch(s, "unreachable");
  await tearDown(s);
  expect(existsSync(s.checkout)).toBe(true);

  await expect(answerQuarantine(s)).rejects.toThrow(`refs changed out of band — was: ${gateTip} refs/heads/${s.branch}`);
  git(s.ws.path, "update-ref", `refs/heads/${s.branch}`, gateTip);
  await answerQuarantine(s);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
  expect(existsSync(s.checkout)).toBe(false);
});

it("運んだ checkout を消せなくても回答の merge back はやり直され、消せるようになった後の回答が消す(ADR 0369 決定7)", async () => {
  const s = await sessionWithWork("owed-delete-fails", { parent: true, wip: false });
  completeThroughGate(s);
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();
  const parent = join(s.checkout, "..");
  chmodSync(parent, 0o555);
  try {
    await expect(answerQuarantine(s)).rejects.toThrow(DomainError);
    expect(git(s.ws.path, "show", `${s.parentBranch}:work.txt`)).toBe("work");
    expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
    expect(existsSync(s.checkout)).toBe(true);
  } finally {
    chmodSync(parent, 0o755);
  }

  await answerQuarantine(s);

  expect(quarantineQuestion(s.db, "workspace", s.ws.name)).toBeUndefined();
  expect(existsSync(s.checkout)).toBe(false);
});

it("drift に加えて名前の場所の別の ref も帯域外で動いていれば、回答は成果を運び、基準の撮り直しがその ref を受け入れる(ADR 0369 決定7 / ADR 0351 決定4)", async () => {
  const s = await sessionWithWork("owed-drift-moved-ref");
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();
  git(s.ws.path, "branch", "moved-by-hand", "main");

  await answerQuarantine(s);

  expect(git(s.ws.path, "show", `${s.branch}:wip.txt`)).toBe("wip");
  expect(existsSync(s.checkout)).toBe(false);
  await expect(nextPickup(s)).resolves.toBeDefined();
});

it("退避が名前の場所の事情で落ちた完了済み review の唯一の写しを、修理の後の回答が運ぶ(ADR 0369 決定1)", async () => {
  const s = await sessionWithWork("owed-review", { type: "review" });
  completeTask(s.db, s.task, FULL_HANDOFF, "deckhand", s.clock.now(), "worker");
  const repair = breakNamedPlace(s, "broken");
  await tearDown(s);
  expect(released(s.db, s.task.id)).toEqual([]);
  repair();

  await answerQuarantine(s);

  expect(git(s.ws.path, "show", `${s.branch}:wip.txt`)).toBe("wip");
  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
  expect(existsSync(s.checkout)).toBe(false);
});

it("cancel された task の済まなかった解放も、回答が退避してから checkout を消す(ADR 0369 決定1)", async () => {
  const s = await sessionWithWork("owed-cancelled");
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  markTeardown(s.db, s.task.id, s.clock.now());
  cancelTaskDirectly(s.db, getTask(s.db, s.task.id)!, null, s.clock.now(), { defaultWorkspaceName: s.ws.name, defaultAgentName: "deckhand", quarantined: quarantineStops(s.db) }, "webui");
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();

  await answerQuarantine(s);

  expect(getTask(s.db, s.task.id)?.status).toBe("cancelled");
  expect(git(s.ws.path, "show", `${s.branch}:wip.txt`)).toBe("wip");
  expect(existsSync(s.checkout)).toBe(false);
});

it("前の session が残した checkout には回答が触れず、最後の session の済まなかった解放だけを運ぶ(ADR 0369 決定2)", async () => {
  const s = await sessionWithWork("owed-earlier-session");
  escalateTask(s.db, s.task, ESCALATION, "deckhand", s.clock.now(), "worker");
  const repair = breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();
  // 停止の門を通らずに次の session を組む(済まなかった解放を持つ task を止める pickup の門は ADR 0369 決定4 の別 ticket)
  const again = pickupTask(s.db, getTask(s.db, s.task.id)!, "deckhand", s.clock.now())!;
  const last = await prepareAtPickup(s.db, s.ws, again, { now: s.clock.now() });
  appendEvent(s.db, { taskId: s.task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: s.clock.now() });
  writeFileSync(join(last.path, "later.txt"), "later\n");
  escalateTask(s.db, again, ESCALATION, "deckhand", s.clock.now(), "worker");
  breakNamedPlace(s, "drift");
  await tearDown(s);
  repair();

  await answerQuarantine(s);

  expect(git(s.ws.path, "show", `${s.branch}:later.txt`)).toBe("later");
  expect(existsSync(last.path)).toBe(false);
  expect(readFileSync(join(s.checkout, "wip.txt"), "utf8")).toBe("wip\n");
  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: last.path }]);
});

/** 面接室で出題された受験者が task の checkout で `answer.txt` を commit した session。root は出題の後に解放済み。 */
async function examineeInRoom(name: string) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace(name);
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: ws.name, interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, clock.now(), ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const { room, base, place: rootPlace } = await pickUpInterviewRoot(db, root, ws);
  const [posed] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", clock.now(), "worker", commitRoomCopy(db, rootPlace, root.id)) as [Task];
  releaseWorkspace(db, rootPlace, root, clock.now());
  const task = pickupTask(db, posed, "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, room, task, { workspacesBaseDir: base, now: clock.now() });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  commitWork(place.path, "answer.txt", "answer\n");
  const slot = new Slot();
  const resolve = () => ws;
  const deps: TeardownDeps = { db, clock, slot, resolve, pollNow: () => {} };
  return { db, clock, ws, root, room, task, place, checkout: place.path, branch: `task/${task.id}`, resolve, slot, deps, workspacesDir: base };
}

it("未決着の受験者の済まなかった解放は、面接室の Quarantine の受理がやり直す(ADR 0369 決定2)", async () => {
  const s = await examineeInRoom("owed-examinee");
  const lock = join(s.room.path, ".git", "refs", "heads", `${s.branch}.lock`);
  writeFileSync(lock, "");
  await tearDown(s);
  expect(getTask(s.db, s.task.id)?.status).toBe("todo");
  expect(released(s.db, s.task.id)).toEqual([]);
  rmSync(lock);

  await answerQuarantine(s, s.root.id);

  expect(quarantineQuestion(s.db, "workspace", s.root.id)).toBeUndefined();
  expect(git(s.room.path, "show", `${s.branch}:answer.txt`)).toBe("answer");
  expect(released(s.db, s.task.id)).toEqual([{ kind: "task_checkout_released", path: s.checkout }]);
  expect(existsSync(s.checkout)).toBe(false);
});

it("決着した受験者の最後の checkout は、面接室の Quarantine の受理でも記録として残る(ADR 0276 決定4 / ADR 0369 決定2)", async () => {
  const s = await examineeInRoom("settled-examinee");
  recordTaskCheckoutTip(s.db, s.place, s.task.id);
  completeTask(s.db, s.task, FULL_HANDOFF, "deckhand", s.clock.now(), "worker");
  await tearDown(s);
  expect(existsSync(s.checkout)).toBe(true);
  quarantineWorkspace(s.db, s.root.id, new Error("repaired by hand"), s.clock.now());

  await answerQuarantine(s, s.root.id);

  expect(quarantineQuestion(s.db, "workspace", s.root.id)).toBeUndefined();
  expect(readFileSync(join(s.checkout, "answer.txt"), "utf8")).toBe("answer\n");
  expect(released(s.db, s.task.id)).toEqual([]);
});
