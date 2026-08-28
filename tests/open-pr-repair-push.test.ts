import { rm } from "node:fs/promises";
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
