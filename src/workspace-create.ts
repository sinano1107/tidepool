import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { GitHubClient } from "./github.js";
import { authedGit, type GitHubAuth } from "./github-auth.js";
import {
  assertValidAllowedDomains,
  assertValidReviewAllowedCommands,
  assertValidWorkspaceName,
  loadRegistry,
  ownEntry,
  type RegistrySource,
  type WorkspaceEntry,
} from "./registry.js";
import { commitToRegistry, refreshRegistryForWrite } from "./registry-write.js";
import { parseGitHubRepo, RepoAccessMissingError, repairRepoAccess } from "./repo-access.js";
import {
  conventionCheckoutPath,
  entryCheckoutPath,
  git,
  originUrl,
  resolvesToRegistryClone,
  UnknownWorkspaceError,
  type WorkspacesBaseDirSource,
} from "./workspace.js";

/** The WebUI's workspace-creation verbs (issue #57): three entrances, one
 *  resulting Workspace — the mode is a circumstance of creation, not a kind
 *  (CONTEXT.md's Workspace). Human-only; agents keep going through
 *  registry-edit tasks instead (2026-07-14 grilling). */
export type CreateWorkspaceInput = {
  name: string;
  notes?: string;
  /** Setting protection at creation needs no confirmation step — adding it
   *  only ever moves in the safe direction (issue #57; removal is the edit
   *  flow's confirmed action). */
  protected?: boolean;
} & (
  | {
      mode: "register";
      /** The existing checkout on this host — the one mode that records an
       *  explicit, host-specific path (ADR 0018 keeps board-created entries
       *  convention-derived instead). */
      path: string;
    }
  | {
      mode: "clone";
      /** What `git clone` accepts — recorded on the entry as provenance. */
      repo: string;
    }
  | {
      /** The name doubles as the new GitHub repository's name — the shared
       *  charset assertValidWorkspaceName enforces is safe for both. */
      mode: "create";
    }
);

/** What every workspace-admin verb needs: which registry clone to commit to,
 *  and the base directory path-omitting entries derive from (ADR 0018) —
 *  both threaded in by the composition root, never read from env here. */
export interface WorkspaceAdminDeps {
  /** どの registry clone を検証・一覧・書き込みに使うか、そのクローンが remote
   *  正本を持つか(ADR 0052 決定1)の組 — 必ず一緒に運ばれるので1つの型にした
   *  (issue #210 レビュー — AgentAdminDeps / ProfileAdminDeps と共有する
   *  Data Clumps だった)。 */
  registry: RegistrySource;
  workspacesBaseDir: string;
  /** ADR 0040 / issue #149: the board's own state paths (fixed for the whole
   *  process), threaded in by the composition root. The creation gate refuses
   *  a workspace that would intersect one of them. Absent → nothing to protect
   *  (a caller outside main.ts, e.g. a test); the pickup-side floor
   *  (claude-worker.ts) still catches whatever gets registered anyway —
   *  including the registry-edit PR path, which never passes this gate. */
  boardState?: BoardStatePath[];
  /** The board's GitHub identity (ADR 0024) for the registry push (ADR 0052
   *  決定1: 失敗は致命 — #210) and clone/repository calls, absent when no
   *  secrets file is configured — clones then run unauthenticated, the same
   *  fail-closed posture as the optional `github` client below. */
  githubAuth?: GitHubAuth;
}

/** 共通の dep に、**GitHub へ出ていく workspace 動詞**が要るものを1つ足した組:
 *  `clone`(ADR 0067 決定2 の登録の門)と `publish`(決定8)がこれを共有する。 */
export interface WorkspaceGitHubDeps extends WorkspaceAdminDeps {
  /** Absent(盤面が GitHub 身元を持たない、ADR 0024)→ ADR 0067 の到達性 probe は
   *  撃たれず、今日の挙動のまま —— clone は素の git に委ね、publish は push が落ちる
   *  だけになる。`create` は GitHub に一切出ないので、そもそもこれを読まない
   *  (ADR 0066 決定1)。 */
  github?: GitHubClient;
}

/** 返すのは着地した checkout のパス(ADR 0082 決定1)。MCP の `create_workspace`
 *  は1回の呼び出しで登録まで進むので、「見せてから決める」形が無い —— 決めた後に
 *  どこへ落ちたかを返すことがその代わりである。 */
export type CreateWorkspaceFn = (input: CreateWorkspaceInput) => Promise<string>;
export type UpdateWorkspaceFn = (input: UpdateWorkspaceInput) => Promise<void>;
/** 返すのは publish が push した remote-tracking ref(`refs/remotes/origin/<branch>`)
 *  である。ADR 0064 決定4 の再基準化は「盤面が**実際に書いた** ref の行だけ」を要求し、
 *  publish はその集合を **push の直前に checkout から読んで確定させる**唯一の場所だから
 *  である —— 事後に `refs/remotes/origin/*` を列挙し直す綴りだと、その間に worker が
 *  偽造した remote-tracking ref まで「盤面が書いた」に化け、ADR 0064 が閉じた潜在バグ
 *  (偽造 → 無実の次セッションへの誤帰属)がそのまま戻る。 */
export type PublishWorkspaceFn = (input: PublishWorkspaceInput) => Promise<string[]>;

/** The settings surface's workspace verbs as one bundle (issue #57): they
 *  exist together or not at all (a registry is configured, or none is), so
 *  the composition root binds them once and the layers in between thread one
 *  dep, not three. */
export interface WorkspaceAdmin {
  create: CreateWorkspaceFn;
  list: () => WorkspaceListView;
  update: UpdateWorkspaceFn;
  /** ADR 0066 決定2/8: purely-local → remote-backed の遷移を与える4つ目の動詞。 */
  publish: PublishWorkspaceFn;
}

/** publish の3つ目の拒否(ADR 0066 決定5 / issue #285): 盤面が GitHub 身元
 *  (ADR 0024)を持たないので push できない。要求するのは `github` クライアントでは
 *  なく `githubAuth` である —— publish が GitHub に出るのは git の push 1本だけで、
 *  API は ADR 0067 の probe(あれば撃つ)にしか使わない。
 *
 *  ADR 0066 決定1 以降、create モードはこのエラーを投げない(GitHub に一切出ない)。 */
export class GitHubIdentityMissingError extends Error {
  constructor() {
    super("publish needs the board's GitHub identity (TIDEPOOL_GITHUB_TOKEN_FILE) to push");
    this.name = "GitHubIdentityMissingError";
  }
}

/** The registration gate's refusal (ADR 0040 / issue #149): the checkout this
 *  entry would point at intersects one of the board's own state paths. issue
 *  #121 refused a registration-time check for *injectivity* because that is a
 *  human convention and the check would be inaccurate — this one is path
 *  containment, which is exact, and it guards a floor, so the gate may refuse
 *  it outright. The floor itself still lives at pickup (claude-worker.ts): a
 *  registry-edit PR never passes through here. */
export class BoardStateOverlapError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BoardStateOverlapError";
  }
}

/** Where this creation's checkout will actually live — the one path the gate
 *  judges. `register` records an explicit host path; `clone` and `create` both
 *  land at the convention-derived location (ADR 0018), which does not exist
 *  yet at gate time (boardStateOverlap resolves the deepest existing ancestor
 *  and joins the rest lexically — ADR 0040). */
function intendedCheckoutPath(input: CreateWorkspaceInput, deps: WorkspaceAdminDeps): string {
  return input.mode === "register"
    ? input.path
    : conventionCheckoutPath(input.name, deps.workspacesBaseDir);
}

/** Orchestrates one workspace creation: external effects first, the registry
 *  commit strictly last (issue #57) — a mid-way failure leaves only orphans
 *  the registry never knew about, never a half-registered entry. */
export async function createWorkspace(input: CreateWorkspaceInput, deps: WorkspaceGitHubDeps): Promise<string> {
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  assertValidWorkspaceName(registry, input.name);
  const path = intendedCheckoutPath(input, deps);
  // ADR 0040: before any external effect — a refused registration must not
  // leave a clone or a GitHub repository behind.
  if (deps.boardState) {
    const overlap = boardStateOverlap(path, deps.boardState);
    if (overlap) throw new BoardStateOverlapError(overlap.reason);
  }
  const entry = await buildEntry(input, deps);
  if (input.notes !== undefined) entry.notes = input.notes;
  if (input.protected) entry.protected = true;
  commitWorkspaceEntry(deps, input.name, entry, `add workspace ${input.name} via WebUI`);
  return path;
}

/** The edit half of the WebUI's workspace admin (issue #57 phase 3): only
 *  `notes`, `protected`, `review_allowed_commands` (ADR 0061), and
 *  `allowed_domains` (ADR 0072) are editable
 *  — changing `path`/`repo`/`branch` re-points the entry at a different real
 *  checkout, which stays a manual edit (the registry is a git repository).
 *  A partial patch throughout: an absent field is untouched, which is what
 *  lets the confirmation gate below judge the payload alone. */
export interface UpdateWorkspaceInput {
  name: string;
  /** Provided → set; empty string → remove the field. */
  notes?: string;
  protected?: boolean;
  /** ADR 0035's review write-floor lift, editable from the human doors since
   *  ADR 0061 (the create door deliberately stays out of it — 決定3). Provided
   *  → set; the empty array removes the key, absence being the canonical "no
   *  commands", the same shape as `protected` below. */
  review_allowed_commands?: string[];
  /** ADR 0072's workspace-scoped network egress lift. Empty removes it. */
  allowed_domains?: string[];
  /** Consent to every dangerous value in this payload, not to unprotecting
   *  alone (ADR 0061 決定1) — one boolean, the refusal's reason codes say
   *  what it bought. */
  confirm?: boolean;
}

/** Machine-readable reason codes `dangerousWorkspaceValues` can return — the
 *  workspace twin of profile-create's `DangerousValueReason`, stable strings
 *  a door's refusal enumerates rather than prose (ADR 0061 決定1). */
export type DangerousWorkspaceValueReason =
  | "unprotect"
  | "review_allowed_commands_set"
  | "allowed_domains_set";

/** Pure judgment of which values in *this payload* widen what agents may do
 *  (ADR 0061 決定2): removing protection, and setting the review write-floor
 *  lift to a non-empty list. It never reads the entry being edited — the
 *  update is a partial patch, so a field the human did not touch is simply
 *  absent, and the empty array (clearing the list) moves in the safe
 *  direction and asks nothing. */
function dangerousWorkspaceValues(
  input: Pick<UpdateWorkspaceInput, "protected" | "review_allowed_commands" | "allowed_domains">,
): DangerousWorkspaceValueReason[] {
  const reasons: DangerousWorkspaceValueReason[] = [];
  if (input.protected === false) reasons.push("unprotect");
  if (input.review_allowed_commands?.length) reasons.push("review_allowed_commands_set");
  if (input.allowed_domains?.length) reasons.push("allowed_domains_set");
  return reasons;
}

/** A payload carrying dangerous values arrived without `confirm` (issue #57,
 *  generalized by ADR 0061 決定1 from "removing protection" to "every
 *  dangerous value in this payload"). Enforcement lives here in the domain,
 *  once: the API maps this to a 409 with `dangerous_values`, the management
 *  MCP to a tool error — and both bodies enumerate the reason codes, so the
 *  message carries them too rather than only the structured field. */
export class WorkspaceConfirmationRequiredError extends Error {
  constructor(
    name: string,
    public readonly reasons: DangerousWorkspaceValueReason[],
  ) {
    super(
      `workspace "${name}" edit contains dangerous values (${reasons.join(", ")}); resubmit with confirm: true`,
    );
    this.name = "WorkspaceConfirmationRequiredError";
  }
}

/** The one unprotect no confirmation can buy (issue #57 / ADR 0013): the
 *  entry pointing at the board's own registry clone. "Changes to the registry
 *  always need human approval" is the floor everything else stands on —
 *  removing it must never be within one click's (or one curl's) reach. */
export class RegistrySelfUnprotectError extends Error {
  constructor(name: string) {
    super(
      `workspace "${name}" is the board's own registry clone — its protection cannot be removed here`,
    );
    this.name = "RegistrySelfUnprotectError";
  }
}


export async function updateWorkspace(input: UpdateWorkspaceInput, deps: WorkspaceAdminDeps): Promise<void> {
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  // the self-refusal outranks confirmation — checked first so a confirmed
  // request gets the honest "never here", not another confirm loop. It also
  // ignores the entry's current flag: the floor must not depend on the very
  // state it protects
  if (
    input.protected === false &&
    resolvesToRegistryClone(entry, input.name, deps.registry.dir, deps.workspacesBaseDir)
  ) {
    throw new RegistrySelfUnprotectError(input.name);
  }
  // grammar before confirmation, for the same reason as the self-refusal: a
  // malformed prefix is not something a confirm can buy, and the value the
  // human read must be the one the CLI receives (ADR 0061 根拠5)
  if (input.review_allowed_commands !== undefined) {
    assertValidReviewAllowedCommands(input.review_allowed_commands);
  }
  if (input.allowed_domains !== undefined) {
    assertValidAllowedDomains(input.allowed_domains);
  }
  const dangerous = dangerousWorkspaceValues(input);
  if (dangerous.length > 0 && input.confirm !== true) {
    throw new WorkspaceConfirmationRequiredError(input.name, dangerous);
  }
  const next: WorkspaceEntry = { ...entry };
  if (input.notes !== undefined) {
    if (input.notes === "") delete next.notes;
    else next.notes = input.notes;
  }
  if (input.protected !== undefined) {
    // absence is the canonical "not protected" — mirrors creation, which
    // never writes `protected: false`
    if (input.protected) next.protected = true;
    else delete next.protected;
  }
  if (input.review_allowed_commands !== undefined) {
    if (input.review_allowed_commands.length === 0) delete next.review_allowed_commands;
    else next.review_allowed_commands = input.review_allowed_commands;
  }
  if (input.allowed_domains !== undefined) {
    if (input.allowed_domains.length === 0) delete next.allowed_domains;
    else next.allowed_domains = input.allowed_domains;
  }
  commitWorkspaceEntry(deps, input.name, next, `update workspace ${input.name} via WebUI`);
}

/** ADR 0066 決定2 の入力: publish するのはどの workspace か、宛先の repo URL はどこか。
 *  宛先は**毎回人間が打つ値**であり、盤面は所有者も綴りも検証しない —— 打ち間違いは
 *  人間の入力の範疇で、権限が無ければ push が落ちるだけである。 */
export interface PublishWorkspaceInput {
  name: string;
  repo: string;
}

/** publish の1つ目の拒否(ADR 0066 決定5): エントリが既に `repo` を持つ。この拒否が
 *  リトライの意味も確定させる —— 成功した publish の再送は「もう remote 正本がある」
 *  であって、宛先の差し替えではない(それは registry の手編集)。 */
export class WorkspaceAlreadyPublishedError extends Error {
  constructor(name: string, repo: string) {
    super(`workspace "${name}" already declares a remote source of truth (repo: ${repo})`);
    this.name = "WorkspaceAlreadyPublishedError";
  }
}

/** publish の2つ目の拒否(ADR 0066 決定5): エントリが盤面自身の registry clone を
 *  指している。通すと workspace エントリは remote-backed を宣言し、合成 root
 *  (`RegistryMode`)は purely-local を宣言する —— ADR 0052 が quarantine と定めた
 *  「2つの宣言の食い違い」を人間の扉が製造することになる。`RegistrySelfUnprotectError`
 *  (ADR 0013)と同じ形の、確認では買えない拒否である。 */
export class RegistrySelfPublishError extends Error {
  constructor(name: string) {
    super(
      `workspace "${name}" is the board's own registry clone — its remote source of truth is the board's own composition, not this door`,
    );
    this.name = "RegistrySelfPublishError";
  }
}

/** publish の4つ目の拒否(ADR 0066 決定5): エントリは `repo` を持たないのに
 *  checkout には `origin` が在る。それは帯域外の手作業が作った ADR 0052 のずれ状態で
 *  あり、pickup でどのみち quarantine に落ちる —— publish が上書きして辻褄を合わせる
 *  形は採らない。**巻き戻しの線もここで引かれる**: 自分が `remote add` した場合しか
 *  `remote remove` しないので、publish が足していない remote は決して消えない。 */
export class CheckoutHasOriginError extends Error {
  constructor(name: string, origin: string) {
    super(
      `workspace "${name}" declares no remote source of truth but its checkout already has an 'origin' (${origin}) — repair the mismatch by hand`,
    );
    this.name = "CheckoutHasOriginError";
  }
}

/** ADR 0066 決定2 の扉: purely-local な workspace に remote 正本を与える。
 *  `git remote add origin` → `git push --atomic --all` → registry エントリへ `repo`。
 *  checkout は動かさない(ADR 0064 の「走っているセッションの作業ツリーを奪わない」)。 */
export async function publishWorkspace(
  input: PublishWorkspaceInput,
  deps: WorkspaceGitHubDeps,
): Promise<string[]> {
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  if (entry.repo !== undefined) throw new WorkspaceAlreadyPublishedError(input.name, entry.repo);
  if (resolvesToRegistryClone(entry, input.name, deps.registry.dir, deps.workspacesBaseDir)) {
    throw new RegistrySelfPublishError(input.name);
  }
  if (!deps.githubAuth) throw new GitHubIdentityMissingError();
  const dir = entryCheckoutPath(entry, input.name, deps.workspacesBaseDir);
  const existing = originUrl(dir);
  if (existing !== undefined) throw new CheckoutHasOriginError(input.name, existing);
  // ADR 0067 決定8: ADR 0066 決定5 が名指しした最頻の人為ミス「repo は作ったが bot の
  // 招待を忘れた」を、push が落ちる**前に**招待1枚で直す。位置は `remote add` の手前で
  // なければならない —— 直せなかったとき、巻き戻す痕跡がそもそも作られない側に立つ。
  await assertRepoAccess(input.repo, deps.github);
  // ── ここから下に `await` は1つも無い(ADR 0066 決定5)。`authedGit` も
  // `commitToRegistry` も `execFileSync` なので、await を挟まなければ publish 全体が
  // イベントループに対して不可分になり、pickup が中間状態(clone に remote があるのに
  // 宣言が無い = ADR 0052 の quarantine 事由)を観測できない ──
  // probe の往復の間に人間面から同じエントリの編集(notes など)が landed していたら、
  // 上で読んだ写しは既に古い —— そのまま書くと相手の編集を黙って巻き戻す。publish の
  // 対象は**既に登録済み**の workspace なので、`createWorkspace` の「途中失敗が残すのは
  // registry が知らない孤児だけ」という根拠はここでは引き継げない(ADR 0066 決定5)。
  const fresh = ownEntry(loadRegistry(deps.registry.dir, deps.registry.mode).workspaces, input.name);
  if (!fresh) throw new UnknownWorkspaceError(input.name);
  if (fresh.repo !== undefined) throw new WorkspaceAlreadyPublishedError(input.name, fresh.repo);
  git(dir, "remote", "add", "origin", input.repo);
  try {
    // `--all` が送る集合 = そのとき checkout にある `refs/heads/*`。**push の直前に**
    // 読むのが要件である(ADR 0064 決定4): 撮り直す ref の集合は盤面が書いたものだけに
    // 確定していなければならず、事後に `refs/remotes/origin/*` を列挙し直すと、その間に
    // worker が偽造した remote-tracking ref を基準へ迎え入れてしまう。
    const branches = git(dir, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads/")
      .split("\n")
      .filter((branch) => branch !== "");
    // `--atomic` は必須(ADR 0066 決定6): 宛先が「Add a README」つきの非空 repo
    // だと `main` だけが non-fast-forward で落ち、`task/*` は宛先に存在しないので
    // **成功してしまう**。非 atomic だと publish は失敗扱いでローカルを巻き戻すのに、
    // 人間の「空のはずの repo」にはタスクブランチが載ったまま残る。
    // `--all` は `refs/heads/*` だけ —— タグはドメイン上の意味を持たないので送らない
    // (ADR 0066 決定6)。上限は掛けない: 人間が起こす一括転送なので clone と同じ扱い。
    authedGit(deps.githubAuth, dir, "push", "--atomic", "--all", "origin");
    commitWorkspaceEntry(
      deps,
      input.name,
      { ...fresh, repo: input.repo },
      `publish workspace ${input.name} via WebUI`,
    );
    return branches.map((branch) => `refs/remotes/origin/${branch}`);
  } catch (err) {
    // 巻き戻すのは**自分が足した origin だけ**(上の CheckoutHasOriginError が
    // その線を引いている)。最も起きる人為ミスは「repo は作ったが bot の招待を
    // 忘れた」で、経路は remote add(成功)→ push(失敗)→ registry コミット未実行。
    // registry コミットが落ちた場合もここへ来る: 宣言の無い workspace に origin が
    // 残るほうが ADR 0052 のずれそのものであり、再送は同一 ref の push なので
    // up-to-date で通る。
    git(dir, "remote", "remove", "origin");
    throw err;
  }
}

/** Each mode's external half, ordered so the registry commit stays last. */
async function buildEntry(
  input: CreateWorkspaceInput,
  deps: WorkspaceGitHubDeps,
): Promise<WorkspaceEntry> {
  if (input.mode === "register") return registerExistingCheckout(input.path);
  if (input.mode === "clone") {
    await assertRepoAccess(input.repo, deps.github);
    return cloneAndDescribe(input.name, input.repo, deps);
  }
  return createLocalCheckout(input.name, deps);
}

/** ADR 0066 決定1 の create モードの外部半分: GitHub に一切出ず、規約由来の場所
 *  (ADR 0018)に `git init -b main` + 初期コミットで checkout を作る。
 *
 *  `-b main` は明示が必須である — ホストの `init.defaultBranch` は盤面の管理下に
 *  なく、`master` の環境では初期ブランチ名が保護ブランチの既定(`main`)とずれて
 *  `ensureTaskBranch`(workspace.ts)が pickup 時に落ちる。初期コミットが要るのは
 *  同じ理由で、空リポジトリには `main` が存在しない。`repo` を書かないため、生まれる
 *  workspace は構造的に purely-local である(ADR 0052 決定3)。 */
function createLocalCheckout(name: string, deps: WorkspaceGitHubDeps): WorkspaceEntry {
  const dir = conventionCheckoutPath(name, deps.workspacesBaseDir);
  // idempotent retry (issue #57): 規約どおりの場所に既にある checkout は、前回
  // registry コミット直前で失敗した孤児 —— 済んだ手順として流用する(clone
  // モードの cloneAndDescribe と同じ形)
  if (!existsSync(dir)) {
    // git init creates any missing directories itself, mkdir first is redundant
    git(deps.workspacesBaseDir, "init", "-b", "main", dir);
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "initial commit");
  }
  return {};
}

/** 盤面がこれから git でその repo へ出ていく直前に、書けることを1回だけ確かめ、
 *  招待1枚で直せるなら直す(ADR 0067 決定2 の登録の門 = `clone`、決定8 の `publish`)。
 *  撃たないのは2つの場合で、どちらも今日の挙動のまま通す:
 *
 *  - `github` 不在 —— 盤面が GitHub 身元(ADR 0024)を持たないので probe を撃つ相手
 *    そのものが無い。ここは通す側で、git 呼び出しは今日どおり素のまま落ちる
 *  - 非 GitHub の URL —— `clone` の入力欄も `publish` の宛先欄も「anything git が
 *    受ける綴り」であり、`parseGitHubRepo` の `undefined` がそのままこの門になる
 *    (決定1)
 *
 *  `create` モードは GitHub に一切出ない(ADR 0066 決定1)ので呼ばない。`register`
 *  モードにも置かない(決定3 の非対称): 既にホスト上にある checkout の登録に probe を
 *  足すと、登録の門が全モードでネットワークを要求することになる。 */
async function assertRepoAccess(repo: string, github: GitHubClient | undefined): Promise<void> {
  const ref = parseGitHubRepo(repo);
  if (!github || !ref) return;
  const { guidance } = await repairRepoAccess(github, ref);
  if (guidance) throw new RepoAccessMissingError(guidance);
}

/** The registration gate refused a `register` path that is not a git
 *  repository (ADR 0066 決定7): `repo` is written as an **observation made at
 *  registration time** (ADR 0052 決定3), and an object that cannot be observed
 *  must not get a written declaration in its place. */
export class NotAGitRepositoryError extends Error {
  constructor(public readonly path: string) {
    super(`${path} is not a git repository`);
    this.name = "NotAGitRepositoryError";
  }
}

/** The register mode's half: the entry records the explicit host path, plus the
 *  checkout's own `origin` URL as its **remote-source-of-truth declaration**
 *  (ADR 0052 決定3 / issue #211). Reading it here is what makes the declaration a
 *  declaration at all — the clone/create modes get it for free because they were
 *  handed the URL, and the board must not be left inferring it from the clone at
 *  every use (the fallback ADR 0052 rejected by name).
 *
 *  No remote → no `repo`: a checkout that is nobody's clone is a legitimate,
 *  purely-local workspace, and writing `repo` anyway would manufacture exactly
 *  the declaration/reality mismatch that pickup quarantines.
 *
 *  **The path must be a git repository at all** (ADR 0066 決定7 — the previous
 *  justification for skipping this, "a checkout can be placed after the entry",
 *  is withdrawn). The check is just `git -C <path> rev-parse --git-dir`'s
 *  success, same shape as ADR 0040's overlap gate: the gate refuses, the floor
 *  stays at pickup. Without it, registering an unobservable path would write
 *  the "no repo" default not as an observation but as a guess — and a human
 *  placing a remote-backed clone there later would make declaration and
 *  reality disagree, the exact mismatch pickup quarantines. */
function registerExistingCheckout(path: string): WorkspaceEntry {
  try {
    git(path, "rev-parse", "--git-dir");
  } catch {
    throw new NotAGitRepositoryError(path);
  }
  const repo = originUrl(path);
  return repo === undefined ? { path } : { path, repo };
}

/** The clone mode's external half: a checkout at the convention-derived
 *  location (ADR 0018 — the entry never records the path). */
function cloneAndDescribe(name: string, repo: string, deps: WorkspaceGitHubDeps): WorkspaceEntry {
  const dir = conventionCheckoutPath(name, deps.workspacesBaseDir);
  // idempotent retry (issue #57): a checkout already at the convention-derived
  // location is a completed step — the orphan a previous attempt left when it
  // failed before the registry commit — not a conflict
  // a private repo's clone needs the machine-user token too (ADR 0024) —
  // same injection path as every other board-driven git network call
  if (!existsSync(dir)) authedGit(deps.githubAuth, deps.workspacesBaseDir, "clone", repo, dir);
  // a fresh clone's HEAD is the upstream default branch — recorded when it
  // isn't "main" so branch discipline and the PR base start out right
  // (issue #27); "main" stays implicit (protectedBranch's default)
  const defaultBranch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  return defaultBranch === "main" ? { repo } : { repo, branch: defaultBranch };
}

/** One workspace entry as the settings surface shows it (issue #57 phase 3):
 *  the entry's own fields plus which name it is and whether it is the board's
 *  own registry clone — the one whose protection the UI never offers to
 *  remove (updateWorkspace enforces the same floor server-side). */
export interface WorkspaceView extends WorkspaceEntry {
  name: string;
  registrySelf: boolean;
}

/** The list read with the base directory as an attribute of the list itself
 *  (ADR 0082 決定1): the client composes `<base>/<name>` for the preview and
 *  for a path-omitting entry's row. That is display, not a second resolution —
 *  the rule is one join and the name carries no separator. */
export interface WorkspaceListView {
  workspaces: WorkspaceView[];
  workspacesBaseDir: { path: string; source: WorkspacesBaseDirSource };
}

/** `source` rides in as an argument rather than on `WorkspaceAdminDeps`: it is
 *  the one thing only this verb needs, and the deps bundle is "what every
 *  workspace-admin verb needs". */
export function listWorkspaceViews(
  deps: WorkspaceAdminDeps,
  source: WorkspacesBaseDirSource,
): WorkspaceListView {
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  return {
    workspaces: Object.entries(registry.workspaces).map(([name, entry]) => ({
      ...entry,
      name,
      registrySelf: resolvesToRegistryClone(entry, name, deps.registry.dir, deps.workspacesBaseDir),
    })),
    workspacesBaseDir: { path: deps.workspacesBaseDir, source },
  };
}

/** Appends the entry to workspaces.yaml inside a disposable worktree and
 *  lands it under the board's own identity (ADR 0020 / ADR 0052 決定6). The
 *  yaml Document API keeps the hand-edited file's comments and formatting.
 *  Reads the file from the worktree, not the registry clone's own working
 *  tree — the clone's checkout is a cache the write never depends on, so the
 *  content this merges into is always the one the worktree actually forked
 *  from. A no-change edit (the same notes resubmitted) is a successful no-op
 *  — `commitToRegistry` skips landing when `write` leaves the tree clean. */
function commitWorkspaceEntry(
  deps: WorkspaceAdminDeps,
  name: string,
  entry: WorkspaceEntry,
  message: string,
): void {
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join(worktreeDir, "workspaces.yaml");
      const doc = parseDocument(readFileSync(file, "utf8"));
      doc.set(name, entry);
      writeFileSync(file, doc.toString());
    },
    message,
  );
}
