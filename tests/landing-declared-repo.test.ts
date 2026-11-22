import { expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { createLanding, type LandingDeps, rootPrOutcome } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { registerTask, type Task } from "../src/tasks.js";
import { declaredRepoDisagreement, type WorkspaceConfig } from "../src/workspace.js";
import { awaitWindow, FakeGitHubClient } from "./fakes.js";
import {
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
  recordPrOpenedOutsideConvergence,
  registeredReef,
  reRegister,
} from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0399 決定1・3・5: task は pickup が宣言の repo に届いたときにその repo を記録し、根を運ぶ・PR を読む前に今の宣言と比べ、食い違えば
// その根だけを、記録と今の宣言を名指す PR 昇格失敗の question で止める(spec #3595 の振る舞い 1)。

/** 旧い repo で拾われ PR #1 を開いた done の根を残して、`reef` を削除の扉 → 登録の扉で別の repo の checkout に登録し直し、`repair` なら
 *  盤面の経路で根に修理を載せた盤面 —— 根は運ぶ内容を持ち、PR を読みに行く所まで進む。`external` の根は削除の扉を止めない(ADR 0370 決定1)。 */
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
  if (repair) await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), done, "repair.txt", "repair\n");
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

/** 旧い repo で拾われ PR #1 を開いた根に修理が載った盤面で、`hold` が止める await の間に、同じ checkout の origin を別の repo へ向けて
 *  扉で登録し直す(扉は origin から `repo:` を書く —— #3500 の実測の形)。`hold` は収束に足す材料を返せる。 */
async function reRegisteredDuringAwait(hold: (github: FakeGitHubClient) => { entered: Promise<void>; open: () => void; deps?: Partial<LandingDeps> }) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeLandingWorkspace("reef-old");
  const { workspace: other } = await makeRemoteBackedWorkspace("reef-other");
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
  await reRegister(db, reef, { ...old, repo: other.repo }, () => git(old.path, "remote", "set-url", "origin", other.repo!));
  window.open();
  await converging;
  return { db, github, old, other, root: done, head };
}

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

it("PR の状態を読む前の await(token の取得)の間に扉で別の repo へ登録し直しても、盤面は新しい repo の PR を読まず、記録と今の宣言を名指して止まる", async () => {
  const { db, github, old, other, root } = await reRegisteredDuringAwait(holdBefore("getPullRequestState"));

  expect([github.stateChecks, github.pushes]).toEqual([[], []]);
  stoppedNamingBoth(db, root, old.repo!, `repo ${other.repo}`);
});

it("push の準備の await の間に扉で別の repo へ登録し直しても、盤面はその根を push せず、workspace の Quarantine でなく記録と今の宣言を名指して止まる", async () => {
  const { db, github, old, other, root, head } = await reRegisteredDuringAwait(holdBefore("preparePush"));

  expect([github.pushes, github.requests]).toEqual([[], []]);
  expect(git(old.head_repo!, "rev-parse", `task/${root.id}`)).toBe(head);
  stoppedNamingBoth(db, root, old.repo!, `repo ${other.repo}`);
});

// push の前に PR の head を手元へ取る token の await(ADR 0242 決定1)の後も、古い宣言で名前の場所を比べる前に根の記録を比べる
it("PR の head を取る token の await の間に扉で別の repo へ登録し直しても、盤面はその根を push せず、workspace の Quarantine でなく記録と今の宣言を名指して止まる", async () => {
  const { db, github, old, other, root, head } = await reRegisteredDuringAwait((github) => {
    // 手元に無い head —— 収束は push の前に token を温めてそれを取りに行く
    github.scriptHead(1, "f".repeat(40));
    const { window, githubAuth } = fetchHeldAtToken();
    return { ...window, deps: { githubAuth } };
  });

  expect([github.pushes, github.requests]).toEqual([[], []]);
  expect(git(old.head_repo!, "rev-parse", `task/${root.id}`)).toBe(head);
  stoppedNamingBoth(db, root, old.repo!, `repo ${other.repo}`);
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
