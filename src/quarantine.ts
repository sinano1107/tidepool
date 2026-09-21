/** Quarantine(CONTEXT.md)の種類の表(ADR 0137 決定1・2)。1種類足すことは下の表に
 *  1行足すことである。行が持つのは kind・散文の組み立て・停止範囲で、**いつ立てるかは
 *  呼び出し側に残る** —— 生きた検査の位置と順序は ADR 0008 / 0030 / 0052 が根拠を持つ。
 *
 *  鍵は全種類 `(kind, value)` で、1鍵につき開いた確認型 question は最大1枚。盤面全体で
 *  資源の名を持たない種類の value は NULL である。依存の向きはこの module → タスクの
 *  module であり、逆は張らない。 */
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { HaltKind } from "./halt-kind.js";
import { PROVIDER_VALUES, type Provider } from "./provider.js";
import { canonicalHarness } from "./registry.js";
import { BOARD_WORKER_ID, type QuestionItem, type ResourceStops, registerTask } from "./tasks.js";

export const FAILED_TEARDOWN_QUESTION_TITLE = "the board's own teardown failed — pickup is stopped";

interface QuarantineProse {
  title: string;
  purpose: string;
  completion_criteria: string;
  /** 省略時は「repaired by hand」の1択。 */
  question?: QuestionItem[];
}

/** Exhaustive repair guidance: adding a Provider is a compile error until its
 * own credential recovery path is written. */
const PROVIDER_AUTH_REPAIR_GUIDANCE: Record<Provider, string> = {
  anthropic:
    "Run `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` in " +
    "`/etc/default/tidepool`, and restart the service.",
  moonshot:
    "Place a valid Moonshot Platform API key in the board's key file " +
    "(`~/.tidepool/moonshot-api-key`, or the path `TIDEPOOL_MOONSHOT_API_KEY_FILE` " +
    "points at), mode 600.",
  openai:
    "Sign in to ChatGPT with `codex login` using the board worker's isolated " +
    "`CODEX_HOME`; API keys are not accepted for the canonical Codex route (ADR 0098).",
};

/** 表の並びは盤面全体の停止の列挙と同じ(containment → failedTeardown →
 *  registryReachability)で、資源単位の種類がその後に続く。 */
export const QUARANTINES = [
  {
    kind: "containment" satisfies HaltKind,
    scope: "board",
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "worker containment is not established — pickup is stopped",
      purpose:
        `${reason}. ` +
        "No agent task is picked up while this stands: a worker that believes it is contained " +
        "but is not is worse than no containment at all, so the board refuses to run one bare " +
        "(ADR 0033 / ADR 0036). Repair the host, then answer — the board re-runs the capability " +
        "check before it accepts the answer, and any answer text is kept as a repair note. " +
        "If the human surface is the broken half, run `npm run token` on the board and open the " +
        "bootstrap URL it prints on this device *before* answering: rotating the token kills the " +
        "cookie you are reading this with.",
      completion_criteria: "the host's worker containment is repaired by hand",
    }),
  },
  {
    kind: "failedTeardown" satisfies HaltKind,
    scope: "board",
    /** 断言するのは3つだけ(ADR 0112 決定5): どのタスクの後始末が・いつから未了で・盤面の
     *  コードが投げた例外の本文。後の2つは呼び出し側が reason に畳む。 */
    prose: (taskId: string | null, reason: string): QuarantineProse => ({
      title: FAILED_TEARDOWN_QUESTION_TITLE,
      purpose:
        `the board's own teardown for task ${taskId} threw this exception, and ${reason}\n\n` +
        "No task is picked up while this stands. Answering re-runs the same teardown: " +
        "if it throws again the answer is refused, " +
        "this question stays open, and the refusal carries that run's exception body.",
      completion_criteria: "the teardown for that task runs to completion",
    }),
  },
  {
    kind: "registryReachability" satisfies HaltKind,
    scope: "board",
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "registry remote is unreachable — pickup is stopped",
      purpose:
        `${reason}. No agent task is picked up while this stands because every spawn depends ` +
        "on the registry source of truth. Repair access to the registry remote, then answer — " +
        "the board refreshes it again before accepting the answer, and keeps any answer text as " +
        "a repair note (ADR 0052). If the board's GitHub login was revoked or is missing, run " +
        "`npm run github-login` on the board host first (ADR 0093).",
      completion_criteria: "the registry remote main is reachable again",
    }),
  },
  {
    kind: "workspace",
    scope: "workspace",
    prose: (name: string | null, reason: string): QuarantineProse => ({
      title: `workspace ${name} needs human attention`,
      purpose:
        `${reason}. ` +
        "Tasks in this workspace stay out of the slot until it is repaired. " +
        "Answering confirms the repair — the board verifies the tree is " +
        "clean before it resumes pickup; any answer text is kept as a repair note.",
      completion_criteria: "the workspace is repaired by hand",
    }),
  },
  {
    kind: "agent",
    scope: "assignees",
    resolveAssignees: (names: string[]) => names,
    prose: (name: string | null, reason: string): QuarantineProse => ({
      title: `agent ${name} needs human attention`,
      purpose:
        `${reason}. ` +
        "Tasks assigned to this agent stay out of the slot until it is repaired. " +
        "Answering confirms the repair — the board verifies before it resumes " +
        "pickup; any answer text is kept as a repair note.",
      completion_criteria: "the agent is repaired by hand",
    }),
  },
  {
    kind: "providerAuth",
    scope: "assignees",
    excludesProviders: (providers: string[]) => providers as Provider[],
    prose: (provider: string | null): QuarantineProse => ({
      title: `${provider} authentication is unavailable — pickup of ${provider}-speaking agents is stopped`,
      purpose:
        `A worker session or Board call returned an authentication failure while speaking the ${provider} ` +
        `provider, so the board has stopped pickup of the agents declared with ` +
        `\`provider: ${provider}\`. Workers and board calls on other providers are unaffected. ` +
        "Restore the credential:\n\n" +
        `1. ${PROVIDER_AUTH_REPAIR_GUIDANCE[provider as Provider]}\n` +
        "2. Return to this question and answer it.\n\n" +
        "The board checks authentication again before accepting the answer and resumes " +
        "pickup only after the check succeeds.",
      completion_criteria: `${provider} authentication has been restored`,
      question: [
        {
          title: `Has ${provider} authentication been restored?`,
          options: ["authentication restored"],
          recommendation: "authentication restored",
        },
      ],
    }),
  },
  {
    kind: "harnessContainment",
    scope: "assignees",
    excludesProviders: (harnesses: string[]) =>
      PROVIDER_VALUES.filter((provider) => harnesses.includes(canonicalHarness(provider))),
    prose: (harness: string | null, reason: string): QuarantineProse => ({
      title: `${harness} Harness containment is not established`,
      purpose:
        `${reason}. Agents whose canonical route uses ${harness} stay out of the ` +
        "slot until it is repaired. Answering confirms the repair; the board re-runs the same " +
        "Harness check before accepting the answer.",
      completion_criteria: `the ${harness} Harness containment is repaired by hand`,
    }),
  },
] as const satisfies ReadonlyArray<{
  kind: string;
  /** 止まる範囲: 盤面全体 / その workspace のタスク / 値が指す assignee 群のタスク。 */
  scope: "board" | "workspace" | "assignees";
  /** assignee 群単位の行が値を agent 名へ写す写像のうち、行そのものが知っているもの。
   *  無い行は合成 root の `QuarantineResolvers` から受ける(registry は読まない、ADR 0041)。 */
  resolveAssignees?: (values: string[]) => string[];
  /** entry 経路(ADR 0110 決定3)で値が外す Provider —— 「その Provider では走れない」
   *  種類だけが持つ。agent 名ではなく entry を外すので `QuarantineResolvers` とは別の写像。 */
  excludesProviders?: (values: string[]) => Provider[];
  prose: (value: string | null, reason: string) => QuarantineProse;
}>;

export type QuarantineKind = (typeof QUARANTINES)[number]["kind"];

/** 解除の門(ADR 0137 決定5): kind → 受理の直前に撃ち直す検査。不成立なら理由つきで
 *  投げる。合成 root が組み、その kind の検査が無い盤面では回答を拒む。 */
export type QuarantineChecks = Partial<Record<QuarantineKind, (value: string | null) => Promise<void>>>;

/** kind → 値の集合を agent 名の集合へ写す resolver。合成 root が registry から組む。
 *  無い kind の値は誰も止めない。 */
export type QuarantineResolvers = Partial<Record<QuarantineKind, (values: string[]) => string[]>>;

/** 開いた quarantine が止めるもの(ADR 0137 決定6)。資源単位の行を停止範囲で畳む:
 *  workspace 単位は開いている値そのもの、assignee 群単位は値を写した agent 名。
 *  pickup 述語・キューの skipped・直接 cancel の門はこの1つの答えを受け取る。 */
export function quarantineStops(db: Db, resolvers: QuarantineResolvers = {}): ResourceStops {
  const stops: ResourceStops = { workspaces: [], assignees: [] };
  for (const row of QUARANTINES) {
    if (row.scope === "board") continue;
    const values = openQuarantineValues(db, row.kind) as string[];
    if (values.length === 0) continue;
    if (row.scope === "workspace") {
      stops.workspaces.push(...values);
      continue;
    }
    const resolve = "resolveAssignees" in row ? row.resolveAssignees : resolvers[row.kind];
    stops.assignees.push(...(resolve?.(values) ?? []));
  }
  return stops;
}

/** 開いた quarantine が entry 経路で外す Provider。`excludesProviders` を持つ行を総なめに畳む。 */
export function quarantineExcludedProviders(db: Db): Provider[] {
  return QUARANTINES.flatMap((row) =>
    "excludesProviders" in row ? row.excludesProviders(openQuarantineValues(db, row.kind) as string[]) : [],
  );
}

/** その鍵の開いた確認型 question。NULL の value は `IS` でしか一致しない。 */
export function openQuarantineQuestion(
  db: Db,
  kind: QuarantineKind,
  value: string | null,
): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE question_quarantine_kind = ? AND question_quarantine_value IS ? AND status = 'todo'`,
    )
    .get(kind, value) as { id: string } | undefined;
}

/** その種類で開いている確認型 question の値を登録順に。 */
export function openQuarantineValues(db: Db, kind: QuarantineKind): Array<string | null> {
  return db
    .prepare(
      `SELECT question_quarantine_value FROM tasks
       WHERE question_quarantine_kind = ? AND status = 'todo' ORDER BY rowid`,
    )
    .pluck()
    .all(kind) as Array<string | null>;
}

/** 唯一の登録口。鍵が開いていれば既存の question に `quarantine_refired` を追記する
 *  だけで、それ以外は何もしない(1鍵につき確認は最大1枚)。 */
export function registerQuarantine(
  db: Db,
  kind: QuarantineKind,
  value: string | null,
  reason: string,
  now: Date,
): void {
  const existing = openQuarantineQuestion(db, kind, value);
  if (existing) {
    appendEvent(db, {
      taskId: existing.id,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "quarantine_refired", cause: reason },
      at: now,
    });
    return;
  }
  const row = QUARANTINES.find((r) => r.kind === kind)!;
  const { question, ...prose } = row.prose(value, reason);
  registerTask(
    db,
    {
      type: "question",
      ...prose,
      question: question ?? [
        { title: prose.title, options: ["repaired by hand"], recommendation: "repaired by hand" },
      ],
      quarantine: { kind, value },
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

/** 検査を撃って立てる種類の共有の手続き: 開いていれば検査を撃たずに止まったと答え
 *  (直っただけでは再開せず、人間の確認回答だけが門)、そうでなければ検査が不成立の
 *  ときだけ登録する。true は「pickup を止める」。 */
export async function quarantineUnlessClear(
  db: Db,
  kind: QuarantineKind,
  value: string | null,
  check: () => Promise<{ available: true } | { available: false; reason: string }>,
  now: Date,
): Promise<boolean> {
  if (openQuarantineQuestion(db, kind, value)) return true;
  const result = await check();
  if (result.available) return false;
  registerQuarantine(db, kind, value, result.reason, now);
  return true;
}
