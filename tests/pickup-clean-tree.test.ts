import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { checkoutPickupPredicates } from "../src/pickup-predicates.js";
import { registerTask } from "../src/tasks.js";
import { commitRoomCopy, openExamineeCheckout, PickupGateError, prepareWorkspaceAtPickup, releaseWorkspace, taskRunPlace } from "../src/workspace.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, openTestInterviewRoom, poseAccepted } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });
const NOW = new Date("2026-11-06T00:00:00.000Z");
let db: Db;
afterEach(() => db?.close());

function work(title: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
}

it.each([
  ["untracked", "late.txt", "written while resting\n"],
  ["modified", "README.md", "modified while resting\n"],
  ["既知パス・untracked・0 バイトの shadow 残骸", ".bashrc", ""],
])("休止後の %s は fetch・休止位置の追従・task branch の作成より前に pickup を止め、書き込みを残す(ADR 0351 決定5)", async (_, path, content) => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("pickup-dirty-tree");
  db = openDb(":memory:");
  const earlier = work("earlier");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, NOW);
  publish("remote.txt", "remote\n", "remote advanced");
  const tracking = git(workspace.path, "rev-parse", "refs/remotes/origin/main");
  const task = work("next");
  writeFileSync(join(workspace.path, path), content);

  const failure = await prepareWorkspaceAtPickup(db, workspace, task).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(PickupGateError);
  expect(failure).toMatchObject({
    place: workspace,
    message: expect.stringContaining("a process wrote them after the board moved the checkout"),
  });

  expect(git(workspace.path, "rev-parse", "refs/remotes/origin/main")).toBe(tracking);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(workspace.path, "branch", "--list", `task/${task.id}`)).toBe("");
  expect(readFileSync(join(workspace.path, path), "utf8")).toBe(content);
});

async function restingRoom() {
  const workspace = await makeWorkspace("pickup-room-real");
  db = openDb(":memory:");
  const root = registerTask(db, {
    type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: workspace.name,
    interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }],
  }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = taskRunPlace(db, root, workspace);
  await prepareWorkspaceAtPickup(db, room, root);
  releaseWorkspace(db, room, root, NOW);
  return { workspace, root, room };
}

it("Interview root の走る面接室も休止後に dirty なら、その名前で pickup を止める(ADR 0351 決定5)", async () => {
  const { root, room } = await restingRoom();
  writeFileSync(join(room.path, "late.txt"), "written while resting\n");

  await expect(prepareWorkspaceAtPickup(db, room, root)).rejects.toMatchObject({
    place: room,
    message: expect.stringContaining("a process wrote them after the board moved the checkout"),
  });

  expect(git(room.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("受験者の記録用 checkout が dirty でも pickup は通し、自分の変更を残す(ADR 0276 / ADR 0351 決定5)", async () => {
  const { workspace, root, room } = await restingRoom();
  await prepareWorkspaceAtPickup(db, room, root);
  const head = commitRoomCopy(db, room);
  const [examinee] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", head);
  releaseWorkspace(db, room, root, NOW);
  openExamineeCheckout(db, examinee!, dirname(room.path), NOW);
  const checkout = taskRunPlace(db, examinee!, workspace);
  writeFileSync(join(checkout.path, "answer.txt"), "unfinished answer\n");

  await prepareWorkspaceAtPickup(db, checkout, examinee!);

  expect(git(checkout.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${examinee!.id}`);
  expect(readFileSync(join(checkout.path, "answer.txt"), "utf8")).toBe("unfinished answer\n");
});

it("読む実環境と他の面接室には tree の clean 検査を当てない(ADR 0351 決定5)", async () => {
  const { workspace, root, room } = await restingRoom();
  const otherRoom = await makeWorkspace("other-room");
  const reads = [workspace, otherRoom].map((place) => {
    writeFileSync(join(place.path, "reading.txt"), "read-only place\n");
    return { place, predicates: checkoutPickupPredicates(place) };
  });

  await prepareWorkspaceAtPickup(db, room, root, { reads });

  expect(git(room.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${root.id}`);
  for (const { place } of reads) expect(readFileSync(join(place.path, "reading.txt"), "utf8")).toBe("read-only place\n");
});
