import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { completeTask, examineeCheckoutPath, interviewRoomPath, registerTask, type Task } from "../src/tasks.js";
import {
  commitRoomCopy,
  excludeWorkspaceProjectSettings,
  openInterviewRoom,
  PlaceNotOpenError,
  type RunPlace,
  recordedInterviewRoom,
  recordTaskCheckoutTip,
  releaseWorkspace,
  runPlaceReadPaths,
  taskRunPlace,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { humanAskpass, startDenyingHttpRemote } from "./git-http-remote.js";
import { commitWork, FULL_HANDOFF, failGitCommits, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, interviewExaminee, makeWorkspace, openTestInterviewRoom, poseAccepted, prepareAtPickup } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 出題の写しと面接室の開き方(ADR 0273 決定1・3)、root と受験者の task の checkout(ADR 0356 決定1・2 / ADR 0276)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-10-15T00:00:00.000Z");
const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const sonnetHigh = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" };
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };

/** 面接室を開いて root を拾った姿(scheduler と同じ順: 面接室を開き、面接室を準備して task の checkout を開く)。基点は面接室と同じ規約の基点。 */
async function pickedRoot(db: Db, name = "room-copy-real") {
  const workspace = await makeWorkspace(name);
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: [opusHigh, sonnetHigh] as never }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = recordedInterviewRoom(db, root.id)!;
  const base = dirname(room.path);
  const place = await prepareAtPickup(db, room, root, { real: workspace, workspacesBaseDir: base });
  return { workspace, root, room, base, place };
}

/** root の session が見る git の状態: HEAD、作業ツリーと本物の index(status)、index の中身。 */
const sessionState = (place: WorkspaceConfig) => [git(place.path, "rev-parse", "HEAD"), git(place.path, "status", "--porcelain", "--untracked-files=all"), git(place.path, "ls-files", "--stage")];

it("出題の写しは、root の task の checkout の作業ツリー(commit 済み・stage 済み・未 stage・untracked の全部)を、面接室の保護ブランチの head を親にした盤面名義の commit にして面接室に ref を1本置く —— root の HEAD・作業ツリー・index も面接室の HEAD も動かない(ADR 0273 決定3 / ADR 0356 決定3・6)", async () => {
  const db = openDb(":memory:");
  const { room, root, place } = await pickedRoot(db);
  const main = git(room.path, "rev-parse", "main");
  commitWork(place.path, "committed.txt", "on the root's branch\n");
  writeFileSync(join(place.path, "staged.txt"), "staged\n");
  git(place.path, "add", "staged.txt");
  writeFileSync(join(place.path, "committed.txt"), "edited, not staged\n");
  mkdirSync(join(place.path, "src"));
  writeFileSync(join(place.path, "src", "untracked.txt"), "untracked\n");
  const before = sessionState(place);

  const head = commitRoomCopy(db, place, root.id);

  expect(sessionState(place)).toEqual(before);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(room.path, "log", "--format=%an %P", "-1", head)).toBe(`tidepool ${main}`);
  expect(git(room.path, "ls-tree", "-r", "--name-only", head).split("\n")).toEqual(["committed.txt", "src/untracked.txt", "staged.txt"]);
  expect(git(room.path, "show", `${head}:committed.txt`)).toBe("edited, not staged");
  expect(git(room.path, "for-each-ref", "--points-at", head, "--format=%(refname)").split("\n")).toEqual([`refs/keep-around/${head}`]);
  db.close();
});

it("空の作業ツリーの写しも、空の tree の commit になる", async () => {
  const db = openDb(":memory:");
  const { room, root, place } = await pickedRoot(db);

  const head = commitRoomCopy(db, place, root.id);

  expect(git(room.path, "ls-tree", "-r", head)).toBe("");
  expect(git(room.path, "rev-parse", `${head}^`)).toBe(git(room.path, "rev-parse", "main"));
  db.close();
});

it("写しは session の最中のサンドボックスの shadow 残骸(ADR 0069 の既知パス・untracked・0 バイト)を含まず、同じパスでも中身のあるファイルは含む", async () => {
  const db = openDb(":memory:");
  const { room, root, place } = await pickedRoot(db);
  writeFileSync(join(place.path, ".bashrc"), "");
  mkdirSync(join(place.path, ".claude"));
  writeFileSync(join(place.path, ".claude", "agents"), "");
  writeFileSync(join(place.path, ".mcp.json"), "{}\n");

  const head = commitRoomCopy(db, place, root.id);

  expect(git(room.path, "ls-tree", "-r", "--name-only", head).split("\n")).toEqual([".mcp.json"]);
  db.close();
});

it("root が自分の .git/config に書いた clean filter は出題の写しで走らず、出題の head は面接室で引ける(ADR 0356 決定3、#3031 の確認点)", async () => {
  const db = openDb(":memory:");
  const { room, root, place } = await pickedRoot(db);
  const marker = join(await tempDir("tidepool-room-filter-"), "ran");
  commitWork(place.path, ".gitattributes", "*.txt filter=marker\n");
  git(place.path, "config", "filter.marker.clean", `touch ${marker}; cat`);
  writeFileSync(join(place.path, "probe.txt"), "the environment\n");

  const head = commitRoomCopy(db, place, root.id);

  expect(existsSync(marker)).toBe(false);
  expect(git(room.path, "rev-parse", "--verify", `${head}^{commit}`)).toBe(head);
  expect(git(room.path, "show", `${head}:probe.txt`)).toBe("the environment");
  db.close();
});

it("面接室は規約の基点の下の root の id に、盤面名義の空コミット 'Initial commit' だけを持つ repo として開き、在り処を実体の綴りで残す —— 空コミットが落ちれば event は残らず、次に開くと残った repo の続きから作る(ADR 0329 決定1・2)", async () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-room-open-");
  failGitCommits();
  expect(() => openInterviewRoom(db, root, base, NOW)).toThrow("fixture commit failed");
  vi.unstubAllEnvs();
  const room = realpathSync(join(base, root.id));
  expect(interviewRoomPath(db, root.id)).toBeUndefined();

  openInterviewRoom(db, root, base, NOW);
  openInterviewRoom(db, root, base, NOW);

  expect(interviewRoomPath(db, root.id)).toBe(room);
  expect(git(room, "log", "--format=%an %s", "main")).toBe("tidepool Initial commit");
  expect(listEvents(db, root.id).filter((event) => event.payload.kind === "interview_room_opened")).toHaveLength(1);
  db.close();
});

it("git init が落ちた面接室はディレクトリを残し、開いた event は残さない(ADR 0329 決定1)", async () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-room-init-failure-");
  const path = join(base, root.id);
  mkdirSync(path);
  writeFileSync(join(path, ".git"), "not a gitfile\n");

  expect(() => openInterviewRoom(db, root, base, NOW)).toThrow();
  expect(interviewRoomPath(db, root.id)).toBeUndefined();
  expect(existsSync(path)).toBe(true);
  db.close();
});

it.each([false, true])("記録済みの master の面接室は、未生の HEAD だけ main に向け直して空コミットを補い、生まれた HEAD は保つ(born=%s、ADR 0329 決定13)", async (born) => {
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-room-master-");
  openInterviewRoom(db, root, base, NOW);
  const path = interviewRoomPath(db, root.id)!;
  rmSync(join(path, ".git"), { recursive: true });
  git(path, "init", "--quiet", "--initial-branch=master");
  if (born) git(path, "commit", "--quiet", "--allow-empty", "-m", "Human history");

  openInterviewRoom(db, root, base, NOW);

  expect(git(path, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(born ? "refs/heads/master" : "refs/heads/main");
  expect(git(path, "log", "--format=%s")).toBe(born ? "Human history" : "Initial commit");
  db.close();
});

it("repo 完成後・event 前に落ちた面接室は、既存の HEAD と作業ツリーを保って event を1度だけ書く(ADR 0329 決定2)", async () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir("tidepool-room-crash-");
  const path = join(base, root.id);
  mkdirSync(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
  commitWork(path, "kept.txt", "keep the completed repository\n");
  writeFileSync(join(path, "untracked.txt"), "keep the working tree\n");
  const before = sessionState({ name: root.id, path });

  openInterviewRoom(db, root, base, NOW);
  openInterviewRoom(db, root, base, NOW);

  expect(sessionState({ name: root.id, path })).toEqual(before);
  expect(listEvents(db, root.id).filter((e) => e.kind === "interview_room_opened")).toHaveLength(1);
  db.close();
});

it("root の走る場所は面接室の外の task の checkout で、実環境を path でなく場所(名前・repo・保護ブランチを持つ WorkspaceConfig、在り処は実体の綴り)として読む —— 面接室の HEAD は root の session の前・中・後で main(issue #2223 / ADR 0356 決定1 / ADR 0276 決定1)", async () => {
  const db = openDb(":memory:");
  const workspace = { ...(await makeWorkspace("reads-real")), repo: "https://github.com/acme/reads-real.git", branch: "main" };
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = recordedInterviewRoom(db, root.id)!;
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

  const place = await prepareAtPickup(db, room, root, { real: workspace, workspacesBaseDir: dirname(room.path) });

  expect(place).toMatchObject({ name: root.id, namedPlace: room, reads: [{ ...workspace, path: realpathSync(workspace.path) }] });
  expect(place.path.startsWith(`${room.path}/`)).toBe(false);
  expect(place.path.startsWith(`${room.path}.checkout/`)).toBe(true);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${root.id}`);
  commitWork(place.path, "probe.txt", "the environment\n");
  writeFileSync(join(place.path, "draft.txt"), "half composed\n");

  releaseWorkspace(db, place, root, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(room.path, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
  expect(git(room.path, "show", `task/${root.id}:draft.txt`)).toBe("half composed");
  expect(existsSync(place.path)).toBe(false);
  db.close();
});

it("Interview の場所の読みの path に面接室の objects は入らない —— root は実環境だけ、受験者は何も読みに開かない(ADR 0356 決定2 追記)", async () => {
  const db = openDb(":memory:");
  const { workspace, root, room, base, place } = await pickedRoot(db, "read-paths-real");
  expect(runPlaceReadPaths(place)).toEqual([realpathSync(workspace.path)]);
  const [examinee] = poseAccepted(db, root, POSE, "auditor", NOW, "worker", commitRoomCopy(db, place, root.id)) as [Task];
  releaseWorkspace(db, place, root, NOW);

  expect(runPlaceReadPaths(await pickUp(db, examinee, room, base))).toEqual([]);
  db.close();
});

/** root が task の checkout で環境を組んで出題し、監査が受理し、root が解放された姿。`compose` は写しの前に root の作業ツリーへ書く。 */
async function posedInRoom(db: Db, compose: (checkout: string) => void = () => {}) {
  const picked = await pickedRoot(db, "examinee-checkout-real");
  const { root, place } = picked;
  commitWork(place.path, "probe.txt", "the environment\n");
  compose(place.path);
  const head = commitRoomCopy(db, place, root.id);
  const examinees = poseAccepted(db, root, POSE, "auditor", NOW, "worker", head);
  releaseWorkspace(db, place, root, NOW);
  return { ...picked, head, examinees };
}

/** 受験者の pickup の順(scheduler と同じ): 面接室を準備して task の checkout を開く。 */
const pickUp = (db: Db, examinee: Task, room: WorkspaceConfig, base: string): Promise<RunPlace> => prepareAtPickup(db, room, examinee, { workspacesBaseDir: base });

/** 退避と削除を通らない、受験者の完了の門(ADR 0359 決定1)と verb の記録。 */
function complete(db: Db, place: RunPlace, examinee: Task): Task {
  recordTaskCheckoutTip(db, place, examinee.id);
  return completeTask(db, examinee, FULL_HANDOFF, "tako", NOW, "worker");
}

it("出題の後、head は面接室で引けて keep-around から到達でき、面接室の HEAD は main のまま —— 受験者の初回の pickup は面接室の外(規約の基点の下の受験者の id)に複製の checkout を開き、履歴は出題の head とその祖先だけで、兄弟・root のブランチも keep-around も alternates も持たない(ADR 0273 決定3 / ADR 0276 決定1・3 / ADR 0356 決定2 追記)", async () => {
  const db = openDb(":memory:");
  const { root, room, head, examinees, base } = await posedInRoom(db);
  const [first, second] = examinees as [Task, Task];
  expect(git(room.path, "rev-parse", "--verify", `${head}^{commit}`)).toBe(head);
  expect(git(room.path, "rev-parse", `refs/keep-around/${head}`)).toBe(head);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

  const place = await pickUp(db, first, room, base);
  await pickUp(db, second, room, base);

  const checkout = place.path;
  expect(place).toMatchObject({ name: root.id, namedPlace: room, reads: [] });
  expect(examineeCheckoutPath(db, first.id)).toBe(checkout);
  expect(dirname(checkout)).toBe(realpathSync(join(base, first.id)));
  expect(checkout.startsWith(`${room.path}/`)).toBe(false);
  expect(existsSync(join(checkout, ".git", "objects", "info", "alternates"))).toBe(false);
  expect(git(checkout, "log", "--all", "--format=%s").split("\n")).toEqual(["Add the project files", "Initial commit"]);
  expect(git(checkout, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(`refs/heads/task/${first.id} ${head}`);
  expect(git(checkout, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${first.id}`);
  expect(git(checkout, "status", "--porcelain")).toBe("");
  expect(readdirSync(checkout).sort()).toEqual([".git", "probe.txt"]);
  expect(git(room.path, "rev-parse", `task/${first.id}`)).toBe(head);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  // 面接室の在り処(root の id を持つ)は受験者の `.git` のどのファイルにも残らない —— FETCH_HEAD・config・reflog・packed-refs も
  const gitFiles = readdirSync(join(checkout, ".git"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  for (const file of gitFiles) expect(readFileSync(join(file.parentPath, file.name), "latin1")).not.toContain(root.id);
  db.close();
});

it("出題の写しと root の解放の間で盤面が落ちても、後始末の再実行は普通の解放で、head は面接室で引けたまま受験者の pickup が引ける(ADR 0356 決定6)", async () => {
  const db = openDb(":memory:");
  const { workspace, root, room, base, place } = await pickedRoot(db, "pose-crash-real");
  commitWork(place.path, "probe.txt", "the environment\n");
  const head = commitRoomCopy(db, place, root.id);
  const [examinee] = poseAccepted(db, root, POSE, "auditor", NOW, "worker", head) as [Task];

  // 再起動の復旧は記録から走る場所を引き直して解放する
  releaseWorkspace(db, taskRunPlace(db, root, workspace), root, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
  expect(git(room.path, "rev-parse", "--verify", `${head}^{commit}`)).toBe(head);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  const examineePlace = await pickUp(db, examinee, room, base);
  expect(git(examineePlace.path, "rev-parse", "HEAD")).toBe(head);
  db.close();
});

it("root が .gitignore で外したものも先の受験者の ignored の生成物も、次の受験者の作業ツリーに無い(ADR 0276 決定2)", async () => {
  const db = openDb(":memory:");
  const { room, examinees, base } = await posedInRoom(db, (checkout) => {
    writeFileSync(join(checkout, ".gitignore"), "build/\n");
    mkdirSync(join(checkout, "build"));
    writeFileSync(join(checkout, "build", "root-made.txt"), "the root's build\n");
  });
  const [first, second] = examinees as [Task, Task];
  const firstPlace = await pickUp(db, first, room, base);
  mkdirSync(join(firstPlace.path, "build"));
  writeFileSync(join(firstPlace.path, "build", "first-made.txt"), "the first target's build\n");
  releaseWorkspace(db, firstPlace, first, NOW);

  const secondPlace = await pickUp(db, second, room, base);

  expect(readdirSync(secondPlace.path).sort()).toEqual([".git", ".gitignore", "probe.txt"]);
  expect(git(secondPlace.path, "status", "--porcelain", "--ignored")).toBe("");
  db.close();
});

// 旧: 解放は受験者の checkout で tree rule を通して main に戻し、再開は同じ checkout を使った(ADR 0276 決定1)。ADR 0356 決定2 の後は
// WIP が面接室のタスクブランチに着いて checkout は消え、再開はその tip から作り直す
it("受験者の escalate・上限の解放は WIP を面接室の task/<id> に着けて checkout を消し、再開はその tip から checkout を作り直して WIP の中身を持つ —— 兄弟のブランチは見えない(ADR 0356 決定2 追記)", async () => {
  const db = openDb(":memory:");
  const { root, room, examinees, base } = await posedInRoom(db);
  const [examinee, sibling] = examinees as [Task, Task];
  const place = await pickUp(db, examinee, room, base);
  commitWork(place.path, "answer.txt", "a committed step\n");
  writeFileSync(join(place.path, "wip.txt"), "half an answer\n");

  releaseWorkspace(db, place, examinee, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
  const wip = git(room.path, "rev-parse", `task/${examinee.id}`);
  expect(git(room.path, "show", `${wip}:wip.txt`)).toBe("half an answer");
  expect(git(room.path, "show", `${wip}:answer.txt`)).toBe("a committed step");
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

  const resumed = await pickUp(db, examinee, room, base);
  const siblingPlace = await pickUp(db, sibling, room, base);

  expect(resumed.path).not.toBe(place.path);
  expect(git(resumed.path, "rev-parse", "HEAD")).toBe(wip);
  expect(readFileSync(join(resumed.path, "wip.txt"), "utf8")).toBe("half an answer\n");
  expect(git(resumed.path, "status", "--porcelain")).toBe("");
  expect(git(siblingPlace.path, "for-each-ref", "--format=%(refname)")).toBe(`refs/heads/task/${sibling.id}`);
  expect(() => git(siblingPlace.path, "cat-file", "-e", `${wip}^{commit}`)).toThrow();
  db.close();
});

it("受験者の解放の再実行は何もせず quarantine も立てない —— タスクブランチだけが無視する生成物があっても(#2960 の probe の書き直し、ADR 0356 決定2)", async () => {
  const db = openDb(":memory:");
  const { root, room, examinees, base } = await posedInRoom(db);
  const examinee = examinees[0]!;
  const place = await pickUp(db, examinee, room, base);
  commitWork(place.path, ".gitignore", "build/\n");
  mkdirSync(join(place.path, "build"));
  writeFileSync(join(place.path, "build", "out.txt"), "generated\n");
  releaseWorkspace(db, place, examinee, NOW);
  const tip = git(room.path, "rev-parse", `task/${examinee.id}`);

  releaseWorkspace(db, place, examinee, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(git(room.path, "rev-parse", `task/${examinee.id}`)).toBe(tip);
  expect(listEvents(db, examinee.id).filter((e) => e.kind === "task_checkout_released")).toHaveLength(1);
  db.close();
});

// 旧: ref の基準は受験者の checkout ごとで、鍵は受験者の id だった(ADR 0276 決定3)。ADR 0356 決定4 の後は基準は名前の場所(面接室、root id)だけが持つ
it("受験者の pickup・解放・完了は workspace_state にも sparse の pin にも受験者の id の行を作らず、中断中の受験者と次の受験者の解放は盤面自身の違反を立てない(ADR 0356 決定4)", async () => {
  const db = openDb(":memory:");
  const { root, room, examinees, base } = await posedInRoom(db);
  const [interrupted, next] = examinees as [Task, Task];
  const interruptedPlace = await pickUp(db, interrupted, room, base);
  const nextPlace = await pickUp(db, next, room, base);
  excludeWorkspaceProjectSettings(db, nextPlace);
  commitWork(nextPlace.path, "answer.txt", "an answer\n");

  releaseWorkspace(db, interruptedPlace, interrupted, NOW);
  const done = complete(db, nextPlace, next);
  releaseWorkspace(db, nextPlace, done, NOW, true, undefined, undefined, true);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  const keys = [
    ...(db.prepare("SELECT name FROM workspace_state").pluck().all() as string[]),
    ...(db.prepare("SELECT name FROM workspace_sparse_policies").pluck().all() as string[]),
  ];
  expect(keys.filter((key) => key === interrupted.id || key === next.id)).toEqual([]);
  expect(keys).toContain(root.id);
  db.close();
});

it("決着した受験者の解放は最後の checkout を残し、その HEAD は最後の tip で、解放済みと刻まない —— 再実行も quarantine を立てず、次の受験者の準備の後も残る(ADR 0276 決定4)", async () => {
  const db = openDb(":memory:");
  const { root, room, examinees, base } = await posedInRoom(db);
  const [examinee, next] = examinees as [Task, Task];
  const place = await pickUp(db, examinee, room, base);
  commitWork(place.path, "answer.txt", "an answer\n");
  const answer = git(place.path, "rev-parse", "HEAD");
  const done = complete(db, place, examinee);

  releaseWorkspace(db, place, done, NOW, true, undefined, undefined, true);
  releaseWorkspace(db, place, done, NOW, true, undefined, undefined, true);
  await pickUp(db, next, room, base);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(git(place.path, "rev-parse", "HEAD")).toBe(answer);
  expect(git(place.path, "show", "HEAD:answer.txt")).toBe("an answer");
  expect(git(room.path, "rev-parse", `task/${examinee.id}`)).toBe(answer);
  expect(examineeCheckoutPath(db, examinee.id)).toBe(place.path);
  expect(listEvents(db, examinee.id).filter((e) => e.kind === "task_checkout_released")).toEqual([]);
  db.close();
});

// 旧: 受験者は checkout を共有していたので、報告後の書き込みを答案に退避せず面接室を quarantine した(ADR 0109 決定3、#3053 の例外)。
// ADR 0359 決定3 の後は work と同じく観測として記録し、面接室は止めない
it("受験者の報告後の書き込みは答案に入らず観測として記録され、面接室を止めない(ADR 0359 決定3)", async () => {
  const db = openDb(":memory:");
  const { root, room, examinees, base } = await posedInRoom(db);
  const examinee = examinees[0]!;
  const place = await pickUp(db, examinee, room, base);
  commitWork(place.path, "answer.txt", "an answer\n");
  const answer = git(place.path, "rev-parse", "HEAD");
  const done = complete(db, place, examinee);
  writeFileSync(join(place.path, "late.txt"), "outside the answer\n");

  releaseWorkspace(db, place, done, NOW, true, undefined, undefined, true);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(git(room.path, "rev-parse", `task/${done.id}`)).toBe(answer);
  expect(listEvents(db, done.id).find((e) => e.kind === "task_checkout_written_after_completion")?.payload).toMatchObject({ observation: "uncommitted", paths: ["late.txt"] });
  db.close();
});

it("未決着の受験者の解放で checkout の repo が読めなければ、task の失敗として checkout を残し、面接室は止めない(ADR 0356 決定2)", async () => {
  const db = openDb(":memory:");
  const { root, room, examinees, base } = await posedInRoom(db);
  const examinee = examinees[0]!;
  const place = await pickUp(db, examinee, room, base);
  writeFileSync(join(place.path, "wip.txt"), "half an answer\n");
  rmSync(join(place.path, ".git"), { recursive: true });

  releaseWorkspace(db, place, examinee, NOW);

  expect(workspaceNeedsHuman(db, root.id)).toBe(false);
  expect(readFileSync(join(place.path, "wip.txt"), "utf8")).toBe("half an answer\n");
  expect(listEvents(db, examinee.id).map((e) => e.kind)).toContain("task_checkout_release_failed");
  db.close();
});

it("global の insteadOf が面接室の path を http へ書き換えても、受験者の checkout は網に出ず作成する(ADR 0356 決定5)", async () => {
  const db = openDb(":memory:");
  const { room, examinees, base } = await posedInRoom(db);
  const remote = await startDenyingHttpRemote();
  const globalConfig = join(await tempDir("tidepool-global-config-"), "gitconfig");
  writeFileSync(globalConfig, `[url "${remote.url}"]\n\tinsteadOf = ${room.path}\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("LC_ALL", "C");
  const askpass = await humanAskpass();

  try {
    const examinee = examinees[0] as Task;
    await pickUp(db, examinee, room, base);
    expect(examineeCheckoutPath(db, examinee.id)).toBeDefined();
    expect({ askpass: askpass.tripped(), requests: remote.requests() }).toEqual({ askpass: false, requests: [] });
  } finally {
    vi.unstubAllEnvs();
    db.close();
  }
});

it("出題が記録した head を面接室で引けなければ、受験者の準備はその理由で投げ、checkout もブランチも作らない(ADR 0276 決定1)", async () => {
  const db = openDb(":memory:");
  const workspace = await makeWorkspace("examinee-unresolvable-head");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: [opusHigh] as never }, NOW, ...HUMAN_WEBUI);
  openTestInterviewRoom(db, root);
  const room = recordedInterviewRoom(db, root.id)!;
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  const [examinee] = poseAccepted(db, root, POSE, "auditor", NOW, "worker", unknown) as [Task];

  await expect(pickUp(db, examinee, room, dirname(room.path))).rejects.toThrow(
    `the protected branch head the probe recorded for ${examinee.id} (${unknown}) cannot be resolved in this checkout`,
  );
  expect(examineeCheckoutPath(db, examinee.id)).toBeUndefined();
  expect(existsSync(join(dirname(room.path), examinee.id))).toBe(false);
  expect(git(room.path, "branch", "--list", `task/${examinee.id}`)).toBe("");
  db.close();
});

// 旧: 受験者の checkout は記録された場所で、main の checkout が落ちた回と event 前の回の開き直しを釘にしていた(ADR 0329 決定1・2)。
// ADR 0356 決定2 の後は pickup ごとの番地に作り直す task の checkout で、開いた event が repo の後に書かれる釘は work と共有する
it("面接室の在り処が無い Interview の受験者の走る場所は、面接室が開いていないと名指して投げる(quarantine の理由になる)", async () => {
  const db = openDb(":memory:");
  const examinee = interviewExaminee(db, NOW);
  const workspace = await makeWorkspace("examinee-no-room");

  expect(() => taskRunPlace(db, examinee, workspace)).toThrow(PlaceNotOpenError);
  expect(() => taskRunPlace(db, examinee, workspace)).toThrow("the interview room of");
  db.close();
});

it("決着した受験者の下に repair の work を登録すると拒まれる(ADR 0268 決定5)", async () => {
  const db = openDb(":memory:");
  const [child] = (await posedInRoom(db)).examinees as [Task];
  const settled = completeTask(db, child, FULL_HANDOFF, "tako", NOW, "worker");

  expect(() => registerTask(db, { type: "work", title: "repair", purpose: "fix the answer", completion_criteria: "fixed", parent_id: settled.id }, NOW, ...HUMAN_WEBUI)).toThrow(DomainError);
  db.close();
});
