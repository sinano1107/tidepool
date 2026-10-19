import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { completeTask, examineeCheckoutPath, interviewRoomPath, registerTask, type Task } from "../src/tasks.js";
import { commitRoomCopy, openExamineeCheckout, openInterviewRoom, prepareWorkspaceAtPickup, releaseWorkspace, taskRunPlace, type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { commitWork, FULL_HANDOFF, failGitCommits, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, openTestInterviewRoom, poseAccepted } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 出題の写しと面接室の開き方(ADR 0273 決定1・3)、受験者の checkout(ADR 0276)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-10-15T00:00:00.000Z");
const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const sonnetHigh = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" };
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };

/** 面接室を開いて root の pickup の姿(root のタスクブランチを checkout)にし、走る場所を返す。 */
async function pickedRoom(db: Db) {
  const workspace = await makeWorkspace("room-copy-real");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = taskRunPlace(db, root, workspace);
  git(room.path, "checkout", "-b", `task/${root.id}`, "main");
  return room;
}

/** root の session が見る git の状態: HEAD、作業ツリーと本物の index(status)、index の中身。 */
const sessionState = (room: WorkspaceConfig) => [git(room.path, "rev-parse", "HEAD"), git(room.path, "status", "--porcelain", "--untracked-files=all"), git(room.path, "ls-files", "--stage")];

it("出題の写しは、面接室の作業ツリー(commit 済み・stage 済み・未 stage・untracked の全部)を、保護ブランチの head を親にした盤面名義の commit にして ref を1本置く —— root の HEAD・作業ツリー・index は動かない(ADR 0273 決定3 / ADR 0064)", async () => {
  const db = openDb(":memory:");
  const room = await pickedRoom(db);
  const main = git(room.path, "rev-parse", "main");
  commitWork(room.path, "committed.txt", "on the root's branch\n");
  writeFileSync(join(room.path, "staged.txt"), "staged\n");
  git(room.path, "add", "staged.txt");
  writeFileSync(join(room.path, "committed.txt"), "edited, not staged\n");
  mkdirSync(join(room.path, "src"));
  writeFileSync(join(room.path, "src", "untracked.txt"), "untracked\n");
  const before = sessionState(room);

  const head = commitRoomCopy(db, room);

  expect(sessionState(room)).toEqual(before);
  expect(git(room.path, "log", "--format=%an %P", "-1", head)).toBe(`tidepool ${main}`);
  expect(git(room.path, "ls-tree", "-r", "--name-only", head).split("\n")).toEqual(["committed.txt", "src/untracked.txt", "staged.txt"]);
  expect(git(room.path, "show", `${head}:committed.txt`)).toBe("edited, not staged");
  expect(git(room.path, "for-each-ref", "--points-at", head, "--format=%(refname)").split("\n")).toHaveLength(1);
  db.close();
});

it("空の作業ツリーの写しも、空の tree の commit になる", async () => {
  const db = openDb(":memory:");
  const room = await pickedRoom(db);

  const head = commitRoomCopy(db, room);

  expect(git(room.path, "ls-tree", "-r", head)).toBe("");
  expect(git(room.path, "rev-parse", `${head}^`)).toBe(git(room.path, "rev-parse", "main"));
  db.close();
});

it("写しは session の最中のサンドボックスの shadow 残骸(ADR 0069 の既知パス・untracked・0 バイト)を含まず、同じパスでも中身のあるファイルは含む", async () => {
  const db = openDb(":memory:");
  const room = await pickedRoom(db);
  writeFileSync(join(room.path, ".bashrc"), "");
  mkdirSync(join(room.path, ".claude"));
  writeFileSync(join(room.path, ".claude", "agents"), "");
  writeFileSync(join(room.path, ".mcp.json"), "{}\n");

  const head = commitRoomCopy(db, room);

  expect(git(room.path, "ls-tree", "-r", "--name-only", head).split("\n")).toEqual([".mcp.json"]);
  db.close();
});

it("面接室は規約の基点の下の root の id に、盤面名義の空コミット 'Initial commit' だけを持つ repo として開き、在り処を実体の綴りで残す —— 空コミットが落ちても在り処は先に残り、次に開くと残った repo の続きから作る(ADR 0273 決定1)", async () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-room-open-");
  failGitCommits();
  expect(() => openInterviewRoom(db, root, base, NOW)).toThrow("/nonexistent-gpg");
  vi.unstubAllEnvs();
  const room = realpathSync(join(base, root.id));
  expect(interviewRoomPath(db, root.id)).toBe(room);

  openInterviewRoom(db, root, base, NOW);
  openInterviewRoom(db, root, base, NOW);

  expect(git(room, "log", "--format=%an %s", "main")).toBe("tidepool Initial commit");
  expect(listEvents(db, root.id).filter((event) => event.payload.kind === "interview_room_opened")).toHaveLength(1);
  db.close();
});

/** root が面接室に環境を組んで出題し、監査が受理した姿: root のブランチに WIP、`room` は出題の写しを持つ。`compose` は写しの前に
 *  面接室の作業ツリーへ書く。受験者の checkout の基点は面接室と同じ規約の基点。 */
async function posedInRoom(db: Db, targets: object[] = [opusHigh], compose: (room: string) => void = () => {}) {
  const workspace = await makeWorkspace("examinee-checkout-real");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: targets as never }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = taskRunPlace(db, root, workspace);
  git(room.path, "checkout", "-b", `task/${root.id}`, "main");
  commitWork(room.path, "probe.txt", "the environment\n");
  compose(room.path);
  const head = commitRoomCopy(db, room);
  const examinees = poseAccepted(db, root, POSE, "auditor", NOW, "worker", head);
  return { workspace, root, room, head, examinees, base: dirname(room.path) };
}

/** 受験者の pickup の順(scheduler と同じ): checkout を開き、走る場所で準備する。 */
async function pickUp(db: Db, examinee: Task, workspace: WorkspaceConfig, base: string) {
  openExamineeCheckout(db, examinee, base, NOW);
  const place = taskRunPlace(db, examinee, workspace);
  await prepareWorkspaceAtPickup(db, place, examinee);
  return place;
}

it("受験者の初回の pickup は面接室の外(規約の基点の下の受験者の id)に checkout を開いて在り処を実体の綴りで残し、履歴は出題の head とその祖先だけで、兄弟・root のブランチも keep-around も持たない —— 走る場所は名前が root の id、path が自分の checkout、読みに開く場所は無く、root の走る場所は変わらない(ADR 0276 決定1・3)", async () => {
  const db = openDb(":memory:");
  const { workspace, root, room, head, examinees, base } = await posedInRoom(db, [opusHigh, sonnetHigh]);
  const [first, second] = examinees as [Task, Task];
  const rootPlace = taskRunPlace(db, root, workspace);

  const place = await pickUp(db, first, workspace, base);
  await pickUp(db, second, workspace, base);

  const checkout = realpathSync(join(base, first.id));
  expect(place).toMatchObject({ name: root.id, path: checkout, read_paths: [] });
  expect(examineeCheckoutPath(db, first.id)).toBe(checkout);
  expect(checkout.startsWith(`${room.path}/`)).toBe(false);
  expect(git(checkout, "log", "--all", "--format=%s").split("\n")).toEqual(["Add the project files", "Initial commit"]);
  expect(git(checkout, "for-each-ref", "--format=%(refname) %(objectname)").split("\n")).toEqual([`refs/heads/main ${head}`, `refs/heads/task/${first.id} ${head}`]);
  expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${first.id}`);
  expect(git(checkout, "status", "--porcelain")).toBe("");
  expect(readdirSync(checkout).sort()).toEqual([".git", "probe.txt"]);
  expect(taskRunPlace(db, root, workspace)).toEqual(rootPlace);
  db.close();
});

it("root が .gitignore で外したものも先の受験者の ignored の生成物も、次の受験者の作業ツリーに無い(ADR 0276 決定2)", async () => {
  const db = openDb(":memory:");
  const { workspace, examinees, base } = await posedInRoom(db, [opusHigh, sonnetHigh], (room) => {
    writeFileSync(join(room, ".gitignore"), "build/\n");
    mkdirSync(join(room, "build"));
    writeFileSync(join(room, "build", "root-made.txt"), "the root's build\n");
  });
  const [first, second] = examinees as [Task, Task];
  const firstPlace = await pickUp(db, first, workspace, base);
  mkdirSync(join(firstPlace.path, "build"));
  writeFileSync(join(firstPlace.path, "build", "first-made.txt"), "the first target's build\n");
  releaseWorkspace(db, firstPlace, first, NOW);

  const secondPlace = await pickUp(db, second, workspace, base);

  expect(readdirSync(secondPlace.path).sort()).toEqual([".git", ".gitignore", "probe.txt"]);
  expect(git(secondPlace.path, "status", "--porcelain", "--ignored")).toBe("");
  db.close();
});

it("解放は受験者の checkout で tree rule を通して main に戻し、再開は同じ checkout で退避した WIP の commit と ignored の生成物を持ったまま走る(ADR 0276 決定1)", async () => {
  const db = openDb(":memory:");
  const { workspace, root, examinees, base } = await posedInRoom(db, [opusHigh], (room) => writeFileSync(join(room, ".gitignore"), "build/\n"));
  const [examinee] = examinees as [Task];
  const place = await pickUp(db, examinee, workspace, base);
  writeFileSync(join(place.path, "wip.txt"), "half an answer\n");
  mkdirSync(join(place.path, "build"));
  writeFileSync(join(place.path, "build", "out.txt"), "generated\n");

  releaseWorkspace(db, place, examinee, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(git(place.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  const wip = git(place.path, "rev-parse", `task/${examinee.id}`);

  expect(await pickUp(db, examinee, workspace, base)).toEqual(place);

  expect(git(place.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${examinee.id}`);
  expect(git(place.path, "rev-parse", "HEAD")).toBe(wip);
  expect(git(place.path, "show", "HEAD:wip.txt")).toBe("half an answer");
  expect(existsSync(join(place.path, "build", "out.txt"))).toBe(true);
  db.close();
});

it("出題が記録した head を面接室で引けなければ、checkout を開くことはその理由で投げ、repo もブランチも作らない(ADR 0276 決定1)", async () => {
  const db = openDb(":memory:");
  const workspace = await makeWorkspace("examinee-unresolvable-head");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = interviewRoomPath(db, root.id)!;
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  const [examinee] = poseAccepted(db, root, POSE, "auditor", NOW, "worker", unknown) as [Task];

  expect(() => openExamineeCheckout(db, examinee, dirname(room), NOW)).toThrow(
    `the protected branch head the probe recorded for ${examinee.id} (${unknown}) cannot be resolved in this checkout`,
  );
  expect(existsSync(join(dirname(room), examinee.id, ".git"))).toBe(false);
  expect(git(room, "branch", "--list", `task/${examinee.id}`)).toBe("");
  db.close();
});

it("ref の基準は受験者の checkout ごと —— 中断中の受験者の基準は次の受験者の準備で上書きされず、その解放は盤面自身の違反を立てない(ADR 0276 決定3 / ADR 0064)", async () => {
  const db = openDb(":memory:");
  const { workspace, root, examinees, base } = await posedInRoom(db, [opusHigh, sonnetHigh]);
  const [interrupted, next] = examinees as [Task, Task];
  const interruptedPlace = await pickUp(db, interrupted, workspace, base);
  const nextPlace = await pickUp(db, next, workspace, base);

  releaseWorkspace(db, interruptedPlace, interrupted, NOW);
  releaseWorkspace(db, nextPlace, next, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  db.close();
});

it("決着した受験者の checkout とタスクブランチは、次の受験者の準備の後も別の Interview の受験者の準備の後も残り、面接室の ref・reflog・object は減らない(ADR 0276 決定4)", async () => {
  const db = openDb(":memory:");
  const { workspace, room, examinees, base } = await posedInRoom(db, [opusHigh, sonnetHigh]);
  const [done, next] = examinees as [Task, Task];
  const donePlace = await pickUp(db, done, workspace, base);
  commitWork(donePlace.path, "answer.txt", "an answer\n");
  const answer = git(donePlace.path, "rev-parse", "HEAD");
  releaseWorkspace(db, donePlace, done, NOW, true, undefined, undefined, true);
  completeTask(db, done, FULL_HANDOFF, "tako", NOW, "worker");
  const roomState = () => [git(room.path, "for-each-ref"), git(room.path, "reflog", "show", "--no-abbrev", "HEAD"), git(room.path, "count-objects", "-v")];
  const before = roomState();
  const other = await posedInRoom(db);

  await pickUp(db, next, workspace, base);
  await pickUp(db, other.examinees[0]!, other.workspace, other.base);

  expect(git(donePlace.path, "rev-parse", `task/${done.id}`)).toBe(answer);
  expect(git(donePlace.path, "show", `task/${done.id}:answer.txt`)).toBe("an answer");
  expect(roomState()).toEqual(before);
  db.close();
});


it("決着した受験者の下に repair の work を登録すると拒まれる(ADR 0268 決定5)", async () => {
  const db = openDb(":memory:");
  const [child] = (await posedInRoom(db)).examinees as [Task];
  const settled = completeTask(db, child, FULL_HANDOFF, "tako", NOW, "worker");

  expect(() => registerTask(db, { type: "work", title: "repair", purpose: "fix the answer", completion_criteria: "fixed", parent_id: settled.id }, NOW, ...HUMAN_WEBUI)).toThrow(DomainError);
  db.close();
});
