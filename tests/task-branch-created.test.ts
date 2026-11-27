import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents, listEventsOfKinds } from "../src/events.js";
import { completeTask, derivedWorkspace, fillEmptyWorkspace, getTask, humanDecomposeTask, pickupTask, registerTask, returnToQueue, type Task } from "../src/tasks.js";
import { recordTaskCheckoutTip, releaseWorkspace, resolveTaskBranchLineage, workspaceNeedsHuman } from "../src/workspace.js";
import { api, bootTidepool, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, HUMAN_WEBUI, humanDecomposeTaskViaWebui, makeWorkspace, prepareAtPickup, seedTaskBranch } from "./harness.js";

// ADR 0372 決定2〜4 / ADR 0375 決定2: タスクブランチを作ったら `task_branch_created` を残し、系譜はこの event と列で読む(#3418)

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-20T00:00:00.000Z");

function work(db: Db, title: string, extra: { parent_id?: string; workspace?: string; assignee?: string } = {}): Task {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done", ...extra }, NOW, ...HUMAN_WEBUI);
}

function branchEvents(db: Db, taskId: string) {
  return listEvents(db, taskId).filter((e) => e.kind === "task_branch_created").map((e) => e.payload);
}

it("pickup が自分のタスクブランチを作ると、作成時の sha と workspace の名前を持つ task_branch_created を残す", async () => {
  const ws = await makeWorkspace("branch-created-own");
  const db = openDb(":memory:");
  const task = pickupTask(db, work(db, "root"), "deckhand", NOW, { workspace: ws.name })!;

  await prepareAtPickup(db, ws, task);

  expect(branchEvents(db, task.id)).toEqual([
    { kind: "task_branch_created", sha: git(ws.path, "rev-parse", `task/${task.id}`), workspace: ws.name },
  ]);
  expect(getTask(db, task.id)!.workspace).toBe(ws.name);
  db.close();
});

it("木を先に登録すると、子の pickup が根の列・task/<根>・event を保護ブランチから固定し、子は task/<根> から切られて帰り、根の後の pickup は同じブランチを使う(ADR 0372 決定3)", async () => {
  const ws = await makeWorkspace("branch-created-tree");
  const db = openDb(":memory:");
  const root = work(db, "root");
  const child = pickupTask(db, work(db, "child", { parent_id: root.id }), "deckhand", NOW, { workspace: ws.name })!;
  const main = git(ws.path, "rev-parse", "main");

  const place = await prepareAtPickup(db, ws, child, { defaultWorkspaceName: ws.name });

  expect(getTask(db, root.id)!.workspace).toBe(ws.name);
  expect(branchEvents(db, root.id)).toEqual([{ kind: "task_branch_created", sha: main, workspace: ws.name, column_filled_from: "default" }]);
  expect(git(ws.path, "rev-parse", `task/${child.id}`)).toBe(main);

  commitWork(place.path, "child.txt", "child work\n");
  recordTaskCheckoutTip(db, place, child.id);
  releaseWorkspace(db, place, child, NOW, true, undefined, undefined, true);
  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "show", `task/${root.id}:child.txt`)).toBe("child work");

  const merged = git(ws.path, "rev-parse", `task/${root.id}`);
  const rootPlace = await prepareAtPickup(db, ws, pickupTask(db, getTask(db, root.id)!, "deckhand", NOW, { workspace: ws.name })!, { defaultWorkspaceName: ws.name });
  expect(git(rootPlace.path, "rev-parse", "HEAD")).toBe(merged);
  expect(branchEvents(db, root.id)).toHaveLength(1);
  db.close();
});

it("深い木は上から固定し、下の祖先の列の出所は上で固定した祖先の id になる(ADR 0372 決定2・3)", async () => {
  const ws = await makeWorkspace("branch-created-deep");
  const db = openDb(":memory:");
  const top = work(db, "top");
  const middle = work(db, "middle", { parent_id: top.id });
  const child = pickupTask(db, work(db, "child", { parent_id: middle.id }), "deckhand", NOW, { workspace: ws.name })!;
  const main = git(ws.path, "rev-parse", "main");

  await prepareAtPickup(db, ws, child, { defaultWorkspaceName: ws.name });

  const fixed = listEventsOfKinds(db, ["task_branch_created"]).map((e) => [e.task_id, e.payload]);
  expect(fixed).toEqual([
    [top.id, { kind: "task_branch_created", sha: main, workspace: ws.name, column_filled_from: "default" }],
    [middle.id, { kind: "task_branch_created", sha: main, workspace: ws.name, column_filled_from: top.id }],
    [child.id, { kind: "task_branch_created", sha: main, workspace: ws.name }],
  ]);
  expect([getTask(db, top.id)!.workspace, getTask(db, middle.id)!.workspace]).toEqual([ws.name, ws.name]);
  db.close();
});

it("祖先のブランチを作れなければ pickup の準備が投げ、その祖先の列・ref・event も子のブランチも残らない —— 上で固定した祖先は揃ったまま(ADR 0372 決定3)", async () => {
  const ws = await makeWorkspace("branch-created-fail");
  const db = openDb(":memory:");
  const top = work(db, "top");
  const middle = work(db, "middle", { parent_id: top.id });
  const child = pickupTask(db, work(db, "child", { parent_id: middle.id }), "deckhand", NOW, { workspace: ws.name })!;
  // 最初の撮りより前に置く —— 基準に入るので、門でなく task/<middle> の作成(D/F の衝突)で落ちる
  git(ws.path, "branch", `task/${middle.id}/blocker`);

  await expect(prepareAtPickup(db, ws, child, { defaultWorkspaceName: ws.name })).rejects.toThrow(`task/${middle.id}`);

  expect(getTask(db, middle.id)!.workspace).toBeNull();
  expect(branchEvents(db, middle.id)).toEqual([]);
  expect(git(ws.path, "for-each-ref", "--format=%(refname)", `refs/heads/task/${middle.id}`, `refs/heads/task/${child.id}`)).toBe(`refs/heads/task/${middle.id}/blocker`);
  expect(branchEvents(db, child.id)).toEqual([]);
  expect([getTask(db, top.id)!.workspace, branchEvents(db, top.id).length, git(ws.path, "rev-parse", `task/${top.id}`)]).toEqual([ws.name, 1, git(ws.path, "rev-parse", "main")]);
  db.close();
});

it("pickup が ref を作る前に止まった task は task_branch_created を持たず、後で分解したその子の pickup が保護ブランチの tip から固定する —— pickup の event をブランチと読まない(ADR 0372 決定2 / ADR 0274)", async () => {
  const ws = await makeWorkspace("branch-created-stopped");
  const db = openDb(":memory:");
  const parent = pickupTask(db, work(db, "parent"), "deckhand", NOW, { workspace: ws.name })!;
  writeFileSync(join(ws.path, "resting.txt"), "written while resting\n");
  await expect(prepareAtPickup(db, ws, parent, { defaultWorkspaceName: ws.name })).rejects.toThrow(/uncommitted changes while resting/);
  returnToQueue(db, parent, { kind: "pickup_stopped", quarantine: "workspace", value: ws.name, reason: "resting change" }, NOW);
  rmSync(join(ws.path, "resting.txt"));
  expect(branchEvents(db, parent.id)).toEqual([]);

  const [child] = humanDecomposeTask(db, getTask(db, parent.id)!, { reason: "split", children: [{ title: "child", purpose: "why", completion_criteria: "done" }] }, NOW, "webui");
  await prepareAtPickup(db, ws, pickupTask(db, child!, "deckhand", NOW, { workspace: ws.name })!, { defaultWorkspaceName: ws.name });

  expect(branchEvents(db, parent.id)).toEqual([{ kind: "task_branch_created", sha: git(ws.path, "rev-parse", "main"), workspace: ws.name }]);
  db.close();
});

// 未決着の人間の祖先は固定される(ADR 0374 決定3)—— tests/human-work.test.ts の pin C5
it("決着した人間の task の下の work は系譜に飛ばされて保護ブランチから切られ、人間の祖先の列・ref・event は動かない(ADR 0372 決定4、#1827)", async () => {
  const ws = await makeWorkspace("branch-created-human");
  const db = openDb(":memory:");
  const human = work(db, "human", { assignee: HUMAN_ACTOR_ID });
  const child = pickupTask(db, work(db, "child", { parent_id: human.id }), "deckhand", NOW, { workspace: ws.name })!;
  completeTask(db, human, undefined, HUMAN_ACTOR_ID, NOW, "webui");

  await prepareAtPickup(db, ws, child, { defaultWorkspaceName: ws.name });

  expect(git(ws.path, "rev-parse", `task/${child.id}`)).toBe(git(ws.path, "rev-parse", "main"));
  expect(getTask(db, human.id)!.workspace).toBeNull();
  expect(branchEvents(db, human.id)).toEqual([]);
  expect(git(ws.path, "for-each-ref", "--format=%(refname)", `refs/heads/task/${human.id}`)).toBe("");
  expect(resolveTaskBranchLineage(db, ws, child, () => NOW)).toEqual({ branch: undefined, outlivedForkSource: false });
  db.close();
});

it("ref を書いて event の前に落ちた作成は、次の pickup が ref を書き直さずに今の sha で event を1つだけ足す(ADR 0372 決定2 / ADR 0329 決定2 と同じ形)", async () => {
  const ws = await makeWorkspace("branch-created-resume");
  const db = openDb(":memory:");
  const task = pickupTask(db, work(db, "root"), "deckhand", NOW, { workspace: ws.name })!;
  commitWork(ws.path, "side.txt", "side\n");
  git(ws.path, "branch", `task/${task.id}`, "HEAD~1");
  const sha = git(ws.path, "rev-parse", `task/${task.id}`);

  await prepareAtPickup(db, ws, task);
  await prepareAtPickup(db, ws, task);

  expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(sha);
  expect(branchEvents(db, task.id)).toEqual([{ kind: "task_branch_created", sha, workspace: ws.name }]);
  db.close();
});

it("別の workspace の列を持つ祖先は、task_branch_created を持っていても系譜に数えず、子は自分の workspace の保護ブランチから切られる(ADR 0372 決定4)", async () => {
  const a = await makeWorkspace("branch-created-ws-a");
  const b = await makeWorkspace("branch-created-ws-b");
  const db = openDb(":memory:");
  const parent = work(db, "parent", { workspace: a.name });
  seedTaskBranch(db, a, parent.id);
  const legacyChild = work(db, "child", { parent_id: parent.id });
  fillEmptyWorkspace(db, legacyChild.id, b.name);
  const child = pickupTask(db, getTask(db, legacyChild.id)!, "deckhand", NOW)!;

  await prepareAtPickup(db, b, child, { defaultWorkspaceName: b.name });

  expect(git(b.path, "rev-parse", `task/${child.id}`)).toBe(git(b.path, "rev-parse", "main"));
  expect(resolveTaskBranchLineage(db, b, child, () => NOW)).toEqual({ branch: undefined, outlivedForkSource: false });
  db.close();
});

it("既定の差し替え: pickup 前の未着手の木は差し替えた既定へ一緒に動く(ADR 0372 決定1)", async () => {
  const b = await makeWorkspace("branch-created-swap-before");
  const db = openDb(":memory:");
  const root = work(db, "root");
  const first = work(db, "first", { parent_id: root.id });
  const second = work(db, "second", { parent_id: root.id });
  expect([root, first, second].map((task) => derivedWorkspace(db, task))).toEqual([null, null, null]);

  await prepareAtPickup(db, b, pickupTask(db, first, "deckhand", NOW, { workspace: b.name })!, { defaultWorkspaceName: b.name });

  expect([getTask(db, root.id)!.workspace, getTask(db, first.id)!.workspace, derivedWorkspace(db, getTask(db, second.id)!)]).toEqual([b.name, b.name, b.name]);
  db.close();
});

it("既定の差し替え: 子の pickup で固定された親は差し替え後も動かず、兄弟の木も親の workspace に導かれ、間の未着手の祖先を固定してそこから切られる(ADR 0372 決定1・3・4)", async () => {
  const a = await makeWorkspace("branch-created-swap-a");
  const b = await makeWorkspace("branch-created-swap-b");
  const db = openDb(":memory:");
  const root = work(db, "root");
  const first = work(db, "first", { parent_id: root.id });
  const second = work(db, "second", { parent_id: root.id });
  const grandchild = work(db, "grandchild", { parent_id: second.id });
  await prepareAtPickup(db, a, pickupTask(db, first, "deckhand", NOW, { workspace: a.name })!, { defaultWorkspaceName: a.name });

  // 既定を b に差し替えた盤面の pickup
  const picked = pickupTask(db, grandchild, "deckhand", NOW, { workspace: b.name })!;
  await prepareAtPickup(db, a, picked, { defaultWorkspaceName: b.name });

  expect([getTask(db, root.id)!.workspace, getTask(db, second.id)!.workspace, picked.workspace]).toEqual([a.name, a.name, a.name]);
  expect(branchEvents(db, second.id)).toEqual([{ kind: "task_branch_created", sha: git(a.path, "rev-parse", "main"), workspace: a.name, column_filled_from: root.id }]);
  expect(resolveTaskBranchLineage(db, a, picked, () => NOW).branch).toBe(`task/${second.id}`);
  db.close();
});

it("review の pickup は未着手の祖先を固定しない(ADR 0372 決定3)", async () => {
  const ws = await makeWorkspace("branch-created-review");
  const db = openDb(":memory:");
  const root = work(db, "root");
  const review = registerTask(db, { type: "review", title: "review", purpose: "why", completion_criteria: "done", parent_id: root.id }, NOW, BOARD_ACTOR_ID, "board");

  await prepareAtPickup(db, ws, pickupTask(db, review, "fugu", NOW, { workspace: ws.name })!, { defaultWorkspaceName: ws.name });

  expect(getTask(db, root.id)!.workspace).toBeNull();
  expect(branchEvents(db, root.id)).toEqual([]);
  expect(git(ws.path, "for-each-ref", "--format=%(refname)", `refs/heads/task/${root.id}`)).toBe("");
  db.close();
});

// server boundary: 既定の名前は scheduler が渡す —— domain の試験は harness で手渡すので、渡し忘れはここでしか見えない
it("盤面の pickup は既定の workspace を祖先の導出に渡し、列の無い根を既定で固定する(ADR 0372 決定1・3)", async () => {
  const ws = await makeWorkspace("branch-created-scheduler");
  const t = await bootTidepool({ workspace: ws });
  onTestFinished(() => t.stop());
  const root = registerTask(t.db, { type: "work", title: "root", purpose: "why", completion_criteria: "done" }, t.clock.now(), ...HUMAN_WEBUI);
  const [child] = humanDecomposeTaskViaWebui(t.db, root, { reason: "split", children: [{ title: "child", purpose: "why", completion_criteria: "done" }] }, t.clock.now());

  await t.clock.advance(HOUR);

  expect(t.worker.started.map((task) => task.id)).toEqual([child!.id]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json as Array<{ kind: string; payload: unknown }>;
  expect(events.filter((e) => e.kind === "task_branch_created").map((e) => e.payload)).toEqual([
    { kind: "task_branch_created", sha: git(ws.path, "rev-parse", `task/${root.id}`), workspace: ws.name, column_filled_from: "default" },
  ]);
});
