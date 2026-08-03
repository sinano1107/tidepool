import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type ResolvedAgent, resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import type { Clock } from "./clock.js";
import { type ContainmentCapability, quarantineContainment } from "./containment.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload, listEvents } from "./events.js";
import {
  type AgentDefinition,
  agentBodyAtCommit,
  isPluginGlob,
  loadRegistry,
  ownEntry,
  type Registry,
  type RosterAgent,
  SKILL_WILDCARD,
} from "./registry.js";
import { buildSandboxSettings, floorOverridingSettings } from "./sandbox.js";
import { AUTHORITY_WILDCARD, DEFAULT_AUDITOR_NAME, HUMAN_ROSTER_AGENT, type Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import {
  guardRegistryDefaultBranch,
  quarantineWorkspace,
  resolveExecutionWorkspace,
  resolveOrQuarantine,
  resolveWorkspacesBaseDir,
  type WorkspaceConfig,
} from "./workspace.js";

/** The process boundary the adapter is tested at: everything vendor-specific
 *  (the claude CLI, its flags) flows through this one call. */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => {
  stdout: NodeJS.ReadableStream;
  /** issue #125: the CLI's own failure channel (spawn-time errors, auth
   *  errors, forced terminations print here, not to stream-json) — captured so
   *  a failure always leaves evidence, alongside the stdout transcript. */
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): void;
  /** issue #32: the adapter's own exit observation point (promoted out of
   *  defaultSpawn's former console.error-only handler) — usage/cost recording
   *  needs to happen here, at the process boundary, not buried in a fake. */
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** issue #127: the adapter's own spawn-failure observation point (promoted
   *  out of defaultSpawn's former console.error-only handler, same move as
   *  "exit" above / issue #32) — a spawn() that never produces a process
   *  (ENOENT/EACCES/PATH misconfig) fires this instead of "exit", and
   *  recording that as spawn_failed needs to happen at the process boundary,
   *  not buried in a fake. Node's ChildProcess satisfies this structurally,
   *  so defaultSpawn needs no implementation change to provide it. */
  on(event: "error", listener: (err: Error) => void): void;
};

// the CLI defines this as a closed 5-value set; unlike --model (an open,
// ever-growing set of aliases/full names) it's safe and worth validating
// here — the adapter is where vendor-specific knowledge belongs (ADR 0005)
const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Shared by boot-time default validation and every per-task spawn — one
 *  check, not a copy at each call site. */
function assertKnownEffort(definition: AgentDefinition): void {
  if (definition.effort !== undefined && !EFFORT_LEVELS.includes(definition.effort)) {
    throw new Error(`unknown effort level: ${definition.effort}`);
  }
}

// injected into every spawned session's system prompt (issue #31 / ADR
// 0010), regardless of agent or profile — a board-wide doctrine copied into
// each authority profile would drift, and "Agent tool"/"Workflow tool" are
// vendor vocabulary the adapter translates the board's line into (ADR 0005)
const BOARD_DOCTRINE = `## Board doctrine

Work that needs independent completion criteria, separate authority, its own
risk, or survival across sessions must not be routed to the Agent tool —
that is delegation smuggled past the board. Register that split with the
tidepool MCP's decompose instead.

The Agent tool may only be used for labor-splitting that does not divide
accountability (exploration, parallel research, mechanical edits): you carry
full accountability for its output as the parent task. If another registry
agent's capability is needed, use decompose with an assignee, not the Agent
tool.

The Workflow tool is off-limits in task sessions: a workflow script is a
decompose plan that never reached the board. If you find yourself wanting to
write one, register that split with the tidepool MCP's decompose instead.`;

// ADR 0017: the worker protocol (rules of the road for a board worker) is a
// board-wide doctrine, so it lives here and is injected into every session —
// not copied into each agent definition, where it would drift the same way
// BOARD_DOCTRINE would. Only the cross-cutting posture lives here: the MCP
// tool descriptions already carry each verb's semantics, and "call
// get_current_task first" already rides the `-p` prompt below — re-listing
// either here would just relocate the drift ADR 0017 removes. The canonical
// default agent is therefore an empty-body definition (tako) — it carries no
// specialty prose, and this section supplies the protocol every worker shares.
const WORKER_PROTOCOL = `## Rules of the road

Do the work in the current working directory. It is the task's workspace.

The tidepool MCP verbs are your only channel back to the board. Invent no side
channels: no direct edits to the board, no unrecorded decisions. If it is not
in an MCP verb, it did not happen.

Escalating is never wrong; guessing outside your authority is. When a decision
is outside your authority or you hit a dead end, escalate rather than guess.`;

/** One roster line's text (issue #43 / ADR 0014): "name — description",
 *  shared by every entry — a registry agent's `AgentDefinition` or the
 *  fixed `HUMAN_ROSTER_AGENT` alike, since both are `RosterAgent`s. */
function rosterLine(agent: RosterAgent): string {
  return `${agent.name} — ${agent.description}`;
}

/** Builds the push half of the roster (issue #43 / ADR 0014): the spawned
 *  agent's own `assignable_to` resolved against the registry into
 *  "name — description" lines, one per direct delegate. Cost is
 *  proportional to the allowlist, not the registry — `*` expands to every
 *  registry agent (an author's deliberate cost/permission tradeoff), and
 *  `human` (never a registry agent) draws `HUMAN_ROSTER_AGENT` only when
 *  explicitly listed. Absent/empty `assignable_to` → undefined (nothing to
 *  push). Names drifted out of the registry are silently skipped, same
 *  fail-closed spirit as the rest of this file's registry-drift handling. */
function buildRoster(registry: Registry, assignableTo: string[] | undefined): string | undefined {
  if (assignableTo === undefined || assignableTo.length === 0) return undefined;
  const wildcard = assignableTo.includes(AUTHORITY_WILDCARD);
  const explicitNames = assignableTo.filter((name) => name !== AUTHORITY_WILDCARD);
  const agentNames = wildcard ? Object.keys(registry.agents) : explicitNames;
  const agents: RosterAgent[] = agentNames
    .map((name) => ownEntry(registry.agents, name))
    .filter((agent): agent is AgentDefinition => agent !== undefined);
  if (explicitNames.includes(HUMAN_ROSTER_AGENT.name)) agents.push(HUMAN_ROSTER_AGENT);
  return agents.length > 0 ? agents.map(rosterLine).join("\n") : undefined;
}

/** Wraps a built roster (or nothing) as the trailing `## Roster` section of
 *  the system prompt — its own heading (CONTEXT.md's Roster term) rather
 *  than folded into `## Authority`, since it names delegates, not authority. */
function rosterSection(roster: string | undefined): string {
  return roster === undefined ? "" : `\n\n## Roster\n\n${roster}`;
}

/** Does one allowlist entry permit one enumerated skill? (issue #56 / ADR
 *  0025) The five-form vocabulary, resolved against the CLI's enumerated set:
 *  `"*"` permits everything; `@workspace` permits a skill the checkout carries;
 *  `@host` permits a skill the checkout does not (the user/plugin remainder);
 *  a `名前:*` glob permits that plugin's skills; an individual name permits its
 *  exact match. `workspaceSkills` is the checkout's own set — the seam the
 *  `@workspace`/`@host` split is a difference against. */
function skillPermitted(entry: string, skill: string, workspaceSkills: Set<string>): boolean {
  if (entry === SKILL_WILDCARD) return true;
  if (entry === "@workspace") return workspaceSkills.has(skill);
  if (entry === "@host") return !workspaceSkills.has(skill);
  // entries are already grammar-validated (registry.ts), so a glob is a
  // well-formed "名前:*" — strip the trailing "*" and prefix-match ("plug:*" →
  // "plug:"). isPluginGlob is the one shared definition of that shape.
  if (isPluginGlob(entry)) return skill.startsWith(entry.slice(0, -1));
  return entry === skill;
}

/** The complement deny (issue #56 / ADR 0025 point 3): the only enforcement
 *  primitive is per-skill deny, so an agent's allowlist is enforced as
 *  "everything the CLI enumerated minus everything the allowlist permits".
 *  Pure set algebra over the three inputs — the vendor ping that produces
 *  `enumeratedSkills` and the `--disallowedTools` plumbing that consumes the
 *  result live in `start()`. An allowlist entry that matches nothing in
 *  `enumeratedSkills` (a typo, a workspace-absent name) is naturally inert:
 *  only enumerated skills are ever iterated, so an unmatched entry neither
 *  denies nor permits anything (ADR 0023's "reference, not a claim of stock").
 *  Order follows `enumeratedSkills` for a stable, auditable deny list. */
export function computeSkillDenials(
  allowlist: string[],
  enumeratedSkills: string[],
  workspaceSkills: string[],
): string[] {
  const workspaceSet = new Set(workspaceSkills);
  return enumeratedSkills.filter(
    (skill) => !allowlist.some((entry) => skillPermitted(entry, skill, workspaceSet)),
  );
}

// review の書き込み系 Bash パターン。**この配列の役割は ADR 0035(issue #144)
// で変わった。**
//
// 当初(ADR 0013 追記 / issue #59)これは書き込み床そのもののつもりだった。
// それは失敗している — `--disallowedTools` は `Bash(<prefix>*)` の前置一致で、
// リダイレクト(`>`)はコマンドではないので原理的にパターンが書けず、
// インタプリタとラッパは無限にある。床は permission 層(review spawn の
// `--permission-mode manual`)へ移った。
//
// 今この配列が担うのは2つ:
//
//  1. **明確な拒否**。`git commit` や `rm` は、承認要求という形の暗黙の拒否では
//     なく名指しで断る — エージェントに早い段階で境界を伝える UX。
//  2. **`review_allowed_commands` の天井**。deny は allow に常勝する(ADR 0033
//     実験2、manual 下でも実測)ので、registry がここに挙がるコマンドを開くこと
//     はできない。ただし天井が覆うのは**ここに挙がっているものだけ**である。
//     インタプリタもラッパも挙がっていないので、registry に `sh -c` と書けば
//     文法検証を通り `Bash(sh -c*)` として実際に開く。これは穴ではなく設計上の
//     線引き — 列挙で塞ぐ試みは上のとおり失敗したので、`review_allowed_commands`
//     の門は機械ではなく保護 workspace の人間 merge である(ADR 0035)。
//
// 読み取りコマンド(cat/ls/grep 等)は対象外。パターン形式(`Bash(<prefix>*)`)
// はインストール済み CLI の --help(2.1.214)の例("Bash(git *) Edit")で確認済み。
// この配列を編集したら
// tests/review-tool-denials.test.ts の arrayContaining リストも手で合わせる
// こと — テスト側はこの配列を import せず独立した literal で書いている
// (tdd スキルの「期待値は独立した情報源から」の線: import して比較すると
// コードが計算する通りに期待値も計算するトートロジーになる)。
const REVIEW_BASH_WRITE_DENIALS = [
  "Bash(git commit*)",
  "Bash(git push*)",
  "Bash(git add*)",
  "Bash(git merge*)",
  "Bash(git rebase*)",
  "Bash(git reset*)",
  "Bash(rm*)",
  "Bash(mv*)",
  "Bash(cp*)",
  "Bash(mkdir*)",
  "Bash(touch*)",
  "Bash(sed -i*)",
  "Bash(tee*)",
  "Bash(chmod*)",
  "Bash(chown*)",
];

/** review タスクの harness deny(ADR 0013 追記 / issue #59): read-only は
 *  review という task type の性質であって実行エージェントの性質ではない
 *  (CONTEXT.md の Review、ADR 0013)——ので、この関数は `task.type` だけを見る。
 *  従来の reviewer profile(mcp.ts の REVIEWER_AUTHORITY_PROFILE)は MCP verb
 *  層(decompose/list_agents の assignable_to・allowed_workspaces)の強制で、
 *  ここはその追記が狙う CLI ツール層の強制 — 両方とも「task type が profile を
 *  上書きする」という ADR 0013 の同じ原則の別レイヤーでの実装。issue #56 の
 *  computeSkillDenials と同じ「組み立ては純関数、配線は launch() 側」という
 *  分離だが、CLI 側の列挙が要らない(Edit/Write/NotebookEdit とパターンは
 *  task.type だけで決まる固定集合)ぶん同期・ping 不要。*/
export function reviewToolDenials(taskType: Task["type"]): string[] {
  if (taskType !== "review") return [];
  return ["Edit", "Write", "NotebookEdit", ...REVIEW_BASH_WRITE_DENIALS];
}

// ツール許可リスト(CONTEXT.md の Tool allowlist / ADR 0039)。**盤面のコード
// 定数**であって registry データではない — 床はデータの状態に依存しない
// (ADR 0013、`REVIEW_BASH_WRITE_DENIALS` / `src/sandbox.ts` と同じ位置づけ)。
// agent には依らず、task type にのみ依る。
//
// ADR 0038 の「床 = 残余の既定」は、ファイル操作でない in-process ツールには
// **届いていない**。`acceptEdits` + 本番フラグ一式の下で `CronCreate` が承認要求
// なしに実行された(ADR 0039 測定2)— この族は permission の subject ですらなく、
// モードの残余に落ちる対象に入っていない。塞ぎ方は列挙 deny ではなく `--tools`
// による**既定拒否**である: 列挙 deny には執行力はあるが(測定3)閉世界の仮定で、
// ベンダーが増やしたツールは**開いたまま**入ってくる。
//
// 挙げた理由のうち自明でないもの: `Task` は BOARD_DOCTRINE が意図的に開いている
// 既決事項(ADR 0010 追記)。**綴りは `Task` であって `Agent` ではない** — この面の
// 名前は `Task` で(init の `tools` もそう返す)、モデル側に現れる名前が `Agent`
// である(実測: セッション自身は「I have Agent」と列挙しつつ、サブエージェントの
// spawn は成功する)。`Agent` と書き換えると黙って不活性になる(測定8)。
// `TaskOutput` / `TaskStop` は todo リストの仲間ではなく `Bash` の
// `run_in_background` の受け口。`Glob` / `Grep` は
// 2.1.220 の既定の面に出ていないが名指しすれば現れる(測定7)ので、work
// セッションに本物の検索ツールを与えられるのはこのリストを書くからである。
//
// 落とした側は ADR 0039 決定1 に全量の理由がある(`RemoteTrigger` は人間の
// アカウント名義の OAuth token をプロセス内で自動付与し、`PushNotification` は
// Quiet hours と Digest を素通りする、等)。
//
// この配列を編集したら**テスト側の literal も手で合わせること**。テストはこの配列を
// import せず独立した literal で書いている(`REVIEW_BASH_WRITE_DENIALS` と同じ線 —
// import して比べるとコードが計算する通りに期待値も計算するトートロジーになる)ので、
// 置いてある場所は1つではない: tests/spawn-tools.test.ts(正)、
// tests/claude-worker.test.ts(spawn 引数と init 行、ファイル冒頭の2定数)、
// tests/tool-surface-drift.test.ts / tests/tool-surface-containment.test.ts
// (それぞれ WORK_SURFACE)。
//
// テストが保証できないのは**綴りの正しさ**である — 実在しない名前は警告なく不活性に
// なる(測定8)。それを捕まえるのは封じ込め能力の3つ目の問い(`checkToolSurface`)。
const WORKER_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Skill",
  "Task",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
];

/** review の面から消える編集系。**書き込み床の移設ではない**(ADR 0039 決定2):
 *  床は ADR 0035 が置いた permission 層(`--permission-mode manual` +
 *  `autoAllowBashIfSandboxed: false`)にそのまま残り、`reviewToolDenials` の
 *  `Edit` / `Write` / `NotebookEdit` も残る。2層にする理由は冗長性ではなく性質の
 *  違いで、deny 層は**黙って**効かなくなりうる(ADR 0037 追記の実測)のに対し、
 *  `--tools` による除去は init イベントの `tools` 配列を読めば**観測できる**。 */
const REVIEW_REMOVED_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit"];

/** spawn の `--tools`(ADR 0039 決定1): そのセッションの面に現れる組み込み
 *  ツールの全量。`spawnAllowedTools` / `reviewToolDenials` と同じ「組み立ては
 *  純関数、配線は `launch()`」の分離。
 *
 *  review 以外はすべて work と同じ面である — read-only は review という task
 *  type の性質であって実行エージェントの性質ではない(ADR 0013)。 */
export function spawnTools(taskType: Task["type"]): string[] {
  // どちらの分岐も**新しい配列**を返す — 床の定数そのものを呼び出し側に渡すと、
  // 呼び出し側の `sort()` や `push()` が床を書き換えられてしまう(`reviewToolDenials`
  // が毎回組み立て直しているのと同じ理由)。
  if (taskType !== "review") return [...WORKER_TOOLS];
  return WORKER_TOOLS.filter((tool) => !REVIEW_REMOVED_TOOLS.includes(tool));
}

/** 比較対象から外す接頭辞。MCP verb は `--tools` を生き残る別軸なので(ADR 0039
 *  測定5)、面の照合はこれで始まるエントリを見ない — MCP サーバーが繋がらなかった
 *  セッションでは verb が丸ごと消えるため、含めると「盤面の MCP が落ちている」が
 *  封じ込め能力の不成立に化ける。それは別の障害であり別の扱いを受けるべきである。 */
const MCP_TOOL_PREFIX = "mcp__";

/** 封じ込め能力の3つ目の問い(ADR 0039 決定3 / CONTEXT.md の Containment
 *  capability): **観測されたツール面が盤面の宣言どおりか**。ツール面のドリフトは
 *  workspace の性質でも agent の性質でもなく**ホストの性質**である — このホストの
 *  CLI が盤面の宣言を honor しなくなった、という事実 — なので、既存2つ(fs
 *  サンドボックス / 人間面の自己検査)と同格に束ねられ、不成立なら盤面全体の
 *  pickup が止まる。
 *
 *  照合は**集合の一致**である。どちらの向きもずれであり、しかも意味が違う:
 *
 *  - **観測 ⊃ 期待** — 盤面の宣言が honor されなくなった / 新ツールが素通りしてきた。
 *    `--tools` の外にあるのは `RemoteTrigger`(人間のアカウント名義の OAuth token を
 *    プロセス内で自動付与)のような族である
 *  - **観測 ⊂ 期待** — 挙げた名前が改名・廃止されて**警告なく不活性化**した
 *    (測定8)。worker は能力を1つ失ったまま走り続けるので、放っておくとタスクが
 *    詰まって初めて分かる
 *
 *  純関数であり、**封じ込め能力の probe(`probeToolSurfaceCapability`)と worker 自身の
 *  init 行の照合が同じこれを共有する** — 期待集合を2箇所に置かない(ADR 0039
 *  決定3)。答えの型も封じ込め能力の他の半分と同じ1つ(`ContainmentCapability`)。 */
export function checkToolSurface(
  observed: string[],
  taskType: Task["type"],
): ContainmentCapability {
  const expected = spawnTools(taskType);
  const builtIn = observed.filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX));
  const unexpected = builtIn.filter((tool) => !expected.includes(tool));
  const missing = expected.filter((tool) => !builtIn.includes(tool));
  if (unexpected.length === 0 && missing.length === 0) return { available: true };
  // 観測された**具体名**を両方向とも本文に置く。封じ込めの question は「直して
  // から答える」ものなので、どの名前が余ってどの名前が消えたのかが読めなければ
  // 修理できない(人間面の半分が観測した status code を本文に置くのと同じ線)。
  const observations = [
    unexpected.length > 0
      ? `it offered ${unexpected.join(", ")} on top of the allowlist`
      : undefined,
    missing.length > 0
      ? `the allowlist named ${missing.join(", ")} but the session never got them`
      : undefined,
  ].filter((part) => part !== undefined);
  return {
    available: false,
    reason:
      `this host's claude CLI no longer gives a ${taskType} session the tool surface the board ` +
      `declared (ADR 0039): ${observations.join("; ")}. A tool the board never named is a side ` +
      "channel the WORKER_PROTOCOL closes in prose only, and a name that no longer exists goes " +
      "inert with no warning — so either direction means the board's declaration and the CLI " +
      "have parted ways. Check the CLI version against the Tool allowlist (CONTEXT.md), then " +
      "fix the list or pin the CLI",
  };
}

/** The MCP server key a worker's mcp-config carries, and therefore the stem of
 *  every `mcp__<server>__<verb>` permission subject. One constant so the server
 *  the board writes and the permission token it allows can never drift apart —
 *  a typo would leave a review session unable to touch the board at all
 *  (ADR 0035). */
const MCP_SERVER_NAME = "tidepool";

/** spawn の `--allowedTools`(ADR 0035 / 0038)。どちらのプロファイルも残余が
 *  承認要求に倒れるモードで走る(review は `manual`、work は `acceptEdits`)——
 *  headless では誰も承認できないのでそれが床になる、というのが ADR 0038 の
 *  骨格である。よって「床の外に出す」ものだけをここが明示的に開ける。
 *
 *  1. **MCP verbs — task type に依らず両プロファイル**。盤面への唯一の channel
 *     で、開けないとセッションは仕事にならない(review について ADR 0035 事実2
 *     が実測し、work が `auto` を離れたことで同じことが work にも起きる)。
 *     サーバ単位で開ける — verb の権限は盤面側(authority profile / MCP router)
 *     が縛るので、CLI 側で開けても権限モデルは緩まない。
 *  2. **workspace の `review_allowed_commands` — review 専用**。`npm test` の
 *     ような正当な副作用コマンドの巻き添えを、ホスト非依存のコマンド接頭辞と
 *     して registry が宣言し、ここが `Bash(<prefix>*)` へ機械変換する。work は
 *     元から書けるのでこれを必要とせず、開ければ registry のデータが work の
 *     Bash 面を広げる経路になる。permission を広げる設定なので門は registry の
 *     人間 merge(agent の skill allowlist と同じ線)。
 *
 *  review 部分は `reviewToolDenials` と同じく `task.type` だけを見る — read-only
 *  は review という task type の性質であって実行エージェントの性質ではない
 *  (ADR 0013)。deny は allow に常勝する(ADR 0033 実験2、manual 下でも実測で
 *  確認)ので、registry が `git commit` や `rm` を開くことはできない —— ただし
 *  天井が覆うのは `REVIEW_BASH_WRITE_DENIALS` が名指しした分だけである(そこの
 *  コメント参照)。雑な allow に対する一般の防壁は機械ではなく registry の人間
 *  merge。 */
export function spawnAllowedTools(
  taskType: Task["type"],
  reviewAllowedCommands: string[],
): string[] {
  // 1つ目は task type に依らない — 綴られるのは一度だけで、それが「MCP は両
  // プロファイルに乗る」という決定そのものである。
  const allowed = [`mcp__${MCP_SERVER_NAME}`];
  if (taskType !== "review") return allowed;
  return [...allowed, ...reviewAllowedCommands.map((prefix) => `Bash(${prefix}*)`)];
}

// always explicit: the CLI remembers the host's last model/effort choice,
// and a flip in some unrelated directory must not leak into runs (ADR
// 0005) — shared by every `claude` CLI spawn site so the pinning rule has
// one shape, not one copy per call site
export function pinnedModelFlags(model: string, effort: string): string[] {
  return ["--model", model, "--effort", effort];
}

/** The agent's own git identity, injected into the worker child's env so the
 *  commits a task session makes carry the agent's name, not the host's git
 *  config (issue #53). Mechanical, not entrusted to the agent's good will — the
 *  four GIT_* vars pin both author and committer. The email's `.invalid` TLD
 *  (RFC 2606) can never resolve to a real deliverable address, so an agent
 *  name never masquerades as a person's inbox. ADR 0024 invariant: only
 *  identity vars ride the worker env — never a GitHub token (the board injects
 *  those per-call in github-auth.ts, never into the inherited env). */
export function agentGitIdentityEnv(agentName: string): Record<string, string> {
  const email = `${agentName}@tidepool.invalid`;
  return {
    GIT_AUTHOR_NAME: agentName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: agentName,
    GIT_COMMITTER_EMAIL: email,
  };
}

type WorkerExitedUsage = Extract<EventPayload, { kind: "worker_exited" }>["usage"];

// issue #125: worker_exited が運ぶ stderr 末尾の行数。全量は <taskId>.stderr.log
// に残るので、イベント側は失敗形の判別に足る末尾だけを持つ。
const STDERR_TAIL_LINES = 20;

/** Per-chunk trim for the in-memory stderr tail (issue #125): keeps the last
 *  STDERR_TAIL_LINES lines plus the final `split("\n")` element (the empty
 *  string a trailing "\n" produces, or an unterminated partial line) — so
 *  concatenating the next chunk can never glue two real lines together. This
 *  bounds the buffer regardless of how chatty a session's stderr is; the
 *  verbatim full text is on disk, not here. */
function trimStderrTail(text: string): string {
  return text
    .split("\n")
    .slice(-(STDERR_TAIL_LINES + 1))
    .join("\n");
}

/** The worker_exited summary (issue #125): the last STDERR_TAIL_LINES lines
 *  of the captured stderr, or null when the session wrote nothing (or only a
 *  bare newline) — 実内容の無い stderr を空文字で残すと「捕捉が欠落した」形と
 *  紛れるので、null 側に倒す。A trailing "\n" terminates the last line rather
 *  than opening an empty one. */
function stderrTail(text: string): string | null {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-STDERR_TAIL_LINES).join("\n");
  return tail === "" ? null : tail;
}

/** The stream-json CLI's own final `result` event shape (vendor-specific,
 *  hence kept private to this adapter — ADR 0005) — only the fields
 *  worker_exited needs. */
interface StreamResultEvent {
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/** Fail-closed like the rest of this file's vendor-shape handling
 *  (`checkUsage`'s try/catch, the quarantine-on-drift paths in `start()`): a
 *  `result` line whose `usage`/`total_cost_usd` don't match the expected
 *  shape is treated as no result at all, never cast through blind and left
 *  to throw later inside a stdout "data" handler. */
function isStreamResultEvent(value: unknown): value is StreamResultEvent {
  if (typeof value !== "object" || value === null) return false;
  const { total_cost_usd, usage } = value as Record<string, unknown>;
  if (typeof total_cost_usd !== "number") return false;
  if (typeof usage !== "object" || usage === null) return false;
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    usage as Record<string, unknown>;
  return (
    typeof input_tokens === "number" &&
    typeof output_tokens === "number" &&
    typeof cache_read_input_tokens === "number" &&
    typeof cache_creation_input_tokens === "number"
  );
}

function parseResultLine(line: string): StreamResultEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    if (parsed.type !== "result") return null;
    return isStreamResultEvent(parsed) ? parsed : null;
  } catch {
    // a line split mid-chunk or genuinely malformed output — the last
    // *complete* result line already seen wins, so this just isn't one
    return null;
  }
}

/** Translates the CLI's vendor-shaped result event into the board's own
 *  worker_exited usage vocabulary (ADR 0005 / issue #32): total_cost_usd
 *  becomes estimated_cost_usd, no CLI field names leak past this point. */
function toUsage(result: StreamResultEvent): WorkerExitedUsage {
  return {
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_tokens: result.usage.cache_read_input_tokens,
    cache_creation_tokens: result.usage.cache_creation_input_tokens,
    estimated_cost_usd: result.total_cost_usd,
  };
}

export interface ClaudeWorkerOptions {
  db: Db;
  clock: Clock;
  /** Local clone of the agent registry repository. */
  registryDir: string;
  /** Agent name in the registry (`agents/<name>.md`). */
  agent: string;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), same shape
   *  as `agent` above — the fallback a `review` task's unset `assignee`
   *  resolves to at spawn (issue #42), instead of `agent`. Absent →
   *  `DEFAULT_AUDITOR_NAME` (the pointer always resolves — CONTEXT.md's
   *  Auditor). */
  auditorName?: string;
  /** Workspace name in the registry's workspaces.yaml — where tasks run. */
  workspace: string;
  /** ADR 0018: base directory a workspace entry's path derives from when the
   *  entry omits `path`. Absent → `resolveWorkspacesBaseDir`'s own fallback
   *  (`~/tidepool-workspaces`). */
  workspacesDir?: string;
  /** The board's MCP endpoint, e.g. http://127.0.0.1:4589/mcp. */
  mcpUrl: string;
  /** Where stream-json transcripts and spawn-time MCP configs land. */
  logDir: string;
  spawn?: SpawnFn;
  /** issue #81 / ADR 0028: the PTY boundary checkUsage scrapes /usage at.
   *  Injected so the scrape orchestration runs without a real PTY in tests. */
  pty?: PtyFn;
  /** issue #56 / ADR 0025: the skill-enumeration boundary the complement-deny
   *  ping runs at. Injected so the deny plumbing is tested without a real CLI. */
  enumerateSkills?: EnumerateSkillsFn;
}

/** Request/response process boundary for one-shot CLI calls (unlike the
 *  streaming SpawnFn above) — the claude-draft-client's JIT draft poll runs
 *  through it (ADR 0008). checkUsage moved off this to the PTY boundary below
 *  (issue #81 / ADR 0028), since `/usage` only renders under a TTY. */
export type ExecFn = (command: string, args: string[]) => Promise<string>;

/** The skill-enumeration boundary (issue #56 / ADR 0025 point 4): resolve the
 *  full skill set the CLI would give the session at `cwd`, or null if the probe
 *  failed. Injected so the deny-list computation runs without a real CLI in
 *  tests (same fake-injection posture as SpawnFn/PtyFn, ADR 0027). */
export type EnumerateSkillsFn = (cwd: string) => Promise<string[] | null>;

// ADR 0025 point 4: let the CLI itself report the resolved skill set instead
// of re-deriving project/user/plugin discovery on tidepool's side (which would
// drift). A `/usage` ping's init event carries `skills` = the full resolved set
// (workspace + user + plugin-prefixed), and `/usage` is local processing — cost
// 0, num_turns 0, ~2s natural exit (verified, CLI 2.1.210). Guardrails mirror
// checkUsage's old cost ceiling; --safe-mode is deliberately absent (it would
// hide the very skills being enumerated — leakage is the observation target
// here, not a threat).
const SKILL_ENUM_ARGS = [
  "-p",
  "/usage",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--max-budget-usd",
  "0.01",
];

/** The `type: "system", subtype: "init"` line's string-array fields — the CLI's
 *  own report of what it resolved for the session. `skills` is ADR 0025's
 *  enumeration; `tools` is the surface ADR 0039 compares against the board's
 *  Tool allowlist. Fail-closed like parseResultLine: a non-init line, a
 *  split/malformed line, or a field that isn't an array of strings all read as
 *  "not the init report" rather than as an empty answer. */
function parseInitField(line: string, field: "skills" | "tools"): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: unknown;
      subtype?: unknown;
      [key: string]: unknown;
    };
    if (parsed.type !== "system" || parsed.subtype !== "init") return null;
    const value = parsed[field];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
    return value as string[];
  } catch {
    return null;
  }
}

const parseInitTools = (line: string): string[] | null => parseInitField(line, "tools");

// The /usage ping exits naturally in ~2s (ADR 0025); this is the fail-closed
// backstop for a CLI that hangs (auth stall, missing exit) so a wedged probe
// can neither block the spawn forever nor leave an orphan — same "no orphan"
// posture as checkUsage (ADR 0028), reached by SIGKILL on timeout.
const SKILL_ENUM_TIMEOUT_MS = 15_000;

/** One `/usage` init-report ping: run the CLI at `cwd` and return the init
 *  event's `field` array, or null if the ping never produced one. Two callers
 *  now — ADR 0025's skill enumeration and ADR 0039's tool-surface probe — which
 *  is the whole reason the ADR could say "tools も見るだけの小改造で済む": this is
 *  already the mechanism that takes an init event and hands it back. */
function runInitPing(
  cwd: string,
  extraArgs: string[],
  field: "skills" | "tools",
  timeoutMs: number = SKILL_ENUM_TIMEOUT_MS,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn("claude", [...SKILL_ENUM_ARGS, ...extraArgs], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let buffered = "";
    let observed: string[] | null = null;
    let settled = false;
    const finish = (result: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) observed = parseInitField(line, field) ?? observed;
    });
    // an unlistened "error" (missing binary) would crash the board process
    child.on("error", () => finish(null));
    child.on("exit", () => {
      observed = parseInitField(buffered, field) ?? observed;
      finish(observed);
    });
  });
}

const defaultEnumerateSkills: EnumerateSkillsFn = (cwd) => runInitPing(cwd, [], "skills");

/** A ping at a *neutral* cwd: a fresh empty directory, so nothing a checkout
 *  carries takes part in what the CLI resolves. Cleaned up only AFTER the probe
 *  resolves — the CLI is still running against this cwd until then, so removing
 *  it mid-probe would be a race. */
function atNeutralCwd(
  prefix: string,
  probe: (cwd: string) => Promise<string[] | null>,
): Promise<string[] | null> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return probe(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort: a leftover empty temp dir is harmless
    }
  });
}

/** The tool-surface probe's boundary (ADR 0039 決定3): what built-in tools a
 *  session on this host actually gets when the board declares its allowlist, or
 *  null if the ping failed. Injected so the capability answer is tested without a
 *  real CLI (same posture as EnumerateSkillsFn). */
export type EnumerateToolsFn = () => Promise<string[] | null>;

// 3つ目の問いの正本の ping(ADR 0039 決定3)。**work のリストで撃つ — review 用に
// 2本目は撃たない。** review は work の真部分集合なので、改名で不活性化した名前
// (測定8)はどちらのリストでも同じように欠ける。review 固有の失敗形は「編集系の
// **除去**が honor されなくなった」だけで、それは実 review セッションの init 行を
// task type ごとに照合する深層防御側(`checkSessionToolSurface`)が観測する。
//
// **この ping が運ぶのは本番フラグ一式のうち面を決める分だけである。** `--tools` は
// 測る対象そのもの、`--permission-mode` と `--setting-sources project` は本番と同じ値。
// 運ばないのは `--settings`(サンドボックスプロファイル)と `--mcp-config` — どちらも
// **タスク単位の生成物**(workspace のパス・タスク帰属つき URL)で、spawn の外には
// 存在しない。したがって正本が答えるのは「このホストの CLI が盤面の `--tools` 宣言を
// honor するか」であり、`--settings` まで含んだ**実際の spawn 形**を測るのは深層防御側
// (実セッションの init 行)である。2つで面の全体を覆う、という分担であって取りこぼし
// ではない — ADR 0039 の測定は本番フラグ一式で 18本(組み込み17 + MCP verb 1)を観測
// しており、正本の側はその MCP verb が無い 17本を見る(`mcp__` は比較対象外なので
// どちらでも同じ答えになる)。
//
// `--setting-sources project` を足すのは**本番と同じ tier を読ませる**ため。足さないと
// ホストの人間の `~/.claude/settings.json` の `permissions.deny` が面を削り
// (ADR 0039 測定3)、本番の worker では起きない欠落を封じ込めの不成立に化けさせる。
// SKILL_ENUM_ARGS 側には足さない — skill 列挙は user tier の skill を見るのが
// 目的で(`enumerateHostSkills` の @host 集合)、そこに足すと集合が壊れる。
const TOOL_SURFACE_PROBE_ARGS = [
  "--permission-mode",
  "acceptEdits",
  "--setting-sources",
  "project",
  "--tools",
  spawnTools("work").join(","),
];

// この ping の timeout は skill 列挙と**分ける**。失敗の重さが違う:
// skill 列挙の timeout は spawn 1回を諦めるだけ(タスクは watchdog が回収する)だが、
// こちらの timeout は「観測できなかった = 不成立」→ **盤面全体の pickup 停止 +
// 確認 question** になる。つまり遅いホストが誤って盤面を止める側に倒れる。冷えた CLI の
// 起動がどこまで伸びうるかはホスト依存(ADR 0028 が Pi を macOS より遅い側として実測
// している)なので、上限は「詰まりを検知する」役だけを残して広く取る。ping 自体が
// 遅いぶんは poll が待つだけで、誤停止よりはるかに安い。
const TOOL_SURFACE_PROBE_TIMEOUT_MS = 60_000;

const defaultEnumerateTools: EnumerateToolsFn = () =>
  // neutral cwd で撃つ: workspace の cwd で撃つと、その checkout の
  // `.claude/settings.json` の `permissions.deny` が面を削って(測定3)「ホストの
  // 封じ込め能力の不成立」に化ける。それは workspace の性質であって別の資源であり、
  // `floorOverridingSettings` がすでにその担当である。
  atNeutralCwd("tidepool-tools-", (cwd) =>
    runInitPing(cwd, TOOL_SURFACE_PROBE_ARGS, "tools", TOOL_SURFACE_PROBE_TIMEOUT_MS),
  );

/** 封じ込め能力の3つ目の問い(ADR 0039 決定3)の正本: `/usage` ping を**その場で
 *  撃ち**、観測されたツール面を `checkToolSurface` に渡す。
 *
 *  **memoize しない**のが要件である。解除は「能力検査を回答時にもう一度走らせて
 *  成立する」ことで検証される(CONTEXT.md の Quarantine)ので、再実行できない検査は
 *  確認 question を受理できない。呼ばれるのは起動時 / pickup ごと / quarantine の
 *  回答受理時。
 *
 *  ping が失敗したら**不成立**に倒す — 「測れなかった」は「無事」ではない
 *  (人間面の半分が接続失敗を不成立に倒すのと同じ線)。ここを skip にすると3つ目の
 *  問いが黙って飾りになる。 */
export async function probeToolSurfaceCapability(
  enumerate: EnumerateToolsFn = defaultEnumerateTools,
): Promise<ContainmentCapability> {
  const observed = await enumerate();
  if (observed === null) {
    return {
      available: false,
      reason:
        "the board could not observe the tool surface its own `claude` CLI hands a worker " +
        "session (the /usage ping produced no init report — a missing binary, a stalled auth " +
        "prompt, or a timeout) — whether the declared Tool allowlist is honored is unknown, " +
        "and unknown is not safe (ADR 0039)",
    };
  }
  // work プロファイルで撃っている(TOOL_SURFACE_PROBE_ARGS のコメント参照)
  return checkToolSurface(observed, "work");
}

/** The skills-picker candidate source (issue #106 / ADR 0025): the `@host`
 *  individual skills the WebUI's agent skills picker offers, enumerated by the
 *  same `/usage` ping mechanism the spawn-time complement-deny uses — but at a
 *  *neutral* cwd (a fresh empty directory), so nothing but the host's own
 *  user-level + plugin-prefixed skills is resolved. At an empty cwd there is no
 *  `.claude/skills/`, so the whole enumerated set *is* the `@host` set; the
 *  caller returns it verbatim (the scope words `*`/`@workspace`/`@host` are the
 *  picker's own additions, not this API's).
 *
 *  Why the picker deliberately does NOT enumerate a workspace's own skills: the
 *  settings screen has no workspace context to enumerate against — an agent
 *  definition is workspace-independent (it traverses every workspace it is sent
 *  to, ADR 0025 点2), so `@workspace` is a *late-bound* reference resolved per
 *  spawn against whichever checkout the task runs in, never a fixed list picked
 *  here. A workspace-specific individual name is added by free entry instead
 *  (an allowlist is a reference, not a claim of stock — ADR 0023). Null on a
 *  failed probe, same fail-closed shape as `defaultEnumerateSkills`; the route
 *  degrades that to an empty candidate set rather than a spawn failure. */
export const enumerateHostSkills = (): Promise<string[] | null> =>
  atNeutralCwd("tidepool-skills-", defaultEnumerateSkills);

/** The checkout's own skills (issue #56 / ADR 0025): the directory names under
 *  `<workspace>/.claude/skills/`. This one-directory scan is the only discovery
 *  logic tidepool keeps in-house — the `@workspace`/`@host` split is a
 *  difference against it (a skill the CLI enumerated but the checkout doesn't
 *  carry is host-provided). A missing directory is an empty set, not an error
 *  (a workspace need not carry any skills). */
function scanWorkspaceSkills(workspacePath: string): string[] {
  try {
    return readdirSync(join(workspacePath, ".claude", "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export const defaultExec: ExecFn = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** The interactive-TUI process boundary checkUsage scrapes at (issue #81 /
 *  ADR 0028): a PTY, so `claude`'s /usage panel renders as it would under a
 *  real terminal. Everything vendor-specific (node-pty, the interactive CLI
 *  flags) flows through this one call — faked in tests so the scrape
 *  orchestration runs without a real PTY (ADR 0027). */
export type PtyProcess = {
  onData(listener: (data: string) => void): void;
  /** Bytes to the CLI's stdin: a submitted line ends in ENTER; shutdown is
   *  CTRL_C sent twice. */
  write(data: string): void;
  kill(signal?: string): void;
  onExit(listener: () => void): void;
};

export type PtyFn = (
  command: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
) => PtyProcess;

// ADR 0028 empirical parameters. The scrape orchestration (checkUsage below)
// is unit-tested against a fake PTY, but these literal values are not — they
// were tuned by driving the real interactive CLI on both macOS (2.1.212) and
// the production Pi board (2.1.207), 2026-07-17. Re-confirm on a fresh host.
//
// Wait for this before sending /usage (never a fixed sleep): the input box
// shows a rotating `Try "…"` placeholder once it is drawn. Unlike the mode
// footer ("? for shortcuts" vs "shift+tab to cycle", which differs by the
// host's permission mode) or the safe-mode banner (which renders too early,
// before the box accepts input), the placeholder is common to every host and
// marks the prompt itself. Matched space-insensitively (see `squash`).
export const PROMPT_READY_MARKER = 'Try "';
// The interactive input box silently drops a slash command typed the instant
// it renders, so we let it settle before sending /usage. This is not a blind
// startup sleep — the prompt marker above is still the gate; this is the box's
// input-init window, found empirically (2000ms was the reliable floor on
// macOS; 2500 also cleared the slower Pi with margin).
const USAGE_PROMPT_SETTLE_MS = 2_500;
// The /usage panel is captured once both header lines have rendered; these
// double as the acceptance-criteria markers (Current session / Current week).
const PANEL_MARKERS = ["Current session", "Current week"];
// Once the panel's headers appear, each row's % and reset line can still
// arrive in a later chunk (the panel renders top-to-bottom over several
// writes). Wait for the render to go quiet before capturing so a chunk
// boundary can't split a number off the header we keyed on. Comfortably
// shorter than the gap before the panel re-renders with its usage breakdown,
// so we capture the first complete render, not the breakdown.
const PANEL_QUIET_MS = 500;
// Fail closed if the panel has not rendered within this budget (measured
// end-to-end ~3.4s on macOS, ~7s on the Pi, so 15s is generous headroom).
const USAGE_TIMEOUT_MS = 15_000;
// Wide enough that "Current session …" never wraps at 80 columns (ADR 0028).
const PTY_COLS = 200;
const PTY_ROWS = 50;
// stdin control bytes: submit a line, and Ctrl-C (sent twice for a clean
// interactive shutdown).
const ENTER = "\r";
const CTRL_C = "\x03";

// Force the fullscreen TUI renderer regardless of the host's own setting: the
// classic renderer lays words out with cursor-position moves rather than
// spaces, so once ANSI is stripped the panel collapses to "Currentsession
// 36%used" and parseUsage (#80) can't read it. The fullscreen renderer emits
// real spaces, keeping the raw parseable. Passed via --settings, which is
// honored even under --safe-mode (verified on the Pi board). This is the one
// piece of state checkUsage pins rather than inheriting from the host.
const USAGE_TUI_SETTINGS = JSON.stringify({ tui: "fullscreen" });

// Strip ANSI/OSC escapes and all whitespace. The CLI positions words with
// cursor-move escapes, not spaces, so a marker like "Current session" is never
// a contiguous substring of the raw stream; matching against this squashed
// view ("Currentsession") is robust across renderers and terminal widths. The
// captured raw is still returned verbatim — this view is only for matching.
function squash(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[@-_][0-9;?]*[A-Za-z]?/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/\s+/g, "");
}

/** Space-insensitive (but case-sensitive) substring match against the squashed
 *  PTY stream. Case matters on purpose: `PROMPT_READY_MARKER` squashes to
 *  `Try"`, and keeping the capital T is what stops it matching a squashed
 *  `Retry "…"` (`…etry"…`). A spurious match would only fail closed anyway —
 *  parseUsage (#80) returns null on a capture that isn't a real panel. */
function seen(buffer: string, marker: string): boolean {
  return squash(buffer).includes(squash(marker));
}

function hasUsagePanel(buffer: string): boolean {
  return PANEL_MARKERS.every((marker) => seen(buffer, marker));
}

const defaultSpawn: SpawnFn = (command, args, opts) => {
  const child = nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stderr は捕捉のため pipe に変えた(issue #125)が、従来 "inherit" で
  // 運用者がリアルタイムに見ていた可視性はこの tee で維持する(pipe は
  // process.stderr を close しない — Node の readable.pipe の仕様)
  child.stderr.pipe(process.stderr);
  // exit observation (worker_exited event) and spawn-failure observation
  // (spawn_failed event, issue #127) are the adapter's job now (launch()) —
  // child already exposes .on("exit", ...) and .on("error", ...)
  // structurally, nothing more to wire here. An unlistened "error" would
  // crash the whole board process, but launch() always attaches a listener,
  // so that risk never materializes.
  return child;
};

/** "entry #3" / "entries #3, #5" — decision-log event ids, the same id space
 *  the RCA reads via get_current_task's parent decision_log (issue #87). */
function entryLabels(ids: number[]): string {
  return `${ids.length === 1 ? "entry" : "entries"} ${ids.map((id) => `#${id}`).join(", ")}`;
}

const nodeRequire = createRequire(import.meta.url);

/** The real PTY boundary (issue #81 / ADR 0028): node-pty renders the
 *  interactive /usage panel under a TTY. node-pty is a native module and the
 *  only real-PTY path — kept out of automated tests (ADR 0027) and required
 *  lazily so the fake-injected suite never needs it built. */
const defaultPty: PtyFn = (command, args, opts) => {
  // node-pty's IPty already satisfies PtyProcess (onData/onExit/write/kill);
  // the seam exists to isolate the require, not to re-wrap identical methods.
  const nodePty = nodeRequire("node-pty") as {
    spawn(
      file: string,
      args: string[],
      options: { cwd: string; cols: number; rows: number; name: string },
    ): PtyProcess;
  };
  return nodePty.spawn(command, args, {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    name: "xterm-256color",
  });
};

/** The real WorkerAdapter: spawns a headless Claude Code session per task.
 *  Vendor knowledge (spawn recipe, stream-json, agent definition format) stays
 *  inside this module — the board only sees the WorkerAdapter seam. */
export class ClaudeCodeWorker implements WorkerAdapter {
  readonly id: string;
  private readonly options: ClaudeWorkerOptions;
  private readonly spawn: SpawnFn;
  private readonly pty: PtyFn;
  private readonly enumerateSkills: EnumerateSkillsFn;
  /** logDir pinned to an absolute path: the spawned CLI resolves relative
   *  paths against its own cwd (the workspace), not against the board. */
  private readonly logDir: string;
  /** Live child processes by task id, for the watchdog's kill() (#9). A
   *  finished process removes itself so a stale entry never outlives it. */
  private readonly running = new Map<string, { kill(signal: NodeJS.Signals): void }>();
  /** ADR 0018: resolved once at construction, same "config edge" posture as
   *  the rest of `options` — env access itself stays in main.ts. */
  private readonly workspacesDir: string;

  constructor(options: ClaudeWorkerOptions) {
    this.id = options.agent;
    this.options = options;
    this.spawn = options.spawn ?? defaultSpawn;
    this.pty = options.pty ?? defaultPty;
    this.enumerateSkills = options.enumerateSkills ?? defaultEnumerateSkills;
    this.logDir = resolve(options.logDir);
    this.workspacesDir = resolveWorkspacesBaseDir(options.workspacesDir);
    // fail at boot, not at first pickup: a misconfigured registry must refuse
    // to start the board rather than wedge the first task
    this.validateDefaults(loadRegistry(options.registryDir));
  }

  /** Boot-time validation only: the configured default workspace/agent/
   *  authority/effort must all resolve against the registry, or the
   *  misconfiguration is thrown by name — a board must refuse to start
   *  rather than wedge the first task. Per-task resolution (task.workspace,
   *  task.assignee) happens fresh in `start()` below (issue #26 / ADR 0009,
   *  ADR 0012 / issue #36) — drift there quarantines instead of throwing. */
  private validateDefaults(registry: Registry): void {
    resolveExecutionWorkspace(registry, this.options.workspace, null, this.workspacesDir);
    const agent = resolveExecutionAgent(registry, this.options.agent, null);
    assertKnownEffort(agent.definition);
  }

  /** ADR 0020 part 4: a party review (self RCA) is a review task with a
   *  concrete assignee — the historical worker, baked as a fact (CONTEXT.md's
   *  Review: "self = 確定値") — hanging off the objected task (parent). Its
   *  evidence is the agent definition as it stood *when each objected decision
   *  was made*: 当時版 is resolved per objected log entry (issue #87) — the
   *  `worker_spawned` session (the strict agent version, ADR 0001) that was
   *  live when that entry was written, read from the committed registry at its
   *  hash. Anchoring on the entries — not simply the latest spawn — keeps a
   *  later escalation-return re-spawn under a refined definition from being
   *  mistaken for the 当時版; resolving per entry — not folding to one anchor —
   *  keeps judgments that span sessions under different versions from being
   *  read against a definition that never shaped them. Entries all resolving
   *  to one version (the common case) produce the original single section,
   *  byte for byte; distinct versions are each injected, labeled with the
   *  decision-log entry ids they were live for (the same id space the RCA
   *  reads via get_current_task's parent decision_log). Independent reviews
   *  (unset assignee → the Auditor pointer, issue #42) get no such injection:
   *  their value is distance from the judgment, not the 原本. Best-effort — an
   *  entry whose version cannot be resolved (a kill left no record, an
   *  unreachable commit) is declared as an evidence gap when other versions
   *  did resolve, and degrades to no section at all when none did (no claim
   *  made, nothing to declare) — never a failed spawn. The review still
   *  executes under the current definition (ADR 0019): this only adds
   *  evidence, not the reviewer's identity. */
  private historicalDefinitionSection(task: Task): string {
    if (task.type !== "review" || task.assignee === null || task.parent_id === null) return "";
    const events = listEvents(this.options.db, task.parent_id);
    const byId = new Map(events.map((e) => [e.id, e]));
    // the objected log entries this worker wrote (each objection_raised annotates
    // one entry on this same task), earliest first
    const objectedEntryIds = [
      ...new Set(
        events
          .filter((e) => e.kind === "objection_raised")
          .map((e) => (e.payload as Extract<EventPayload, { kind: "objection_raised" }>).entry_id)
          .filter((entryId) => byId.get(entryId)?.worker_id === task.assignee),
      ),
    ].sort((a, b) => a - b);
    // per entry: the spawn live when it was written — the latest worker_spawned
    // by this worker at or before the entry. Map insertion order is
    // chronological because the entries are.
    const byCommit = new Map<string, number[]>();
    const unresolved: number[] = [];
    for (const entryId of objectedEntryIds) {
      const spawned = events
        .filter(
          (e) => e.kind === "worker_spawned" && e.worker_id === task.assignee && e.id <= entryId,
        )
        .at(-1);
      if (!spawned) {
        unresolved.push(entryId);
        continue;
      }
      const { registry_commit } = spawned.payload as Extract<
        EventPayload,
        { kind: "worker_spawned" }
      >;
      byCommit.set(registry_commit, [...(byCommit.get(registry_commit) ?? []), entryId]);
    }
    const resolved: Array<{ commit: string; entryIds: number[]; body: string }> = [];
    for (const [commit, entryIds] of byCommit) {
      const body = agentBodyAtCommit(this.options.registryDir, commit, task.assignee);
      if (body === undefined) unresolved.push(...entryIds);
      else resolved.push({ commit, entryIds, body });
    }
    if (resolved.length === 0) return "";
    if (resolved.length === 1 && unresolved.length === 0) {
      return (
        "\n\n## Definition under review (as it stood when you ran the objected task)\n\n" +
        "This is your agent definition recorded at the commit you were spawned from — " +
        "the version that shaped the decision now under review. Read it as evidence for " +
        '"why did I make that call". You nonetheless carry out this review under your ' +
        "current definition (ADR 0019: repair is not a re-enactment).\n\n---\n\n" +
        resolved[0]!.body
      );
    }
    // no-spawn entries and unreachable-commit entries land in two phases above,
    // so their interleaving can drift from entry order — restore it once here
    unresolved.sort((a, b) => a - b);
    const gap =
      unresolved.length === 0
        ? ""
        : "\n\nNote: no definition version could be resolved for your objected " +
          `${entryLabels(unresolved)} (missing session record or ` +
          "unreachable commit) — the evidence above is incomplete for those judgments.";
    return (
      "\n\n## Definitions under review (as they stood when you made each objected decision)\n\n" +
      "These are your agent definition bodies recorded at the commits you were spawned " +
      "from, resolved per objected decision-log entry — each version below is the one " +
      "that was live when you wrote the entries it is labeled with. Read them as evidence " +
      'for "why did I make that call". You nonetheless carry out this review under your ' +
      "current definition (ADR 0019: repair is not a re-enactment)." +
      resolved
        .map(
          ({ commit, entryIds, body }) =>
            `\n\n### As of registry commit ${commit.slice(0, 7)} — live for your objected ` +
            `${entryLabels(entryIds)}\n\n---\n\n${body}`,
        )
        .join("") +
      gap
    );
  }

  start(task: Task): void {
    // loaded per pickup so a registry update takes effect on the next task
    const registry = loadRegistry(this.options.registryDir);
    // ADR 0020 part 2: `main` is read as a code constant, so verify it is still
    // the clone's real default branch (origin/HEAD) — a mismatch drops the
    // registry workspace into quarantine rather than silently trusting a
    // branch that isn't the default. A side check: the current (non-registry)
    // task keeps its slot regardless, same posture as the drift checks below.
    guardRegistryDefaultBranch(
      this.options.db,
      registry,
      this.options.registryDir,
      this.workspacesDir,
      this.options.clock.now(),
    );
    // task.workspace (issue #26 / ADR 0009) and task.assignee (ADR 0012 /
    // issue #36) both take precedence over this worker's configured
    // defaults — resolved fresh against the registry every pickup, never
    // pinned. An unknown name in either is registry drift, not a config
    // mistake: resolveOrQuarantine/resolveAgentOrQuarantine fail it closed
    // into quarantine rather than throwing out of start() — defense in depth
    // alongside the scheduler's own pre-pickup gate, which is what
    // ordinarily catches this before start() is ever called.
    const workspace = resolveOrQuarantine(
      this.options.db,
      (taskWorkspace) =>
        resolveExecutionWorkspace(registry, this.options.workspace, taskWorkspace, this.workspacesDir),
      task.workspace,
      this.options.clock.now(),
    );
    if (!workspace) return;
    // issue #60 / ADR 0033 (+ #144 / ADR 0035): the CLI merges the *workspace's*
    // own `.claude/settings.json` with the per-task `--settings` floor below,
    // and both floor-defining keys leak through — `sandbox.filesystem.allowRead`
    // entries win, and a `permissions.allow` entry lifts review's manual write
    // floor (both measured — see floorOverridingSettings). A work session can
    // write its own checkout, so this would be a two-session escalation: widen
    // the floor in session N, walk out in N+1. A workspace that redefines the
    // floor is a broken resource — quarantined like a dirty tree, and no session
    // starts in it meanwhile.
    const overriding = floorOverridingSettings(workspace.path);
    if (overriding.length > 0) {
      quarantineWorkspace(
        this.options.db,
        workspace.name,
        new Error(
          `workspace carries .claude/${overriding.join(", .claude/")} declaring its own ` +
            "sandbox or permissions settings, which would widen the worker floor " +
            "(ADR 0033 / ADR 0035) — remove the sandbox and permissions blocks",
        ),
        this.options.clock.now(),
      );
      return;
    }
    // a review task's unset assignee resolves to the Auditor pointer, not
    // this worker's configured default agent (issue #42 / CONTEXT.md's
    // Auditor: independent review's value is its distance from the original
    // judgment, so it must never fall back to the same agent that did the
    // work) — every other type keeps resolving to `this.options.agent`.
    const defaultAgentName =
      task.type === "review" ? this.options.auditorName ?? DEFAULT_AUDITOR_NAME : this.options.agent;
    const agent = resolveAgentOrQuarantine(
      this.options.db,
      (taskAssignee) => resolveExecutionAgent(registry, defaultAgentName, taskAssignee),
      task.assignee,
      this.options.clock.now(),
    );
    if (!agent) return;
    assertKnownEffort(agent.definition);
    // ADR 0025: skill access is the agent's frontmatter allowlist, enforced
    // here as the complement deny of the CLI-enumerated full set. The two
    // ping-free shapes launch synchronously (nothing changes for the
    // unrestricted default agent): `["*"]` denies nothing, `[]` disables slash
    // commands wholesale. A finite list needs the CLI to enumerate the full set
    // first (a ~2s zero-token /usage ping at the workspace cwd); that failure
    // fails the spawn closed — never run without the deny list (no fail-open,
    // ADR 0025 point 6).
    const skills = agent.definition.skills;
    if (skills.length === 1 && skills[0] === SKILL_WILDCARD) {
      this.launch(task, workspace, agent, registry, {
        deny: [],
        disableSlashCommands: false,
        // nothing is denied, so ADR 0033's sandbox may open the skill roots
        // wholesale — there is no allowlist for a `cat` to route around
        permittedSkills: "all",
      });
      return;
    }
    if (skills.length === 0) {
      this.launch(task, workspace, agent, registry, {
        deny: [],
        disableSlashCommands: true,
        permittedSkills: [],
      });
      return;
    }
    void this.enumerateSkills(workspace.path).then((enumerated) => {
      if (enumerated === null) {
        // spawn failure with no fail-open (ADR 0025 point 6): the deny list
        // could not be resolved, so no session starts and the allowlist is
        // never bypassed. No child means no worker_exited to record; the task
        // keeps the slot with no process, and the watchdog reclaims it at its
        // per-type time limit into tidepool's failure question (the retry
        // path) — the same failure system every kill routes to, entered
        // without a running process to kill. Deliberately NOT degraded into a
        // --disable-slash-commands spawn: that would silently drop the
        // equipment the agent was promised and make the failure unobservable.
        console.error(
          `[worker] skill enumeration failed for task ${task.id}; not spawning ` +
            "(deny list unresolved, no fail-open — ADR 0025)",
        );
        return;
      }
      // the @workspace/@host split is a difference against the checkout's own
      // skills — scanned only when a scope word is actually present.
      const needsScan = skills.some((s) => s === "@workspace" || s === "@host");
      const workspaceSkills = needsScan ? scanWorkspaceSkills(workspace.path) : [];
      const deny = computeSkillDenials(skills, enumerated, workspaceSkills);
      // ADR 0033: the sandbox's skill re-allow is the *permitted* set — the
      // same complement, the other way round — so a denied skill's directory
      // is never opened for reading either (issue #132's semantics must hold
      // for `cat`, not just for the Skill tool).
      const denied = new Set(deny);
      const permittedSkills = enumerated.filter((skill) => !denied.has(skill));
      this.launch(task, workspace, agent, registry, {
        deny,
        disableSlashCommands: false,
        permittedSkills,
      });
    });
  }

  /** The vendor spawn recipe, run once the skill deny list is resolved (ADR
   *  0025): builds the headless `claude` invocation, tees its stream-json
   *  transcript verbatim, and records worker_spawned / worker_exited at the
   *  process boundary (issue #32). `enforcement` carries the per-skill denies
   *  (folded into --disallowedTools alongside the always-present Workflow ban)
   *  and whether to --disable-slash-commands (the empty-allowlist shape), plus
   *  the permitted-skill set ADR 0033's sandbox re-allows for reading. */
  private launch(
    task: Task,
    workspace: WorkspaceConfig,
    agent: ResolvedAgent,
    registry: Registry,
    enforcement: {
      deny: string[];
      disableSlashCommands: boolean;
      permittedSkills: string[] | "all";
    },
  ): void {
    const { definition, profile } = agent;
    // the ?task= param is the attribution the MCP router checks against the
    // slot — a stray call from a stale process fails that check and is refused
    const mcpConfigPath = join(this.logDir, `${task.id}.mcp.json`);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: { type: "http", url: `${this.options.mcpUrl}?task=${task.id}` },
        },
      }),
    );
    // ADR 0033: every worker session — review and work alike — runs its Bash
    // inside the CLI's own sandbox, confined to the workspace. Written per task
    // next to the MCP config above, the same shape and lifetime; the profile
    // itself is a code constant (src/sandbox.ts), never registry data.
    const sandboxSettingsPath = join(this.logDir, `${task.id}.sandbox.json`);
    writeFileSync(
      sandboxSettingsPath,
      JSON.stringify(
        buildSandboxSettings({
          taskType: task.type,
          workspacePath: workspace.path,
          permittedSkills: enforcement.permittedSkills,
        }),
      ),
    );
    const prompt =
      `You are picking up tidepool task ${task.id}. ` +
      "Call get_current_task first, then work it to completion through the tidepool MCP verbs.";
    // dynamic orchestration is a category ban for workers (ADR 0010 addendum /
    // issue #31): "Workflow" is always denied. Per-skill denies (ADR 0025 point
    // 3: per-skill deny is the only enforcement primitive) ride the same flag,
    // one Skill(name) token each. Confirmed against the installed CLI that both
    // "Workflow" and "Skill(名前)" are the tool names a headless session honors.
    // review タスクの harness deny(ADR 0013 追記 / issue #59)も同じ
    // --disallowedTools に折り込む — task.type だけで決まるので誰の assignee
    // でも(self RCA も含め)外れない。comma 区切り(CLI は comma/space どちらも
    // 受け付ける、--help): "Bash(git push*)" のように内部に space を含む
    // トークンを space 区切りで畳むと1トークンが誤分割される。
    const disallowedTools = [
      "Workflow",
      ...enforcement.deny.map((s) => `Skill(${s})`),
      ...reviewToolDenials(task.type),
    ].join(",");
    // ADR 0035 / 0038: what has to be lifted back out of the mode's floor. Same
    // comma join as the deny above, for the same reason — a `Bash(npm test*)`
    // token carries an internal space. Never empty now: the MCP server rides
    // both profiles.
    const allowedTools = spawnAllowedTools(
      task.type,
      workspace.review_allowed_commands ?? [],
    ).join(",");
    const child = this.spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        // A FLOOR IS A RESIDUAL DEFAULT (ADR 0038). Headless sessions cannot
        // answer a permission prompt, so what a mode does with the operations
        // its rules say nothing about *is* the floor: `auto` answers them with
        // the classifier's self-approval (a model's judgment, which ADR 0033
        // refuses to count), the other modes answer them by asking — and with
        // nobody there, asking *is* the refusal.
        //
        // The tool layer (Read / Write / Edit / Glob / Grep …) runs in-process,
        // where ADR 0033's sandbox does not reach: while `work` ran `auto`, its
        // residual was "yes" and a worker could read everything readable on the
        // host and write everywhere writable (issue #151). `acceptEdits` is
        // exactly one notch looser than `manual`: edits pass, so work can still
        // work, and only outside-cwd is closed. `review` stays `manual` (ADR
        // 0035), where every side effect asks. No worker session runs `auto`.
        //
        // Bash is untouched by this: the sandbox profile leaves
        // `autoAllowBashIfSandboxed` at its `true` default for work (it is off
        // for review, which is what makes review's write floor hold), so
        // sandboxed Bash never reaches this layer in a work session and the OS
        // remains its only bound.
        "--permission-mode",
        task.type === "review" ? "manual" : "acceptEdits",
        // WHO IS ALLOWED TO WRITE PERMISSION AT ALL (ADR 0038). The mode above
        // is flag tier, but permission *merges* across tiers: an `allow` in the
        // host human's `~/.claude/settings.json` or in the workspace's
        // gitignored `settings.local.json` lifts the boundary this mode draws —
        // measured with controls on both. Neither tier buys a worker anything
        // (the board hands over everything it needs through `--settings`
        // below), and the local one grows on its own via "don't ask again"
        // without ever passing a human's review. `project` and not `""`/`user`:
        // the workspace's own CLAUDE.md and skills ride the project tier, and
        // ADR 0037 measured the other two taking them down. The cost is that
        // the host's personal `~/.claude/skills` and plugin skills no longer
        // reach a worker — deliberate: the board does not carry what it does
        // not manage into a session (ADR 0033).
        "--setting-sources",
        "project",
        "--disallowedTools",
        disallowedTools,
        // Neither mode above lets the MCP verbs through on their own, so every
        // spawn carries this flag (ADR 0038); review additionally names its
        // `review_allowed_commands` (ADR 0035). Unconditional on purpose — a
        // spawn with no allowlist is a session that cannot reach the board.
        "--allowedTools",
        allowedTools,
        // A DEFAULT-DENY ALLOWLIST (ADR 0039). The mode above is the floor for
        // whatever the permission layer sees — but the non-file in-process tools
        // are not permission subjects at all, so nothing residual reaches them:
        // `CronCreate` executed under `acceptEdits` + this exact flag set with no
        // approval asked (測定2). `--tools` closes that layer the other way round,
        // by naming everything the session may have and nothing else, so a tool
        // the vendor adds later arrives *closed* (an enumerated deny would let it
        // in open). Only the built-in surface is affected — MCP verbs and skills
        // survive it untouched (測定5), which is what makes this compatible with
        // `--allowedTools mcp__tidepool` above and ADR 0025's skill machinery.
        //
        // Never conditional, never empty: `--tools ""` is the CLI's spelling for
        // "disable all tools" (--help), so an empty join would silently produce a
        // session that cannot call anything rather than an error. The value sits
        // immediately before the next `--flag` because the option is variadic
        // (`--tools <tools...>`) — a bare token after it would be swallowed.
        "--tools",
        spawnTools(task.type).join(","),
        // the empty-allowlist shape: one flag disables every slash command
        // (skills included), so no per-skill enumeration is needed (ADR 0025
        // point 5).
        ...(enforcement.disableSlashCommands ? ["--disable-slash-commands"] : []),
        ...pinnedModelFlags(definition.model ?? "sonnet", definition.effort ?? "medium"),
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        // ADR 0033: the OS floor under the tool layer above. Note the CLI
        // silently ignores a --settings file that fails validation under -p
        // (documented in its own --help), so this flag alone is not evidence
        // the sandbox is on — that is what the deploy-time canary smoke and
        // the capability check are for.
        "--settings",
        sandboxSettingsPath,
        // who the agent is (registry definition body) and what its authority
        // sounds like (profile guidance prose), stitched at spawn time. A party
        // review (self RCA) additionally carries the 当時版 definition as
        // evidence (ADR 0020 part 4), appended last.
        "--append-system-prompt",
        `${definition.systemPrompt}\n\n## Authority\n\n${profile.guidance}${rosterSection(buildRoster(registry, profile.assignable_to))}\n\n${BOARD_DOCTRINE}\n\n${WORKER_PROTOCOL}${this.historicalDefinitionSection(task)}`,
      ],
      // the agent's own commits are stamped with the agent's identity (issue
      // #53), merged over the inherited env — never a token (ADR 0024).
      { cwd: workspace.path, env: { ...process.env, ...agentGitIdentityEnv(agent.name) } },
    );
    // the whole stream-json session is kept verbatim: the audit trail of what
    // the agent actually did, not just what it wrote back to the board
    child.stdout.pipe(createWriteStream(join(this.logDir, `${task.id}.stream.jsonl`)));
    // stderr は CLI レベルの失敗(spawn 即死・limit 強制終了・認証エラー)が
    // 唯一証拠を残す面 — stream.jsonl の隣に全量保存する(issue #125)
    child.stderr.pipe(createWriteStream(join(this.logDir, `${task.id}.stderr.log`)));
    // stdout の lastResult と同じ tee 形: worker_exited がファイルを読み返さず
    // に末尾要約を載せられるよう、イベント用の末尾だけをメモリに保つ。
    // chunk 単位の toString() は UTF-8 文字を境界で割ると置換文字に化けるので、
    // StringDecoder が境界をまたぐシーケンスを繰り越す(全量ファイル側は pipe
    // なのでバイト正確 — これは要約側だけの問題)
    const stderrDecoder = new StringDecoder("utf8");
    let stderrBuffered = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
      stderrBuffered = trimStderrTail(stderrBuffered + text);
    });
    // teed alongside the file write (issue #32): tracks the latest
    // stream-json `result` line so worker_exited can report usage/cost at
    // exit without re-reading the file back off disk
    let lastResult: StreamResultEvent | null = null;
    let buffered = "";
    // 面の照合は init 行1本で答えが出る(それ以降の行を JSON.parse し直す理由がない)
    let toolSurfaceObserved = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        lastResult = parseResultLine(line) ?? lastResult;
        if (!toolSurfaceObserved) {
          toolSurfaceObserved = this.checkSessionToolSurface(task, line, child);
        }
      }
    });
    this.running.set(task.id, child);
    appendEvent(this.options.db, {
      taskId: task.id,
      // attributed to whichever agent actually got spawned (ADR 0012 / issue
      // #36) — not this worker's configured default, which a pre-set
      // delegation may override
      workerId: agent.name,
      // issue #127: this records the *attempt* to spawn, not a successful
      // session — spawn() has already returned synchronously by this point,
      // but Node's "error" can still fire after this write if the process
      // never actually came into being (ENOENT etc.). That is not a false
      // record: every fact this event carries (the resolved definition, the
      // registry commit read) is true regardless of whether the process
      // starts. spawn_failed, when it follows, closes the pair honestly
      // rather than this event needing to be walked back.
      payload: {
        kind: "worker_spawned",
        registry_commit: registry.commit,
        definition_version: definition.version,
      },
      at: this.options.clock.now(),
    });
    // issue #127: Node's spawn() itself failing (ENOENT/EACCES/PATH
    // misconfig) fires "error" but never "exit" — the process never comes
    // into being, so the "exit" handler below never runs and worker_exited
    // is never written. This is the dedicated observation point for that
    // failure class (same promotion out of defaultSpawn as "exit" got in
    // issue #32). "error" is not spawn-exclusive (e.g. a failed kill() also
    // fires it), so err.syscall is the discriminator: Node stamps spawn
    // failures with syscall "spawn <command>".
    child.on("error", (err) => {
      const errno = err as NodeJS.ErrnoException;
      if (!errno.syscall?.startsWith("spawn")) {
        console.error(`[worker] error on task ${task.id}:`, err);
        return;
      }
      this.running.delete(task.id);
      console.error(`[worker] failed to spawn claude for task ${task.id}:`, err);
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        payload: {
          kind: "spawn_failed",
          error_code: errno.code ?? null,
          message: err.message,
        },
        at: this.options.clock.now(),
      });
    });
    // usage is settled at process exit — after task_completed via MCP, not
    // before (issue #32) — so kill/crash sessions still get a worker_exited
    // with usage: null rather than losing the exit fact entirely
    child.on("exit", (code, signal) => {
      this.running.delete(task.id);
      // the final stdout chunk may not end in "\n" (stream simply closes
      // mid-line), which would otherwise strand the last result line in
      // `buffered` forever and read as a false "missing usage" — same
      // status as an actual kill, which it isn't
      lastResult = parseResultLine(buffered) ?? lastResult;
      // 文字の途中で stream が閉じた場合の未完バイト列を flush(この場合の
      // 置換文字は捏造ではなく「途中で切れた」事実そのもの)
      stderrBuffered = trimStderrTail(stderrBuffered + stderrDecoder.end());
      // this diagnostic used to live in defaultSpawn (console.error only);
      // promoted here alongside the worker_exited write so an operator
      // tailing logs still sees a crash, not just the audit record (issue #32)
      if (code !== 0) console.error(`[worker] claude exited with ${signal ?? code}`);
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        payload: {
          kind: "worker_exited",
          exit_code: code,
          signal,
          stderr_tail: stderrTail(stderrBuffered),
          usage: lastResult ? toUsage(lastResult) : null,
        },
        at: this.options.clock.now(),
      });
    });
  }

  /** ADR 0039 決定3 の**深層防御側**: 走っているセッション自身の init 行の `tools`
   *  を、封じ込め能力の probe と**同じ照合関数・同じ期待集合**(`checkToolSurface`)
   *  で見る。正本は `/usage` ping のほうだが、盤面はすでに worker の stdout を
   *  1行ずつ読んでいるので追加コストは実質ゼロで、しかも測っているのが**実
   *  セッションそのもの**である(ping は本番と同じフラグ形の代理でしかない)。
   *
   *  不成立時は新しい器を作らず既存の封じ込め能力の経路に乗る — 盤面全体の pickup が
   *  止まり、Tidepool 名義の確認 question が1枚立つ(2枚目は
   *  `quarantineContainment` 自身が短絡する)。
   *
   *  **そのセッションは走らせない。** init 行はセッションの開始直後 — モデルが
   *  最初の tool_use を出す前 — に出るので、ここで殺すのは「走っている仕事を途中で
   *  奪う」ことではなく、ADR 0025 point 6 が skill 列挙の失敗に対して取ったのと同じ
   *  「このセッションは走らせない(fail-open しない)」である。ずれが広い側なら
   *  worker は持つべきでない能力を持ったまま走ることになり、狭い側なら能力を1つ
   *  失って詰まるだけなので、どちらの向きも走らせる理由がない。slot は既存の失敗
   *  経路 — watchdog の per-type 時限 → 失敗 question(リトライ)— が回収する。
   *  SIGTERM ではなく SIGKILL なのは、猶予の目的が「エージェントに畳ませる」こと
   *  であり、ここで止めたい相手がまさにその「これ以上動くこと」だから。
   *
   *  戻り値は「init の `tools` を観測したか」— 呼び出し側はそれ以降の行をこの検査に
   *  通さない(1セッションに init 行は1本だけ、実測)。
   *
   *  init 行が無いセッション(壊れた行・`tools` を持たない init)は判定しない —
   *  観測が無いことを不成立に化けさせるのは正本(ping)の仕事である。サブエージェント
   *  を起こしたセッションでも親の stream に init 行は1本しか出ない(実測)ので、
   *  この判定が同一セッション内で二度走ることはない。 */
  private checkSessionToolSurface(
    task: Task,
    line: string,
    child: { kill(signal: NodeJS.Signals): void },
  ): boolean {
    const tools = parseInitTools(line);
    if (!tools) return false;
    const surface = checkToolSurface(tools, task.type);
    if (surface.available) return true;
    console.error(`[worker] tool surface drift on task ${task.id}: ${surface.reason}`);
    child.kill("SIGKILL");
    quarantineContainment(this.options.db, surface.reason, this.options.clock.now());
    return true;
  }

  kill(taskId: string, signal: KillSignal): void {
    this.running.get(taskId)?.kill(signal);
  }

  /** Scrapes the interactive /usage panel over a PTY (issue #81 / ADR 0028).
   *  The panel renders only under a TTY, and only the interactive session
   *  keeps the OAuth subscription auth that draws the % figures (`--bare`
   *  drops to API billing and the panel disappears). Runs in the board's own
   *  cwd (unlike start(), which pins cwd to the task's workspace) with
   *  --safe-mode so the board repo's CLAUDE.md/skills/MCP never leak into the
   *  probe. Auth/tokens are never touched — refresh is left to the CLI's own
   *  startup (ADR 0028's core constraint). Returns the captured raw text
   *  verbatim; ANSI stripping and extraction are parseUsage's job (#80). Any
   *  failure — spawn error, early exit, or timeout — resolves null so the
   *  scheduler fails closed, and the session is always torn down (Ctrl-C×2
   *  then kill) so no orphan is left behind. `--settings` pins the fullscreen
   *  renderer (see USAGE_TUI_SETTINGS) so the panel stays parseable regardless
   *  of the host's own TUI setting.
   *
   *  The old exec probe carried an ADR 0005 runaway *cost* ceiling
   *  (--model haiku/--max-turns/--max-budget-usd). That's gone: the
   *  interactive /usage panel makes no model call under subscription auth, so
   *  there is no cost to cap — runaway is bounded instead by time
   *  (USAGE_TIMEOUT_MS → SIGKILL). */
  async checkUsage(): Promise<string | null> {
    let session: PtyProcess;
    try {
      const settingsPath = join(this.logDir, "usage-tui-settings.json");
      writeFileSync(settingsPath, USAGE_TUI_SETTINGS);
      session = this.pty("claude", ["--safe-mode", "--settings", settingsPath], {
        cwd: process.cwd(),
        cols: PTY_COLS,
        rows: PTY_ROWS,
      });
    } catch {
      return null;
    }

    return new Promise<string | null>((resolve) => {
      let buffer = "";
      let promptSeen = false;
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let panelTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        clearTimeout(panelTimer);
        try {
          // Ctrl-C×2 nudges the interactive session to exit cleanly, then
          // SIGKILL as the backstop so a CLI that catches/ignores the default
          // hangup can never orphan (ADR 0028's "no orphan" is the hard
          // acceptance criterion, so make it uncatchable rather than trust the
          // TUI's signal handling).
          session.write(CTRL_C + CTRL_C);
          session.kill("SIGKILL");
        } catch {
          // already gone (e.g. finishing from onExit) — nothing left to do
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), USAGE_TIMEOUT_MS);

      session.onExit(() => finish(hasUsagePanel(buffer) ? buffer : null));

      session.onData((data) => {
        buffer += data;
        // pattern-wait for the prompt (never a fixed sleep), then let the box
        // settle before sending /usage once — a command typed the instant the
        // box renders is dropped (ADR 0028).
        if (!promptSeen && seen(buffer, PROMPT_READY_MARKER)) {
          promptSeen = true;
          settleTimer = setTimeout(() => session.write(`/usage${ENTER}`), USAGE_PROMPT_SETTLE_MS);
        }
        if (hasUsagePanel(buffer)) {
          // capture once the panel stops rendering (debounce), so a chunk
          // boundary can't strand a %/reset row we haven't buffered yet
          clearTimeout(panelTimer);
          panelTimer = setTimeout(() => finish(buffer), PANEL_QUIET_MS);
        }
      });
    });
  }
}
