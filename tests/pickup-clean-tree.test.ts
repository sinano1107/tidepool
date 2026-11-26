import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { boardReadTree, boardWriteTree, CheckoutHostError, CheckoutUnreadableError } from "../src/git.js";
import { checkoutPickupPredicates, discardUncommitted } from "../src/pickup-predicates.js";
import { registerTask } from "../src/tasks.js";
import { WorkerTreeGitTimeoutError } from "../src/worker-tree-git-timeout.js";
import { commitRoomCopy, NamedPlaceFetchError, PickupGateError, RoomCopyGitlinkError, recordedInterviewRoom, releaseWorkspace, verifyWorkspaceClean, type WorkspaceConfig } from "../src/workspace.js";
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

  expect(() => commitRoomCopy(db, place, root.id)).toThrow(CheckoutUnreadableError);
  expect(gitObjectFileCount(room.path)).toBe(before);
});

// ADR 0365 決定2: 出題の写しも記録に worker の tree を書く —— 面接室の保護ブランチの head から gitlink を足す・進める tree は ref を書く前に拒む
it.each(["追加", "前進"] as const)("root の checkout が gitlink を%sしたら、出題の写しは path を名指して拒み、面接室の保護ブランチも keep-around の ref も動かない(ADR 0365 決定2)", async (change) => {
  const source = await submoduleSource("room-copy-gitlink-source");
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-gitlink"), change === "前進" ? (room) => commitSubmodule(room, source) : undefined);
  if (change === "前進") {
    commitWork(source, "lib.txt", "v2\n");
    const tip = git(source, "rev-parse", "HEAD");
    git(place.path, "update-index", "--cacheinfo", `160000,${tip},mod`);
    git(place.path, "commit", "-m", "advance the library");
    mkdirSync(join(place.path, "mod"), { recursive: true });
  } else {
    commitSubmodule(place.path, source);
  }
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

it("保護ブランチと同名の注釈付きタグがあっても、出題の写しの親はブランチの commit になる(ADR 0360 決定3・5)", async () => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-branch-and-tag"));
  const parent = git(room.path, "rev-parse", "refs/heads/main");
  git(room.path, "tag", "-a", "main", parent, "-m", "same name as the protected branch");
  const tag = git(room.path, "rev-parse", "refs/tags/main");
  writeFileSync(join(place.path, "probe.txt"), "the environment\n");

  const head = commitRoomCopy(db, place, root.id);

  expect(git(room.path, "rev-parse", `${head}^`)).toBe(parent);
  expect(git(room.path, "rev-parse", "refs/tags/main")).toBe(tag);
});

it("保護ブランチの ref が注釈付きタグを指す場合は、出題の写しを書かずに拒む(ADR 0423 決定3)", async () => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-tag-parent"));
  git(room.path, "tag", "-a", "tag", "-m", "invalid protected branch target");
  const tag = git(room.path, "rev-parse", "refs/tags/tag");
  writeFileSync(join(room.path, ".git", "refs", "heads", "main"), `${tag}\n`);
  writeFileSync(join(place.path, "probe.txt"), "the environment\n");

  expect(() => commitRoomCopy(db, place, root.id)).toThrow(`recorded parent ${tag} is not a commit`);
  expect(git(room.path, "rev-parse", "refs/heads/main")).toBe(tag);
  expect(git(room.path, "for-each-ref", "refs/keep-around/")).toBe("");
});

/** 面接室の loose `id` を消す(`missing`)か、zlib でない byte に置き換える(`corrupt`)。 */
function damageLoose(repo: string, id: string, damage: "missing" | "corrupt"): void {
  const loose = join(repo, ".git", "objects", id.slice(0, 2), id.slice(2));
  rmSync(loose);
  if (damage === "corrupt") writeFileSync(loose, "not zlib");
}

// #3814: 出題の写しの callback は面接室にしか無い保護ブランチの親を読む。親の commit・tree の損傷は root の worktree の故障(`pose_probe` が
// 「作業ツリーを直せ」と拒む型)にも worker の git の時間切れ(root の回収)にもならない —— 型の無い失敗は面接室の側の拒みに落ちる。
// worktree が再現する面接室の tree(前の出題の写し)の破損は下の固定が扱う
it.each([
  ["commit", "missing"],
  ["commit", "corrupt"],
  ["tree", "missing"],
  ["tree", "corrupt"],
] as const)("面接室の保護ブランチの親の %s が %s なら、出題の写しは root の worktree の故障にせず ref も書かない(#3814)", async (object, damage) => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-damaged-parent"));
  commitWork(place.path, "probe.txt", "the environment\n");
  // root の tip の閉包の外へ進める —— 親の commit と tree は面接室の loose にしか無い
  commitWork(room.path, "room-only.txt", "only in the room\n");
  const protectedHead = git(room.path, "rev-parse", "refs/heads/main");
  damageLoose(room.path, git(room.path, "rev-parse", object === "commit" ? protectedHead : `${protectedHead}^{tree}`), damage);

  const failure = (() => {
    try {
      commitRoomCopy(db, place, root.id);
    } catch (err) {
      return err;
    }
  })();

  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(CheckoutUnreadableError);
  expect(failure).not.toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(git(room.path, "rev-parse", "refs/heads/main")).toBe(protectedHead);
  expect(git(room.path, "for-each-ref", "refs/keep-around/")).toBe("");
});

// ADR 0412 決定1・2(#3814): 出題の写しの stage は面接室の objects を借りない —— worktree が前の写しの tree を再現しても stage は自前で書き、
// 面接室の tree の破損は面接室への fetch が読んで落ちる。欠けなら stage が書いた tree が運ばれる
it.each(["corrupt", "missing"] as const)("worktree が前の出題の写しの tree を再現し面接室のその tree が %s なら、出題し直しは root の worktree の故障にしない(#3814)", async (damage) => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-reposed-tree"));
  writeFileSync(join(place.path, "notes.txt"), "not committed\n");
  const first = commitRoomCopy(db, place, root.id);
  // commit の日付は秒の粒度 —— 同じ秒の出題し直しは1回目と同じ commit を面接室から借りて書かず、運ぶものも確かめる自前の object も無い
  // (面接室の外からの損傷は守らない、ADR 0398 決定3)。ここで見るのは別の commit を運ぶ出題し直し
  await new Promise((resolve) => setTimeout(resolve, 1050 - (Date.now() % 1000)));
  const protectedHead = git(room.path, "rev-parse", "refs/heads/main");
  const keptAround = git(room.path, "for-each-ref", "refs/keep-around/");
  damageLoose(room.path, git(room.path, "rev-parse", `${first}^{tree}`), damage);

  if (damage === "corrupt") {
    expect(() => commitRoomCopy(db, place, root.id)).toThrow(NamedPlaceFetchError);
    expect(git(room.path, "rev-parse", "refs/heads/main")).toBe(protectedHead);
    expect(git(room.path, "for-each-ref", "refs/keep-around/")).toBe(keptAround);
  } else {
    const head = commitRoomCopy(db, place, root.id);
    expect(git(room.path, "cat-file", "-p", `${head}:notes.txt`)).toBe("not committed");
  }
});

// ADR 0412 決定2 / ADR 0388 決定2(#3814): stage が自前で書いた blob は運んだ後の確かめの集合に入る —— 面接室にしか無い同じ中身の blob が
// 壊れていれば入れ直す
it("worktree が面接室にしか無い壊れた blob と同じ中身を持てば、出題の写しは通りその blob を面接室で読めるようにする(#3814)", async () => {
  const { root, room, place } = await pickedRoot(await makeWorkspace("room-copy-room-only-blob"));
  writeFileSync(join(place.path, "notes.txt"), "only in the room\n");
  const blob = git(room.path, "hash-object", "-w", join(place.path, "notes.txt"));
  damageLoose(room.path, blob, "corrupt");

  commitRoomCopy(db, place, root.id);

  expect(git(room.path, "cat-file", "-p", blob)).toBe("only in the room");
});

// ADR 0412 決定2(#3814): stage が名前の場所の objects を読まないことは stage の入口で強制する —— 借りた写しを渡すのは盤面の不変条件の破れで、
// worktree の故障にも host の失敗にも数えない。worktree は読めば `CheckoutUnreadableError` になる形にして、読む前に止まることを見る
it("objects を借りる repo を渡した stage は、worktree を読む前に型の無い失敗で止まる(#3814)", async () => {
  const workspace = await makeWorkspace("stage-borrowed-objects");
  breakCheckoutStaging(workspace.path, STAGING_FAILURES[0]);
  const borrowing = join(workspace.path, ".git", "borrowing");
  git(workspace.path, "clone", "--quiet", "--bare", "--shared", workspace.path, borrowing);
  const use = vi.fn();

  const failure = (() => {
    try {
      boardWriteTree(workspace.path, git(workspace.path, "rev-parse", "HEAD"), borrowing, use);
    } catch (err) {
      return err;
    }
  })();

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: expect.stringContaining("alternates") });
  for (const typed of [CheckoutUnreadableError, CheckoutHostError, WorkerTreeGitTimeoutError]) expect(failure).not.toBeInstanceOf(typed);
  expect(use).not.toHaveBeenCalled();
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

it("出口が名指す捨てる操作は、sparse の pin の下で cone の外に足されたファイルも捨てて tree を clean にする(ADR 0401 決定7, #3614)", async () => {
  const workspace = await makeWorkspace("discard-under-sparse-pin");
  mkdirSync(join(workspace.path, "d"));
  writeFileSync(join(workspace.path, "d", "hidden"), "hidden by the pin\n");
  git(workspace.path, "add", "d/hidden");
  git(workspace.path, "commit", "-m", "tracked outside the cone");
  const from = git(workspace.path, "rev-parse", "HEAD");
  mkdirSync(join(workspace.path, "n"));
  writeFileSync(join(workspace.path, "n", "new"), "outside the cone\n");
  git(workspace.path, "add", "n/new");
  git(workspace.path, "commit", "-m", "outside the cone");
  const to = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "reset", "-q", "--hard", from);
  // 本物の index に skip-worktree の bit が残り、n/new が staged になる
  boardReadTree(workspace.path, from, to, { pattern: "/*\n!/*/\n", cone: true });
  expect(git(workspace.path, "status", "--porcelain")).toBe("A  n/new");
  expect(existsSync(join(workspace.path, "d", "hidden"))).toBe(false);

  // 文から操作を読むので、文と働きがずれない
  const commands = [...discardUncommitted().matchAll(/`git [^`]+`/g)].slice(0, 2).map(([command]) => command.slice(1, -1));
  expect(commands).toHaveLength(2);
  for (const command of commands) git(workspace.path, ...command.split(" ").slice(1));

  expect(() => verifyWorkspaceClean(openDb(":memory:"), workspace)).not.toThrow();
  // --ignore-skip-worktree-bits なら pin が隠す file を書き出す —— 捨てる操作は pin の外を木に戻さない
  expect(existsSync(join(workspace.path, "d", "hidden"))).toBe(false);
});

/** 休止中の名前の場所に、盤面自身の checkout の移動が `read-tree -u -m` を済ませ ref を書く前に落ちた痕を作る —— 基準の `ref` の行は
 *  予告(`<old>|<new>`)のまま、ref は書かれず、index と木は新しい tree(ADR 0356 決定5 / ADR 0243 決定5)。`retried` は予告を
 *  先に1つ足した前の試み —— 行は `<old>|<retried>|<new>` の3値になる(`writeBoardRefs` の再予告)。 */
async function stalledCheckoutMove(name: string, ref = "refs/heads/main", retried = false) {
  const workspace = await makeWorkspace(name);
  db = openDb(":memory:");
  const earlier = work("earlier");
  releaseWorkspace(db, await prepareAtPickup(db, workspace, earlier), earlier, NOW);
  const from = git(workspace.path, "rev-parse", "HEAD");
  let candidates = from;
  if (retried) {
    commitWork(workspace.path, "first-try.txt", "first try\n");
    candidates += `|${git(workspace.path, "rev-parse", "HEAD")}`;
    git(workspace.path, "reset", "-q", "--hard", from);
  }
  commitWork(workspace.path, "moved.txt", "moved\n");
  const to = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "reset", "-q", "--hard", from);
  const baseline = db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(workspace.name) as string;
  const announced = baseline.includes(` ${ref}\n`) || baseline.endsWith(` ${ref}`)
    ? baseline.replace(`${from} ${ref}`, `${candidates}|${to} ${ref}`)
    : `${baseline}\n|${to} ${ref}`;
  db.prepare("UPDATE workspace_state SET ref_snapshot = ? WHERE name = ?").run(announced, workspace.name);
  boardReadTree(workspace.path, from, to);
  return { workspace, to };
}

it("盤面自身の checkout の移動が ref を書く前に落ちた痕では、pickup の拒否文が目標 sha・木と目標の比べ方・捨てる操作を名指す(ADR 0401 決定7, #3199)", async () => {
  const { workspace, to } = await stalledCheckoutMove("pickup-stalled-move");
  // 文が名指す比べ方がこの痕で本当に何も出さない —— read-tree が足した file は index に載り `??` にならない
  expect(git(workspace.path, "diff", to)).toBe("");
  expect(git(workspace.path, "status", "--porcelain")).not.toContain("??");

  const failure = await prepareAtPickup(db, workspace, work("next")).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(PickupGateError);
  const message = (failure as Error).message;
  expect(message).toContain(`its target is ${to}`);
  expect(message).toContain(`\`git diff ${to}\``);
  expect(message).toContain("`git status --porcelain` shows no `??` line");
  expect(message).toContain(discardUncommitted());
  expect(message).not.toContain("a process wrote them");
});

it("再予告で3値になった行では、最後の値を目標として名指す(ADR 0243 決定1, #3199)", async () => {
  const { workspace, to } = await stalledCheckoutMove("pickup-stalled-retried-move", "refs/heads/main", true);

  await expect(prepareAtPickup(db, workspace, work("next"))).rejects.toMatchObject({
    message: expect.stringContaining(`its target is ${to}`),
  });
});

it("checkout されていない ref の予告(`task/<id>` の作成)は木を動かさないので、dirty な休止の拒否文に注記を足さない(#3199)", async () => {
  const { workspace } = await stalledCheckoutMove("pickup-unchecked-announcement", "refs/heads/task/other");

  const failure = await prepareAtPickup(db, workspace, work("next")).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(PickupGateError);
  expect((failure as Error).message).toContain("a process wrote them after the board moved the checkout");
  expect((failure as Error).message).not.toContain("stopped part-way");
});

it("Quarantine の受理の clean の検査も、予告を読めるときは同じ注記を出す(ADR 0401 決定7, #3199)", async () => {
  const { workspace, to } = await stalledCheckoutMove("verify-stalled-move");

  expect(() => verifyWorkspaceClean(db, workspace)).toThrow(`\`git diff ${to}\``);
});
