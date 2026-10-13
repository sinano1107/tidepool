import { z } from "zod";
import { verifyAgentRepaired } from "./agent.js";
import { type AgentAdmin, AgentTierMismatchError, agentViewProviders } from "./agent-create.js";
import { assertAssigneeCanTake } from "./assignee.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { type CliAuthCheck, type ModelProbe, quarantineBoardCallRefusal, quarantineCliAuthForProvider } from "./cli-auth.js";
import type { Clock } from "./clock.js";
import type { ContainmentCheck } from "./containment.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import type { DraftClient } from "./draft.js";
import { appendEvent, type EventOrigin } from "./events.js";
import {
  type AddTierAmendment,
  applyExecutionSettingsChange,
  assertTierRunnableFor,
  composeRoutingRow,
  type ExecutionSettingsChange,
  parseAddTierAmendment,
  parseAgentTierAmendment,
  parseRoutingRowChange,
  parseTierDescriptionAmendment,
  type RoutingRowChange,
  registryPinChanges,
} from "./execution-setting.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import type { HarnessContainmentCheck } from "./harness-containment.js";
import { contentLeftBehind, type Landing, type LandingVerdict, landingBlock, observePrHead, openPrPromotionQuestionIds, outsidePushDropNotice, recordPrPromotionAbandoned, UNREPORTED_CI_GRACE_ORIGIN_TEXT, UNREPORTED_CI_GRACE_TEXT, unreportedCiGraceElapsed } from "./landing.js";
import { approveMemoryProposal, humanEntryInput, listMemoryEntries, type MemoryAmendment, movedTail, parseMemoryAmendment, rejectMemoryProposal } from "./memory.js";
import { whyNotPositiveInteger } from "./positive-integer.js";
import type { Provider } from "./provider.js";
import { openQuarantineQuestion, parseTableRowEffortValue, parseTableRowValue, type QuarantineChecks, type QuarantineKind, type QuarantineResolvers, quarantineStops, tableRowEffortTrigger } from "./quarantine.js";
import { questionKindOf } from "./question-kind.js";
import type { Harness, RegistryReachabilityCheck } from "./registry.js";
import { RegistryFetchFailedError, RegistryPushFailedError } from "./registry-write.js";
import { parseGitHubRepo, repairRepoAccess } from "./repo-access.js";
import { normalizeText, whyBlank } from "./required-text.js";
import { requiredTextSchema } from "./required-text-schema.js";
import {
  answerQuestion,
  assertAnswerable,
  assertInterviewTargets,
  assertNoUnsettledIssueRef,
  assertUnsettledNotInProgress,
  type BoardTask,
  type CancelDefaults,
  type ChildSpec,
  cancelTaskDirectly,
  completeTask,
  type EditTaskInput,
  editTask,
  getTask,
  type HandoffDoc,
  humanDecomposeTask,
  latestChild,
  logDecision,
  MERGE_QUESTION_OPTIONS,
  PR_PROMOTION_FAILURE_OPTIONS,
  type ProposalAmendment,
  presentTask,
  type RegisterTaskInput,
  type RegistryProposal,
  registerTask,
  settleQuestionAsObserved,
  type Task,
  taskIdForPr,
} from "./tasks.js";
import type { FailedTeardownCheck } from "./teardown.js";
import { liveTierRows, proposalTierNames, type Tier, tierNameOf, tierNames } from "./tier.js";
import { stageFrontInsert, triageActivity } from "./triage.js";
import type { PendingReclaim } from "./watchdog.js";
import { HUMAN_WORKER_ID } from "./worker-id.js";
import {
  buildWorkspaceResolver,
  mergeTaskToProtected,
  OutOfBandProtectedBranchError,
  quarantineWorkspace,
  redoMergeBacks,
  UnknownWorkspaceError,
  verifyWorkspaceClean,
  type WorkspaceConfig,
} from "./workspace.js";

export interface RegisterThroughHumanDoorDeps {
  db: Db;
  agentRegistered?: (name: string) => boolean;
  /** その名前がいま組み込み agent に解決されるか(shadow するエントリが無い)。Absent → registry の無い盤面。 */
  resolvesToBuiltIn?: (name: string) => boolean;
  draftClient?: DraftClient;
  github?: GitHubClient;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  isProtectedWorkspace?: (name: string) => boolean;
  /** 登録の成功は pickup の契機である(ADR 0119 決定2)。門で弾かれた登録は撃たない。 */
  pollNow: () => void;
  defaultAgentName?: string;
  auditorName?: string;
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
  | { ok: true; task: BoardTask }
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
  resolvesToBuiltIn?: (name: string) => boolean;
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
      assertAssigneeCanTake(deps, child.assignee, "work");
      assertReviewersKnown(deps.agentRegistered, child.review_by);
    }
    if (whyBlank(input.reason)) throw new DomainError("a decomposition requires a reason");
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
  const issueNumberReason = whyNotPositiveInteger(input.github_issue_number);
  if (issueNumberReason) return { ok: false, failure: { kind: "invalid", error: issueNumberReason } };
  if (whyBlank(input.workspace) || whyBlank(input.body)) {
    return {
      ok: false,
      failure: { kind: "invalid", error: "an issue comment requires a workspace, positive issue number, and body" },
    };
  }
  input = { ...input, workspace: normalizeText(input.workspace), body: normalizeText(input.body) };
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

/** A reviewer is always an agent (ADR 0111); unlike an assignee, `human` is
 * not a built-in escape from registry resolution. */
export function assertReviewersKnown(
  agentRegistered: ((name: string) => boolean) | undefined,
  reviewers: string[] | undefined,
): void {
  for (const reviewer of reviewers ?? []) {
    if (reviewer === HUMAN_WORKER_ID || (agentRegistered && !agentRegistered(reviewer))) {
      throw new DomainError(`unknown agent: ${reviewer}`);
    }
  }
}

/** resolver が無い盤面は workspace を追跡しないので、どの名前も通す。 */
function workspaceKnown(
  workspaceName: string,
  resolveWorkspace: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  workspace: WorkspaceConfig | undefined,
): boolean {
  const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
  if (!resolve) return true;
  try {
    resolve(workspaceName);
    return true;
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    return false;
  }
}

export function assertWorkspaceKnown(
  workspaceName: string,
  resolveWorkspace: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  workspace: WorkspaceConfig | undefined,
): void {
  if (!workspaceKnown(workspaceName, resolveWorkspace, workspace)) throw new DomainError(`unknown workspace: ${workspaceName}`);
}

type MemoryReferenceDeps = { agentRegistered?: (name: string) => boolean; workspace?: WorkspaceConfig; resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig };

/** 人間と meta-review が記憶に書く参照名 —— 宛先の agent・scope の workspace —— は書く瞬間に registry で解決できなければ拒む
 *  (ADR 0173 決定1・2)。null(全員 / 盤面全体)は常に可、registry の無い盤面では通す。門は選択の入る操作の呼び手が掛け、
 *  domain 層の書き込み・写しは registry を知らない。 */
export function assertMemoryReferencesKnown(deps: MemoryReferenceDeps, { addressee, workspace }: { addressee?: string | null; workspace?: string | null }): void {
  if (addressee != null && deps.agentRegistered && !deps.agentRegistered(addressee)) throw new DomainError(`unknown agent: ${addressee}`);
  if (workspace != null) assertWorkspaceKnown(workspace, deps.resolveWorkspace, deps.workspace);
}

/** 人間の面(settings の HTTP / 管理MCP)の直書きの入力: 参照名の門を通してから humanEntryInput。編集(supersedes)も
 *  同じ門を通り、削除済みの宛先・scope のままの編集は拒む(ADR 0173 決定3)。 */
export function gatedHumanEntryInput<T extends { workspace: string | null; addressee?: string | null; original_title?: string; original_text?: string; original_language?: string }>(
  deps: MemoryReferenceDeps & { db: Db },
  input: T,
) {
  assertMemoryReferencesKnown(deps, input);
  return humanEntryInput(deps.db, input);
}

/** 人間の面(WebUI と管理MCP)が共有する記憶の一覧(ADR 0173 決定5)。孤立の印 orphaned は宛先の agent・scope の
 *  workspace のどちらが registry で解決できないかを読むときに導出する(保存しない)。null の宛先・scope は孤立しない。
 *  registry の無い盤面(agentRegistered が無い)では欄ごと付けない。registry は名前ごとに1度だけ引く。 */
export function listMemoryEntriesForHuman(
  deps: MemoryReferenceDeps & { db: Db },
  filter: Parameters<typeof listMemoryEntries>[1],
): Array<ReturnType<typeof listMemoryEntries>[number] & { orphaned?: "addressee" | "scope" | "both" | null }> {
  const entries = listMemoryEntries(deps.db, filter);
  if (!deps.agentRegistered) return entries;
  const dead = (names: Array<string | null>, known: (name: string) => boolean) =>
    new Set([...new Set(names)].filter((name) => name !== null && !known(name)));
  const deadAddressees = dead(entries.map((e) => e.addressee), deps.agentRegistered);
  const deadScopes = dead(entries.map((e) => e.scope), (name) => workspaceKnown(name, deps.resolveWorkspace, deps.workspace));
  return entries.map((entry) => {
    const addressee = deadAddressees.has(entry.addressee);
    const scope = deadScopes.has(entry.scope);
    return { ...entry, orphaned: addressee && scope ? "both" : addressee ? "addressee" : scope ? "scope" : null };
  });
}

/**
 * 人間名義の task 登録を実行する正準の application seam。
 * WebUI と管理 MCP は transport の違いだけを持ち、この門を共有する。
 */
export async function registerThroughHumanDoor(
  deps: RegisterThroughHumanDoorDeps,
  input: HumanRegisterInput,
  now: () => Date,
  origin: EventOrigin,
): Promise<RegisterThroughHumanDoorResult> {
  try {
    if (input.type !== "work" && input.type !== "review") {
      throw new DomainError("a human can register only work or review tasks");
    }
    const isHumanDecomposeChild = input.parent_id !== undefined && input.type === "work";
    if (isHumanDecomposeChild && input.github_issue_number !== undefined) {
      throw new DomainError("a child task cannot be issue-backed");
    }
    // 子の登録は decompose を通り registerTask の検査に届かないので、同じ検査をここで呼ぶ
    if (isHumanDecomposeChild) assertInterviewTargets(deps.db, input);
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
      return { ok: true, task: presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName) };
    }
    if (input.workspace !== undefined) {
      assertWorkspaceKnown(input.workspace, deps.resolveWorkspace, deps.workspace);
    }
    assertAssigneeCanTake(deps, input.assignee, input.type);
    assertReviewersKnown(deps.agentRegistered, input.review_by);
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
            quarantineBoardCallRefusal(deps.db, err, "issue inspection", undefined, now());
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
    return { ok: true, task: presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName) };
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
  /** merge 回答が手元に無い PR の head を取る fetch の、盤面の GitHub 身元(ADR 0093 / ADR 0242 決定1)。 */
  githubAuth?: GitHubAuth;
  landing: Landing;
  /** ADR 0099 決定3: 受理された Containment quarantine の確認回答が slot を解放する
   *  唯一の門。空の再観測は containment の検査の側にある。Absent → watchdog を
   *  持たない盤面(回収を待っている slot が存在しない)。 */
  reclaim?: Pick<PendingReclaim, "acceptReclaimed">;
  quarantineChecks?: QuarantineChecks;
  /** registry の agent 一覧と tier の書き込み(issue #920): tier の提案への approve が使う。Absent → registry の無い盤面。 */
  agentAdmin?: Partial<Pick<AgentAdmin, "list" | "changeTier">>;
  /** memory の提案の approve が candidate の宛先を照合する(ADR 0173 決定2)。Absent → registry の無い盤面。 */
  agentRegistered?: (name: string) => boolean;
  defaultAgentName?: string;
  auditorName?: string;
}

/** 門の検査の材料。合成 root が一度だけ `quarantineChecks` に束ね、回答の口
 *  (WebUI・管理 MCP)へは map だけが渡る。 */
export interface QuarantineCheckDeps {
  db: Db;
  defaultAgentName?: string;
  auditorName?: string;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github?: GitHubClient;
  /** merge back のやり直し(ADR 0240 決定4)の fetch が使う盤面の GitHub 身元(ADR 0093)。 */
  githubAuth?: GitHubAuth;
  /** ADR 0217 決定5: agent 名の quarantine の解除検査の前に、その agent のキューの PR の
   *  盤面の外での merge を観測する。Absent → 観測せず、キューの PR は着地待ちに数えられる。 */
  landing?: Pick<Landing, "observeAutoMergeOutcomes">;
  boardState?: BoardStatePath[];
  /** Whether an agent name is currently registered — one half of the agent
   *  check; absent → only "no unsettled tasks remain" can clear it. */
  agentRegistered?: (name: string) => boolean;
  /** A name resolving to the built-in is not "back in the registry" (ADR 0228 決定4). */
  resolvesToBuiltIn?: (name: string) => boolean;
  /** Why a registered name fails pickup's resolution, or undefined when it resolves
   *  (issue #1745): an entry whose definition does not hold is not "back" either.
   *  Absent → registration alone counts as back. */
  agentDefinitionFailure?: (name: string) => string | undefined;
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
  /** ADR 0184 決定5: 行の Quarantine の probe。その Provider の口が無い行への回答は拒む。
   *  `clock` は probe が 401 を返したとき Provider 認証の経路へ落とす時刻。 */
  modelProbes?: Partial<Record<Provider, ModelProbe>>;
  clock?: Clock;
  /** ADR 0098: re-run the named Harness check before accepting repair. */
  harnessContainment?: HarnessContainmentCheck;
}

/** 解除の門の map(ADR 0137 決定5)。材料が無い種類は map に載らず、その確認への
 *  回答は拒まれる —— 検証できないまま受理する経路は無い。 */
export function quarantineChecks(deps: QuarantineCheckDeps): QuarantineChecks {
  const { containment, registryReachability, teardownQuarantine, providerCliAuth, modelProbes, clock, harnessContainment } = deps;
  // modelProbes / clock は下の `modelProbes && clock` の内側でだけ呼ぶので、絞った型で受け取る
  const recheckRow = async (
    presentProbes: Partial<Record<Provider, ModelProbe>>,
    presentClock: Clock,
    { provider, model, effort }: { provider: Provider; model: string; effort?: string | null },
  ) => {
    const row = [provider, model, effort].filter(Boolean).join(" / ");
    const probe = presentProbes[provider];
    if (!probe) throw new DomainError(`this board cannot verify that ${row} runs`);
    const result = await probe(model, effort ?? undefined);
    if (result.status === "runs") return;
    if (result.status === "unauthorized") quarantineCliAuthForProvider(deps.db, provider, presentClock.now());
    throw new DomainError(`${row} still cannot run: ${result.reason}`);
  };
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
      // workspace の検査の失敗は、どれも理由をそのまま人間へ返す回答の拒否である
      const refuseOnError = async (check: () => void | Promise<void>) => {
        try {
          await check();
        } catch (err) {
          throw new DomainError(err instanceof Error ? err.message : String(err));
        }
      };
      await refuseOnError(() => verifyWorkspaceClean(target));
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
      await refuseOnError(() => redoMergeBacks(deps.db, target, deps.workspace?.name, deps.githubAuth));
    },
    agent: async (value) => {
      const quarantineAgentName = value!;
      await deps.landing?.observeAutoMergeOutcomes(quarantineAgentName);
      try {
        // 組み込みの判定が先: 組み込みを work として解決すると定義の不成立になり、review まで数えてしまう(ADR 0228 決定4)
        const builtIn = deps.resolvesToBuiltIn?.(quarantineAgentName);
        const registered = !builtIn && deps.agentRegistered?.(quarantineAgentName);
        const definitionFailure = registered ? deps.agentDefinitionFailure?.(quarantineAgentName) : undefined;
        verifyAgentRepaired(
          deps.db,
          quarantineAgentName,
          builtIn ? "built-in" : registered && definitionFailure === undefined ? "registry" : "absent",
          deps.defaultAgentName,
          deps.auditorName,
          definitionFailure,
          buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace),
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
    // ADR 0184 決定5: その id で最小の1ターン。通った(予算上限で止まった = ターンは走った、を含む)
    // ときだけ受理し、401 は Provider 認証の経路に落としてから拒む
    ...(modelProbes && clock && {
      tableRow: (value) => recheckRow(modelProbes, clock, parseTableRowValue(value!)),
      // ADR 0218 決定2: effort ごとの行は、その effort でも検査し直す(Codex は一覧の読み直し)。起動時の照合の行は、その probe が
      // effort を読まないので回答では決着させない(決定6)。項目の無い question は `assertAnswerable` が先に拒むので、ここは二重の門
      tableRowEffort: async (value) => {
        const row = parseTableRowEffortValue(value!);
        if (tableRowEffortTrigger(row.provider) === "startupReconciliation") {
          throw new DomainError("only a table edit settles this question: change this row's effort or delete the row in the settings tab");
        }
        await recheckRow(modelProbes, clock, row);
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

/** retry の受理・拒否(ADR 0241 決定5)。verdict が無いのは、候補の読み取りそのものが失敗した回だけである。 */
function promotionRetryError(verdict: LandingVerdict | undefined): string | undefined {
  if (!verdict) return "the board could not read its landing roots; answer again";
  switch (verdict.kind) {
    case "landed":
    case "up_to_date":
    // 運ぶものが無いのは人間に判断を求めない事実で、retry を選んだ回答はそのまま受理する(ADR 0073 / issue #1725)
    case "nothing_to_land":
      return undefined;
    case "failed":
    case "excluded":
    case "quarantined":
      return verdict.error;
    case "deferred":
      return verdict.reason === "attached_children"
        ? `review still running: ${verdict.count} attached child task(s) unsettled`
        : `cannot land yet: ${verdict.count} objection(s) raised in this triage await commit`;
  }
}

export interface CancelThroughHumanDoorDeps {
  db: Db;
  pollNow: () => void;
  workspace?: WorkspaceConfig;
  defaultAgentName?: string;
  auditorName?: string;
  quarantineResolvers?: QuarantineResolvers;
}

export interface EditThroughHumanDoorDeps {
  db: Db;
  agentRegistered?: (name: string) => boolean;
  resolvesToBuiltIn?: (name: string) => boolean;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  defaultAgentName?: string;
  auditorName?: string;
}

export interface CompleteThroughHumanDoorDeps {
  db: Db;
  pollNow: () => void;
  defaultAgentName?: string;
  auditorName?: string;
}

/** Shared human-surface completion for human-assignee tasks. */
export async function completeThroughHumanDoor(
  deps: CompleteThroughHumanDoorDeps,
  taskId: string,
  handoff: Partial<HandoffDoc> | undefined,
  now: () => Date,
  origin: EventOrigin,
): Promise<HumanVerbResult<BoardTask>> {
  const task = getTask(deps.db, taskId);
  if (!task) return { ok: false, failure: { kind: "not_found", error: "task not found" } };
  try {
    if (task.assignee !== HUMAN_WORKER_ID) {
      throw new DomainError(
        "only a human-assignee task can be completed here — agents complete via MCP's complete_task",
      );
    }
    assertUnsettledNotInProgress(task, "completed");
    const done = completeTask(deps.db, task, handoff, HUMAN_WORKER_ID, now(), origin);
    deps.pollNow();
    return { ok: true, value: presentTask(deps.db, done, deps.defaultAgentName, deps.auditorName) };
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
): HumanVerbResult<BoardTask> {
  const task = getTask(deps.db, taskId);
  if (!task) return { ok: false, failure: { kind: "not_found", error: "task not found" } };
  try {
    if (input.assignee) assertAssigneeCanTake(deps, input.assignee, task.type);
    assertReviewersKnown(deps.agentRegistered, input.review_by);
    if (input.workspace) {
      assertWorkspaceKnown(input.workspace, deps.resolveWorkspace, deps.workspace);
    }
    editTask(deps.db, task, input, now(), origin);
    return { ok: true, value: presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName) };
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
): Promise<HumanVerbResult<BoardTask>> {
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
    deps.pollNow();
    return { ok: true, value: presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName) };
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
  // 根拠の行の pin は表の書き口の hook が決着させる(ADR 0150 決定1)ので、ここで照合するのは registry 側だけ
  const agent = list().find((a) => a.name === proposal.agent);
  if (registryPinChanges(proposal, agent, liveTierRows(deps.db)).length) throw stale(["agent_tier"]);
  const assertLandable = (providers: string[]) => assertTierRunnableFor(deps.db, proposal.agent, providers, to);
  assertLandable(agentViewProviders(agent!));
  try {
    return await changeTier({
      name: proposal.agent,
      expectTier: tierNameOf(deps.db, proposal.pin.tier),
      to,
      assertLandable,
      message: `lower agent ${proposal.agent}'s tier to ${to} (question ${questionId})`,
    });
  } catch (err) {
    if (err instanceof AgentTierMismatchError) throw stale(["agent_tier"]);
    if (err instanceof RegistryPushFailedError || err instanceof RegistryFetchFailedError) throw new DomainError(err.message);
    throw err;
  }
}

/** 回答の入力 schema。HTTP と管理 MCP の両方の扉がこれを使い、扉ごとの食い違いを作らない(issue #1310)。 */
export const answerInputSchema = z.object({
  // one answer per question item, in item order (issue #30) — the domain
  // enforces the length match against the question's own item count so callers
  // get a domain error, not a schema error, on a partial submission
  answers: z.array(requiredTextSchema).min(1),
  // the steering channel for a reject's reason (issue #40) — optional here;
  // which answers require it is the domain gate's call (ADR 0179). A blank one
  // is folded to "no comment" by submitAnswer (issue #1310); any other is
  // carried through verbatim onto the question_answered event
  comment: z.string().optional(),
  // routing の提案の approve に添える修正値(ADR 0150 決定2)。形は提案の種別ごとなので、検査は submitAnswer が持つ
  amendment: z.record(z.string(), z.unknown()).optional(),
});

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
  origin: EventOrigin,
  openTriage = false,
  amendment?: unknown,
): Promise<BoardTask> {
  // 空・空白だけの comment は「comment なし」に畳む(issue #1310)。空白でない comment は手を加えない。以降はこの値だけを見る
  if (comment === undefined || whyBlank(comment)) comment = undefined;
  // Every special-case side effect below must come after this validation.
  // Otherwise a malformed answer can retry promotion, inspect/merge a PR, or
  // verify quarantine before answerQuestion eventually rejects the payload.
  answers = assertAnswerable(task, answers, comment);
  // 提案は段を id で持つ。修正値・書き込みは名前で喋るので、いまの名前に引いた形で読む(issue #1436)
  const kind = questionKindOf(task);
  const proposal = kind.kind === "proposal" ? proposalTierNames(deps.db, kind.proposal) : null;
  // 修正値は approve だけが種別ごとの schema で受ける(ADR 0150 決定2・ADR 0152 決定2)。昇格 / 降格・candidate を持たない memory の提案(invalidate・既存の後継の consolidate)・reject の修正値も黙って捨てず断る
  let amended: ProposalAmendment | undefined;
  if (amendment !== undefined) {
    if (answers[0] === "approve" && proposal?.kind === "routing" && proposal.op === "row") amended = parseRoutingRowChange(tierNames(deps.db), amendment);
    else if (answers[0] === "approve" && proposal?.kind === "routing" && proposal.op === "add_tier") amended = parseAddTierAmendment(amendment);
    else if (answers[0] === "approve" && proposal?.kind === "routing" && proposal.op === "tier_description") amended = { description: parseTierDescriptionAmendment(amendment) };
    else if (answers[0] === "approve" && proposal?.kind === "registry") amended = { to: parseAgentTierAmendment(tierNames(deps.db), proposal, amendment) };
    else if (answers[0] === "approve" && proposal?.kind === "memory" && "candidate_id" in proposal) amended = parseMemoryAmendment(amendment);
    else throw new DomainError("only an approve answer to a routing row, add-tier, tier description, agent tier, or memory proposal with a candidate takes an amendment");
  }
  // approve は「これを注入する」宣言 —— candidate の宛先(修正値があればそれ)と scope が解決できなければ、付け替えるか reject する(ADR 0173 決定2)。
  // 移された candidate は複製の scope で見る(ADR 0162 決定6)
  if (answers[0] === "approve" && proposal?.kind === "memory" && "candidate_id" in proposal) {
    const named = movedTail(deps.db, proposal.candidate_id);
    assertMemoryReferencesKnown(deps, { addressee: amended && "addressee" in amended ? amended.addressee : named.addressee, workspace: named.scope });
  }

  let release: (() => void) | null = null;
  let tierTarget: Tier | undefined;
  let registryCommit: string | undefined;
  try {
    // 回答を記録する前に済ませる種類ごとの副作用。種類は1つなので順は互いに独立
    switch (kind.kind) {
      case "pr_promotion_retry":
        if (answers[0] === PR_PROMOTION_FAILURE_OPTIONS[0]) {
          const verdicts = await deps.landing.converge({ answering: task.id });
          const error = promotionRetryError(verdicts.find((root) => root.taskId === kind.task_id)?.verdict);
          if (error) throw new DomainError(error);
        }
        break;
      case "local_merge":
        if (answers[0] === MERGE_QUESTION_OPTIONS[0]) {
          assertLandingAllowed(deps.db, kind.task_id);
          const mergeWorkspace = resolveWorkspaceForAnswer(
            deps,
            task.workspace,
            "cannot land the task branch",
          );
          try {
            mergeTaskToProtected(deps.db, mergeWorkspace, kind.task_id);
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
        break;
      case "pr_merge": {
        const mergePr = kind.pr;
        // ADR 0079 決定3 / ADR 0229 決定4 のバックストップ。回答の値に依らず、かつ CI ゲートより**先**に
        // 走る — merge 済み・閉じた PR は CI が赤/pending でも観測決着に到達しなければならず、
        // 「hold」の回答も決定として記録されてはならない(誰も決めていない)。座礁を
        // 置換するだけの機構なので、workspace が引けない・網が届かない場合は今日どおりの
        // 経路に落ちる(正しさは失われない: merge 実行は依然失敗し question は開いたまま)。
        if (await deps.landing.observePullRequestOutcome(task)) {
          return presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName);
        }
        if (answers[0] === MERGE_QUESTION_OPTIONS[0]) {
          const landingTaskId = taskIdForPr(deps.db, mergePr, task.workspace);
          assertLandingAllowed(deps.db, landingTaskId);
          if (!deps.github) {
            throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
          }
          const mergeWorkspace = resolveWorkspaceForAnswer(
            deps,
            task.workspace,
            "cannot check CI or merge",
            "GitHub/workspace",
          );
          // ADR 0242 決定1: head を1回だけ読み、同じ head で積み残し・CI・merge を通す
          const pr = await deps.github.readPullRequest({ path: mergeWorkspace.path, number: mergePr });
          // ADR 0242 決定3: 比べられなければ積み残し —— 拒否文は「運んでいる途中」でなく、比べられなかった事実と理由を言う(#1854)
          if (pr.state === "unreadable") {
            throw new DomainError(`cannot merge: could not read PR #${mergePr}, so its head could not be compared with the task's content`);
          }
          // 記録に無い head は拒否より前に刻む —— escalate の PR はキューの行を持たないので、起点はここで残す(ADR 0231 決定4)
          observePrHead(deps.db, landingTaskId, mergePr, pr.head, now());
          // ADR 0231 決定3: 積み残しは門の検査と同じ時点で、門とは別に読む
          let left: string[];
          try {
            left = await contentLeftBehind(deps.db, mergeWorkspace, landingTaskId, pr.head, { auth: deps.githubAuth });
          } catch (err) {
            throw new DomainError(
              `cannot merge: could not compare PR #${mergePr}'s head ${pr.head} with the task's content — ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          if (left.length > 0) {
            // ADR 0242 決定4: 盤面の外の push が落とした内容は盤面が運べない —— その事実と直す手段を言う
            const dropped = await outsidePushDropNotice(deps.db, mergeWorkspace, landingTaskId, left, { number: mergePr, head: pr.head });
            if (dropped) throw new DomainError(`cannot merge: ${dropped}; then answer again`);
            // ADR 0240 決定5: 運ぶ面を名指しする
            const quarantineQuestionId = openQuarantineQuestion(deps.db, "workspace", mergeWorkspace.name)?.id;
            const promotionQuestionId = openPrPromotionQuestionIds(deps.db, landingTaskId)[0];
            const carrier = quarantineQuestionId
              ? `the open workspace quarantine question (${quarantineQuestionId})`
              : promotionQuestionId && `the open PR promotion failure question (${promotionQuestionId})`;
            throw new DomainError(
              `cannot merge yet: PR #${mergePr} does not carry all of the task's content yet — ` +
                (carrier
                  ? `${carrier} carries it; answer that question first, then answer again`
                  : "the board is still carrying it; answer again later"),
            );
          }
          // ADR 0227 決定2・3: check 未報告は猶予の間だけ pending と同じに拒み、過ぎれば回答の中の人間の判断で通す
          if (pr.ci === "unreported" && !unreportedCiGraceElapsed(deps.db, landingTaskId, pr.head, now())) {
            throw new DomainError(
              `CI checks on PR #${mergePr} have not reported yet — answer again once they report, or ` +
                `${UNREPORTED_CI_GRACE_TEXT} after ${UNREPORTED_CI_GRACE_ORIGIN_TEXT}`,
            );
          }
          if (pr.ci !== "success" && pr.ci !== "unreported") {
            throw new DomainError(`CI is not green yet (status: ${pr.ci}) — cannot merge`);
          }
          // ADR 0236 決定2・3: 印は merge の直前に同期で取り、取れなければ拒む(question は開いたまま)。印はこの関数が
          // 返るまで持つ —— merge の回答では、決着(回答と pr_merged)を書いた後に await は無い
          release = deps.landing.takeInFlightMark(task.workspace, mergePr);
          if (!release) {
            throw new DomainError(`PR #${mergePr} is being merged by the board right now — answer again in a moment`);
          }
          // External merge precedes the persisted answer. If it fails, the question
          // stays open and the human can retry instead of being stranded as done.
          // CI を読んだ head に固定する(ADR 0231 決定1)
          // 失敗は文面で分けずすべて DomainError に包む —— ローカル着地(ADR 0103 決定4)と同じ形で、WebUI は 409 で理由を見られる
          try {
            await deps.github.mergePullRequest({ path: mergeWorkspace.path, number: mergePr }, pr.head);
          } catch (err) {
            throw new DomainError(`merging PR #${mergePr} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        break;
      }
      case "quarantine": {
        // Quarantine confirmation is never taken on faith (ADR 0137 決定5): the
        // kind's check runs immediately before accepting, and a board that cannot
        // check that kind refuses the answer rather than accepting it unverified.
        const check = deps.quarantineChecks?.[kind.quarantine as QuarantineKind];
        if (!check) throw new DomainError(`this board cannot verify a ${kind.quarantine} repair`);
        await check(kind.value);
        break;
      }
      case "proposal":
        // tier の提案の approve は registry への commit が先(issue #920 / ADR 0150 決定5)—— merge と同じく、着地しなければ question は open のまま
        if (proposal?.kind === "registry" && answers[0] === "approve") {
          tierTarget = (amended as { to: Tier } | undefined)?.to ?? proposal.to;
          registryCommit = await landAgentTier(deps, task.id, kind.proposal as RegistryProposal, tierTarget, now);
        }
        break;
      case "escalation":
      case "failure":
      case "premise_breach":
      case "approval":
      case "cli_auth_expiry_warning":
        break;
      default:
        kind satisfies never;
    }

    // An answer during triage is durable immediately, but its parent unblock is
    // staged until commit. The activity touch also defers the timeout close.
    const session = triageActivity(deps.db, now(), openTriage);
    // 提案 question(ADR 0120 決定3・spec #615 F / ADR 0150)は回答と適用を1 transaction にする。memory の approve は承認の
    // export(pin 不一致の DomainError は回答ごと巻き戻す)、reject は reject の export、defer は何もしない(ADR 0165)。routing の approve は表の書き口で
    // 行を書く —— 回答が先に question を done にするので、書き口の陳腐化の hook はこの question 自身を決着させない
    const question = deps.db.transaction(() => {
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
        if (answers[0] === "approve") approveMemoryProposal(deps.db, proposal, task.id, origin, now(), amended as MemoryAmendment | undefined);
        else if (answers[0] === "reject") rejectMemoryProposal(deps.db, proposal, task.id, origin, now());
      } else if (proposal?.kind === "routing" && answers[0] === "approve") {
        if (proposal.op === "add_tier") {
          // 段の挿入と行の移動を1つの transaction で(ADR 0200 決定8)。修正後の値の検査は挿入の扉がやり直し、拒めば回答ごと巻き戻る
          const tier = { ...proposal.tier, ...(amended as AddTierAmendment | undefined) };
          applyExecutionSettingsChange(deps.db, { setting: "insert_tier", ...tier }, origin, now(), task.id);
          applyExecutionSettingsChange(deps.db, { setting: "row", key: proposal.row, row: { ...proposal.pin.row, tier: tier.name } }, origin, now(), task.id);
        } else {
          const change: ExecutionSettingsChange =
            proposal.op === "row"
              ? { setting: "row", key: proposal.row, row: composeRoutingRow(proposal, amended as RoutingRowChange | undefined) }
              : proposal.op === "tier_description"
                ? { setting: "edit_tier", name: proposal.tier, description: (amended as { description: string } | undefined)?.description ?? proposal.description }
                : { setting: "learner_promoted", value: proposal.op === "promote" };
          applyExecutionSettingsChange(deps.db, change, origin, now(), task.id);
        }
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
    if (kind.kind === "pr_merge" && answers[0] === MERGE_QUESTION_OPTIONS[0]) {
      appendEvent(deps.db, {
        taskId: task.id,
        workerId: HUMAN_WORKER_ID,
        origin,
        payload: { kind: "pr_merged", pr_number: kind.pr },
        at: now(),
      });
    }
    // Giving up promotion otherwise leaves no trace beyond a settled question;
    // preserve the reason on the immutable decision log of that question.
    // 断念した内容(その時点の head)は盤面名義の事実としてタスクに刻む(ADR 0225 決定1)
    if (kind.kind === "pr_promotion_retry" && answers[0] === PR_PROMOTION_FAILURE_OPTIONS[1]) {
      logDecision(
        deps.db,
        question,
        `PR promotion abandoned for task ${kind.task_id} — this content stays on its task branch; a later change to the branch asks again`,
        HUMAN_WORKER_ID,
        now(),
        origin,
      );
      recordPrPromotionAbandoned(
        deps.db,
        buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace),
        task.workspace,
        kind.task_id,
        now(),
      );
    }
    // 受理された確認回答が slot を解放する唯一の門(ADR 0099 決定3)。空の再観測は
    // 上の検証節で済んでいる — ここは効果の側で、slot-release tree rule はこの
    // 解放と対で走る。待っている回収を持たない Containment quarantine(ツール面のずれ
    // など)では no-op。
    if (kind.kind === "quarantine" && kind.quarantine === "containment") deps.reclaim?.acceptReclaimed();
    // 受理された回答は常に poll を撃つ —— 何が pickable になったかの判定は poll の1点で行い、契機の側は判定しない
    // (ADR 0119 決定1)。triage 中は盤面が止まっていて、session の commit が poll を撃つ(ADR 0065 決定9)
    if (!session) deps.pollNow();
    return presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName);
  } finally {
    release?.();
  }
}
