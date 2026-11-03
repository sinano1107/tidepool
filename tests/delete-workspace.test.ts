import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { loadRegistry } from "../src/registry.js";
import { DeletionConfirmationRequiredError } from "../src/registry-write.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { prepareWorkspaceAtPickup, projectSettingsHiddenByBoard, releaseWorkspace } from "../src/workspace.js";
import { deleteWorkspace, RegistrySelfDeleteError } from "../src/workspace-create.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeWorkspace, quarantineQuestion } from "./harness.js";
import { FIXTURE_WORKSPACE, makeRegistry, writeUnannounced } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

/** 参照ゼロ・既定でもない盤面の事実。 */
const NO_REFERENCES = { unsettledTaskCount: 0, awaitingLandingTaskIds: [] };

/** 盤面が pickup で基準を撮った `name` の checkout。sparse の写しも行に置き、worker は自分のタスクブランチに1つ commit した。 */
async function sessionWithState(name: string) {
  const db = openDb(":memory:");
  const ws = await makeWorkspace(name);
  const now = new Date();
  const registered = registerTask(db, { type: "work", title: "t", purpose: "why", completion_criteria: "done" }, now, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", now)!;
  await prepareWorkspaceAtPickup(db, ws, task);
  db.prepare("UPDATE workspace_state SET sparse_snapshot = ? WHERE name = ?").run('{"mode":"disabled","pattern":null}', name);
  commitWork(ws.path, "work.txt", "work\n");
  return { db, ws, task, now };
}

type Session = Awaited<ReturnType<typeof sessionWithState>>;

/** 行の有無を production の読み手で: sparse の写しは「盤面が隠している最中」の印、基準は解放の比較が読む(無ければ違反、ADR 0064 決定6)。 */
function expectState(s: Session, kept: boolean): void {
  expect(projectSettingsHiddenByBoard(s.db, s.ws)).toBe(kept);
  releaseWorkspace(s.db, s.ws, s.task, s.now);
  expect(quarantineQuestion(s.db, "workspace", s.ws.name) === undefined).toBe(kept);
}

const registryDeps = (dir: string) => ({
  registry: { dir, mode: "purely-local" as const, writeRef: writeUnannounced },
  workspacesBaseDir: "/workspaces",
});

describe("deleteWorkspace: workspace_state の行(ADR 0351 決定7)", () => {
  vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

  it("削除が成立すると、その name の行(基準と sparse の写し)が無くなる", async () => {
    const s = await sessionWithState("tidepool");

    await deleteWorkspace({ name: "tidepool", confirm: true }, { ...registryDeps(await makeMainRegistry()), ...NO_REFERENCES, db: s.db });

    expectState(s, false);
  });

  it("confirm なしで拒まれたとき、行はそのまま", async () => {
    const s = await sessionWithState("tidepool");

    await expect(
      deleteWorkspace({ name: "tidepool" }, { ...registryDeps(await makeMainRegistry()), ...NO_REFERENCES, db: s.db }),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expectState(s, true);
  });

  it.each([
    ["未決着タスク", { unsettledTaskCount: 1 }],
    ["着地待ち", { awaitingLandingTaskIds: ["t1"] }],
    ["既定 workspace", { defaultWorkspaceName: "tidepool" }],
  ])("確認で買えない拒否(%s)のとき、行はそのまま", async (_reason, references) => {
    const s = await sessionWithState("tidepool");

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        { ...registryDeps(await makeMainRegistry()), ...NO_REFERENCES, ...references, db: s.db },
      ),
    ).rejects.toMatchObject({ name: "DeletionBlockedError" });

    expectState(s, true);
  });

  it("盤面自身の registry clone の拒否のとき、行はそのまま", async () => {
    const s = await sessionWithState("registry");
    const registryDir = await makeMainRegistry();
    writeFileSync(join(registryDir, "workspaces.yaml"), `registry:\n  path: ${registryDir}\n`);
    git(registryDir, "add", "-A");
    git(registryDir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "register self");

    await expect(
      deleteWorkspace({ name: "registry", confirm: true }, { ...registryDeps(registryDir), ...NO_REFERENCES, db: s.db }),
    ).rejects.toThrow(RegistrySelfDeleteError);

    expectState(s, true);
  });
});

describe("deleteWorkspace: 正常系(issue #205 / ADR 0087 決定1・決定4)", () => {
  it("workspaces.yaml からエントリを除去するコミットが着地し、残る checkout の場所を返す", async () => {
    const registryDir = await makeMainRegistry();

    const checkout = await deleteWorkspace(
      { name: "tidepool", confirm: true },
      {
        registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
        workspacesBaseDir: "/workspaces",
        ...NO_REFERENCES,
        db: openDb(":memory:"),
      },
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("delete workspace tidepool via WebUI");
    // ADR 0087 決定4: ホスト上の checkout は触らない —— 応答が場所を名指しする
    expect(checkout).toBe(FIXTURE_WORKSPACE);
  });
});

describe("deleteWorkspace: 確認の門(issue #205 / ADR 0087)", () => {
  it("confirm なしの削除要求は拒まれ、エントリは残る", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      deleteWorkspace(
        { name: "tidepool" },
        {
          registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
          db: openDb(":memory:"),
        },
      ),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("deleteWorkspace: 確認で買えない拒否(ADR 0087 決定2/3)", () => {
  it("未決着タスクが参照していると confirm があっても消せず、件数が理由に載る", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
          db: openDb(":memory:"),
          unsettledTaskCount: 3,
        },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "unsettled_tasks", count: 3 }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
  });

  it("この workspace で着地を待つ完了タスクがあると confirm があっても消せず、件数が理由に載る(ADR 0226)", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
          db: openDb(":memory:"),
          awaitingLandingTaskIds: ["t1", "t2"],
        },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      message: 'workspace "tidepool" cannot be deleted: 2 completed task(s) still await landing through it: t1, t2',
      reasons: [{ code: "tasks_awaiting_landing", count: 2, task_ids: ["t1", "t2"] }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
  });

  it("盤面の既定 workspace は confirm があっても消せない", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
          db: openDb(":memory:"),
          defaultWorkspaceName: "tidepool",
        },
      ),
    ).rejects.toMatchObject({ name: "DeletionBlockedError", reasons: [{ code: "board_default" }] });
  });

  it("profile の allowed_workspaces に列挙されているだけの workspace は消せる(ADR 0087 決定2)", async () => {
    const registryDir = await makeRegistry({
      "authority/standard.yaml":
        "guidance: lists tidepool as an allowed workspace\nassignable_to: []\nallowed_workspaces:\n  - tidepool\nmerge: escalate\n",
    });
    git(registryDir, "branch", "-M", "main");

    await deleteWorkspace(
      { name: "tidepool", confirm: true },
      {
        registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
        workspacesBaseDir: "/workspaces",
        ...NO_REFERENCES,
        db: openDb(":memory:"),
      },
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    // 掃除は不要 —— 許可先が1つ消えるだけで無害である
    expect(
      loadRegistry(registryDir, "purely-local").authority.standard?.allowed_workspaces,
    ).toEqual(["tidepool"]);
  });

  it("盤面自身の registry clone は永久に消せない(RegistrySelfDeleteError)", async () => {
    const registryDir = await makeMainRegistry();
    // registry clone 自身を workspace として登録した状態(ADR 0052 決定3)
    writeFileSync(join(registryDir, "workspaces.yaml"), `registry:\n  path: ${registryDir}\n`);
    git(registryDir, "add", "-A");
    git(registryDir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "register self");

    await expect(
      deleteWorkspace(
        { name: "registry", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local", writeRef: writeUnannounced },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
          db: openDb(":memory:"),
        },
      ),
    ).rejects.toThrow(RegistrySelfDeleteError);
  });
});
