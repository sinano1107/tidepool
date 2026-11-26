import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { HEAD_REPO_REMOTE } from "../src/github-auth.js";
import { assertLandingRefs, createLanding, type Landing, type LandingDeps, rootPrOutcome } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { registerTask, type Task } from "../src/tasks.js";
import { DeclaredRepoMismatchError, declaredRepoDisagreement, protectedBranch, taskBranch, type WorkspaceConfig, withRememberedRepoCheck } from "../src/workspace.js";
import { awaitWindow, FakeGitHubClient } from "./fakes.js";
import {
  commitWork,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeLandingWorkspace,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  prepareAtPickup,
  restedInterviewRoom,
} from "./harness.js";
import {
  boardEvents,
  commitThroughTaskCheckout,
  completeThroughTaskCheckout,
  convergeOn,
  fetchHeldAtToken,
  finish,
  giveHeadRepo,
  landingWork,
  openBoard,
  promotionFailures,
  pushPrHead,
  type RegisteredReef,
  recordPrOpenedOutsideConvergence,
  registeredReef,
  reRegister,
} from "./landing-fixture.js";
import { setWorkspaceEntry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定1・3・5: task は pickup が宣言の repo に届いたときにその repo を記録し、根を運ぶ・PR を読む前に今の宣言と比べ、食い違えば
// その根だけを、記録と今の宣言を名指す PR 昇格失敗の question で止める(spec #3595 の振る舞い 1)。

/** 旧い repo で拾われ PR #1 を開いた done の根を残して、`reef` を削除の扉 → 登録の扉で別の repo の checkout に登録し直し、`repair` なら
 *  着地の最初の撮りより前に新しい checkout の根に修理を置く。`external` の根は削除の扉を止めない(ADR 0370 決定1)。 */
async function reRegisteredWithRepairedRoot({ repair = true } = {}) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const { workspace: moved } = await makeLandingWorkspace("reef-new");
  const reef = await registeredReef(old);
  const github = new FakeGitHubClient();

  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "external" } });

  await reRegister(db, reef, moved);
  if (repair) {
    const branch = taskBranch(done.id);
    git(moved.path, "fetch", "--quiet", old.path, branch);
    git(moved.path, "checkout", "--quiet", "-b", branch, "FETCH_HEAD");
    commitWork(moved.path, "repair.txt", "repair\n");
    git(moved.path, "checkout", "--quiet", protectedBranch(moved));
  }
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github });
  return { db, github, landing, old, moved, root: done };
}

/** 根だけが、記録の repo と今の宣言を名指す PR 昇格失敗の question で止まり、workspace の Quarantine は立たない(ADR 0399 決定5)。 */
const stoppedNamingBoth = (db: Db, root: Task, recorded: string, current: string) => {
  const [question, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(question!.purpose).toContain(`recorded repo ${recorded}`);
  expect(question!.purpose).toContain(`now declares ${current}`);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
};

it.each([
  ["merged", (github: FakeGitHubClient, repo: string) => github.scriptMergedOutside(1, repo)],
  ["closed", (github: FakeGitHubClient, repo: string) => github.scriptClosedOutside(1, repo)],
  ["open", (github: FakeGitHubClient, repo: string) => github.scriptPullRequestOnBranch("task/other", 1, undefined, undefined, repo)],
  ["absent", () => {}],
] as const)("別の repo で登録し直した名前の、PR を開いた根は、新しい repo の #1 が %s でも読まずに、記録と今の宣言を名指して止まる", async (_, script) => {
  const { db, github, landing, old, moved, root } = await reRegisteredWithRepairedRoot();
  script(github, moved.repo!);

  await landing.converge();

  expect([github.stateChecks, github.pushes, github.requests]).toEqual([[], [], []]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
  stoppedNamingBoth(db, root, old.repo!, `repo ${moved.repo}`);
});

// 運ぶ内容の無い根も、新しい repo の保護ブランチと比べて内容で終わらず、人間に知らせて止まる —— 根の最初の行き先の読みが比べる
it("別の repo で登録し直した名前の、PR を開いた根は、運ぶ修理が無くても記録と今の宣言を名指して止まる", async () => {
  const { db, github, landing, old, moved, root } = await reRegisteredWithRepairedRoot({ repair: false });

  await landing.converge();

  expect([github.stateChecks, github.pushes, github.requests]).toEqual([[], [], []]);
  stoppedNamingBoth(db, root, old.repo!, `repo ${moved.repo}`);
});

/** 旧い repo で拾われ PR #1 を開いた根に修理が載った盤面で、`hold` が止める await の間に `during` を撃つ。`hold` は収束に足す材料を返せる。
 *  既定の `during` は registry の `path:` を同じ repo の clone へ手で書き換え、古い checkout を消す —— 削除の扉は着地の執行中を拒むので
 *  (ADR 0421 決定4 追記)、await の間に宣言が変わる形は手編集だけである。`door` は `during` が投げたもの。 */
async function changedDuringAwait(
  hold: (github: FakeGitHubClient) => { entered: Promise<void>; open: () => void; deps?: Partial<LandingDeps> },
  during: (fixture: { db: Db; reef: RegisteredReef; old: WorkspaceConfig; landing: Landing }) => Promise<void> = movedToClone,
) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeLandingWorkspace("reef-old");
  const reef = await registeredReef(old);
  giveHeadRepo(db, reef, old.head_repo!);
  const github = new FakeGitHubClient();
  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  const head = pushPrHead(github, reef.resolve("reef"), done.id, 1);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "external" }, head, workspace: reef.resolve("reef") });
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), done, "repair.txt", "repair\n");
  const window = hold(github);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github, ...window.deps });

  const converging = landing.converge();
  await window.entered;
  const door = await during({ db, reef, old, landing }).then(() => undefined, (error: unknown) => error);
  window.open();
  await converging;
  return { db, github, reef, old, root: done, head, door };
}

async function movedToClone({ reef, old }: { reef: RegisteredReef; old: WorkspaceConfig }) {
  const clone = join(await tempDir("reef-clone-"), "reef");
  git(old.path, "clone", "--quiet", old.path, clone);
  git(clone, "remote", "set-url", "origin", old.repo!);
  git(clone, "remote", "add", HEAD_REPO_REMOTE, old.head_repo!);
  setWorkspaceEntry(reef.registryDir, "reef", "path", clone);
  rmSync(old.path, { recursive: true, force: true });
}

/** 根だけが path の変更の PR 昇格失敗の question で止まり、workspace の Quarantine は立たない(ADR 0399 決定3)。 */
const stoppedOnPathChange = (db: Db, root: Task) => {
  const [question, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(question!.purpose).toContain("the registered checkout path changed during the operation");
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
};

/** `method` の呼び出しを、本物の token の await に当たる所で1回止める。 */
function holdBefore<M extends "getPullRequestState" | "preparePush">(method: M) {
  return (github: FakeGitHubClient) => {
    const window = awaitWindow();
    const original = (github[method] as (input: never) => Promise<unknown>).bind(github);
    github[method] = (async (input: never) => {
      await window.hold();
      return original(input);
    }) as FakeGitHubClient[M];
    return window;
  };
}

/** push の前に PR の head を手元へ取る token の await(ADR 0242 決定1)。 */
const holdAtHeadFetch = (github: FakeGitHubClient) => {
  // 手元に無い head —— 収束は push の前に token を温めてそれを取りに行く
  github.scriptHead(1, "f".repeat(40));
  const { window, githubAuth } = fetchHeldAtToken();
  return { ...window, deps: { githubAuth } };
};

it("PR の状態を読む前の await(token の取得)の間に registry の path: を同じ repo の clone へ手で書き換えても、盤面は PR を読まず、根だけが path の変更で止まる", async () => {
  const { db, github, root } = await changedDuringAwait(holdBefore("getPullRequestState"));

  expect([github.stateChecks, github.pushes]).toEqual([[], []]);
  stoppedOnPathChange(db, root);
});

it("push の準備の await の間に registry の path: を同じ repo の clone へ手で書き換えても、盤面はその根を push せず、根だけが path の変更で止まる", async () => {
  const { db, github, old, root, head } = await changedDuringAwait(holdBefore("preparePush"));

  expect([github.pushes, github.requests]).toEqual([[], []]);
  expect(git(old.head_repo!, "rev-parse", `task/${root.id}`)).toBe(head);
  stoppedOnPathChange(db, root);
});

it("PR の head を取る token の await の間に registry の path: を同じ repo の clone へ手で書き換えても、盤面はその根を push せず、根だけが path の変更で止まる", async () => {
  const { db, github, old, root, head } = await changedDuringAwait(holdAtHeadFetch);

  expect([github.pushes, github.requests]).toEqual([[], []]);
  expect(git(old.head_repo!, "rev-parse", `task/${root.id}`)).toBe(head);
  stoppedOnPathChange(db, root);
});

// ADR 0421 決定4 追記: この await の間は収束がその名前の根を着地させている —— 扉は登録し直しを拒み、記録と今の宣言は食い違わない
it("PR の head を取る token の await の間の削除の扉は、push する内容と着地の執行中を名指して拒み、名前は元の repo の登録のまま残る", async () => {
  const { workspace: other } = await makeRemoteBackedWorkspace("reef-other");
  const { db, reef, old, root, door } = await changedDuringAwait(holdAtHeadFetch, ({ db, reef, old, landing }) =>
    reRegister(db, reef, { ...old, repo: other.repo }, () => git(old.path, "remote", "set-url", "origin", other.repo!), landing),
  );

  expect(door).toMatchObject({ name: "DeletionBlockedError", reasons: [{ code: "unpushed_pr_content", task_ids: [root.id] }, { code: "landing_in_progress", task_ids: [root.id] }] });
  expect(reef.resolve("reef").repo).toBe(old.repo);
  expect(promotionFailures(db, root.id).map(({ purpose }) => purpose).join("\n")).not.toContain("now declares");
});

// 釘(#3699): 保護ブランチの写しの読み直し(`refreshProtectedBranch`)の token の await。窓に入らなければ `changedDuringAwait` は進まない
it("merge 済みの根が保護ブランチの写しを読み直す token の await の間に registry の path: を同じ repo の clone へ手で書き換えると、根だけが path の変更で止まる", async () => {
  const { db, root } = await changedDuringAwait((github) => {
    github.scriptMergedOutside(1);
    const { window, githubAuth } = fetchHeldAtToken();
    return { ...window, deps: { githubAuth } };
  });

  stoppedOnPathChange(db, root);
});

/** 旧い repo で拾われ PR #1 を開いた done の根を残し、`reef` を扉で purely-local の checkout(`moved`)に登録し直した盤面。 */
async function reRegisteredPurelyLocal(moved: (old: WorkspaceConfig, root: Task) => Promise<{ workspace: WorkspaceConfig; between?: () => void }>) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const reef = await registeredReef(old);
  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  recordPrOpenedOutsideConvergence(db, done, 1, clock.now(), { authority: { merge: "external" } });
  const local = await moved(old, done);
  await reRegister(db, reef, local.workspace, local.between);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github: new FakeGitHubClient() });
  return { db, landing, old, root: done };
}

it("repo を記録した根の名前を、扉で根のブランチを持たない別の purely-local の checkout に登録し直すと、根は git を読まずに記録と今の宣言を名指して止まる", async () => {
  const { db, landing, old, root } = await reRegisteredPurelyLocal(async () => ({ workspace: await makeWorkspace("reef-local") }));

  await landing.converge();

  stoppedNamingBoth(db, root, old.repo!, "no repo (purely-local)");
});

it("repo を記録した根のブランチを同じ checkout で保護ブランチに merge し、origin を外して扉で purely-local に登録し直しても、根は内容で終わらずに記録と今の宣言を名指して止まる", async () => {
  const { db, landing, old, root } = await reRegisteredPurelyLocal(async (old, root) => ({
    workspace: { ...old, repo: undefined },
    between: () => {
      git(old.path, "merge", "--quiet", "--no-edit", `task/${root.id}`);
      git(old.path, "remote", "remove", "origin");
    },
  }));

  await landing.converge();

  expect(boardEvents(db, root.id, "landing_finished")).toEqual([]);
  stoppedNamingBoth(db, root, old.repo!, "no repo (purely-local)");
});

// ADR 0372 決定3: 子の pickup が祖先を固定するときも記録を書く —— 書かなければ、拾われたことのない祖先の根は着地で必ず止まる
it("子の pickup が固定した祖先の根は、自分で拾われていなくても、記録を持って PR を開く", async () => {
  const { workspace } = await makeLandingWorkspace("reef");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = landingWork(db, clock, workspace.name);
  const child = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, clock.now(), ...HUMAN_WEBUI);
  await completeThroughTaskCheckout(db, clock, workspace, child, "child.txt", "merged back\n");
  finish(db, clock, parent);

  await expect(convergeOn(landing, parent.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: 1 });
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${parent.id}`]);
});

// ADR 0399 決定3: 面接室の受験者は面接室にしか届かず着地しないので記録しない。着地しない受験者に外から見える違いは無いので、比較の述語で読む
it("面接室の受験者は、面接室で拾われても宣言の repo を記録しない", async () => {
  const { db, room, base, examinee } = await restedInterviewRoom("examinee-no-record", true);

  await prepareAtPickup(db, room, examinee!, { workspacesBaseDir: base });

  expect(declaredRepoDisagreement(db, examinee!.id, room)).toMatch(/no record/);
});

// ADR 0399 決定5・7: 基準の行の無い名前の最初の撮りの前の項が、登録し直しで根の比較に落ちたら、その名前の Quarantine でなく根の止まり。
// #3699 の後は catch の外の宛先の読み直しが同じ同期区間で先に投げるので、この test が固定するのは結果で、catch の素の投げ直しの行ではない
it("基準の行の無い名前の着地の前の比較で、覚えた repo の項が path の変化を見て根の比較に落ちると、DeclaredRepoMismatchError がそのまま出て workspace の Quarantine は立たない", async () => {
  const { db, clock } = await openBoard();
  const reef = await makeWorkspace("reef");
  const declared = new DeclaredRepoMismatchError("task/t-1 cannot be carried: the board recorded repo acme/old for it, but workspace reef now declares repo acme/new.");
  const workspace = withRememberedRepoCheck(db, { ...reef, checkDeclaredRepo: () => { throw declared; } }, () => clock.now(), () => ({ ...reef, path: `${reef.path}-moved` }));

  let thrown: unknown;
  try {
    assertLandingRefs(db, workspace, undefined, undefined, clock.now());
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBe(declared);
  expect(openQuarantineQuestion(db, "workspace", reef.name)).toBeUndefined();
});
