import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
const MINUTE = 60 * 1000;

afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function complete(taskId: string): Promise<void> {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
}

async function decompose(taskId: string, title: string): Promise<void> {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: `${title} is an independent slice`,
      children: [{ title, purpose: `purpose of ${title}`, completion_criteria: `${title} is done` }],
    },
  });
  await client.close();
}

it("decompose の子は親ブランチから切られ、完了すると親ブランチへ戻って PR も着地 question も作らない", async () => {
  const workspace = await makeWorkspace(dirs, "lineage");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "integrate the feature");
  await t.clock.advance(HOUR);

  writeFileSync(join(workspace.path, "parent.txt"), "parent work\n");
  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "the child can be implemented independently",
      children: [
        {
          title: "implement the child",
          purpose: "finish one part",
          completion_criteria: "the child artifact exists",
        },
      ],
    },
  });
  await parentClient.close();

  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === parent.id,
  );
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "show", `task/${child.id}:parent.txt`)).toBe("parent work");

  writeFileSync(join(workspace.path, "child.txt"), "child work\n");
  await complete(child.id);

  expect(git(workspace.path, "show", `task/${parent.id}:child.txt`)).toBe("child work");
  expect(t.github.requests).toEqual([]);
  expect(
    (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
      (task: any) => task.type === "question",
    ),
  ).toEqual([]);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("完了時 review は元 PR が merge 済みでも被レビュータスクの恒久ブランチから切られる", async () => {
  const workspace = await makeWorkspace(dirs, "review-lineage");
  t = await bootTidepool({ workspace });
  const reviewed = await registerWork(t, "ship reviewed work", undefined, true);
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "reviewed.txt"), "review this\n");
  await complete(reviewed.id);

  git(workspace.path, "merge", "--no-ff", `task/${reviewed.id}`, "-m", "merge reviewed work");
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === reviewed.id,
  );
  await t.clock.advance(HOUR);

  expect(git(workspace.path, "rev-parse", `task/${review.id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${reviewed.id}`),
  );
  expect(git(workspace.path, "rev-parse", `task/${review.id}`)).not.toBe(
    git(workspace.path, "rev-parse", "main"),
  );
});

it("review の完了は生成物を被レビュー work ブランチへ merge back しない", async () => {
  const workspace = await makeWorkspace(dirs, "review-transparent-release");
  t = await bootTidepool({ workspace });
  const reviewed = await registerWork(t, "review without branch pollution", undefined, true);
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "reviewed.txt"), "reviewed work\n");
  await complete(reviewed.id);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === reviewed.id,
  );
  await t.clock.advance(HOUR);
  const reviewedHead = git(workspace.path, "rev-parse", `task/${reviewed.id}`);
  writeFileSync(join(workspace.path, "review-output.txt"), "generated during review\n");

  const client = await mcpClient(t.mcpBaseUrl, review.id);
  await client.callTool({ name: "complete_task", arguments: {} });
  await client.close();

  expect(git(workspace.path, "rev-parse", `task/${reviewed.id}`)).toBe(reviewedHead);
  expect(
    git(workspace.path, "diff", "--name-only", `task/${reviewed.id}..task/${review.id}`),
  ).toBe("review-output.txt");
});

it("review の修理は元 PR が未 merge なら被レビュー work へ戻り、PR を増やさない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "open-pr-repair");
  t = await bootTidepool({ workspace });
  const reviewed = await registerWork(t, "ship repairable work", undefined, true);
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "reviewed.txt"), "needs review\n");
  await complete(reviewed.id);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === reviewed.id,
  );
  await t.clock.advance(HOUR);
  await decompose(review.id, "repair the reviewed work");
  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === review.id,
  );
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${reviewed.id}`),
  );

  writeFileSync(join(workspace.path, "repair.txt"), "fixed\n");
  await complete(repair.id);

  expect(git(workspace.path, "show", `task/${reviewed.id}:repair.txt`)).toBe("fixed");
  expect(t.github.requests).toHaveLength(1);
});

it("review の修理は元 PR が merge 済みなら保護ブランチから切られ、自分の PR を開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "merged-pr-repair");
  t = await bootTidepool({ workspace });
  const reviewed = await registerWork(t, "ship merged work", undefined, true);
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "reviewed.txt"), "merged work\n");
  await complete(reviewed.id);
  git(workspace.path, "push", "origin", `task/${reviewed.id}:main`);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === reviewed.id,
  );
  await t.clock.advance(HOUR);
  await decompose(review.id, "repair merged work");
  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === review.id,
  );
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(
    git(workspace.path, "rev-parse", "main"),
  );

  writeFileSync(join(workspace.path, "repair.txt"), "fixed after merge\n");
  await complete(repair.id);

  expect(t.github.requests).toHaveLength(2);
  expect(t.github.requests[1]?.branch).toBe(`task/${repair.id}`);
});

it("ルート review の修理子は work の祖先がないため保護ブランチから切られる", async () => {
  const workspace = await makeWorkspace(dirs, "root-review-repair");
  t = await bootTidepool({ workspace });
  const review = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "audit the workspace",
      purpose: "find independent issues",
      completion_criteria: "findings are recorded",
    })
  ).json;
  await t.clock.advance(HOUR);
  await decompose(review.id, "repair the audit finding");
  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === review.id,
  );
  await t.clock.advance(HOUR);

  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(
    git(workspace.path, "rev-parse", "main"),
  );
});

it("入れ子の decompose はルートから親まで候補を進め、直近の統合幹から孫を切る", async () => {
  const workspace = await makeWorkspace(dirs, "nested-lineage");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "parent integration");
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "parent.txt"), "parent\n");
  await decompose(parent.id, "first child");

  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === parent.id,
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "child.txt"), "child\n");
  await decompose(child.id, "nested child");
  expect(git(workspace.path, "diff", "--name-only", `task/${parent.id}..task/${child.id}`)).toBe(
    "child.txt",
  );

  const grandchild = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === child.id,
  );
  await t.clock.advance(HOUR);

  expect(git(workspace.path, "rev-parse", `task/${grandchild.id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${child.id}`),
  );
  expect(git(workspace.path, "show", `task/${grandchild.id}:parent.txt`)).toBe("parent");
  expect(git(workspace.path, "show", `task/${grandchild.id}:child.txt`)).toBe("child");
});

it("先行する兄弟の merge back 後に pickup された兄弟は、その成果を含む親ブランチから切られる", async () => {
  const workspace = await makeWorkspace(dirs, "sibling-lineage");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "integrate siblings");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the two slices can run in queue order",
      children: [
        { title: "first sibling", purpose: "first", completion_criteria: "first done" },
        { title: "second sibling", purpose: "second", completion_criteria: "second done" },
      ],
    },
  });
  await client.close();

  const children = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (task: any) => task.parent_id === parent.id,
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "first.txt"), "first result\n");
  await complete(children[0].id);
  await t.clock.advance(HOUR);

  expect(git(workspace.path, "show", `task/${children[1].id}:first.txt`)).toBe("first result");
  expect(git(workspace.path, "rev-parse", `task/${children[1].id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${parent.id}`),
  );
});

it("decompose 子の review 修理は、着地済みの子ブランチを飛ばして現在の親統合幹から切られる", async () => {
  const workspace = await makeWorkspace(dirs, "decomposed-review-repair");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "parent integration");
  await t.clock.advance(HOUR);
  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "the reviewed child is independent",
      children: [
        {
          title: "reviewed child",
          purpose: "produce the child result",
          completion_criteria: "child result exists",
          review_flag: true,
        },
      ],
    },
  });
  await parentClient.close();

  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === parent.id && task.type === "work",
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "child.txt"), "child result\n");
  await complete(child.id);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === child.id && task.type === "review",
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "parent-progress.txt"), "new parent work\n");
  await decompose(parent.id, "second integration child");
  await api(t.baseUrl, "POST", `/api/tasks/${review.id}/move`, { after: null });
  await t.clock.advance(HOUR);
  await decompose(review.id, "repair the reviewed child");

  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === review.id && task.type === "work",
  );
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/move`, { after: null });
  await t.clock.advance(HOUR);

  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${parent.id}`),
  );
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).not.toBe(
    git(workspace.path, "rev-parse", `task/${child.id}`),
  );
  expect(git(workspace.path, "show", `task/${repair.id}:parent-progress.txt`)).toBe(
    "new parent work",
  );
});

it("付帯子の実行中に祖先が着地したら、完了時の再解決で保護ブランチへ帰り先を切り替える", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-reresolution");
  t = await bootTidepool({ workspace });
  const reviewed = await registerWork(t, "work that lands during repair", undefined, true);
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "reviewed.txt"), "reviewed work\n");
  await complete(reviewed.id);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === reviewed.id && task.type === "review",
  );
  await t.clock.advance(HOUR);
  await decompose(review.id, "repair after moving base");
  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === review.id && task.type === "work",
  );
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(
    git(workspace.path, "rev-parse", `task/${reviewed.id}`),
  );

  git(workspace.path, "push", "origin", `task/${reviewed.id}`);
  const merger = await mkdtemp(join(tmpdir(), "tidepool-lineage-merger-"));
  dirs.push(merger);
  git(merger, "clone", workspace.repo!, ".");
  git(merger, "merge", "--no-ff", `origin/task/${reviewed.id}`, "-m", "merge reviewed work");
  git(merger, "push", "origin", "main");

  writeFileSync(join(workspace.path, "repair.txt"), "repair after landing\n");
  await complete(repair.id);

  expect(t.github.requests).toHaveLength(2);
  expect(t.github.requests[1]?.branch).toBe(`task/${repair.id}`);
  expect(git(workspace.path, "diff", "--name-only", `task/${reviewed.id}..task/${repair.id}`)).toBe(
    "repair.txt",
  );
});

it("merge back が conflict すると完了は維持したまま workspace を quarantine する", async () => {
  const workspace = await makeWorkspace(dirs, "lineage-conflict");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "conflicting integration");
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "shared.txt"), "base\n");
  await decompose(parent.id, "conflicting child");

  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === parent.id,
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "shared.txt"), "child version\n");

  const parentCheckout = await mkdtemp(join(tmpdir(), "tidepool-parent-worktree-"));
  dirs.push(parentCheckout);
  git(workspace.path, "worktree", "add", parentCheckout, `task/${parent.id}`);
  writeFileSync(join(parentCheckout, "shared.txt"), "parent version\n");
  git(parentCheckout, "add", "shared.txt");
  git(parentCheckout, "commit", "-m", "advance parent independently");
  git(workspace.path, "worktree", "remove", parentCheckout);

  await complete(child.id);

  const done = (await api(t.baseUrl, "GET", `/api/tasks/${child.id}`)).json;
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(done.status).toBe("done");
  expect(board.find((task: any) => task.type === "question")?.title).toContain(
    "lineage-conflict",
  );
  expect(git(workspace.path, "status", "--porcelain")).toContain("UU shared.txt");
  expect(t.github.requests).toEqual([]);
});

it("兄弟が親ブランチを進めた後の merge back は ff-only にせず、正当な merge commit を作る", async () => {
  const workspace = await makeWorkspace(dirs, "non-ff-lineage");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "integrate divergent siblings");
  await t.clock.advance(HOUR);
  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "siblings may finish out of pickup order",
      children: [
        { title: "paused sibling", purpose: "first", completion_criteria: "first done" },
        { title: "finishing sibling", purpose: "second", completion_criteria: "second done" },
      ],
    },
  });
  await parentClient.close();

  const children = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (task: any) => task.parent_id === parent.id && task.type === "work",
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "paused.txt"), "paused result\n");
  const pausedClient = await mcpClient(t.mcpBaseUrl, children[0].id);
  await pausedClient.callTool({
    name: "escalate",
    arguments: {
      context: "one choice is needed before completion",
      questions: [
        {
          title: "continue the paused sibling?",
          options: ["continue", "stop"],
          recommendation: "continue",
        },
      ],
    },
  });
  await pausedClient.close();
  expect(
    git(workspace.path, "diff", "--name-only", `task/${parent.id}..task/${children[0].id}`),
  ).toBe("paused.txt");

  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "question" && task.parent_id === children[0].id,
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "finished.txt"), "finished result\n");
  await complete(children[1].id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["continue"] });
  await complete(children[0].id);

  expect(git(workspace.path, "show", `task/${parent.id}:paused.txt`)).toBe("paused result");
  expect(git(workspace.path, "show", `task/${parent.id}:finished.txt`)).toBe("finished result");
  expect(
    git(workspace.path, "rev-list", "--parents", "-n", "1", `task/${parent.id}`).split(" "),
  ).toHaveLength(3);
});

it("watchdog の slot 解放は WIP を子ブランチに残し、親へ merge back しない", async () => {
  const workspace = await makeWorkspace(dirs, "watchdog-lineage");
  t = await bootTidepool({
    workspace,
    watchdog: { timeLimits: { work: MINUTE }, grace: MINUTE },
  });
  const parent = await registerWork(t, "parent for failed child");
  await t.clock.advance(HOUR);
  await decompose(parent.id, "child that times out");
  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.parent_id === parent.id && task.type === "work",
  );
  await t.clock.advance(HOUR);
  writeFileSync(join(workspace.path, "timed-out.txt"), "unfinished child work\n");

  await t.clock.advance(MINUTE);
  await t.clock.advance(MINUTE);

  expect(git(workspace.path, "show", `task/${child.id}:timed-out.txt`)).toBe(
    "unfinished child work",
  );
  expect(git(workspace.path, "diff", "--name-only", `task/${parent.id}..task/${child.id}`)).toBe(
    "timed-out.txt",
  );
});
