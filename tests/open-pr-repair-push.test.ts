import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import {
  api,
  attachChild,
  bootTidepool,
  commitWork,
  completeViaMcp,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  questions,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];

afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 盤面が焼いている ref スナップショット(ADR 0064 決定1)の行。 */
function refSnapshot(pool: Tidepool, workspaceName: string): string[] {
  const db = openDb(join(pool.dir, "board.sqlite"));
  try {
    const row = db
      .prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?")
      .get(workspaceName) as { ref_snapshot: string | null } | undefined;
    return (row?.ref_snapshot ?? "").split("\n").filter((line) => line !== "");
  } finally {
    db.close();
  }
}

/** 「着地し終えた根 work」を作る: review 付きで完了させ、その review の決着が着地を
 *  起こす(ADR 0092 決定1 の門)。remote-backed なら PR が1本開き、purely-local なら
 *  着地 question が立つ。 */
async function landedWork(workspace: WorkspaceConfig): Promise<any> {
  t = await bootTidepool({ workspace });
  const work = await registerWork(t, "ship reviewable work", undefined, true);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "v1\n");
  await completeViaMcp(t, work.id);
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === work.id,
  );
  await t.clock.advance(HOUR);
  await completeViaMcp(t, review.id, false);
  return (await api(t.baseUrl, "GET", `/api/tasks/${work.id}`)).json;
}

/** 着地済みの `work` に付いた修理を1本、拾って commit して完了させる。返すのは修理を
 *  拾った直後の ref スナップショット —— 完了で盤面が撮り直す前の姿である。 */
async function completeRepair(work: any, workspace: WorkspaceConfig): Promise<string[]> {
  const repair = attachChild(t, work.id, "repair the reviewed work");
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/move`, { after: null });
  await t.clock.advance(HOUR);
  const before = refSnapshot(t, workspace.name);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  const res: any = await completeViaMcp(t, repair.id);
  expect(res.isError ?? false).toBe(false);
  return before;
}

async function squashTaskIntoOrigin(workspace: WorkspaceConfig, taskId: string): Promise<void> {
  const merger = await mkdtemp(join(tmpdir(), "tidepool-open-pr-squash-"));
  dirs.push(merger);
  git(merger, "clone", workspace.repo!, ".");
  git(merger, "fetch", workspace.path, `task/${taskId}:landed`);
  git(merger, "merge", "--squash", "landed");
  git(merger, "commit", "-m", "squash landed work");
  git(merger, "push", "origin", "main");
}

async function changeProtectedFile(
  workspace: WorkspaceConfig,
  file: string,
  body: string,
): Promise<void> {
  const publisher = await mkdtemp(join(tmpdir(), "tidepool-protected-change-"));
  dirs.push(publisher);
  git(publisher, "clone", workspace.repo!, ".");
  writeFileSync(join(publisher, file), body);
  git(publisher, "add", file);
  git(publisher, "commit", "-m", `change ${file} after landing`);
  git(publisher, "push", "origin", "main");
}

it("PR が開いたままの祖先へ merge back された修理を、盤面が push して PR を更新する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "open-pr-push");
  const work = await landedWork(workspace);
  expect(t.github.requests).toHaveLength(1);

  const before = await completeRepair(work, workspace);

  // 修理はタスクブランチに載り、PR は増えず、盤面が origin へ押し直す
  expect(git(workspace.path, "show", `task/${work.id}:repair.txt`)).toBe("fixed");
  expect(t.github.requests).toHaveLength(1);
  expect(t.github.pushes).toEqual([{ path: workspace.path, branch: `task/${work.id}` }]);
  const head = git(workspace.path, "rev-parse", `task/${work.id}`);
  // ADR 0064 決定4: 盤面自身の push を、盤面が自分の記録に撮り直している
  expect(refSnapshot(t, workspace.name)).toContain(`${head} refs/remotes/origin/task/${work.id}`);
});

it("push のあとに別タスクの slot 解放が走っても、盤面自身の push は帯域外違反にならない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "push-then-release");
  const work = await landedWork(workspace);
  await completeRepair(work, workspace);

  const next = await registerWork(t, "the next slice");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "next.txt", "more\n");
  await completeViaMcp(t, next.id);

  // quarantine なら着地そのものが飛ぶ —— 2本目の PR が開いたことが素通りの証拠
  expect(t.github.requests).toHaveLength(2);
  expect((await questions(t)).filter((q: any) => q.status === "todo")).toEqual([]);
});

it("purely-local の同じ構図では push もリモート記録の変更も起きない", async () => {
  const workspace = await makeWorkspace(dirs, "local-repair");
  const work = await landedWork(workspace);
  expect(work.pr_number).toBeNull();

  const before = await completeRepair(work, workspace);

  expect(git(workspace.path, "show", `task/${work.id}:repair.txt`)).toBe("fixed");
  expect(t.github.pushes).toEqual([]);
  expect(refSnapshot(t, workspace.name)).toEqual(before);
});

it("祖先の PR が既に merge 済みなら push しない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "merged-pr");
  const work = await landedWork(workspace);
  t.github.scriptMergedOutside(work.pr_number);

  await completeRepair(work, workspace);

  expect(t.github.pushes).toEqual([]);
  expect(t.github.mergeChecks).toContainEqual({ path: workspace.path, number: work.pr_number });
});

it("squash merge 後に review 子が決着しただけの再発火は、push も question も event も増やさない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "merged-pr-review-settlement");
  t = await bootTidepool({ workspace });
  const work = await registerWork(t, "ship work reviewed after PR open");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "v1\n");
  await completeViaMcp(t, work.id);
  const landed = (await api(t.baseUrl, "GET", `/api/tasks/${work.id}`)).json;
  const review = attachChild(t, work.id, "review already-landed work", undefined, "review");
  await squashTaskIntoOrigin(workspace, work.id);
  t.github.scriptMergedOutside(landed.pr_number);
  await api(t.baseUrl, "POST", `/api/tasks/${review.id}/move`, { after: null });
  await t.clock.advance(HOUR);
  await completeViaMcp(t, review.id, false);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.pushes).toEqual([]);
  expect((await questions(t)).filter((q: any) => q.status === "todo")).toEqual([]);
  expect(
    (await api(t.baseUrl, "GET", `/api/tasks/${work.id}/events`)).json.filter(
      (event: any) => event.kind === "nothing_to_land",
    ),
  ).toEqual([]);
});

it("走行中に fork 元が squash merge された修理は、保護ブランチへ追いついて自分の差分だけの PR を開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "squash-catch-up");
  const work = await landedWork(workspace);
  const repair = attachChild(t, work.id, "repair after squash landing");
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/move`, { after: null });
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${work.id}`),
  );

  await squashTaskIntoOrigin(workspace, work.id);
  t.github.scriptMergedOutside(work.pr_number);
  commitWork(workspace.path, "repair.txt", "fixed after squash\n");
  const completed: any = await completeViaMcp(t, repair.id);
  expect(completed.isError ?? false).toBe(false);

  expect(t.github.requests.at(-1)).toMatchObject({
    branch: `task/${repair.id}`,
    base: "main",
  });
  expect(
    git(
      workspace.path,
      "diff",
      "--name-only",
      `refs/remotes/origin/main...task/${repair.id}`,
    ),
  ).toBe("repair.txt");
  const [head, firstParent, secondParent] = git(
    workspace.path,
    "rev-list",
    "--parents",
    "-n",
    "1",
    `task/${repair.id}`,
  ).split(" ");
  expect(secondParent).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expect(firstParent).not.toBe(secondParent);
  expect(refSnapshot(t, workspace.name)).toContain(`${head} refs/heads/task/${repair.id}`);
  expect((await questions(t)).filter((q: any) => q.status === "todo")).toEqual([]);
});

it("追いつき merge が合わなければ PR 昇格失敗 question を立て、手動解決後の retry で PR を開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "squash-catch-up-conflict");
  const work = await landedWork(workspace);
  const repair = attachChild(t, work.id, "repair conflicting after squash");
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/move`, { after: null });
  await t.clock.advance(HOUR);

  await squashTaskIntoOrigin(workspace, work.id);
  await changeProtectedFile(workspace, "repair.txt", "protected version\n");
  t.github.scriptMergedOutside(work.pr_number);
  commitWork(workspace.path, "repair.txt", "task version\n");
  const completed: any = await completeViaMcp(t, repair.id);
  expect(completed.isError ?? false).toBe(false);

  expect(t.github.requests).toHaveLength(1);
  const failure = (await questions(t)).find(
    (q: any) => q.status === "todo" && q.question_pending_pr_promotion_task_id === repair.id,
  );
  expect(failure).toMatchObject({
    title: expect.stringContaining("PR promotion failed"),
    purpose: expect.stringContaining("does not merge cleanly"),
  });
  expect(
    (await questions(t)).filter((q: any) => q.question_quarantine_workspace !== null),
  ).toEqual([]);

  git(workspace.path, "checkout", `task/${repair.id}`);
  expect(() => git(workspace.path, "merge", "refs/remotes/origin/main")).toThrow();
  writeFileSync(join(workspace.path, "repair.txt"), "resolved task version\n");
  git(workspace.path, "add", "repair.txt");
  git(workspace.path, "commit", "-m", "resolve protected catch-up");
  git(workspace.path, "checkout", "main");

  const retried = await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, {
    answers: ["retry"],
  });
  expect(retried.status).toBe(200);
  expect(t.github.requests.at(-1)).toMatchObject({
    branch: `task/${repair.id}`,
    base: "main",
  });
  expect(
    git(
      workspace.path,
      "diff",
      "--name-only",
      `refs/remotes/origin/main...task/${repair.id}`,
    ),
  ).toBe("repair.txt");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json.status).toBe("done");
});

it("追いつきの git 道具が壊れた失敗を conflict と偽らず PR 昇格失敗 question に残す", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "squash-catch-up-tool-error");
  const work = await landedWork(workspace);
  const repair = attachChild(t, work.id, "repair before a git tool error");
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/move`, { after: null });
  await t.clock.advance(HOUR);

  await squashTaskIntoOrigin(workspace, work.id);
  t.github.scriptMergedOutside(work.pr_number);
  commitWork(workspace.path, "repair.txt", "repair survives tool failure\n");
  writeFileSync(
    join(workspace.path, ".git", "refs", "heads", "task", `${repair.id}.lock`),
    "locked\n",
  );
  const completed: any = await completeViaMcp(t, repair.id);
  expect(completed.isError ?? false).toBe(false);

  const failure = (await questions(t)).find(
    (q: any) => q.status === "todo" && q.question_pending_pr_promotion_task_id === repair.id,
  );
  expect(failure.purpose).toContain("cannot lock ref");
  expect(failure.purpose).not.toContain("does not merge cleanly");
  expect(failure.purpose).not.toContain("conflict");
  expect(
    (await questions(t)).filter((q: any) => q.question_quarantine_workspace !== null),
  ).toEqual([]);
});

it("squash merge 後に同じ行が進んだ祖先へ修理が戻っても、merge 済み PR の前で無言にしない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "merged-pr-with-repair");
  const work = await landedWork(workspace);
  const repair = attachChild(t, work.id, "repair a line changed after squash");
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/move`, { after: null });
  await t.clock.advance(HOUR);

  await squashTaskIntoOrigin(workspace, work.id);
  await changeProtectedFile(workspace, "feature.txt", "protected follow-up\n");
  t.github.scriptMergedOutside(work.pr_number);
  commitWork(workspace.path, "feature.txt", "repair result\n");
  const completed: any = await completeViaMcp(t, repair.id);
  expect(completed.isError ?? false).toBe(false);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.pushes).toEqual([]);
  expect((await questions(t)).filter((q: any) => q.status === "todo")).toMatchObject([
    { question_pending_pr_promotion_task_id: work.id },
  ]);
  expect(
    (await questions(t)).filter((q: any) => q.question_quarantine_workspace !== null),
  ).toEqual([]);
});

it("push の失敗は PR 昇格失敗 question として人間に見える", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "push-failure");
  const work = await landedWork(workspace);
  t.github.scriptPushFailure(new Error("remote hung up after upload"));

  const before = await completeRepair(work, workspace);

  expect(t.github.pushes).toHaveLength(1);
  expect((await questions(t)).filter((q: any) => q.status === "todo")).toMatchObject([
    { question_pending_pr_promotion_task_id: work.id },
  ]);
  // ADR 0064 決定4: 失敗した push の後に撮り直してはならない
  expect(refSnapshot(t, workspace.name)).toEqual(before);
});
