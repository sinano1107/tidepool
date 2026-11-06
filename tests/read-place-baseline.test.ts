import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { poseProbe, registerTask } from "../src/tasks.js";
import { commitRoomCopy, openInterviewRoom, PickupGateError, pickupGate, prepareWorkspaceAtPickup, releaseWorkspace, taskRunPlace, type WorkspaceConfig } from "../src/workspace.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });
const NOW = new Date("2026-11-06T00:00:00.000Z");
let db: Db;
afterEach(() => db?.close());

function work(title: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
}

async function reader(workspace: WorkspaceConfig) {
  const root = registerTask(db, {
    type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: workspace.name,
    interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }],
  }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("read-place-baseline-rooms-");
  const reads = await pickupGate(db, workspace, root, base);
  openInterviewRoom(db, root, base, NOW);
  const room = taskRunPlace(db, root, workspace);
  return { root, room, reads, base };
}

it("休止中に実環境の main が動くと、読む root の pickup は refs/heads/main を名指して実環境の名前で止まる(ADR 0351 決定6)", async () => {
  const workspace = await makeWorkspace("read-idle-main");
  db = openDb(":memory:");
  const earlier = work("leaves a baseline");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, NOW);
  commitWork(workspace.path, "by-hand.txt", "unknown commit while resting\n");
  const moved = git(workspace.path, "rev-parse", "main");
  const { root, room, reads } = await reader(workspace);

  const failure = await prepareWorkspaceAtPickup(db, room, root, { reads }).catch((err: unknown) => err);

  expect(failure).toBeInstanceOf(PickupGateError);
  expect(failure).toMatchObject({
    place: workspace,
    message: expect.stringContaining(`now: ${moved} refs/heads/main`),
  });
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(room.path, "branch", "--list", `task/${root.id}`)).toBe("");
});

it.each([
  ["行が無い", () => {}],
  ["ref_snapshot が NULL", (workspace: WorkspaceConfig) => db.prepare("INSERT INTO workspace_state (name) VALUES (?)").run(workspace.name)],
] as const)("初めて読む実環境が%sなら通り、変化の無い再読も通り、その後の変更は同じ名前の走る pickup が拒む(ADR 0351 決定6)", async (_, seed) => {
  const workspace = await makeWorkspace("first-read");
  db = openDb(":memory:");
  seed(workspace);
  const { root, room, reads } = await reader(workspace);

  await prepareWorkspaceAtPickup(db, room, root, { reads });
  releaseWorkspace(db, room, root, NOW);
  await prepareWorkspaceAtPickup(db, room, root, { reads });
  releaseWorkspace(db, room, root, NOW);
  expect(git(workspace.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  git(workspace.path, "tag", "after-first-read");

  await expect(prepareWorkspaceAtPickup(db, workspace, work("runs in the previously read environment"))).rejects.toThrow("refs/tags/after-first-read");
});

it("読む場所の fetch・park は同じ基準へ畳み、次に走る pickup も通す —— 古い ref へ戻すと解放が拒む(ADR 0351 決定3・6)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("read-remote-advance");
  db = openDb(":memory:");
  const earlier = work("leaves a baseline");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, NOW);
  const before = git(workspace.path, "rev-parse", "main");
  publish("remote.txt", "remote advanced\n", "landed remotely");
  const { root, room, reads } = await reader(workspace);

  await prepareWorkspaceAtPickup(db, room, root, { reads });
  releaseWorkspace(db, room, root, NOW);
  const advanced = git(workspace.path, "rev-parse", "refs/remotes/origin/main");
  expect(advanced).not.toBe(before);
  expect(git(workspace.path, "rev-parse", "main")).toBe(advanced);
  const next = work("runs after the root read it");
  await prepareWorkspaceAtPickup(db, workspace, next);
  expect(git(workspace.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${next.id}`);
  git(workspace.path, "update-ref", "refs/heads/main", before);
  git(workspace.path, "update-ref", "refs/remotes/origin/main", before);

  releaseWorkspace(db, workspace, next, NOW);

  const purpose = quarantineQuestion(db, "workspace", workspace.name)?.purpose;
  expect(purpose).toContain(`now: ${before} refs/heads/main`);
  expect(purpose).toContain(`now: ${before} refs/remotes/origin/main`);
});

it("root 配下の監査 review が読む面接室の変更も、面接室の名前で pickup を止める(ADR 0351 決定6 / ADR 0329 決定8)", async () => {
  const workspace = await makeWorkspace("read-room-audit");
  db = openDb(":memory:");
  const { root, room, reads, base } = await reader(workspace);
  await prepareWorkspaceAtPickup(db, room, root, { reads });
  const audit = poseProbe(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, room));
  releaseWorkspace(db, room, root, NOW);
  git(room.path, "tag", "unexpected-room-tag");
  const auditReads = await pickupGate(db, workspace, audit, base);
  const auditPlace = taskRunPlace(db, audit, workspace);

  await expect(prepareWorkspaceAtPickup(db, auditPlace, audit, { reads: auditReads })).rejects.toMatchObject({
    place: { name: root.id, path: room.path },
    message: expect.stringContaining("refs/tags/unexpected-room-tag"),
  });

  expect(git(workspace.path, "branch", "--list", `task/${audit.id}`)).toBe("");
});
