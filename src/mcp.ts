import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { GitHubClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import type { AuthorityProfile, RosterAgent } from "./registry.js";
import type { Slot } from "./slot.js";
import { createStatelessMcpRouter } from "./stateless-mcp.js";
import {
  assigneeNeedsApproval,
  BOARD_WORKER_ID,
  completeTask,
  contentSourceFor,
  countUnsettledAttachedChildren,
  DEFAULT_AUDITOR_NAME,
  DomainError,
  decomposeTask,
  escalateTask,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_ROSTER_AGENT,
  HUMAN_WORKER_ID,
  logDecision,
  recordLandingDeferred,
  recordPrOpened,
  registerLocalMergeQuestion,
  registerPrPromotionFailureQuestion,
  resolveTaskAgent,
  settlePrPromotionQuestionsAsObserved,
  type Task,
  taskHasLanded,
  taskHistory,
} from "./tasks.js";
import {
  buildWorkspaceResolver,
  catchUpTaskBranch,
  ensureWorkspaceToken,
  isRemoteBacked,
  protectedBranch,
  protectedBranchRef,
  rebaselineRef,
  releaseWorkspace,
  resolveOrQuarantine,
  resolveTaskBranchLineage,
  taskBranch,
  taskHasContentToLand,
  treeIsDirty,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "./workspace.js";

/** ADR 0015 (2026-08-21 addendum) / issue #415: the board-language rule lives
 *  on each board-write verb's own description, not in the worker's system
 *  prompt — a front-loaded instruction was losing to a task's own non-English
 *  payload by the time the worker reached these verbs. */
export const BOARD_WRITE_LANGUAGE_RULE =
  "Write in English even when the task's payload is in another language; " +
  "human-authored text you quote stays in its original language.";

export interface McpDeps {
  db: Db;
  slot: Slot;
  clock: Clock;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task releases against
   *  the board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** The GitHub-facing seam (issue #19): a work task's completion is promoted
   *  to a PR through here. Absent → no PR is ever opened (e.g. a workspaceless
   *  board). */
  github?: GitHubClient;
  /** The board's GitHub identity (ADR 0093) for completion-time workspace refresh. */
  githubAuth?: GitHubAuth;
  /** This board's one configured worker's authority profile (issue #11).
   *  Absent → assignable_to and allowed_workspaces are both unrestricted.
   *  Superseded by `resolveAuthority` below when both are given. */
  authority?: AuthorityProfile;
  /** Resolves the executing task's own agent's authority profile (ADR 0012 /
   *  issue #36), read fresh every call from the task's own `assignee` (null →
   *  the board's default agent) — the delegation-aware successor to the
   *  single fixed `authority` above, which every task shared regardless of
   *  who it was actually assigned to. Absent → falls back to `authority`. */
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
  /** The board's default agent name (ADR 0012 / issue #36): every MCP call is
   *  attributed to a real agent session (never human — that's the separate
   *  /answer route), so a task's unspecified (null) `assignee` resolves here,
   *  not to `HUMAN_WORKER_ID`. Absent → falls back to `HUMAN_WORKER_ID`, same
   *  as the pre-#36 shape for a board with no worker configured at all. */
  defaultAgentName?: string;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), same shape
   *  as `defaultAgentName` above — the fallback a `review` task's unset
   *  `assignee` attributes to instead (issue #42), never `defaultAgentName`.
   *  Absent → `DEFAULT_AUDITOR_NAME` (the pointer always resolves —
   *  CONTEXT.md's Auditor). */
  auditorName?: string;
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry — used to reject a decompose child's
   *  unknown assignee outright (the registering agent's own mistake, same
   *  treatment as an unknown child workspace). Absent → no registry
   *  configured, so any assignee name is accepted, same as the workspace
   *  check's fallback. */
  agentRegistered?: (name: string) => boolean;
  /** Whether an explicitly named workspace is protected (CONTEXT.md's
   *  protected workspace / ADR 0013), read fresh against the registry — a
   *  decompose child naming a protected workspace converts to an approval
   *  question unconditionally, regardless of the registering worker's
   *  authority profile (v1's only protected workspace is the registry
   *  itself). Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** The pull half of the roster (issue #43 / ADR 0014): every registry
   *  agent's name + description, read fresh against the registry every call
   *  (same pattern as `agentRegistered`) — `list_agents` marks each one
   *  direct/needs-approval against the caller's own `assignable_to` via the
   *  same `assigneeNeedsApproval` decompose enforces, plus a fixed `human`
   *  line (CONTEXT.md's Roster: human is delegable but carries no registry
   *  definition). Absent → no registry configured, so `list_agents` reports
   *  only the fixed `human` line. */
  listAgents?: () => RosterAgent[];
}

/** handoff doc は PR 昇格より前に worker が書き終えているので、着地状態(push /
 *  PR / merge)については構造的に古い(issue #303)。PR 本文にだけ盤面がこの
 *  定型行を足す — handoff 自体(DB・翻訳・WebUI 表示)は無改変。PR 番号は
 *  `createPullRequest` が返る前に本文を組み立てるため書けない。 */
const LANDING_NOTICE =
  "This PR was opened by the tidepool board after the task completed. The handoff doc " +
  "above was written by the worker before PR promotion, so it does not reflect landing " +
  "state (push / PR / merge).";

/** 完了の逆方向は GitHub ネイティブに委ねる(issue #49, ADR 0016) — issue-backed
 *  task の PR body に `Closes #N` を追記し、merge が issue を閉じる。PR を伴わない
 *  完了と cancel はこの経路自体を通らないので issue に触れない。 */
export function prBody(handoffDoc: string | null, githubIssueNumber: number | null): string {
  const doc = handoffDoc ?? "";
  const withNotice = doc ? `${doc}\n\n${LANDING_NOTICE}` : LANDING_NOTICE;
  if (githubIssueNumber == null) return withNotice;
  return `${withNotice}\n\nCloses #${githubIssueNumber}`;
}

/** Root work-task completion → landing (issue #19 / ADR 0053 / ADR 0073): by the time this
 *  runs, the tree rule has either stashed the work as a WIP commit on the task branch, or
 *  failed and quarantined the workspace (releaseWorkspace swallows that
 *  failure so the completion itself still stands) — in the latter case the
 *  task branch may carry none of the finished work, so no PR is attempted.
 *  A healthy completion with no commits to carry records nothing_to_land
 *  before the remote-PR / purely-local-question surfaces diverge.
 *  Never entrusted to the worker, never lets a PR failure touch the
 *  completion that already landed — a real creation failure becomes a
 *  Tidepool failure question, while pre-existing quarantine still skips PR
 *  promotion as it did before.
 *  Work returning to an ancestor task branch, question tasks, and review
 *  tasks open no PR.
 *  strict=true is submitAnswer's synchronous retry (issue #66): every
 *  precondition that the first attempt silently skips on becomes a thrown
 *  error the human sees. */
export async function handleRootWorkLanding(
  deps: McpDeps,
  task: Task,
  strict = true,
): Promise<void> {
  if (task.type !== "work") {
    if (strict) throw new Error("only work tasks can be promoted");
    return;
  }
  // resolved against the task's own execution workspace (issue #26 / ADR
  // 0009), never just the board's default, through the same fail-closed
  // seam every other async board-driven use of a task's workspace goes
  // through — an unresolvable name (registry drift) re-quarantines (a no-op
  // if the task's slot release already did moments earlier) and skips the PR
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!resolve) {
    if (strict) throw new Error("no workspace is configured for PR promotion");
    return;
  }
  const workspace = resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
  if (!workspace) {
    if (strict) throw new Error("workspace is unavailable for PR promotion");
    return;
  }
  const lineage = resolveTaskBranchLineage(deps.db, workspace, task);
  if (lineage.branch) {
    if (strict) throw new Error("task completion lands on an ancestor task branch, not a PR");
    return;
  }
  if (workspaceNeedsHuman(deps.db, workspace.name)) {
    if (strict) {
      throw new Error(`workspace "${workspace.name}" needs human attention before PR promotion`);
    }
    return;
  }
  const base = protectedBranchRef(workspace);
  if (!taskHasContentToLand(workspace, task.id)) {
    if (strict) throw new Error(`task branch has nothing to land on "${base}"`);
    // A previously opened PR whose branch is already present by content has
    // no new board observation to record. This is the review-settlement
    // re-fire after an out-of-band squash/rebase merge (ADR 0105 決定3).
    if (task.pr_number !== null) return;
    appendEvent(deps.db, {
      taskId: task.id,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "nothing_to_land", base },
      at: deps.clock.now(),
    });
    return;
  }
  // 着地の門(ADR 0092 決定1): 分解ツリー全体に未決着の付帯子が1つでもあれば、
  // 3面(purely-local の merge question / PR 昇格 / auto-merge キュー投入)のどれも
  // 走らせない。門が分岐の手前・`nothing_to_land` の後ろにあるので、差分ゼロの完了は
  // 付帯子に関係なく従来どおり即座に記録される(ADR 0073)。
  const unsettled = countUnsettledAttachedChildren(deps.db, task.id);
  if (unsettled > 0) {
    if (strict) {
      throw new Error(`review still running: ${unsettled} attached child task(s) unsettled`);
    }
    recordLandingDeferred(deps.db, task.id, unsettled, deps.clock.now());
    return;
  }
  if (!isRemoteBacked(workspace)) {
    if (strict) {
      throw new Error("purely-local work lands through a merge question, not PR promotion");
    }
    const purpose =
      attributedAuthority(deps, task)?.merge === "auto_if_ci_green"
        ? `Workspace "${workspace.name}" is purely-local, so CI cannot be observed and ` +
          `auto_if_ci_green cannot auto-merge "${task.title}". Land its task branch on the ` +
          `protected branch now?`
        : `Workspace "${workspace.name}" is purely-local and has no GitHub merge surface ` +
          `for "${task.title}". Land its task branch on the protected branch now?`;
    registerLocalMergeQuestion(deps.db, task, purpose, deps.clock.now());
    return;
  }
  if (!deps.github) {
    if (strict) throw new Error("GitHub is not configured for PR promotion");
    return;
  }
  if (lineage.outlivedForkSource && catchUpTaskBranch(workspace, task.id)) {
    rebaselineRef(deps.db, workspace, `refs/heads/${taskBranch(task.id)}`);
  }
  // ADR 0053: 既に PR を開いているタスクの着地は、PR を増やさず**その PR を更新
  // する** —— merge back された付帯子の修理を載せるのは、開いたままの PR に向けた
  // この1本の push である(issue #400)。再発火も strict retry も同じここを通る:
  // 分けて書くと retry が既に開いている PR へ2本目を撃つ。merge 済みの PR には
  // 押し直す先が無い(#504)。
  if (task.pr_number !== null) {
    if (await deps.github.isPullRequestMerged({ path: workspace.path, number: task.pr_number })) {
      if (strict) throw new Error(`PR #${task.pr_number} is already merged`);
      throw new Error(
        `PR #${task.pr_number} is already merged, but merge-backed repair work on ` +
          `${taskBranch(task.id)} still has content to land`,
      );
    }
    await deps.github.pushBranch({ path: workspace.path, branch: taskBranch(task.id) });
    // ADR 0064 決定4: 昇格と同じく `refs/remotes/origin/task/<id>` を1本動かす —— ただし
    // 撮り直すのは push が**成功した後**だけ。失敗後に撮ると、その窓で偽造された ref を
    // 基準へ迎え入れる(昇格側の `finally` は push 済みの後の `gh pr create` 失敗を守る型で、
    // ここでは push そのものが落ちうる)
    rebaselineRef(deps.db, workspace, `refs/remotes/origin/${taskBranch(task.id)}`);
    return;
  }
  // an issue-backed task's stored title is only the "#N" placeholder
  // (rowToTask) — the PR title is another of ADR 0016's real use-moments,
  // so it resolves the live issue instead when there is one.
  const { title } = await contentSourceFor(task, deps.github, () => workspace.path).expand();
  let pr: Awaited<ReturnType<typeof deps.github.createPullRequest>>;
  try {
    pr = await deps.github.createPullRequest({
      path: workspace.path,
      branch: taskBranch(task.id),
      base: protectedBranch(workspace),
      title,
      body: prBody(task.handoff_doc, task.github_issue_number),
    });
  } finally {
    // ADR 0064 決定4: 昇格は `refs/remotes/origin/task/<id>` を1本動かす。`gh pr create`
    // が落ちても push は先に済んでいるので、失敗経路でも撃たなければ次の解放が
    // 盤面自身の push を違反として読む
    rebaselineRef(deps.db, workspace, `refs/remotes/origin/${taskBranch(task.id)}`);
  }
  recordPrOpened(
    deps.db,
    task,
    pr.number,
    attributedWorkerId(deps, task),
    deps.clock.now(),
    attributedAuthority(deps, task),
    deps.isProtectedWorkspace?.(workspace.name),
    "worker",
  );
}

async function openHandoffPr(deps: McpDeps, task: Task): Promise<void> {
  if (task.type !== "work") return;
  const landedBefore = taskHasLanded(deps.db, task.id);
  try {
    await handleRootWorkLanding(deps, task, false);
  } catch (err) {
    // 撮った時に偽で今は真 = この呼び出しが飛んでいる最中に別経路(strict retry)が
    // 着地を成立させた。着地済みのタスクに PR 昇格失敗 question を立てるのは人間に
    // 無効な意思決定を見せること(issue #412 / ADR 0079 決定3)。撮った時から真だった
    // 開いている PR への push 失敗(issue #400)は従来どおり登録する。
    if (!landedBefore && taskHasLanded(deps.db, task.id)) return;
    registerPrPromotionFailureQuestion(
      deps.db,
      task,
      err instanceof Error ? err.message : String(err),
      deps.clock.now(),
    );
    return;
  }
  // 着地が成立したかは「throw しなかったこと」では測れない —— 非 strict の
  // `handleRootWorkLanding` は workspace 不在・needs-human・門の不成立で黙って
  // return する。痕跡を読み直してから、開いたままの PR 昇格失敗 question を引退
  // させる(issue #406)。共有の `handleRootWorkLanding` 側に置かないのは、strict
  // retry 経路では同じ question がまだ回答処理の途中にいるため。
  if (taskHasLanded(deps.db, task.id)) {
    settlePrPromotionQuestionsAsObserved(deps.db, task.id, deps.clock.now());
  }
}

/** 付帯子が決着した瞬間に、その祖先の着地を撃ち直す(ADR 0092 決定3)。走査は新設
 *  せず、決着を起こす経路(worker の complete、人間面の complete / cancel / abandon)が
 *  そのまま発火点になる。着地の根は系譜で決まり木の頂点とは限らない(着地済みの根の
 *  下で切られた修理は自分が根になる — ADR 0053)ので、完了済みの work 祖先すべてに
 *  撃つ: 根でない祖先は `handleRootWorkLanding` が系譜で飛ばし、着地済みの祖先は
 *  `taskHasLanded` が飛ばす —— ただし PR を開いたままの祖先だけは通し、開いている PR を
 *  push で更新させる(issue #400)。門はその中で読み直されるので、待っている間に新しい付帯子が
 *  付いていればもう一度待つ。 */
export async function relandRootAncestor(deps: McpDeps, settled: Task): Promise<void> {
  for (
    let ancestor = settled.parent_id ? getTask(deps.db, settled.parent_id) : undefined;
    ancestor;
    ancestor = ancestor.parent_id ? getTask(deps.db, ancestor.parent_id) : undefined
  ) {
    if (ancestor.type !== "work" || ancestor.status !== "done") continue;
    // 着地済みでも、開いたままの PR を持つ祖先だけは撃ち直す —— merge back された
    // 修理をその PR に載せるため(ADR 0053 / issue #400)。他の着地面(着地対象なし /
    // purely-local の着地 question)は痕跡どおり二度と起こさない。
    if (taskHasLanded(deps.db, ancestor.id) && ancestor.pr_number === null) continue;
    await openHandoffPr(deps, ancestor);
  }
}

/** Every MCP call is attributed to a real agent session (never human — that's
 *  the separate /answer route), so an unspecified (null) assignee resolves to
 *  the board's default agent, not `HUMAN_WORKER_ID` (ADR 0012 / issue #36) —
 *  made type-aware for `review` tasks (issue #42 / CONTEXT.md's Auditor): a
 *  review task's unset assignee attributes to the Auditor pointer instead,
 *  which — unlike `defaultAgentName` — always resolves to a value. */
function attributedWorkerId(deps: McpDeps, task: Task): string {
  return resolveTaskAgent(
    task,
    deps.defaultAgentName ?? HUMAN_WORKER_ID,
    deps.auditorName ?? DEFAULT_AUDITOR_NAME,
  );
}

/** The reviewer profile (ADR 0013 / issue #15 layer 2): read-only is a
 *  property of the `review` task type, not of whoever executes it, so this
 *  code constant overrides whatever authority profile the executing agent
 *  would otherwise carry — the one place in the authority model where task
 *  type overrides profile. A code constant, not a registry entry, so the
 *  enforcement floor itself sits outside what Condensation's registry-edit
 *  loop could ever propose a diff against. `allowed_workspaces: []` blocks
 *  every explicit workspace target; `assignable_to: []` blocks every
 *  explicit assignee except the one structural exception decomposeTask
 *  carves out for a review's own repair children (the reviewed task's own
 *  assignee — ADR 0013). The same "task type overrides profile" line reaches
 *  both spawn layers: ADR 0056's system-prompt assembly imports this exact
 *  profile for `## Authority`, while the CLI harness's `reviewToolDenials`
 *  (claude-worker.ts) reads `task.type` directly because the deny needs to
 *  exist before spawn resolves an authority profile — same task-type-not-agent
 *  principle, adapter-side enforcement primitive (ADR 0005). */
export const REVIEWER_AUTHORITY_PROFILE: AuthorityProfile = {
  name: "reviewer",
  guidance:
    "You are reviewing read-only. Never fix directly — findings become repair tasks.\n" +
    "Assign a repair to the worker in your roster: they executed the task you are reviewing.",
  assignable_to: [],
  allowed_workspaces: [],
};

/** The authority governing this task: a `review` task always runs under the
 *  fixed reviewer profile above (ADR 0013), regardless of who it's assigned
 *  to. Otherwise `resolveAuthority` read fresh against the task's own
 *  `assignee` when configured (ADR 0012 / issue #36), else the board's single
 *  fixed `authority` (pre-#36 shape, and still today's shape for a board with
 *  no registry-backed resolver at all). */
function attributedAuthority(deps: McpDeps, task: Task): AuthorityProfile | undefined {
  if (task.type === "review") return REVIEWER_AUTHORITY_PROFILE;
  return deps.resolveAuthority?.(task.assignee) ?? deps.authority;
}

export function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Resolve the caller's ?task= attribution against the slot; every agent-facing
 *  verb goes through this (also rejects stray calls from stale killed processes). */
function resolveAttributedTask(
  deps: McpDeps,
  attributedTaskId: string | null,
): { task: Task } | { error: string } {
  if (attributedTaskId === null || attributedTaskId !== deps.slot.currentTaskId) {
    return { error: "call is not attributed to the current slot task" };
  }
  const task = getTask(deps.db, attributedTaskId);
  if (!task) return { error: "current task not found" };
  return { task };
}

/** The shape every agent verb shares: resolve attribution, run the domain
 *  verb, hand DomainError back as a tool error rather than a protocol one. */
async function runVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task) => unknown,
) {
  const resolved = resolveAttributedTask(deps, attributedTaskId);
  if ("error" in resolved) return toolError(resolved.error);
  try {
    return toolResult(await verb(resolved.task));
  } catch (err) {
    if (err instanceof DomainError) return toolError(err.message);
    throw err;
  }
}

/** タスク自身の実行 workspace(issue #26 / ADR 0009 —— 盤面の既定ではない)。解決できない
 *  名前は `resolveOrQuarantine` が quarantine する**副作用を持つ**ので、1つの verb 呼び出しで
 *  2度撃たない(2度目は同じ観測を cause として重ねて記録するだけである)。 */
function resolveTaskWorkspace(deps: McpDeps, task: Task): WorkspaceConfig | undefined {
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!resolve) return undefined;
  return resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
}

/** 完了の門(ADR 0084 決定1・2 / issue #240)。ここに立つのは `completeTask` を人間経路
 *  (/api・管理MCP)と共有しているからで、拒否は handoff invariant と同じ domain error
 *  —— セッション・slot・ツリーのどれも動かず、worker はコミットして呼び直せる。 */
function assertWorkTreeCommitted(deps: McpDeps, task: Task, workspace: WorkspaceConfig): void {
  if (task.type !== "work" || workspaceNeedsHuman(deps.db, workspace.name)) return;
  if (!treeIsDirty(workspace)) return;
  throw new DomainError(
    "the task workspace has uncommitted changes — commit them on the task branch first, " +
      "with a message whose body says what changed and why in a few lines, readable from " +
      "the git history alone, then call complete_task again",
  );
}

/** Verbs that end the slot session (complete, decompose, escalate): run the
 *  domain verb attributed to the slot worker, then free the slot. Work
 *  completion opts into lineage merge-back; every other release only stashes
 *  WIP. A domain error keeps the slot — the session continues.
 *
 *  `gate` は verb の**前**に走る(ADR 0084 の完了の門)。門を持つ verb だけが workspace を
 *  前倒しで解決するのは、解決自体が quarantine の副作用を持つため —— 前へ出すと、domain
 *  error で終わった escalate / decompose にまでその副作用が及ぶ。 */
function runReleasingVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task, workerId: string, now: Date) => unknown,
  mergeBack = false,
  gate?: (task: Task, workspace: WorkspaceConfig) => void,
) {
  return runVerb(deps, attributedTaskId, async (task) => {
    let workspace = gate ? resolveTaskWorkspace(deps, task) : undefined;
    if (gate && workspace) gate(task, workspace);
    const result = verb(task, attributedWorkerId(deps, task), deps.clock.now());
    // the tree rule runs between the domain verb and the release: a domain
    // error above keeps the session (and its tree) alive, but once the verb
    // lands the WIP is stashed before anything else can enter the workspace.
    // A tree-rule failure falls back to quarantine — the verb already
    // landed, so the release stands, and needs-human halts further pickups.
    if (!gate) workspace = resolveTaskWorkspace(deps, task);
    if (workspace) {
      const merge = mergeBack && task.type === "work";
      // ADR 0093: merge-back は帰り先を決めるために fetch する。その token の
      // 取得だけがネットワークなので、同期の `releaseWorkspace` の手前で撃つ。
      // 失敗は投げずに持ち越す: ここで投げると verb は既に着地しているのに tree rule
      // も slot の解放も走らない。`releaseWorkspace` が fetch 失敗と同じ位置で投げる。
      let tokenFailure: unknown;
      if (merge) {
        try {
          await ensureWorkspaceToken(workspace, deps.githubAuth);
        } catch (err) {
          tokenFailure = err ?? new Error("GitHub token acquisition failed");
        }
      }
      releaseWorkspace(deps.db, workspace, task, deps.clock.now(), merge, deps.githubAuth, tokenFailure);
    }
    deps.slot.release();
    return result;
  });
}

/** A task's own briefing (issue #49, ADR 0016): the "spawn" moment content is
 *  live-resolved for — an issue-backed task's stored title/purpose/
 *  completion_criteria are only the "#N" placeholder (rowToTask), so
 *  contentSourceFor resolves the real thing here. The workspace thunk stays
 *  lazy: an ordinary task's briefing must not trigger workspace resolution
 *  (resolveOrQuarantine can quarantine a name as a side effect). An issue
 *  that dies *after* the scheduler's pickup gate passed (closed/deleted
 *  mid-slot) makes expand() reject and surfaces as a plain tool error — the
 *  worker can escalate itself, and the watchdog is the backstop; the
 *  retry/abandon failure question belongs to the pickup gate alone. */
async function taskContext(deps: McpDeps, task: Task) {
  const content = await contentSourceFor(task, deps.github, () => {
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    const workspace =
      resolve && resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
    return workspace ? workspace.path : undefined;
  }).expand();
  return { id: task.id, ...content };
}

/** Domain verbs only, no generic CRUD (ADR 0002). Attribution comes from the
 *  spawn-time ?task= URL param and must match the current slot task. */
function buildMcpServer(deps: McpDeps, attributedTaskId: string | null): McpServer {
  const server = new McpServer({ name: "tidepool", version: "0.0.0" });

  server.registerTool(
    "get_current_task",
    {
      description:
        "Fetch the context of the task occupying the slot, reading history from top to bottom " +
        "in chronological order. A decision's children are the tasks registered based on that " +
        "decision. A child_outside_the_decomposition is based on no decomposition decision, " +
        "such as a repair task from a human objection, this task's own escalation, or a " +
        "watchdog failure question.",
    },
    async () =>
      runVerb(deps, attributedTaskId, async (task) => {
        const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
        const parentContext = parent && {
          ...(await taskContext(deps, parent)),
          handoff_doc: parent.handoff_doc,
          history: taskHistory(deps.db, parent.id, task.id),
        };
        return {
          ...(await taskContext(deps, task)),
          type: task.type,
          parent: parentContext,
          history: taskHistory(deps.db, task.id),
        };
      }),
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "List every agent in the registry, plus human — the pull half of the roster. " +
        "Your system prompt's own Roster section already lists who you can delegate to " +
        "directly; call this only to see the full board, with each entry marked " +
        '"direct" or "needs_approval" (converts to a human approval question).',
    },
    async () =>
      runVerb(deps, attributedTaskId, (task) => {
        const authority = attributedAuthority(deps, task);
        const entries: RosterAgent[] = [...(deps.listAgents?.() ?? []), HUMAN_ROSTER_AGENT];
        return {
          agents: entries.map((entry) => ({
            ...entry,
            status: assigneeNeedsApproval(deps.db, task, entry.name, authority)
              ? "needs_approval"
              : "direct",
          })),
        };
      }),
  );

  server.registerTool(
    "complete_task",
    {
      description:
        "Complete the current task. Work tasks require the full 6-field handoff doc " +
        "and a committed work tree — commit your changes before calling this. " +
        "resume_context is what the next session needs to pick the work back up — " +
        "do not describe landing state (push / PR / merge): the board lands the " +
        "branch after you complete, and you cannot observe that. " +
        BOARD_WRITE_LANGUAGE_RULE,
      // the schema stays permissive: the handoff invariant is enforced inside
      // the verb so callers get a domain error, not a protocol error
      inputSchema: {
        handoff: z
          .partialRecord(z.enum(HANDOFF_FIELDS), z.string())
          .optional(),
      },
    },
    async ({ handoff }) => {
      let completed: Task | undefined;
      // await が要る: `runReleasingVerb` は release の中で仲介への往復を挟みうる
      // ので、待たずに PR を開くと tree rule / merge-back より先に昇格が走る。
      const result = await runReleasingVerb(
        deps,
        attributedTaskId,
        (task, workerId, now) => {
          const done = completeTask(deps.db, task, handoff, workerId, now, "worker");
          completed = done;
          return { id: done.id, status: done.status };
        },
        true,
        (task, workspace) => assertWorkTreeCommitted(deps, task, workspace),
      );
      if (completed) {
        await openHandoffPr(deps, completed);
        // 完了したのが付帯子なら、待っていた祖先の着地がここで起きる(ADR 0092 決定3)
        await relandRootAncestor(deps, completed);
      }
      return result;
    },
  );

  server.registerTool(
    "log_decision",
    {
      description:
        "Record an in-authority decision as one log line and keep working. " +
        "The line lands in the human-skimmed decision log. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { line: z.string().min(1) },
    },
    async ({ line }) =>
      runVerb(deps, attributedTaskId, (task) => {
        // so the worker's transcript carries this decision's board-issued key (ADR 0083)
        const eventId = logDecision(
          deps.db,
          task,
          line,
          attributedWorkerId(deps, task),
          deps.clock.now(),
          "worker",
        );
        return { logged: true, event_id: eventId };
      }),
  );

  server.registerTool(
    "decompose",
    {
      description:
        "Split the remaining work into child tasks in one decision: records the " +
        "reason in the decision log, queues the children at the tail, blocks the " +
        "current task until they all finish, and frees the slot. Once every child " +
        "settles, the task becomes pickable again in normal queue order to " +
        "integrate and complete for real. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        reason: z.string().min(1),
        children: z.array(
          z.object({
            title: z.string().min(1),
            purpose: z.string().min(1),
            completion_criteria: z.string().min(1),
            risk_flag: z.boolean().optional(),
            assignee: z
              .string()
              .optional()
              .describe(
                "Who to delegate to. Your own system prompt's Roster section lists who " +
                  "you can assign directly; call list_agents for the full board.",
              ),
            workspace: z.string().optional(),
            review_flag: z
              .boolean()
              .optional()
              .describe(
                "Opt this child into an independent review of its deliverable on completion. " +
                  "No authority check applies — declaring it is never out of scope.",
              ),
          }),
        ),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        // an explicitly named child workspace must exist in the registry
        // (issue #26) — this is the registering agent's own mistake, not an
        // authority question, so it's rejected outright before anything
        // registers rather than converted into an approval question (ADR
        // 0009). Absent a real registry, every name is accepted, same as
        // execution-time resolution's fallback.
        const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
        if (resolve) {
          for (const child of input.children) {
            if (child.workspace === undefined) continue;
            try {
              resolve(child.workspace);
            } catch (err) {
              if (!(err instanceof UnknownWorkspaceError)) throw err;
              throw new DomainError(`unknown workspace: ${child.workspace}`);
            }
          }
        }
        // the agent-name generalization of the check above (ADR 0012 / issue
        // #36): an explicitly named child assignee must exist in the
        // registry — the registering agent's own mistake, not an authority
        // question, so it's rejected outright before the assignable_to check
        // even runs. `human` is exempt (never a registry agent).
        if (deps.agentRegistered) {
          for (const child of input.children) {
            if (child.assignee === undefined || child.assignee === HUMAN_WORKER_ID) continue;
            if (!deps.agentRegistered(child.assignee)) {
              throw new DomainError(`unknown agent: ${child.assignee}`);
            }
          }
        }
        const children = decomposeTask(
          deps.db,
          task,
          input,
          workerId,
          now,
          attributedAuthority(deps, task),
          deps.isProtectedWorkspace,
          "worker",
        );
        return { child_ids: children.map((c) => c.id), parent_status: "blocked" };
      }),
  );

  server.registerTool(
    "escalate",
    {
      description:
        "Escalate a decision outside your authority (or an execution dead end): " +
        "registers a question task carrying 1-4 question items (each 2-4 options plus " +
        "a recommendation) sharing one context, blocks the current task on it, and " +
        "frees the slot. A human answers every item in one atomic submission. " +
        BOARD_WRITE_LANGUAGE_RULE,
      // the schema stays permissive: item-count, option-count, and
      // recommendation invariants are enforced inside the verb so callers get
      // a domain error
      inputSchema: {
        context: z.string().min(1),
        questions: z.array(
          z.object({
            title: z.string().min(1),
            detail: z.string().min(1).optional(),
            options: z.array(z.string()),
            recommendation: z.string(),
          }),
        ),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        const question = escalateTask(deps.db, task, input, workerId, now, "worker");
        return { question_id: question.id, parent_status: "blocked" };
      }),
  );

  return server;
}

export function createMcpRouter(deps: McpDeps): Router {
  return createStatelessMcpRouter((req) => {
    const taskParam = typeof req.query.task === "string" ? req.query.task : null;
    return buildMcpServer(deps, taskParam);
  });
}
