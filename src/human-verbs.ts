import { verifyAgentRepaired } from "./agent.js";
import { type AgentAdmin, AgentTierMismatchError } from "./agent-create.js";
import { type AttributionClient, attributeAfterRca, type BehaviorDraftClient } from "./attribution.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { type CliAuthCheck, quarantineCliAuthFailure } from "./cli-auth.js";
import type { ContainmentCheck } from "./containment.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { appendEvent, type EventOrigin } from "./events.js";
import {
  applyExecutionSettingsChange,
  composeRoutingRow,
  type ExecutionSettingsChange,
  parseAgentTierAmendment,
  parseRoutingRowChange,
  type RoutingRowChange,
  readExecutionSettings,
  registryPinChanges,
  routingPinChanges,
  type Tier,
  tierHasRowFor,
} from "./execution-setting.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import type { HarnessContainmentCheck } from "./harness-containment.js";
import { type Landing, type LandingVerdict, landingBlock } from "./landing.js";
import { approveMemoryProposal, rejectMemoryProposal } from "./memory.js";
import { type QuarantineChecks, type QuarantineKind, type QuarantineResolvers, quarantineStops } from "./quarantine.js";
import type { Harness, Provider, RegistryReachabilityCheck } from "./registry.js";
import { RegistryFetchFailedError, RegistryPushFailedError } from "./registry-write.js";
import { parseGitHubRepo, repairRepoAccess } from "./repo-access.js";
import {
  answerQuestion,
  assertAnswerable,
  assertNoUnsettledIssueRef,
  type CancelDefaults,
  type ChildSpec,
  cancelTaskDirectly,
  completeTask,
  DomainError,
  type EditTaskInput,
  editTask,
  getTask,
  type HandoffDoc,
  HUMAN_WORKER_ID,
  hasUnfinishedChildren,
  humanDecomposeTask,
  latestChild,
  logDecision,
  MERGE_QUESTION_OPTIONS,
  PR_PROMOTION_FAILURE_OPTIONS,
  type ProposalAmendment,
  type RegisterTaskInput,
  type RegistryProposal,
  registerTask,
  settleQuestionAsObserved,
  type Task,
  taskIdForPr,
} from "./tasks.js";
import type { FailedTeardownCheck } from "./teardown.js";
import { stageFrontInsert, triageActivity } from "./triage.js";
import type { PendingReclaim } from "./watchdog.js";
import {
  buildWorkspaceResolver,
  mergeTaskToProtected,
  OutOfBandProtectedBranchError,
  protectedBranch,
  quarantineWorkspace,
  rebaselineRef,
  UnknownWorkspaceError,
  verifyWorkspaceClean,
  type WorkspaceConfig,
} from "./workspace.js";

export interface RegisterThroughHumanDoorDeps {
  db: Db;
  agentRegistered?: (name: string) => boolean;
  draftClient?: DraftClient;
  github?: GitHubClient;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  isProtectedWorkspace?: (name: string) => boolean;
  /** 登録の成功は pickup の契機である(ADR 0119 決定2)。門で弾かれた登録は撃たない。 */
  pollNow: () => void;
}

export interface HumanRegisterInput extends RegisterTaskInput {
  decompose_reason?: string;
}

export type GateFailure =
  | { kind: "invalid"; error: string }
  | { kind: "not_found"; error: string }
  | { kind: "issue_unavailable"; error: string }
  | { kind: "inspection_unavailable"; error: string }
  | {
      kind: "issue_rejected";
      error: string;
      missing: string;
      suggested_comment: string;
    };

export type RegisterThroughHumanDoorResult =
  | { ok: true; task: Task }
  | { ok: false; failure: GateFailure };

export type HumanVerbResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      failure:
        | { kind: "not_found"; error: string }
        | { kind: "domain_error"; error: string };
    };

export interface DecomposeThroughHumanDoorDeps {
  db: Db;
  agentRegistered?: (name: string) => boolean;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  isProtectedWorkspace?: (name: string) => boolean;
  /** 子の登録は pickup の契機である(ADR 0119 決定2)。拒否された分解は撃たない。 */
  pollNow: () => void;
}

/** Shared human-surface decomposition. */
export function decomposeThroughHumanDoor(
  deps: DecomposeThroughHumanDoorDeps,
  taskId: string,
  input: { reason: string; children: ChildSpec[] },
  now: () => Date,
  origin: EventOrigin,
): HumanVerbResult<Task[]> {
  try {
    for (const child of input.children) {
      if (child.workspace !== undefined) {
        assertWorkspaceKnown(child.workspace, deps.resolveWorkspace, deps.workspace);
      }
      assertAssigneeKnown(deps.agentRegistered, child.assignee);
      for (const reviewer of child.review_by ?? []) assertReviewerKnown(deps.agentRegistered, reviewer);
    }
    if (input.reason.length === 0) throw new DomainError("a decomposition requires a reason");
    const task = getTask(deps.db, taskId);
    if (!task) return { ok: false, failure: { kind: "not_found", error: "parent task not found" } };
    const children = humanDecomposeTask(deps.db, task, input, now(), deps.isProtectedWorkspace, origin);
    deps.pollNow();
    return { ok: true, value: children };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, failure: { kind: "domain_error", error: err.message } };
    }
    throw err;
  }
}

export type IssueCommentFailure =
  | { kind: "invalid"; error: string }
  | { kind: "not_configured"; error: string }
  | { kind: "unknown_workspace"; error: string }
  | { kind: "github_failed"; error: string };

/** Shared human-surface GitHub issue-comment write. */
export async function addIssueCommentThroughHumanDoor(
  deps: Pick<RegisterThroughHumanDoorDeps, "github" | "workspace" | "resolveWorkspace">,
  input: { workspace: string; github_issue_number: number; body: string },
): Promise<{ ok: true } | { ok: false; failure: IssueCommentFailure }> {
  if (
    input.workspace.length === 0 ||
    !Number.isInteger(input.github_issue_number) ||
    input.github_issue_number <= 0 ||
    input.body.length === 0
  ) {
    return {
      ok: false,
      failure: { kind: "invalid", error: "an issue comment requires a workspace, positive issue number, and body" },
    };
  }
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!deps.github || !resolve) {
    return {
      ok: false,
      failure: { kind: "not_configured", error: "GitHub or workspace tracking not configured" },
    };
  }
  let path: string;
  try {
    path = resolve(input.workspace).path;
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    return {
      ok: false,
      failure: { kind: "unknown_workspace", error: `unknown workspace: ${input.workspace}` },
    };
  }
  try {
    await deps.github.addIssueComment(
      { path, number: input.github_issue_number },
      input.body,
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      failure: { kind: "github_failed", error: "could not post the comment to the issue" },
    };
  }
}

function assertAssigneeKnown(
  agentRegistered: ((name: string) => boolean) | undefined,
  assignee: string | undefined,
): void {
  if (
    assignee !== undefined &&
    assignee !== HUMAN_WORKER_ID &&
    agentRegistered &&
    !agentRegistered(assignee)
  ) {
    throw new DomainError(`unknown agent: ${assignee}`);
  }
}

/** A reviewer is always an agent (ADR 0111); unlike an assignee, `human` is
 * not a built-in escape from registry resolution. */
export function assertReviewerKnown(
  agentRegistered: ((name: string) => boolean) | undefined,
  reviewer: string,
): void {
  if (reviewer === HUMAN_WORKER_ID || (agentRegistered && !agentRegistered(reviewer))) {
    throw new DomainError(`unknown agent: ${reviewer}`);
  }
}

export function assertWorkspaceKnown(
  workspaceName: string,
  resolveWorkspace: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  workspace: WorkspaceConfig | undefined,
): void {
  const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
  if (!resolve) return;
  try {
    resolve(workspaceName);
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    throw new DomainError(`unknown workspace: ${workspaceName}`);
  }
}

/**
 * 人間名義の task 登録を実行する正準の application seam。
 * WebUI と管理 MCP は transport の違いだけを持ち、この門を共有する。
 */
export async function registerThroughHumanDoor(
  deps: RegisterThroughHumanDoorDeps,
  input: HumanRegisterInput,
  now: () => Date,
  origin: EventOrigin = "webui",
): Promise<RegisterThroughHumanDoorResult> {
  try {
    if (input.type !== "work" && input.type !== "review") {
      throw new DomainError("a human can register only work or review tasks");
    }
    const isHumanDecomposeChild = input.parent_id !== undefined && input.type === "work";
    if (isHumanDecomposeChild && input.github_issue_number !== undefined) {
      throw new DomainError("a child task cannot be issue-backed");
    }
    if (isHumanDecomposeChild) {
      const result = decomposeThroughHumanDoor(
        deps,
        input.parent_id!,
        {
          reason: input.decompose_reason ?? "",
          children: [
            {
              title: input.title ?? "",
              purpose: input.purpose ?? "",
              completion_criteria: input.completion_criteria ?? "",
              assignee: input.assignee,
              workspace: input.workspace,
              risk_flag: input.risk_flag,
              review_flag: input.review_flag,
              review_by: input.review_by,
              review_tier: input.review_tier,
              tier: input.tier,
              priority: input.priority,
            },
          ],
        },
        now,
        origin,
      );
      if (!result.ok) {
        return {
          ok: false,
          failure:
            result.failure.kind === "not_found"
              ? result.failure
              : { kind: "invalid", error: result.failure.error },
        };
      }
      const task = result.value[0] ?? latestChild(deps.db, input.parent_id!);
      if (!task) throw new Error("human decompose did not register a child or approval question");
      return { ok: true, task };
    }
    if (input.workspace !== undefined) {
      assertWorkspaceKnown(input.workspace, deps.resolveWorkspace, deps.workspace);
    }
    assertAssigneeKnown(deps.agentRegistered, input.assignee);
    for (const reviewer of input.review_by ?? []) assertReviewerKnown(deps.agentRegistered, reviewer);
    if (input.github_issue_number !== undefined && input.workspace) {
      assertNoUnsettledIssueRef(deps.db, input.workspace, input.github_issue_number);
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (deps.github && resolve) {
        let issue;
        try {
          issue = await deps.github.getIssue({
            path: resolve(input.workspace).path,
            number: input.github_issue_number,
          });
        } catch (err) {
          if (err instanceof IssueGoneError) throw new DomainError(err.message);
          return {
            ok: false,
            failure: {
              kind: "issue_unavailable",
              error: "could not fetch the referenced issue",
            },
          };
        }
        if (deps.draftClient) {
          let inspection;
          try {
            inspection = await deps.draftClient.inspectIssue(issue);
          } catch (err) {
            quarantineCliAuthFailure(deps.db, err, now());
            const fullError = err instanceof Error ? err.message : String(err);
            console.warn("[issue inspection] LLM inspection failed", fullError);
            const preview = fullError.slice(0, 200);
            return {
              ok: false,
              failure: {
                kind: "inspection_unavailable",
                error: `${preview}${fullError.length > preview.length ? "…" : ""} See server logs for full details.`,
              },
            };
          }
          if (!inspection.ok) {
            return {
              ok: false,
              failure: {
                kind: "issue_rejected",
                error: "the referenced issue fails the registration gate",
                missing: inspection.missing,
                suggested_comment: inspection.suggested_comment,
              },
            };
          }
        }
      }
    }
    const task = registerTask(deps.db, input, now(), HUMAN_WORKER_ID, origin);
    deps.pollNow();
    return { ok: true, task };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, failure: { kind: "invalid", error: err.message } };
    }
    throw err;
  }
}

export interface SubmitAnswerDeps {
  db: Db;
  pollNow: () => void;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github?: GitHubClient;
  landing: Landing;
  /** ADR 0115 決定2 / issue #575: abandon は失敗タスクの木を cancel する —— それが
   *  RCA 子なら帰責の第2回がここで走る。 */
  attributionClient?: AttributionClient;
  behaviorDraftClient?: BehaviorDraftClient;
  /** ADR 0099 決定3: 受理された Containment quarantine の確認回答が slot を解放する
   *  唯一の門。空の再観測は containment の検査の側にある。Absent → watchdog を
   *  持たない盤面(回収を待っている slot が存在しない)。 */
  reclaim?: Pick<PendingReclaim, "acceptReclaimed">;
  quarantineChecks?: QuarantineChecks;
  /** registry の agent 一覧と tier の書き込み(issue #920): tier の提案への approve が使う。Absent → registry の無い盤面。 */
  agentAdmin?: Partial<Pick<AgentAdmin, "list" | "changeTier">>;
}

/** 門の検査の材料。合成 root が一度だけ `quarantineChecks` に束ね、回答の口
 *  (WebUI・管理 MCP)へは map だけが渡る。 */
export interface QuarantineCheckDeps {
  db: Db;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github?: GitHubClient;
  boardState?: BoardStatePath[];
  /** Whether an agent name is currently registered — one half of the agent
   *  check; absent → only "no pending tasks remain" can clear it. */
  agentRegistered?: (name: string) => boolean;
  /** 封じ込め能力の合成後の検査(ADR 0033 / ADR 0036)。Absent → containment の
   *  検査が組めず、その確認への回答は拒まれる。 */
  containment?: ContainmentCheck;
  /** ADR 0099 決定3: 回収済み観測を待って止まっている容器の帳簿。 */
  reclaim?: Pick<PendingReclaim, "pendingReclaim">;
  registryReachability?: RegistryReachabilityCheck;
  /** ADR 0112 決定3: 後始末を**投げる版で**もう一度走らせる —— 検査が解放の門そのもの。 */
  teardownQuarantine?: FailedTeardownCheck;
  /** ADR 0097 決定2 / issue #446: provider ごとの probe。その provider の口が無ければ拒む。 */
  providerCliAuth?: Partial<Record<Provider, CliAuthCheck>>;
  /** ADR 0098: re-run the named Harness check before accepting repair. */
  harnessContainment?: HarnessContainmentCheck;
}

/** 解除の門の map(ADR 0137 決定5)。材料が無い種類は map に載らず、その確認への
 *  回答は拒まれる —— 検証できないまま受理する経路は無い。 */
export function quarantineChecks(deps: QuarantineCheckDeps): QuarantineChecks {
  const { containment, registryReachability, teardownQuarantine, providerCliAuth, harnessContainment } = deps;
  return {
    // resolve the named workspace fresh, then verify both its Git tree and its
    // separation from the board's own state
    workspace: async (value) => {
      const quarantineWorkspaceName = value!;
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      let target: WorkspaceConfig;
      try {
        if (!resolve) throw new UnknownWorkspaceError(quarantineWorkspaceName);
        target = resolve(quarantineWorkspaceName);
      } catch (err) {
        if (!(err instanceof UnknownWorkspaceError)) throw err;
        throw new DomainError(
          `no workspace configured for "${quarantineWorkspaceName}" — cannot verify repair`,
        );
      }
      try {
        verifyWorkspaceClean(target);
      } catch (err) {
        throw new DomainError(err instanceof Error ? err.message : String(err));
      }
      if (deps.boardState) {
        const overlap = boardStateOverlap(target.path, deps.boardState);
        if (overlap) throw new DomainError(overlap.reason);
      }
      // ADR 0067 決定2 の3つ目の扉。remote 正本を宣言した workspace だけが対象で、
      // 「盤面は確認を鵜呑みにせず検証してから受理する」に1条件足すだけである ——
      // 仲介が token を出せれば受理し、まだ出せなければ回答を拒んで question は開いた
      // ままになる(ADR 0093 決定8)。ローカルの検査を先に済ませてから撃つので、
      // purely-local な workspace では1つもネットワークに出ない。
      const ref = parseGitHubRepo(target.repo);
      if (deps.github && ref) {
        const { guidance } = await repairRepoAccess(deps.github, ref);
        if (guidance) throw new DomainError(guidance);
      }
    },
    agent: async (value) => {
      const quarantineAgentName = value!;
      try {
        verifyAgentRepaired(
          deps.db,
          quarantineAgentName,
          deps.agentRegistered?.(quarantineAgentName) ?? false,
        );
      } catch (err) {
        throw new DomainError(err instanceof Error ? err.message : String(err));
      }
    },
    ...(containment && {
      containment: async () => {
        const capability = await containment();
        if (!capability.available) {
          throw new DomainError(
            `worker containment is still not established: ${capability.reason}`,
          );
        }
        // ADR 0099 決定3: 回収失敗で立った Containment quarantine の解除は、容器の空を
        // **回答時にもう一度観測して**から受理する。一回限りの process scan は観測に
        // 数えないので、読むのは supervisor が持つ「空になった signal」の帳簿である。
        // 読むのは worker session の容器だけではない: Board call の容器も同じ門を
        // 通る(ADR 0136 決定6)ので、口が返すのは「どの容器か」を名乗る一句である。
        const pendingReclaim = deps.reclaim?.pendingReclaim();
        if (pendingReclaim !== undefined) {
          throw new DomainError(
            `${pendingReclaim} has still not been observed empty — processes from it may still be ` +
              "running against this host and its workspaces. Kill them by hand, then answer again",
          );
        }
      },
    }),
    // 検査そのものが後始末の再実行なので、投げれば question は開いたまま残り、人間は
    // 直してもう一度答えられる。
    ...(teardownQuarantine && { failedTeardown: (value) => teardownQuarantine(value!) }),
    ...(registryReachability && {
      registryReachability: async () => {
        const reachability = await registryReachability();
        if (!reachability.available) {
          throw new DomainError(
            `registry remote is still unreachable: ${reachability.reason ?? "refresh failed"}`,
          );
        }
      },
    }),
    // ADR 0097 決定2 / issue #446: 確認を鵜呑みにせず、その provider を喋る
    // 再検証を回答受理の直前に撃つ(CONTEXT.md「Quarantine」の検証つき解除)。
    ...(providerCliAuth && {
      providerAuth: async (value) => {
        const provider = value as Provider;
        const check = providerCliAuth[provider];
        if (!check) throw new DomainError(`${provider} authentication cannot be verified`);
        const result = await check();
        if (result.status !== "authenticated") {
          throw new DomainError(`${provider} authentication is still unavailable: ${result.reason}`);
        }
      },
    }),
    ...(harnessContainment && {
      harnessContainment: async (value) => {
        const harness = value as Harness;
        const capability = await harnessContainment(harness);
        if (!capability.available) {
          throw new DomainError(
            `${harness} Harness containment is still not established: ${capability.reason}`,
          );
        }
      },
    }),
  };
}

function resolveWorkspaceForAnswer(
  deps: Pick<SubmitAnswerDeps, "workspace" | "resolveWorkspace">,
  taskWorkspace: string | null,
  action: string,
  missingResource = "workspace",
): WorkspaceConfig {
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!resolve) throw new DomainError(`no ${missingResource} configured — ${action}`);
  try {
    return resolve(taskWorkspace);
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    throw new DomainError(`no workspace configured for "${err.workspaceName}" — ${action}`);
  }
}

/** Shared human-surface defaults for direct cancel's quarantine-question gate,
 *  computed here once so the WebUI and MCP cancel routes can't drift apart. */
function humanCancelDefaults(
  db: Db,
  workspace: WorkspaceConfig | undefined,
  defaultAgentName: string | undefined,
  auditorName: string | undefined,
  quarantineResolvers?: QuarantineResolvers,
): CancelDefaults {
  return {
    defaultWorkspaceName: workspace?.name,
    defaultAgentName,
    auditorName,
    quarantined: quarantineStops(db, quarantineResolvers),
  };
}

/** ADR 0092 決定5: 着地 question への `merge` 回答を受理する直前の検証。門(決定1)は
 *  question が立つ瞬間の盤面しか見ていないので、立った後に付いた付帯子や、この triage で
 *  出た未束ねの異議はここでしか捕まらない。異議は Commit で修理子へ束ねられ(ADR 0046)、
 *  以後は (a) 側で捕まるので、2つの検査は同じ待ちを別の時刻から見た姿である。
 *  `hold` は検証しない — 着地しない決定はいつでもできる。 */
function assertLandingAllowed(db: Db, landingTaskId: string): void {
  const block = landingBlock(db, landingTaskId);
  if (!block) return;
  throw new DomainError(
    block.kind === "attached_children"
      ? `cannot merge yet: ${block.count} attached child task(s) unsettled`
      : `cannot merge yet: ${block.count} objection(s) raised in this triage await commit`,
  );
}

/** A settled child can make its parent immediately pickable on either human surface. */
function pollIfParentUnblocked(db: Db, task: Task, pollNow: () => void): void {
  if (!task.parent_id) return;
  const parent = getTask(db, task.parent_id);
  if (parent && parent.status === "todo" && !hasUnfinishedChildren(db, parent.id)) {
    pollNow();
  }
}

function promotionRetryError(verdict: LandingVerdict): string | undefined {
  switch (verdict.kind) {
    case "landed":
      return undefined;
    case "failed":
      return verdict.error;
    case "deferred":
      return verdict.reason === "attached_children"
        ? `review still running: ${verdict.count} attached child task(s) unsettled`
        : `cannot land yet: ${verdict.count} objection(s) raised in this triage await commit`;
    case "nothing_to_land":
      return `task branch has nothing to land on "${verdict.base}"`;
    case "not_applicable":
      return verdict.reason === "not_work"
        ? "only work tasks can be promoted"
        : "task completion lands on an ancestor task branch, not a PR";
  }
}

export interface CancelThroughHumanDoorDeps {
  db: Db;
  pollNow: () => void;
  landing: Landing;
  /** ADR 0115 決定2 / issue #575: cancel された RCA 子が最後の決着になりうるので、
   *  cancel の扉も帰責の第2回を撃つ。 */
  attributionClient?: AttributionClient;
  behaviorDraftClient?: BehaviorDraftClient;
  workspace?: WorkspaceConfig;
  defaultAgentName?: string;
  auditorName?: string;
  quarantineResolvers?: QuarantineResolvers;
}

export interface EditThroughHumanDoorDeps {
  db: Db;
  agentRegistered?: (name: string) => boolean;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
}

export interface CompleteThroughHumanDoorDeps {
  db: Db;
  pollNow: () => void;
  landing: Landing;
  /** ADR 0115 決定2 / issue #575: 最後に決着した RCA 子が人間の完了でも第2回が走る。 */
  attributionClient?: AttributionClient;
  behaviorDraftClient?: BehaviorDraftClient;
  /** 起草の scope が null の workspace で継ぐ盤面の既定(issue #617)。 */
  workspace?: WorkspaceConfig;
}

/** Shared human-surface completion for human-assignee tasks. */
export async function completeThroughHumanDoor(
  deps: CompleteThroughHumanDoorDeps,
  taskId: string,
  handoff: Partial<HandoffDoc> | undefined,
  now: () => Date,
  origin: EventOrigin,
): Promise<HumanVerbResult<Task>> {
  const task = getTask(deps.db, taskId);
  if (!task) return { ok: false, failure: { kind: "not_found", error: "task not found" } };
  try {
    if (task.assignee !== HUMAN_WORKER_ID) {
      throw new DomainError(
        "only a human-assignee task can be completed here — agents complete via MCP's complete_task",
      );
    }
    const done = completeTask(deps.db, task, handoff, HUMAN_WORKER_ID, now(), origin);
    // 帰責の第2回(ADR 0115 決定2): RCA 子は人間登録なので human に振り直して ここで完了できる
    void attributeAfterRca(deps.db, deps, done, now()).catch((err) =>
      console.error(`[attribution] ${done.id}: ${String(err)}`),
    );
    pollIfParentUnblocked(deps.db, done, deps.pollNow);
    await deps.landing.relandAncestors(done);
    return { ok: true, value: done };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, failure: { kind: "domain_error", error: err.message } };
    }
    throw err;
  }
}

/** Shared human-surface edit. */
export function editThroughHumanDoor(
  deps: EditThroughHumanDoorDeps,
  taskId: string,
  input: EditTaskInput,
  now: () => Date,
  origin: EventOrigin,
): HumanVerbResult<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) return { ok: false, failure: { kind: "not_found", error: "task not found" } };
  try {
    if (input.assignee) assertAssigneeKnown(deps.agentRegistered, input.assignee);
    if (input.workspace) {
      assertWorkspaceKnown(input.workspace, deps.resolveWorkspace, deps.workspace);
    }
    return { ok: true, value: editTask(deps.db, task, input, now(), origin) };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, failure: { kind: "domain_error", error: err.message } };
    }
    throw err;
  }
}

/** Shared human-surface direct cancel. */
export async function cancelThroughHumanDoor(
  deps: CancelThroughHumanDoorDeps,
  taskId: string,
  reason: string | undefined,
  now: () => Date,
  origin: EventOrigin,
): Promise<HumanVerbResult<Task>> {
  const task = getTask(deps.db, taskId);
  if (!task) return { ok: false, failure: { kind: "not_found", error: "task not found" } };
  try {
    cancelTaskDirectly(
      deps.db,
      task,
      reason ?? null,
      now(),
      humanCancelDefaults(
        deps.db,
        deps.workspace,
        deps.defaultAgentName,
        deps.auditorName,
        deps.quarantineResolvers,
      ),
      origin,
    );
    // 帰責の第2回(ADR 0115 決定2): cancel も決着。書き込みと同じ tick で呼ぶ(await を挟むと
    // 2つの扉が同時に「RCA 子が揃った」を見る)。fire-and-forget で response を待たせない
    void attributeAfterRca(deps.db, deps, task, now()).catch((err) =>
      console.error(`[attribution] ${task.id}: ${String(err)}`),
    );
    pollIfParentUnblocked(deps.db, task, deps.pollNow);
    await deps.landing.relandAncestors(task);
    return { ok: true, value: getTask(deps.db, task.id)! };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, failure: { kind: "domain_error", error: err.message } };
    }
    throw err;
  }
}

/** tier の提案の approve の書き込み(issue #920 / spec #916 D): pin の照合 → 下げ先の検査 → registry への commit。pin が崩れて
 *  いれば question を observed で決着させて回答を断り、下げ先に行が無い・push できないなら question は open のまま回答を断る。
 *  返り値は着地した commit。 */
async function landAgentTier(deps: SubmitAnswerDeps, questionId: string, proposal: RegistryProposal, to: Tier, now: () => Date): Promise<string> {
  const { list, changeTier } = deps.agentAdmin ?? {};
  if (!list || !changeTier) throw new DomainError("no registry configured — cannot change the agent's tier");
  const stale = (changed: ["rows"] | ["agent_tier"]) => {
    settleQuestionAsObserved(
      deps.db,
      questionId,
      { kind: "routing_proposal_stale", question_id: questionId, proposal_kind: "registry", changed, observed_event_id: null },
      now(),
    );
    return new DomainError(`the proposal's premise no longer holds (${changed.join(", ")} changed), so the board settled the question as observed`);
  };
  const settings = readExecutionSettings(deps.db);
  const rows = routingPinChanges(proposal, settings);
  if (rows?.length) throw stale(["rows"]);
  const agent = list().find((a) => a.name === proposal.agent);
  if (registryPinChanges(proposal, agent).length) throw stale(["agent_tier"]);
  if (!tierHasRowFor(settings.table, agent!.provider.split(", "), to)) {
    throw new DomainError(`the execution-setting table has no row at ${to} for ${proposal.agent}'s providers (${agent!.provider}), so the agent would be skipped`);
  }
  try {
    return await changeTier({ name: proposal.agent, expectTier: proposal.pin.tier, to, message: `lower agent ${proposal.agent}'s tier to ${to} (question ${questionId})` });
  } catch (err) {
    if (err instanceof AgentTierMismatchError) throw stale(["agent_tier"]);
    if (err instanceof RegistryPushFailedError || err instanceof RegistryFetchFailedError) throw new DomainError(err.message);
    throw err;
  }
}

/**
 * question への人間回答を実行する正準の application seam。
 * WebUI と管理 MCP は transport の違いだけを持ち、この副作用列を共有する。
 * `now` は snapshot ではなく provider — 外部副作用の await 後に都度読むことで、
 * 抽出前と同じ event / DB timestamp の順序を保つ。
 */
export async function submitAnswer(
  deps: SubmitAnswerDeps,
  task: Task,
  answers: string[],
  comment: string | undefined,
  now: () => Date,
  origin: EventOrigin = "webui",
  openTriage = false,
  amendment?: unknown,
): Promise<Task> {
  // Every special-case side effect below must come after this validation.
  // Otherwise a malformed answer can retry promotion, inspect/merge a PR, or
  // verify quarantine before answerQuestion eventually rejects the payload.
  assertAnswerable(task, answers);
  const proposal = task.question_proposal;
  // 修正値を受けるのは routing の行の提案と tier の提案の approve だけ(ADR 0150 決定2)。memory(#915)・昇格 / 降格の修正値も黙って捨てず断る
  const amendable = (proposal?.kind === "routing" && proposal.op === "row") || proposal?.kind === "registry";
  if (amendment !== undefined && (!amendable || answers[0] !== "approve")) {
    throw new DomainError("only an approve answer to a routing row proposal or an agent tier proposal takes an amendment");
  }
  let amended: ProposalAmendment | undefined;
  if (amendment !== undefined) amended = proposal?.kind === "registry" ? { to: parseAgentTierAmendment(proposal, amendment) } : parseRoutingRowChange(amendment);

  const promotionTaskId = task.question_pending_pr_promotion_task_id;
  const wantsPromotionRetry =
    promotionTaskId !== null && answers[0] === PR_PROMOTION_FAILURE_OPTIONS[0];
  if (wantsPromotionRetry) {
    const promotionTask = getTask(deps.db, promotionTaskId);
    if (!promotionTask) {
      throw new DomainError("PR promotion can no longer be retried");
    }
    const error = promotionRetryError(await deps.landing.land(promotionTask, task.id));
    if (error) throw new DomainError(error);
  }

  const localMergeTaskId = task.question_pending_local_merge_task_id;
  const wantsLocalMerge =
    localMergeTaskId !== null && answers[0] === MERGE_QUESTION_OPTIONS[0];
  if (wantsLocalMerge) {
    assertLandingAllowed(deps.db, localMergeTaskId);
    const mergeWorkspace = resolveWorkspaceForAnswer(
      deps,
      task.workspace,
      "cannot land the task branch",
    );
    try {
      mergeTaskToProtected(deps.db, mergeWorkspace, localMergeTaskId);
      // ADR 0064 決定4: 盤面が書いた ref の**行だけ**を撮り直す。走っているセッションの
      // 解放が、盤面自身のこの書き込みを違反として読まないために要る
      rebaselineRef(
        deps.db,
        mergeWorkspace,
        `refs/heads/${protectedBranch(mergeWorkspace)}`,
      );
    } catch (err) {
      // ADR 0103 決定4: 隔離するのは帯域外の書き込みの証拠だけである。コンフリクトも
      // 汚れたツリーも git の不調も、着地が失敗しただけでは資源が実行不能だと証明
      // しない —— question は開いたまま残り、人間は直してもう一度答えられる
      if (err instanceof OutOfBandProtectedBranchError) {
        quarantineWorkspace(deps.db, mergeWorkspace.name, err, now());
      }
      throw new DomainError(err instanceof Error ? err.message : String(err));
    }
  }

  const mergePr = task.question_pending_merge_pr;
  // ADR 0079 決定3 のバックストップ。回答の値に依らず、かつ CI ゲートより**先**に
  // 走る — merge 済み PR は CI が赤/pending でも観測決着に到達しなければならず、
  // 「hold」の回答も決定として記録されてはならない(誰も決めていない)。座礁を
  // 置換するだけの機構なので、workspace が引けない・網が届かない場合は今日どおりの
  // 経路に落ちる(正しさは失われない: merge 実行は依然失敗し question は開いたまま)。
  if (await deps.landing.observeMergedPullRequest(task)) {
    return getTask(deps.db, task.id)!;
  }
  const wantsMerge = mergePr !== null && answers[0] === MERGE_QUESTION_OPTIONS[0];
  if (wantsMerge) {
    assertLandingAllowed(deps.db, taskIdForPr(deps.db, mergePr, task.workspace));
    if (!deps.github) {
      throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
    }
    const mergeWorkspace = resolveWorkspaceForAnswer(
      deps,
      task.workspace,
      "cannot check CI or merge",
      "GitHub/workspace",
    );
    const status = await deps.github.getCiStatus({ path: mergeWorkspace.path, number: mergePr });
    if (status !== "success") {
      throw new DomainError(`CI is not green yet (status: ${status}) — cannot merge`);
    }
    // External merge precedes the persisted answer. If it fails, the question
    // stays open and the human can retry instead of being stranded as done.
    await deps.github.mergePullRequest({ path: mergeWorkspace.path, number: mergePr });
  }

  // Quarantine confirmation is never taken on faith (ADR 0137 決定5): the
  // kind's check runs immediately before accepting, and a board that cannot
  // check that kind refuses the answer rather than accepting it unverified.
  const quarantineKind = task.question_quarantine_kind;
  if (quarantineKind) {
    const check = deps.quarantineChecks?.[quarantineKind as QuarantineKind];
    if (!check) throw new DomainError(`this board cannot verify a ${quarantineKind} repair`);
    await check(task.question_quarantine_value);
  }

  // tier の提案の approve は registry への commit が先(issue #920 / ADR 0150 決定5)—— merge と同じく、着地しなければ question は open のまま
  const tierTarget = proposal?.kind === "registry" && answers[0] === "approve" ? ((amended as { to: Tier } | undefined)?.to ?? proposal.to) : undefined;
  const registryCommit = tierTarget && proposal?.kind === "registry" ? await landAgentTier(deps, task.id, proposal, tierTarget, now) : undefined;

  // An answer during triage is durable immediately, but its parent unblock is
  // staged until commit. The activity touch also defers the timeout close.
  const session = triageActivity(deps.db, now(), openTriage);
  // 提案 question(ADR 0120 決定3・spec #615 F / ADR 0150)は回答と適用を1 transaction にする。memory の approve は承認の
  // export(pin 不一致の DomainError は回答ごと巻き戻す)、reject は reject の export。routing の approve は表の書き口で
  // 行を書く —— 回答が先に question を done にするので、書き口の陳腐化の hook はこの question 自身を決着させない
  const { question, parentUnblocked, pickupResumed } = deps.db.transaction(() => {
    const answered = answerQuestion(
      deps.db,
      task,
      answers,
      now(),
      session && ((taskId) => stageFrontInsert(deps.db, session.id, taskId)),
      comment,
      amended,
      origin,
    );
    if (proposal?.kind === "memory") {
      if (answers[0] === "approve") approveMemoryProposal(deps.db, proposal, task.id, origin, now());
      else rejectMemoryProposal(deps.db, proposal, task.id, origin, now());
    } else if (proposal?.kind === "routing" && answers[0] === "approve") {
      const change: ExecutionSettingsChange =
        proposal.op === "row"
          ? { setting: "row", row: composeRoutingRow(proposal, amended as RoutingRowChange | undefined) }
          : { setting: "learner_promoted", value: proposal.op === "promote" };
      applyExecutionSettingsChange(deps.db, change, origin, now(), task.id);
    } else if (proposal?.kind === "registry" && registryCommit) {
      appendEvent(deps.db, {
        taskId: null,
        workerId: HUMAN_WORKER_ID,
        origin,
        payload: { kind: "agent_tier_changed", agent: proposal.agent, from: proposal.pin.tier, to: tierTarget!, question_id: task.id, registry_commit: registryCommit },
        at: now(),
      });
    }
    return answered;
  })();
  if (wantsMerge) {
    appendEvent(deps.db, {
      taskId: task.id,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "pr_merged", pr_number: mergePr! },
      at: now(),
    });
  }
  // Giving up promotion otherwise leaves no trace beyond a settled question;
  // preserve the reason on the immutable decision log of that question.
  if (promotionTaskId !== null && answers[0] === PR_PROMOTION_FAILURE_OPTIONS[1]) {
    logDecision(
      deps.db,
      question,
      `PR promotion abandoned for task ${promotionTaskId} — the work stays on its task branch, no PR`,
      HUMAN_WORKER_ID,
      now(),
      origin,
    );
  }
  // abandon は失敗タスクの木を丸ごと cancel する — そこに付帯子が居たなら、待って
  // いた祖先の着地はここで起きる(ADR 0092 決定3: cancel も決着)
  if (task.question_cancel_option !== null && answers[0] === task.question_cancel_option) {
    const abandoned = task.parent_id ? getTask(deps.db, task.parent_id) : undefined;
    if (abandoned) {
      // 帰責の第2回(ADR 0115 決定2): 捨てられたのが RCA 子ならここが最後の決着になりうる
      void attributeAfterRca(deps.db, deps, abandoned, now()).catch((err) =>
        console.error(`[attribution] ${abandoned.id}: ${String(err)}`),
      );
      await deps.landing.relandAncestors(abandoned);
    }
  }
  // 受理された確認回答が slot を解放する唯一の門(ADR 0099 決定3)。空の再観測は
  // 上の検証節で済んでいる — ここは効果の側で、slot-release tree rule はこの
  // 解放と対で走る。待っている回収を持たない Containment quarantine(ツール面のずれ
  // など)では no-op。
  if (quarantineKind === "containment") deps.reclaim?.acceptReclaimed();
  // An unblocked parent or a released quarantine can make the queue
  // head pickable immediately. During triage, staging keeps both flags false.
  if (parentUnblocked || pickupResumed) deps.pollNow();
  return question;
}
