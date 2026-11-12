import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { TaskCheckoutUnreadableError } from "../src/git.js";
import { checkoutPickupPredicates } from "../src/pickup-predicates.js";
import { registerTask } from "../src/tasks.js";
import { commitRoomCopy, PickupGateError, RoomCopyGitlinkError, recordedInterviewRoom, releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { addSubmodule, breakCheckoutStaging, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, gitObjectFileCount, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, openTestInterviewRoom, pickUpInterviewRoot, poseAccepted, prepareAtPickup, STAGING_FAILURES, submoduleSource } from "./harness.js";

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
  const earlierPlace = await prepareAtPickup(db, workspace, earlier);
  releaseWorkspace(db, earlierPlace, earlier, NOW);
  publish("remote.txt", "remote\n", "remote advanced");
  const tracking = git(workspace.path, "rev-parse", "refs/remotes/origin/main");
  const task = work("next");
  writeFileSync(join(workspace.path, path), content);

  const failure = await prepareAtPickup(db, workspace, task).catch((err: unknown) => err);
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

it("status.showUntrackedFiles=no でも休止後の untracked を pickup で拒む(ADR 0351 決定5)", async () => {
  const workspace = await makeWorkspace("pickup-hidden-untracked");
  db = openDb(":memory:");
  const earlier = work("earlier");
  const earlierPlace = await prepareAtPickup(db, workspace, earlier);
  releaseWorkspace(db, earlierPlace, earlier, NOW);
  git(workspace.path, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(workspace.path, "late.txt"), "written while resting\n");

  await expect(prepareAtPickup(db, workspace, work("next"))).rejects.toMatchObject({
    place: workspace,
    message: expect.stringContaining("?? late.txt"),
  });

  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(readFileSync(join(workspace.path, "late.txt"), "utf8")).toBe("written while resting\n");
});

/** 面接室を開いて root を1度拾い、出題して解放した盤面 —— 面接室は休止中、受験者は1人立っている。 */
async function restingRoom() {
  const workspace = await makeWorkspace("pickup-room-real");
  const { root, room, place } = await pickedRoot(workspace);
  const [examinee] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, place, root.id));
  releaseWorkspace(db, place, root, NOW);
  return { workspace, root, room, examinee: examinee! };
}

/** 面接室を開いて root を拾った盤面。`arrange` は拾う前の面接室に手を入れる。 */
async function pickedRoot(workspace: WorkspaceConfig, arrange: (room: string) => void = () => {}) {
  db = openDb(":memory:");
  const root = registerTask(db, {
    type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: workspace.name,
    interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }],
  }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  arrange(recordedInterviewRoom(db, root.id)!.path);
  return { root, ...(await pickUpInterviewRoot(db, root, workspace)) };
}

const commitSubmodule = (checkout: string, source: string) => {
  addSubmodule(checkout, source);
  git(checkout, "commit", "-m", "add the library as a submodule");
};

it.each(STAGING_FAILURES)("出題の写しで $shape を拒んだら面接室に object は増えない(ADR 0367 決定1)", async (failure) => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-stage-failure"));
  breakCheckoutStaging(place.path, failure);
  writeFileSync(join(place.path, "notes.txt"), "only in the working tree\n");
  const before = gitObjectFileCount(room.path);

  expect(() => commitRoomCopy(db, place, root.id)).toThrow(TaskCheckoutUnreadableError);
  expect(gitObjectFileCount(room.path)).toBe(before);
});

// ADR 0365 決定2: 出題の写しも記録に worker の tree を書く —— 面接室の保護ブランチの head から gitlink を足す・進める tree は ref を書く前に拒む
it("root の checkout が gitlink を足していれば、出題の写しは path を名指して拒み、面接室の保護ブランチも keep-around の ref も動かない(ADR 0365 決定2)", async () => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-gitlink"));
  commitSubmodule(place.path, await submoduleSource("room-copy-gitlink-source"));
  const protectedHead = git(room.path, "rev-parse", "refs/heads/main");
  const before = gitObjectFileCount(room.path);

  const failure = (() => {
    try {
      commitRoomCopy(db, place, root.id);
    } catch (err) {
      return err;
    }
  })();

  expect(failure).toBeInstanceOf(RoomCopyGitlinkError);
  expect((failure as RoomCopyGitlinkError).paths).toEqual(["mod"]);
  expect(git(room.path, "rev-parse", "refs/heads/main")).toBe(protectedHead);
  expect(git(room.path, "for-each-ref", "refs/keep-around/")).toBe("");
  expect(gitObjectFileCount(room.path)).toBe(before);
});

it("面接室の保護ブランチの時点で gitlink があり root が触っていなければ、出題の写しは通る(ADR 0365 決定2)", async () => {
  const source = await submoduleSource("room-copy-gitlink-kept-source");
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-gitlink-kept"), (room) => commitSubmodule(room, source));
  const protectedHead = git(room.path, "rev-parse", "refs/heads/main");
  commitWork(place.path, "probe.txt", "the environment\n");

  const head = commitRoomCopy(db, place, root.id);

  expect(git(room.path, "rev-parse", `${head}:mod`)).toBe(git(room.path, "rev-parse", `${protectedHead}:mod`));
  expect(git(room.path, "rev-parse", `${head}:probe.txt`)).not.toBe("");
});

// ADR 0365 決定3: 出題の写しも盤面の view —— worktree の入れ子の repo は gitlink の値を供給しない
it("root の checkout の untracked の入れ子の repo は出題の写しに入らない(ADR 0365 決定3)", async () => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-nested"));
  const source = await submoduleSource("room-copy-nested-source");
  mkdirSync(join(place.path, "mod"));
  writeFileSync(join(place.path, "mod", ".git"), `gitdir: ${join(source, ".git")}\n`);
  commitWork(place.path, "probe.txt", "the environment\n");

  const head = commitRoomCopy(db, place, root.id);

  expect(git(room.path, "ls-tree", head, "--", "mod")).toBe("");
  expect(git(room.path, "rev-parse", `${head}:probe.txt`)).not.toBe("");
});

// 旧: 受験者の記録用 checkout が dirty でも pickup は通した(ADR 0276)。ADR 0356 決定1・2 の後は受験者も面接室から作り直す task の checkout で
// 走るので、休止の検査は名前の場所(面接室)にだけ当たり、root の pickup と同じく面接室の名前で止まる
it.each(["root", "examinee"] as const)("面接室が休止後に dirty なら、%s の pickup はその名前で止まる(ADR 0351 決定5 / ADR 0356 決定1)", async (who) => {
  const { root, room, examinee } = await restingRoom();
  writeFileSync(join(room.path, "late.txt"), "written while resting\n");

  await expect(prepareAtPickup(db, room, who === "root" ? root : examinee)).rejects.toMatchObject({
    place: room,
    message: expect.stringContaining("a process wrote them after the board moved the checkout"),
  });

  expect(git(room.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("読む実環境と他の面接室には tree の clean 検査を当てない(ADR 0351 決定5)", async () => {
  const { workspace, root, room } = await restingRoom();
  const otherRoom = await makeWorkspace("other-room");
  const reads = [workspace, otherRoom].map((place) => {
    writeFileSync(join(place.path, "reading.txt"), "read-only place\n");
    return { place, predicates: checkoutPickupPredicates(place) };
  });

  const place = await prepareAtPickup(db, room, root, { reads });

  // 旧: 面接室の HEAD が root のタスクブランチに乗った。ADR 0356 決定1 の後は task の checkout が乗る
  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${root.id}`);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  for (const { place } of reads) expect(readFileSync(join(place.path, "reading.txt"), "utf8")).toBe("read-only place\n");
});
