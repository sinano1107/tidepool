import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentAdmin } from "../src/agent-create.js";
import {
  bootstrapUrl as authBootstrapUrl,
  generateToken,
  type HumanCredential,
  hashToken,
} from "../src/auth.js";
import type { BoardStatePath } from "../src/board-state.js";
import type { CliAuthCheck } from "../src/cli-auth.js";
import type { ContainmentCapability } from "../src/containment.js";
import { type Db, openDb } from "../src/db.js";
import type { DraftClient } from "../src/draft.js";
import type { GitHubAuth } from "../src/github-auth.js";
import type { ProfileAdmin } from "../src/profile-create.js";
import type {
  AuthorityProfile,
  RegistryCandidates,
  RegistryReachabilityCheck,
  RegistrySource,
  RosterAgent,
} from "../src/registry.js";
import type { SandboxCapability } from "../src/sandbox.js";
import { startServer } from "../src/server.js";
import { BOARD_WORKER_ID, type RegisterTaskInput, registerTask, type Task } from "../src/tasks.js";
import type { TranslationClient } from "../src/translate.js";
import type { WatchdogConfig } from "../src/watchdog.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import type { WorkspaceAdmin } from "../src/workspace-create.js";
import { FakeClock, FakeGitHubClient, FakePushClient, ScriptedWorker } from "./fakes.js";

export { HOURLY as HOUR } from "../src/scheduler.js";

/** テスト盤面の credential(issue #153 / ADR 0036)。`bootTidepool` は必ず
 *  これを持つ盤面を起こし、`api()` が bearer で提示する — 既存テストの本文は
 *  認証の存在を知らないままでよい。無認証の振る舞いを主張したいテストだけが
 *  素の `fetch` を使う。
 *
 *  **リテラルではなくその場で生成する(issue #154)。** 盤面もハーネスも同じ
 *  プロセスの中にいるので、平文はこの変数として存在すれば足り、ディスクに置く
 *  理由が1つも無い — 置けば「テスト用だから」で始まった文字列が、実盤面に
 *  貼り付けられる既定値として一人歩きする余地が残る(ADR 0036 が盤面側で
 *  ハッシュしか持たないと決めたのと同じ理由を、道具側にも通す)。
 *  プロセスごとに違う値になるが、盤面を起こすのも提示するのもこのモジュールなので
 *  テストからは見えない。 */
export const TEST_TOKEN = generateToken();

/** `startServer` を直に呼ぶテスト(harness を通さないもの)が渡す credential。
 *  ハッシュの組み立てを各所で書き直さない。 */
export const TEST_CREDENTIAL = { tokenHash: () => hashToken(TEST_TOKEN) };

export interface Tidepool {
  baseUrl: string;
  /** `/mcp`'s own base URL (issue #37) — separate from `baseUrl` now that
   *  `/mcp` lives on its own port, off the one `tailscale serve` would
   *  publish. */
  mcpBaseUrl: string;
  clock: FakeClock;
  worker: ScriptedWorker;
  github: FakeGitHubClient;
  push: FakePushClient;
  dir: string;
  /** Shut down the process only, keeping the SQLite file — for restart tests. */
  stopServer: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BootOptions {
  /** Existing board dir to reboot on — for restart tests. */
  dir?: string;
  /** Override the scripted WorkerAdapter identity across board restarts. */
  workerId?: string;
  /** The board's workspace: a real git checkout the tree rule acts on. */
  workspace?: WorkspaceConfig;
  /** ADR 0093 決定5: `TIDEPOOL_GITHUB_TOKEN_FILE` のパス。settings の
   *  「GitHub にログイン済みか」だけがこれを読む。 */
  githubTokenFile?: string;
  /** ADR 0093: 盤面の GitHub 身元。pickup / 完了時の fetch が仲介から
   *  installation token を取る経路を持つ盤面だけが渡す。 */
  githubAuth?: GitHubAuth;
  /** ADR 0052 / issue #211: どの registry clone を読み書きするか + remote 正本の宣言。
   *  registry clone が workspace としても登録されているときの「2つの宣言」の
   *  突き合わせだけがこれを要る。Absent → registry を持たない盤面 = 突き合わせ無し。 */
  registry?: RegistrySource;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009). Absent → every task runs against the single `workspace`
   *  above. */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** Per-task-type absolute time limits (#9). */
  watchdog?: WatchdogConfig;
  /** This board's one worker's authority profile (issue #11). */
  authority?: AuthorityProfile;
  /** Resolves the executing task's own agent's authority profile (ADR 0012 /
   *  issue #36), read fresh every call from `task.assignee` (null → the
   *  board's default agent). Takes precedence over the static `authority`
   *  above when both are given. Absent → falls back to `authority`. */
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry — used both for registration-time
   *  validation and an agent quarantine Confirmation question's clearance
   *  check. Absent → no registry configured, so any name is accepted at
   *  registration and only "no more todo tasks depend on it" can clear a
   *  quarantine. */
  agentRegistered?: (name: string) => boolean;
  /** Assignee/workspace candidates for the registration screen (issue #12).
   *  A static snapshot (the common case) or a per-request provider — the
   *  latter lets a test prove the endpoint re-reads each call (issue #78). */
  registryCandidates?: RegistryCandidates | (() => RegistryCandidates | undefined);
  /** The LLM draft seam (issue #12). Absent (the default) — same as no LLM
   *  configured, matching the "LLM outage" fallback path. */
  draftClient?: DraftClient;
  /** The display-time translation seam (issue #47). Absent (the default) —
   *  same "unreachable" posture as no draftClient configured. */
  translationClient?: TranslationClient;
  /** The board's Auditor pointer (issue #15 layer 2). Absent → falls back to
   *  `DEFAULT_AUDITOR_NAME` inside `commitTriage` itself. */
  auditorName?: string;
  /** Whether an explicitly named workspace is protected (issue #15 layer 2 /
   *  ADR 0013). Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** The pull half of the roster (issue #43 / ADR 0014). Absent → `list_agents`
   *  reports only the fixed `human` line. */
  listAgents?: () => RosterAgent[];
  /** The settings surface's workspace verbs (issue #57) — endpoint tests
   *  fake the one verb they exercise (hence Partial); the orchestration
   *  itself has its own real-git coverage (tests/create-workspace.test.ts,
   *  tests/update-workspace.test.ts). */
  workspaceAdmin?: Partial<WorkspaceAdmin>;
  /** The settings surface's agent verbs (issue #71), workspaceAdmin's twin —
   *  endpoint tests fake the one verb they exercise; the orchestration
   *  itself has its own coverage (tests/create-agent.test.ts,
   *  tests/update-agent.test.ts). */
  agentAdmin?: Partial<AgentAdmin>;
  /** The settings surface's profile verbs (issue #77), agentAdmin's twin —
   *  endpoint tests fake the one verb they exercise; the orchestration itself
   *  has its own coverage (tests/create-profile.test.ts). */
  profileAdmin?: Partial<ProfileAdmin>;
  /** The skills picker's candidate source (issue #106 / ADR 0025 点4) — faked
   *  here so GET /api/skills is exercised without a real `claude` CLI (ADR
   *  0027). Absent → the route degrades to an empty candidate set. */
  hostSkills?: () => Promise<string[] | null>;
  /** Agent names whose registry model is fable (ADR 0030) — read fresh every poll
   *  by the scheduler's fable line and the queue view. Absent → no fable
   *  model resolution, so the fable line never skips anything. */
  fableAgents?: () => string[];
  /** ADR 0052: remote-backed registry reachability seam. */
  registryReachability?: RegistryReachabilityCheck;
  /** ADR 0070: Claude CLI authentication probe. */
  cliAuth?: CliAuthCheck;
  /** ADR 0075: optional token expiry used only for advance warning. */
  cliAuthExpiresAt?: Date;
  /** 封じ込め能力ゲートの fs 半分(ADR 0033 / issue #60)。**渡すとゲートごと
   *  arm される**ので、人間面の自己検査(ADR 0036 / issue #154)も一緒に効く。
   *  Absent → ゲートを持たない盤面(既定): テストの spawn は ScriptedWorker で、
   *  封じ込める実プロセスが無い。ゲートそのものを駆動するテストだけが渡す。 */
  sandboxCapability?: () => SandboxCapability;
  /** 封じ込め能力ゲートの3つ目の問い(ADR 0039 決定3 / issue #164): 観測された
   *  ツール面が Tool allowlist と一致するか。実物は `/usage` ping なので、ここでは
   *  seam ごと差し替える(ADR 0027)。**`sandboxCapability` と一緒に渡さないと
   *  ゲートそのものが arm されない**(封じ込めは1つの検査であって3つのゲートでは
   *  ない)。Absent → 3つ目の問いを持たない盤面: 実 CLI を持たないテストの既定形。 */
  toolSurface?: () => Promise<ContainmentCapability>;
  /** 盤面自身の状態パスと、boot 一斉検査の対象(ADR 0040 / issue #149)。
   *  Absent → 守る状態パスを持たない盤面(既定): テスト盤面は実プロセスの env を
   *  持たないので、重なりガードそのものを駆動するテストだけが渡す。 */
  boardState?: {
    paths: BoardStatePath[];
    listWorkspaces: () => WorkspaceConfig[];
  };
  /** 人間面の credential(issue #153 / ADR 0036)。Absent → 既定の
   *  `TEST_CREDENTIAL`。認証が成立しない盤面の振る舞い(fail-open と、それを
   *  検出する封じ込め能力ゲート — issue #154)を駆動するテストだけが渡す。 */
  credential?: HumanCredential;
}

/** The server wants a per-request candidates provider; a test may pass one
 *  directly (to prove re-reads) or a plain snapshot for convenience. */
function normalizeCandidates(
  candidates: BootOptions["registryCandidates"],
): (() => RegistryCandidates | undefined) | undefined {
  if (typeof candidates === "function") return candidates;
  if (candidates === undefined) return undefined;
  return () => candidates;
}

/** Boot the whole monolith in-process: temp SQLite, real HTTP on an ephemeral port.
 *  The worker and the GitHubClient are swapped for scripted fakes, at the
 *  WorkerAdapter and GitHubClient seams. */
export async function bootTidepool(options: BootOptions = {}): Promise<Tidepool> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "tidepool-test-")));
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock, options.workerId);
  const github = new FakeGitHubClient();
  const push = new FakePushClient();
  const server = await startServer({
    dbPath: join(dir, "board.sqlite"),
    port: 0,
    mcpPort: 0,
    clock,
    // issue #153: テスト盤面も本番と同じく必ず credential を持つ(「省略 =
    // 認証なし」の口は作らない)。既定で提示するのは TEST_TOKEN。
    credential: options.credential ?? TEST_CREDENTIAL,
    worker: () => worker,
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
    watchdog: options.watchdog,
    github,
    authority: options.authority,
    resolveAuthority: options.resolveAuthority,
    agentRegistered: options.agentRegistered,
    // the server takes a per-request provider now; a test may pass one
    // directly, otherwise wrap the static snapshot
    registryCandidates: normalizeCandidates(options.registryCandidates),
    draftClient: options.draftClient,
    translationClient: options.translationClient,
    push,
    auditorName: options.auditorName,
    isProtectedWorkspace: options.isProtectedWorkspace,
    listAgents: options.listAgents,
    workspaceAdmin: options.workspaceAdmin,
    agentAdmin: options.agentAdmin,
    profileAdmin: options.profileAdmin,
    hostSkills: options.hostSkills,
    fableAgents: options.fableAgents,
    registryReachability: options.registryReachability,
    cliAuth: options.cliAuth,
    cliAuthExpiresAt: options.cliAuthExpiresAt,
    registry: options.registry,
    githubAuth: options.githubAuth,
    githubTokenFile: options.githubTokenFile,
    boardState: options.boardState,
    containment: options.sandboxCapability && {
      sandboxCapability: options.sandboxCapability,
      // 明示の null = 3つ目の問いを持たないテスト盤面(server.ts の口が省略を許さない)
      toolSurface: options.toolSurface ?? null,
    },
  });
  let stopped = false;
  const stopServer = async () => {
    if (!stopped) await server.stop();
    stopped = true;
  };
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    mcpBaseUrl: `http://127.0.0.1:${server.mcpPort}`,
    clock,
    worker,
    github,
    push,
    dir,
    stopServer,
    stop: async () => {
      await stopServer();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Real MCP client over streamable HTTP, attributed to a task via ?task=. */
export async function mcpClient(baseUrl: string, taskId?: string): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  if (taskId !== undefined) url.searchParams.set("task", taskId);
  const client = new Client({ name: "tidepool-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

/** Real authenticated client for the human-facing Management MCP.  Keep this
 * distinct from `mcpClient`: the worker and human surfaces are separate trust
 * domains (ADR 0032 / ADR 0036). */
export async function managementMcpClient(baseUrl: string): Promise<Client> {
  const client = new Client({ name: "tidepool-management-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/admin-mcp`), {
      requestInit: { headers: AUTH_HEADERS },
    }),
  );
  return client;
}

/** 道具側の credential(issue #153): 盤面が受ける2つの形のうち bearer のほう。
 *  ブラウザ導線(cookie)は e2e が bootstrap URL を踏んで得る。 */
export const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` } as const;

/** テスト盤面の bootstrap URL — 実ブラウザ(e2e)がここを1回踏んで cookie を得る。 */
export function bootstrapUrl(baseUrl: string): string {
  return authBootstrapUrl(baseUrl, TEST_TOKEN);
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Marks an agent name needs-human directly in `agent_state`, bypassing
 *  `quarantineAgent`'s own question-registration side effect — for tests that
 *  want to drive just the pickup/queue gate SQL (ADR 0012 / issue #36), not
 *  the whole quarantine-registration flow (that flow has its own coverage in
 *  tests/quarantine-agent.test.ts and tests/quarantine-confirm-agent.test.ts). */
export function quarantineAgentRow(db: Db, name: string): void {
  db.prepare(
    `INSERT INTO agent_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(name);
}

/** A real git checkout for tree-rule/branch-discipline/quarantine tests —
 *  stderr captured, not inherited, same as workspace.ts's own `git`. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

/** 「ワーカーが成果を書き、本文を付けてコミットした」の fixture(ADR 0084)。完了を
 *  測るテストはこれを使う —— 書きっぱなしのツリーは完了の門に弾かれる。逆に WIP 退避を
 *  測るテストは素の `writeFileSync` のままでよい(escalate / decompose / review)。 */
export function commitWork(path: string, file: string, body: string): void {
  writeFileSync(join(path, file), body);
  // その1ファイルだけを stage する: `add -A` だと、テストがわざと untracked のまま
  // 残している sandbox shadow まで巻き込んで測りたい差を消す
  git(path, "add", "--", file);
  git(path, "commit", "-m", `add ${file}`);
}

/** 「ワーカーがこのタスクの成果を出した」の fixture。ADR 0084 の完了の門が入って以降、
 *  成果はコミット済みでなければ完了できない —— 書きっぱなしにすると完了が拒否され、
 *  着地も PR も測れない。 */
export function addTaskChange(path: string, taskId: string): void {
  commitWork(path, `${taskId}.txt`, "finished\n");
}

/** A fresh temp git checkout named `name`, one commit deep. The path is
 *  pushed onto the caller's own `dirs` array so its own `afterEach` cleans it
 *  up — this helper only creates, never tracks cleanup itself. */
export async function makeWorkspace(dirs: string[], name: string): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), `tidepool-${name}-`));
  dirs.push(path);
  git(path, "init", "-b", "main");
  await writeFile(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name, path };
}

/** `makeWorkspace` の remote 正本つきの姿(ADR 0052 / issue #211): bare な origin を
 *  持つ checkout と、そこへ**人間の merge を模して**書き込む publisher を組む。
 *  返す `WorkspaceConfig` の `repo` が「この workspace はリモートの正本を持つ」の
 *  宣言そのもので、値としては bare な origin のパス —— 盤面が読むのは有無だけである。
 *
 *  `makeWorkspace` に remote を足さないのは意図的で、remote を持たない workspace は
 *  正当な構成(既存の全テストがその形)だから。remote が要るテストだけがこれを使う。 */
export async function makeRemoteBackedWorkspace(
  dirs: string[],
  name: string,
): Promise<{
  workspace: WorkspaceConfig;
  /** origin の保護ブランチへ直接コミットして push する = リモートで merge が起きた
   *  状態を作る。clone 側の `refs/remotes/origin/main` は fetch するまで動かない ——
   *  そこが測りたい差である。 */
  publish: (file: string, body: string, message: string) => void;
}> {
  const workspace = await makeWorkspace(dirs, name);
  const origin = await mkdtemp(join(tmpdir(), `tidepool-${name}-origin-`));
  const publisher = await mkdtemp(join(tmpdir(), `tidepool-${name}-publisher-`));
  dirs.push(origin, publisher);
  // stderr は piped: clone / push の進捗は成否に関係なく stderr へ出るので、素通しすると
  // テスト出力が git のノイズで埋まる(registry-fixture.ts と同じ規律)
  const netGit = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  netGit(origin, "init", "--bare", "-b", "main");
  netGit(workspace.path, "remote", "add", "origin", origin);
  netGit(workspace.path, "push", "-u", "origin", "main");
  netGit(publisher, "clone", "--quiet", origin, ".");
  return {
    workspace: { ...workspace, repo: origin },
    publish: (file, body, message) => {
      writeFileSync(join(publisher, file), body);
      netGit(publisher, "add", file);
      netGit(publisher, "commit", "-m", message);
      netGit(publisher, "push", "origin", "main");
    },
  };
}

export async function registerWork(
  t: Tidepool,
  title: string,
  workspace?: string,
  reviewFlag?: boolean,
  assignee?: string,
): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    ...(workspace !== undefined && { workspace }),
    ...(reviewFlag !== undefined && { review_flag: reviewFlag }),
    ...(assignee !== undefined && { assignee }),
  });
  return res.json;
}

/** A child under `parentId` — which makes the parent `blocked` (unfinished
 *  child), so the parent sits at the raw head while never being pickable. */
export async function registerChild(t: Tidepool, title: string, parentId: string): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    parent_id: parentId,
    decompose_reason: `split ${title} from its parent`,
  });
  return res.json;
}

/** An unanswered question under `parentId`, which holds every sibling below it
 *  out of the slot — `todo` rows in the table that can never be picked. Returns
 *  the question so a test can answer it and watch the hold release. */
export function holdChildren(t: Tidepool, parentId: string): Task {
  return registerQuestion(t, {
    title: "unrelated decision",
    purpose: "a human wants steering input",
    completion_criteria: "answered",
    parent_id: parentId,
    question: [{ title: "unrelated decision", options: ["yes", "no"], recommendation: "yes" }],
  });
}

/** Fabricates a question task directly against the board's own DB file,
 *  mirroring how tidepool's internal callers (watchdog/quarantine/merge/
 *  decompose) register one. The human-facing `/api/tasks` door refuses
 *  `type: "question"` outright (issue #38), so tests that need a question
 *  fixture go through this seam instead — a second connection to the same
 *  SQLite file is safe under WAL (`openDb`'s own mode). */
export function registerQuestion(t: Tidepool, input: Omit<RegisterTaskInput, "type">): Task {
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    return registerTask(db, { ...input, type: "question" }, t.clock.now(), BOARD_WORKER_ID);
  } finally {
    db.close();
  }
}

/** 盤面の DB へ直に付帯子(親を持ち、based_on_decision を持たず、question でない子)を
 *  1つ足す — `bundleObjections` が異議修理を登録するのと同じ形。人間面の /api/tasks は
 *  parent_id つきの登録に decompose_reason を要求する(= 分解子になる)ので、付帯子の
 *  fixture はこの seam を通す(`registerQuestion` と同じ理由)。 */
export function attachChild(
  t: Tidepool,
  parentId: string,
  title: string,
  assignee?: string,
): Task {
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    return registerTask(
      db,
      {
        type: "work",
        title,
        purpose: `purpose of ${title}`,
        completion_criteria: `criteria of ${title}`,
        parent_id: parentId,
        ...(assignee !== undefined && { assignee }),
      },
      t.clock.now(),
    );
  } finally {
    db.close();
  }
}

/** 盤面が今立てている question の行すべて — 読み口(`GET /api/tasks`)から引く。 */
export async function questions(t: Tidepool): Promise<any[]> {
  return (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.type === "question",
  );
}

/** slot task を MCP の `complete_task` で完了させる。 */
export async function completeViaMcp(t: Tidepool, taskId: string, handoff = true): Promise<any> {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: handoff ? { handoff: FULL_HANDOFF } : {},
  });
  await client.close();
  return res;
}

/** The 6-field handoff doc, filled in with placeholder content — shared by
 *  every test that just needs *a* valid handoff to complete a work task. */
export const FULL_HANDOFF = {
  outcome: "done as specified",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};
