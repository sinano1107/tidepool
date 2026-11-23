/** Quarantine(GLOSSARY.md)の種類の表(ADR 0137 決定1・2)。1種類足すことは下の表に
 *  1行足すことである。行が持つのは kind・散文の組み立て・停止範囲で、**いつ立てるかは
 *  呼び出し側に残る** —— 生きた検査の位置と順序は ADR 0008 / 0030 / 0052 が根拠を持つ。
 *
 *  鍵は全種類 `(kind, value)` で、1鍵につき開いた確認型 question は最大1枚。盤面全体で
 *  資源の名を持たない種類の value は NULL である。依存の向きはこの module → タスクの
 *  module であり、逆は張らない。 */
import { BOARD_ACTOR_ID } from "./actor-id.js";
import { CLAUDE_CLI_VERSION } from "./claude-cli-version.js";
import type { Db } from "./db.js";
import type { EventOrigin, ListedRefusal, ResourceStop, RowRefusalCause } from "./events.js";
import { GH_CLI_VERSION } from "./gh-cli-version.js";
import type { HaltKind } from "./halt-kind.js";
import { CANCEL_THE_RCAS, discardUncommitted, IF_REPOSITORY_PRESENT, namePickupPredicates } from "./pickup-predicates.js";
import { PROVIDER_VALUES, type Provider } from "./provider.js";
import { recordedPlace } from "./recorded-place.js";
import { canonicalHarness, type Harness } from "./registry.js";
import { cancelDiscards, DROP_TARGET_OPTION, getTask, holdsFirstCaptures, interviewRootIdOf, isRca, type QuestionItem, type ResourceStops, registerTask, type TargetKey, type Task, unsettledOpenersOf } from "./tasks.js";
import type { RoomRcaChoice } from "./wire-contract.js";

export const FAILED_TEARDOWN_QUESTION_TITLE = "the board's own teardown failed — pickup is stopped";
export const UNCLOSED_SESSION_QUESTION_TITLE = "the board could not close a worker session — pickup is stopped";
export const POLL_FAILURE_QUESTION_TITLE = "the board's poll keeps throwing";
/** workspace の Quarantine の選択肢(ADR 0373 決定2)。回答の文と完全に一致したときだけ盤面の行為を選ぶ。 */
const REPAIRED_BY_HAND = "repaired by hand";
export const RESTORE_THE_BASELINE = "restore the baseline";
/** ADR 0373 決定5: 戻す先の object が無い ref だけを今の値で基準に入れ、ほかは `restore the baseline` と同じ。 */
export const GIVE_UP_THE_LOST_REFS = "give up the lost refs and restore the baseline";
/** 面接室の名前にだけ加わる(ADR 0373 決定11)。 */
export const RUN_WITH_AN_EMPTY_ROOM = "run with an empty room";
interface QuarantineProse {
  title: string;
  purpose: string;
  completion_criteria: string;
  /** 省略時は「repaired by hand」の1択。空の配列は項目なし —— 回答では決着しない種類(ADR 0218 決定6)。 */
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
  // API キーを受けない正準経路は ADR 0098
  openai:
    "Sign in to ChatGPT with `codex login` using the board worker's isolated " +
    "`CODEX_HOME`; API keys are not accepted for the canonical Codex route.",
};

/** 表の行の Quarantine の値(ADR 0184 決定2): `provider/model`。Provider は閉じた列挙で `/` を
 *  含まないので、最初の `/` で割れば model id に `/` があっても組は一意に戻る。 */
export function tableRowValue(provider: Provider, model: string): string {
  return `${provider}/${model}`;
}

export function parseTableRowValue(value: string): { provider: Provider; model: string } {
  const at = value.indexOf("/");
  return { provider: value.slice(0, at) as Provider, model: value.slice(at + 1) };
}

/** workspace の封じ込めの Quarantine の値(ADR 0259 決定1): `harness/workspace`。Harness は閉じた列挙で `/` を含まないので、
 *  最初の `/` で割れば組は一意に戻る。 */
/** 文を句点で閉じる —— 次の文を足す理由や拒否の文に。すでに句点で終わる文(spec #3273 text B8)には足さない。 */
export const endSentence = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

export function workspaceContainmentValue(harness: Harness, workspace: string): string {
  return `${harness}/${workspace}`;
}

export function parseWorkspaceContainmentValue(value: string): { harness: Harness; workspace: string } {
  const at = value.indexOf("/");
  return { harness: value.slice(0, at) as Harness, workspace: value.slice(at + 1) };
}

/** 行の effort の Quarantine の値(ADR 0218 決定2): `provider/model/effort`。Provider と effort(閉じた5値、ADR 0216)は
 *  `/` を含まないので、最初と最後の `/` で割れば model id に `/` があっても組は一意に戻る。effort「無い」の行(ADR 0218 決定5)は
 *  最後の欄を空で綴る —— 5値はどれも空でないので取り違えない。 */
export function tableRowEffortValue(provider: Provider, model: string, effort: string | null): string {
  return `${tableRowValue(provider, model)}/${effort ?? ""}`;
}

export function parseTableRowEffortValue(value: string): { provider: Provider; model: string; effort: string | null } {
  const at = value.lastIndexOf("/");
  return { ...parseTableRowValue(value.slice(0, at)), effort: value.slice(at + 1) || null };
}

/** 行の effort の Quarantine の契機。DB に残さず、値の provider で決まる: Codex の一覧の照合は openai の行だけ、起動時の照合は
 *  anthropic / moonshot の行(どちらも claude CLI で走る)だけを入れる(#1655)。文面・回答の門・起動時の照合が読む。 */
export function tableRowEffortTrigger(provider: Provider): "codexModelList" | "startupReconciliation" {
  return provider === "openai" ? "codexModelList" : "startupReconciliation";
}

/** 行の effort の Quarantine の文面は契機ごとに組む。 */
const TABLE_ROW_EFFORT_PROSE: Record<ReturnType<typeof tableRowEffortTrigger>, (row: string, reason: string) => QuarantineProse> = {
  // 原因は断言しない(ADR 0184 決定1)
  codexModelList: (row, reason) =>
    rowQuarantineProse(
      row,
      `${reason}. This board's model list does not advertise this effort for this model — with this Codex CLI ` +
      "version and this account. The board does not know why. This row is out of pickup and Board calls while " +
      "this stands; other rows keep running, including this model's rows at other efforts.\n\n" +
      "Repair one of two ways:\n\n" +
      "1. Fix the table: in the settings tab, change this row's effort or delete the row. " +
      "This question then closes on its own.\n" +
      "2. If the effort is right, update tidepool or restore the account, then answer — the board reads the model " +
      "list again and accepts the answer only if it advertises this effort for this model.",
    ),
  // ADR 0218 決定6: 事実は tidepool の更新でしか変わらないので、回答では決着せず表の編集だけで決着する。
  // 「走れない」とも観測とも言わず、版の組み込みの規則と書くべき値(reason)を名指す
  startupReconciliation: (row, reason) => ({
    title: `execution-setting row ${row} does not run with the effort it names`,
    purpose:
      `Claude CLI ${CLAUDE_CLI_VERSION}'s built-in model rules do not run this row with the effort it names: ${reason}. ` +
      "This row is out of pickup and Board calls while this stands; other rows keep running, including this model's " +
      "rows at other efforts.\n\nRepair: in the settings tab, change this row's effort or delete the row. This " +
      "question then closes on its own — no answer settles it.",
    completion_criteria: `the execution-setting table no longer has the row ${row}`,
    question: [],
  }),
};

/** 行の Quarantine(model ごと・Codex の effort ごと)の question の形。違うのは本文だけ。 */
function rowQuarantineProse(row: string, purpose: string): QuarantineProse {
  return {
    title: `execution-setting row ${row} cannot run on this board`,
    purpose,
    completion_criteria: `${row} can run on this board again`,
    question: [
      {
        title: `Can ${row} run again?`,
        options: ["the row can run again"],
        recommendation: "the row can run again",
      },
    ],
  };
}

/** 行でない Interview の対象の question の2つの出口(ADR 0199 決定4)。 */
const RERUN_TARGET_OPTION = "run it again";

/** 行でない Interview の対象の question の形(ADR 0199 決定4)。表の行ではないので settings タブでは直らない。 */
function targetRefusalProse(target: string, reason: string, why: string, keep: string, recheck: string): QuarantineProse {
  return {
    title: `Interview target ${target} cannot run on this board`,
    purpose:
      `${reason}. ${why} Interview children that pin this target are not picked up while this stands; the other ` +
      "targets of their Interviews keep running. This target is not an execution-setting row, so the settings tab " +
      "does not repair it.\n\nAnswer one of two ways:\n\n" +
      `1. "${DROP_TARGET_OPTION}": the board cancels the unsettled children that pin this target. Their sibling ` +
      "children keep running; an Interview left with no answer to score and nothing unsettled ends. If the model " +
      "id is misspelled, choose this and register the Interview again with the right id.\n" +
      `2. "${RERUN_TARGET_OPTION}": ${keep} — ${recheck}, and the children are picked up again.`,
    completion_criteria: `${target} can run on this board again, or no Interview measures it`,
    question: [
      {
        title: `Run ${target} again, or stop measuring it?`,
        options: [RERUN_TARGET_OPTION, DROP_TARGET_OPTION],
        recommendation: RERUN_TARGET_OPTION,
      },
    ],
  };
}

/** Harness 単位の行(封じ込め能力・Worker MCP 到達性)が外す Provider: その Harness を正準経路に持つもの。 */
const providersOnHarnesses = (harnesses: string[]) => PROVIDER_VALUES.filter((provider) => harnesses.includes(canonicalHarness(provider)));

/** 表の並びは盤面全体の停止の列挙と同じ(containment → failedTeardown → unclosedSession →
 *  registryUnreadable → recordContainer)で、資源単位の種類がその後に続く。 */
export const QUARANTINES = [
  {
    kind: "containment" satisfies HaltKind,
    scope: "board",
    // 裸で走らせないのは ADR 0033 / ADR 0036
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "worker containment is not established — pickup is stopped",
      purpose:
        `${reason}. ` +
        "No agent task is picked up while this stands: a worker that believes it is contained " +
        "but is not is worse than no containment at all, so the board refuses to run one bare. " +
        "Repair the host, then answer — the board re-runs the capability " +
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
    kind: "unclosedSession" satisfies HaltKind,
    scope: "board",
    /** 断言するのは3つだけ(ADR 0344 決定3): どの session(task と spawn id)が・いつから閉じられず・盤面のコードが投げた例外の本文。
     *  task id から後は呼び出し側が reason に畳む。 */
    prose: (spawnId: string | null, reason: string): QuarantineProse => ({
      title: UNCLOSED_SESSION_QUESTION_TITLE,
      purpose:
        `the board's own code threw while writing the close of a worker session (spawn event ${spawnId}): ${reason}\n\n` +
        "No task is picked up while this stands. Answering closes that session again: " +
        "if it throws again the answer is refused, this question stays open, and the refusal carries that run's " +
        "exception body. If the session is already closed, the answer passes as is.",
      completion_criteria: "that session's record is closed",
    }),
  },
  {
    kind: "registryUnreadable" satisfies HaltKind,
    scope: "board",
    // 答えの本文を修理メモに残すのは ADR 0052、github-login は ADR 0093。原因は remote への到達・registry clone の default branch
    // (ADR 0377 決定7)・読み込みと検査(ADR 0403 決定5)の3つなので、文はどれにも真に書く。remote の無い盤面にも立つ
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "registry is unavailable — pickup and landing are stopped",
      purpose:
        `${reason}\n\nNo agent task is picked up and no completed task is landed while this stands, because both ` +
        "read the registry. Repair what the reason above names — the registry's files (they must parse and pass the " +
        "registry's checks), or, on a board with a registry remote, access to that remote or the registry clone's " +
        "default branch — then answer. The board reads the registry again (and, with a remote, fetches it) before " +
        "accepting the answer, and keeps any answer text as a repair note. If the board's GitHub login was revoked " +
        "or is missing, run `npm run github-login` on the board host first.",
      completion_criteria:
        "the registry can be read and passes its checks, and with a registry remote, the remote main is reachable and " +
        "the registry clone's origin/HEAD points at origin/main or is absent",
    }),
  },
  {
    kind: "recordContainer" satisfies HaltKind,
    scope: "board",
    // 断言するのは、どの task の・どの path への書き込みが・どの例外で落ちたか(reason)だけで、原因の所在は言わない(ADR 0266 決定3)。
    // 踏んだ task がどうなったか(`todo` へ戻った / 自分の failure question を持つ)は入口ごとに違うので、観測した入口が reason に書く
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "the board's record container cannot be written — pickup is stopped",
      purpose:
        `${reason}\n\n` +
        "No task is picked up while this stands. " +
        "Answering checks the same container by writing a file to that directory and removing it: if the write " +
        "still fails the answer is refused and this question stays open. Any answer text is kept as a repair note.",
      completion_criteria: "the board's record container can be written again",
    }),
  },
  {
    // 続く poll の失敗(ADR 0294 決定2): 機構だけを借り、何も止めない —— pickup を止めているのは失敗そのもの。
    // 断言するのは いつから・何回・最初と最新の例外の本文 だけで(呼び出し側が reason に畳む)、原因の所在は言わない
    kind: "pollFailure",
    scope: "none",
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: POLL_FAILURE_QUESTION_TITLE,
      purpose:
        `${reason}\n\n` +
        "Answering re-runs the poll: if it throws again the answer is refused, this question stays open, " +
        "and the refusal carries that run's exception body.",
      completion_criteria: "a poll runs without throwing",
    }),
  },
  {
    // 続く issue 展開の一時的失敗(ADR 0328 決定3): 機構だけを借り、何も止めない —— 除外が機構で、question は信号。
    // 断言するのは いつから・何回・最初と最新の例外の本文・最後に止めた task だけで(呼び出し側が reason に畳む)
    kind: "issueExpansion",
    scope: "none",
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "the board keeps failing to read GitHub issues at pickup",
      purpose:
        `${reason}\n\n` +
        "Each poll in which an issue read fails leaves out the tasks that read GitHub at pickup (issue-backed tasks and " +
        "the children of an issue-backed parent); other tasks are still picked up. Answering re-reads the last issue " +
        "that failed: if it still fails the answer is refused, this question stays open, and the refusal carries that " +
        "exception body. An issue read that succeeds settles this question without an answer.",
      completion_criteria: "the board reads GitHub issues at pickup again",
    }),
  },
  {
    // gh の版(ADR 0402 決定3): 機構だけを借り、何も止めない —— 止めるのは gh を撃つたびの版の門で、question は信号。
    // 断言するのは宣言の版と観測した版(または読めなかった理由)で、呼び出し側が門の拒否の文を reason に渡す
    kind: "ghVersion",
    scope: "none",
    prose: (_value: string | null, reason: string): QuarantineProse => ({
      title: "the board's gh is not the pinned version",
      purpose:
        `${endSentence(reason)}\n\n` +
        "The board does not run gh while this stands: tasks that read GitHub at pickup sit out each poll (other tasks are " +
        "still picked up), landing and the auto-merge queue wait without asking about any PR, and human actions that run gh " +
        `are refused. To repair, restart the Lima VM so its provision installs gh ${GH_CLI_VERSION} from \`gh-cli-version\`, ` +
        `or put gh ${GH_CLI_VERSION} on the board's PATH by hand.\n\n` +
        "Answering re-reads `gh --version`: if it still does not match, the answer is refused and this question stays open. " +
        "A gh call that succeeds settles this question without an answer.",
      completion_criteria: `the board's gh is ${GH_CLI_VERSION}`,
    }),
  },
  {
    kind: "workspace",
    scope: "workspace",
    // 解除の門が撃つ pickup の述語の一覧をそのまま予告し、解除だけの上乗せを名前の場所に添える(ADR 0329 決定4・5・追記 決定6)
    prose: (name: string | null, reason: string, _cause: RowRefusalCause | undefined, db: Db): QuarantineProse => {
      const room = getTask(db, name!)?.type === "interview";
      const recorded = room ? recordedPlace(db, name!) : undefined;
      // 予告は説明だけを読む —— 検査は撃たないので、実環境の在り処と規約の基点は要らない
      const predicates = namePickupPredicates(db, name!, { name: name!, path: "" }, "");
      const checks = [...(room ? [] : [`a workspace named "${name}" is still configured (the board can resolve it).`]), ...predicates.map((p) => p.describe)];
      // 固定点との交差は pickup の述語として上の一覧に並ぶ(ADR 0377 決定4)。clean は解除の門が撃つ順どおり項の後(ADR 0386 決定4)
      if (!room || recorded?.hasRepository !== false) checks.push(...[
        `it is a usable git repository whose working tree is clean (\`git status --porcelain\` runs and is empty).${discardUncommitted("uncommitted changes")}`,
      ].map((check) => room && !recorded ? `${IF_REPOSITORY_PRESENT}${check}` : check));
      return {
        title: `workspace ${name} needs human attention`,
        purpose:
          // 理由が自分で文を閉じていれば句点を重ねない(spec #3273 text A12 の文は句点で終わる)
          `${endSentence(reason)} ${firstCapturesWait(db, name!)}` +
          "Tasks in this workspace stay out of the slot until it is repaired. " +
          "Answering confirms the repair — the board re-checks all of the following before " +
          "it accepts the answer, and refuses it if any fails:\n\n" +
          checks.map((check, i) => `${i + 1}. ${check}\n`).join("") +
          // 本文は1度だけ書かれ、解除の門は名前を開く未決着の task を回答時に数え直す(ADR 0329 決定4 の Status 追記)
          (room ? "\nA task that starts opening this name after this question was opened adds its own check of the same kind when the answer is checked.\n" : "") +
          // ADR 0369 決定6: 受理は済まなかった解放をやり直す —— 登録した観測者に依らない文だけを本文に置く
          "\nAccepting the answer also finishes the releases this workspace kept from finishing, bringing each such task's last session's work to its task branch.\n" +
          // ADR 0373 決定2・16: 受理は全 ref が基準と同じことを確かめ、選択肢がそれぞれ何をするかを言う(spec #3273 text B1)。ADR 0392 決定4: give-up で `task/<id>` が今の値で入らないことを言う
          `\nAnswering checks that every ref of ${room ? `the interview room ${name}` : `workspace ${name}`} equals the board's baseline; nothing that moved is accepted. ` +
          `\`${REPAIRED_BY_HAND}\`: you repaired something other than refs — the board checks and refuses if a ref differs. ` +
          `\`${RESTORE_THE_BASELINE}\`: the board writes every differing ref back to the baseline and keeps each value it removes under \`refs/keep-around/<sha>\`. ` +
          `\`${GIVE_UP_THE_LOST_REFS}\`: the same, and refs whose commits no longer exist are accepted as they are now, except a lost task branch \`task/<id>\`: the board keeps its current value under \`refs/keep-around/<sha>\` and deletes it, and the next pickup or start_work of an unsettled task makes it again; landing ends for a completed root whose work was lost with its branch, and the reviews and repairs attached to such work, and to work that returns into it, are cancelled. ` +
          "If a merge back conflicts, the refusal says where to resolve it." +
          (room ? ` \`${RUN_WITH_AN_EMPTY_ROOM}\`: the board re-creates the room empty.` : "") +
          "\n\nAny answer text is kept as a repair note.",
        completion_criteria: "the workspace is repaired by hand",
        // 選択肢は常設で、場面ごとに出し分けない(ADR 0373 決定2)—— 回答は自由記述のままで、選択肢と一致しない文は `repaired by hand`
        question: [{ title: `workspace ${name} needs human attention`, options: [REPAIRED_BY_HAND, RESTORE_THE_BASELINE, GIVE_UP_THE_LOST_REFS, ...(room ? [RUN_WITH_AN_EMPTY_ROOM] : [])], recommendation: REPAIRED_BY_HAND }],
      };
    },
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
        "Answering confirms the repair — the board re-checks the following before it accepts " +
        "the answer, and refuses it only if neither holds (either one is enough):\n\n" +
        `1. an agent named "${name}" is back in the registry (never true when no registry is ` +
        "configured).\n" +
        "2. no unsettled task (neither done nor cancelled, including one still running) is " +
        "still assigned to it (e.g. its tasks were reassigned to another agent), and none of " +
        "its completed tasks still waits to land on its profile " +
        "(a queued PR already merged on GitHub is observed and no longer waits).\n\n" +
        "Any answer text is kept as a repair note.",
      completion_criteria: "the agent is repaired by hand",
    }),
  },
  {
    kind: "providerAuth",
    scope: "assignees",
    excludesProviders: (providers: string[]) => providers as Provider[],
    prose: (provider: string | null, reason: string): QuarantineProse => ({
      title: `${provider} authentication is unavailable — pickup of ${provider}-speaking agents is stopped`,
      purpose:
        `${reason}, so the board has stopped pickup of the agents declared with ` +
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
    excludesProviders: providersOnHarnesses,
    prose: (harness: string | null, reason: string): QuarantineProse => ({
      title: `${harness} Harness containment is not established`,
      purpose:
        `${reason}. Agents whose canonical route uses ${harness} stay out of the ` +
        "slot until it is repaired. Answering confirms the repair; the board re-runs the same " +
        "Harness check before accepting the answer.",
      completion_criteria: `the ${harness} Harness containment is repaired by hand`,
    }),
  },
  {
    // Worker MCP 到達性(GLOSSARY.md「Quarantine」/ ADR 0331 決定7)。値は Harness 名。止める範囲は封じ込め能力と同じ形
    kind: "workerMcpReachability",
    scope: "assignees",
    excludesProviders: providersOnHarnesses,
    prose: (harness: string | null, reason: string): QuarantineProse => ({
      title: `${harness} Worker MCP reachability is not established`,
      purpose:
        `${reason}. This is Worker MCP reachability — whether a ${harness} worker can report to the board — ` +
        `not containment, which is whether a worker is confined. Agents whose canonical route uses ${harness} ` +
        "stay out of the slot until it is repaired; other Harnesses keep running. Answering confirms the repair; " +
        `before accepting the answer the board starts one ${harness} probe that connects to the Worker MCP from ` +
        "inside the Harness sandbox, and refuses the answer while it still cannot connect.",
      completion_criteria: `${harness} workers reach the board's Worker MCP again`,
    }),
  },
  {
    // 値は `workspaceContainmentValue` の綴り。Harness 名として読む箇所(停止の読み口・Harness の文面と検査・resolver)は
    // `harnessContainment` の kind で引くので、この種類は混ざらない
    kind: "workspaceContainment",
    scope: "pair",
    prose: (value: string | null, reason: string, _cause: RowRefusalCause | undefined, db: Db): QuarantineProse => {
      const { harness, workspace } = parseWorkspaceContainmentValue(value!);
      return {
        title: `${harness} workers cannot be contained in workspace ${workspace}`,
        purpose:
          `${endSentence(reason)} ${firstCapturesWait(db, workspace)}Tasks in workspace ${workspace} stay off the ${harness} route until this is repaired; ` +
          `other Harnesses in this workspace and ${harness} in other workspaces keep running. ` +
          "Repair the checkout as described above, then answer — the board re-runs the " +
          `${harness} check on workspace ${workspace} before it accepts the answer, and refuses it while ` +
          "the check still fails. Any answer text is kept as a repair note.",
        completion_criteria: `the ${harness} containment in workspace ${workspace} is repaired by hand`,
      };
    },
  },
  {
    // 行の拒否(GLOSSARY.md / ADR 0184)。値は `tableRowValue` の綴り。文面は原因を断言しない(決定1)——
    // 例外は CLI の版の古さで、構造化された証拠が区別するので原因を名指す(ADR 0187 決定3)。原因は値に
    // 入れない: 鍵は (provider, model) で、別の原因の2度目の観測は何も足さず文面は最初の原因のまま(ADR 0366 決定1)
    kind: "tableRow",
    scope: "row",
    prose: (value: string | null, reason: string, refusalCause?: RowRefusalCause): QuarantineProse => {
      const { provider, model } = parseTableRowValue(value!);
      const row = `${provider} / ${model}`;
      const [why, keepRow] =
        refusalCause === "cli_version_too_old"
          ? [
              "This board's Claude Code CLI is older than this model requires, so the " +
                `${provider} provider refused the model id \`${model}\` on this board.`,
              "To keep this row, update tidepool to a version that supports this model, then answer",
            ]
          : [
              `The ${provider} provider refused the model id \`${model}\` on this board — ` +
                "with this CLI version and this account. The board does not know why.",
              "If the model id is right, update tidepool or restore the account, then answer",
            ];
      return rowQuarantineProse(
        row,
        `${reason}. ${why} This row is out of pickup and Board calls while this stands; ` +
          "other rows keep running.\n\nRepair one of two ways:\n\n" +
          "1. Fix the table: in the settings tab, change this row's model or delete the row. " +
          "This question then closes on its own.\n" +
          `2. ${keepRow} — the board checks this model id again before it accepts the answer.`,
      );
    },
  },
  {
    // 行の effort の Quarantine(ADR 0218 決定2)。値は `tableRowEffortValue` の綴りで、資源の単位は行
    kind: "tableRowEffort",
    scope: "row",
    prose: (value: string | null, reason: string): QuarantineProse => {
      const { provider, model, effort } = parseTableRowEffortValue(value!);
      return TABLE_ROW_EFFORT_PROSE[tableRowEffortTrigger(provider)](`${provider} / ${model} / ${effort ?? "no effort"}`, reason);
    },
  },
  {
    // 行でない Interview の対象の拒否(ADR 0199 決定4、issue #1410)。値は `tableRowValue` の綴りで、鍵は (provider, model)。
    // 資源には数えない(回答が修理の確認とは限らない)—— 止めるのは鍵に当たる pin の子だけで、scheduler の候補の口が外す。
    // 原因は断言しない(ADR 0184 決定1)、CLI の版の古さだけは名指す(ADR 0187 決定3)
    kind: "interviewTarget",
    scope: "target",
    prose: (value: string | null, reason: string, refusalCause?: RowRefusalCause): QuarantineProse => {
      const { provider, model } = parseTableRowValue(value!);
      const [why, keep] =
        refusalCause === "cli_version_too_old"
          ? [
              `This board's Claude Code CLI is older than this model requires, so the ${provider} provider refused the model id \`${model}\` on this board.`,
              "update tidepool to a version that supports this model first",
            ]
          : [
              `The ${provider} provider refused the model id \`${model}\` on this board — with this CLI version and this account. The board does not know why.`,
              "if the model id is right, update tidepool or restore the account first",
            ];
      return targetRefusalProse(`${provider} / ${model}`, reason, why, keep, "the board checks this model id again before it accepts the answer");
    },
  },
  {
    // 同じ question の effort の鍵(ADR 0218 決定2): Codex の一覧がその model にこの effort を広告しない。値は `tableRowEffortValue` の綴り
    kind: "interviewTargetEffort",
    scope: "target",
    prose: (value: string | null, reason: string): QuarantineProse => {
      const { provider, model, effort } = parseTableRowEffortValue(value!);
      return targetRefusalProse(
        `${provider} / ${model} / ${effort ?? "no effort"}`,
        reason,
        "This board's model list does not advertise this effort for this model — with this Codex CLI version and this account. The board does not know why.",
        "if the effort is right, update tidepool or restore the account first",
        "the board reads the model list again and accepts the answer only if it advertises this effort for this model",
      );
    },
  },
] as const satisfies ReadonlyArray<{
  kind: string;
  /** 止まる範囲: 盤面全体 / その workspace のタスク / 値が指す assignee 群のタスク /
   *  表の行(selector が表から外す。タスクも entry も止めないので `ResourceStops` に入らない)/
   *  (Harness, workspace) の組(その workspace の task の候補から、その Harness の行だけを外す)/
   *  行でない Interview の対象(鍵に当たる pin の子の候補を外す。資源ではない)/ 何も止めない(続く poll の失敗、ADR 0294 決定2 ・
   *  続く issue 展開の一時的失敗、ADR 0328 決定3・gh の版、ADR 0402 決定3)。 */
  scope: "board" | "workspace" | "assignees" | "row" | "pair" | "target" | "none";
  /** assignee 群単位の行が値を agent 名へ写す写像のうち、行そのものが知っているもの。
   *  無い行は合成 root の `QuarantineResolvers` から受ける(registry は読まない、ADR 0041)。 */
  resolveAssignees?: (values: string[]) => string[];
  /** entry 経路(ADR 0110 決定3)で値が外す Provider —— 「その Provider では走れない」
   *  種類だけが持つ。agent 名ではなく entry を外すので `QuarantineResolvers` とは別の写像。 */
  excludesProviders?: (values: string[]) => Provider[];
  /** `cause` は `tableRow` だけが読む行の拒否の証拠の種類。`db` は workspace の行だけが読む(面接室か、その repo があるか)。 */
  prose: (value: string | null, reason: string, cause: RowRefusalCause | undefined, db: Db) => QuarantineProse;
}>;

export type QuarantineKind = (typeof QUARANTINES)[number]["kind"];

/** 解除の門(ADR 0137 決定5): kind → 受理の直前に撃ち直す検査。不成立なら理由つきで
 *  投げる。合成 root が組み、その kind の検査が無い盤面では回答を拒む。`answer` は回答の文 —— workspace の検査だけが読み、
 *  選択肢で盤面の行為を選ぶ(ADR 0373 決定2)。`origin` は回答が届いた面(ADR 0371 決定8)—— 取り込みの event が回答者として残す(spec #3273 の識別子の表 / pin A5)。盤面が書いたことを応答で言う検査は `notice` を返す。
 *  執行が書き込みより先に commit する検査は確認を返し、回答の書き込みと同じ同期区間で条件を読み直す。
 *  資源を検証する検査は返さない —— 資源を確かめるだけで書き込みより先に commit する執行が無く、読み直す条件が立たない(ADR 0343 決定1)。
 *  `withAnswer` は回答の書き込みと同じ transaction の中で、答えた question の id を受けて撃つ段 —— 投げれば回答ごと巻き戻る(面接室の Quarantine の受理、ADR 0385 決定3・6)。 */
export type QuarantineChecks = Partial<Record<QuarantineKind, (value: string | null, answer: string | undefined, origin: EventOrigin) => Promise<void | (() => void) | { notice?: string; withAnswer?: (questionId: string) => void }>>>;

/** kind → 値の集合を agent 名の集合へ写す resolver。合成 root が registry から組む。
 *  無い kind の値は誰も止めない。 */
export type QuarantineResolvers = Partial<Record<QuarantineKind, (values: string[]) => string[]>>;

function addResourceStops(stops: ResourceStops, row: (typeof QUARANTINES)[number], values: string[], resolvers: QuarantineResolvers): void {
  if (values.length === 0) return;
  if (row.scope === "workspace") stops.workspaces.push(...values);
  if (row.kind === "workspaceContainment") (stops.containmentWorkspaces ??= []).push(...values.map((value) => parseWorkspaceContainmentValue(value).workspace));
  if (row.scope === "assignees") {
    const resolve = "resolveAssignees" in row ? row.resolveAssignees : resolvers[row.kind];
    stops.assignees.push(...(resolve?.(values) ?? []));
  }
}

/** ADR 0137 決定6 / ADR 0368 決定1: 1件の停止の範囲を、開いている停止の集計と同じ行から引く。 */
/** ADR 0373 決定13 追記: 基準の行を持つ面接室でない名前の Quarantine が開いている間、行の無い名前の最初の撮りは理由を問わず待つ ——
 *  本文はそれを毎回言う。 */
function firstCapturesWait(db: Db, name: string): string {
  return holdsFirstCaptures(db, name) ? "Workspaces that have not captured a baseline yet also wait until this question is closed. " : "";
}

export function quarantineStop(kind: "workspace" | "agent" | "workspaceContainment", value: string): ResourceStops {
  const stops: ResourceStops = { workspaces: [], assignees: [] };
  addResourceStops(stops, QUARANTINES.find((row) => row.kind === kind)!, [value], {});
  return stops;
}

/** 開いた quarantine が止めるもの(ADR 0137 決定6)。資源単位の行を停止範囲で畳む:
 *  workspace 単位は開いている値そのもの、assignee 群単位は値を写した agent 名。
 *  pickup 述語・キューの skipped・直接 cancel の門はこの1つの答えを受け取る。 */
export function quarantineStops(db: Db, resolvers: QuarantineResolvers = {}): ResourceStops {
  const stops: ResourceStops = { workspaces: [], assignees: [] };
  for (const row of QUARANTINES) {
    if (row.scope !== "workspace" && row.scope !== "assignees" && row.scope !== "pair") continue;
    addResourceStops(stops, row, openQuarantineValues(db, row.kind) as string[], resolvers);
  }
  return stops;
}

/** 開いた quarantine の停止を立てた question —— 資源の名(workspace 名・写した agent 名)→ question の id(`quarantineStops` と同じ行と
 *  resolver から)。直接 cancel の門の拒否文が先に答える question を名指す(ADR 0385 決定4)。 */
export function quarantineStopQuestions(db: Db, resolvers: QuarantineResolvers = {}): { workspaces: Record<string, string>; assignees: Record<string, string> } {
  const questions = { workspaces: {} as Record<string, string>, assignees: {} as Record<string, string> };
  for (const row of QUARANTINES) {
    if (row.scope !== "workspace" && row.scope !== "assignees") continue;
    for (const [value, id] of openQuarantineQuestions(db, row.kind)) {
      const stopped: ResourceStops = { workspaces: [], assignees: [] };
      addResourceStops(stopped, row, [value as string], resolvers);
      for (const name of stopped.workspaces) questions.workspaces[name] ??= id;
      for (const name of stopped.assignees) questions.assignees[name] ??= id;
    }
  }
  return questions;
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

/** その種類で開いている確認型 question を、値 → question id で。 */
export function openQuarantineQuestions(db: Db, kind: QuarantineKind): Map<string | null, string> {
  const rows = db
    .prepare(
      `SELECT question_quarantine_value AS value, id FROM tasks
       WHERE question_quarantine_kind = ? AND status = 'todo'`,
    )
    .all(kind) as Array<{ value: string | null; id: string }>;
  return new Map(rows.map((row) => [row.value, row.id]));
}

/** The agent-name generalization of workspace.ts's quarantineWorkspace (ADR
 *  0012 / issue #36): put the repair in front of the human as a 1-choice
 *  Confirmation question (its tasks stay out of the slot while it is open) —
 *  same shape, same "1 resource, at most 1 open question" dedup (GLOSSARY.md's
 *  Quarantine). Lives here rather than in agent.ts because landing.ts calls it
 *  and agent.ts value-imports landing.ts — a cycle ADR 0204 決定1 forbids
 *  (issue #1709). */
export function quarantineAgent(db: Db, agentName: string, cause: unknown, now: Date): ResourceStop {
  return registerResourceStop(db, "agent", agentName, cause instanceof Error ? cause.message : String(cause), now);
}

/** 資源の Quarantine を登録し、止めた資源を返す —— 呼び手が `pickup_stopped` / `session_stopped_by_resource` に刻む(ADR 0274 / ADR 0331 決定9)。 */
export function registerResourceStop(
  db: Db,
  quarantine: ResourceStop["quarantine"],
  value: string | null,
  reason: string,
  now: Date,
): ResourceStop {
  registerQuarantine(db, quarantine, value, reason, now);
  return { quarantine, value, reason };
}

/** 面接室の Quarantine の読み口に、面接室を開く未決着の RCA が居る間だけ添える選択肢・その説明・捨てられる done の work(ADR 0385 決定5)。
 *  保存しない —— 表示のたびに記録だけから導き、git を撃たない。question の選択肢・本文・cancel option の列には入れない(Quarantine の行は
 *  cancel option を持たない、ADR 0246 決定3)。回答を受け付けるかは表示に依らず、回答の時点の状態で決まる。居なければ null。 */
export function roomRcaChoice(db: Db, question: Pick<Task, "id" | "question_quarantine_kind" | "question_quarantine_value">): RoomRcaChoice | null {
  const name = question.question_quarantine_value;
  // 読み口は表示用の status を持つ行を渡すので、答えの済みは保存された status で見る
  if (question.question_quarantine_kind !== "workspace" || name === null || getTask(db, name)?.type !== "interview" || getTask(db, question.id)!.status !== "todo") return null;
  const rcas = unsettledOpenersOf(db, name).flatMap((task) => (isRca(db, task.id) ? [task.id] : []));
  if (rcas.length === 0) return null;
  return {
    option: CANCEL_THE_RCAS,
    description: `\`${CANCEL_THE_RCAS}\`: the board cancels, with their unsettled tasks, those of the RCAs ${rcas.join(", ")} whose objects are missing from this room when you answer, and accepts the answer only if every other check passes.`,
    discards: cancelDiscards(db, rcas),
  };
}

/** 唯一の登録口で冪等: 鍵が開いていれば何もしない、閉じていれば確認を1枚立てる(ADR 0366 決定1)—— 呼び手は開いているかを
 *  先に読まない。ある session が開いた停止に当たった事実は session 側の記録が持つ(決定2)。`cause` は文面へ渡す行の拒否の証拠の種類。 */
export function registerQuarantine(
  db: Db,
  kind: QuarantineKind,
  value: string | null,
  reason: string,
  now: Date,
  cause?: RowRefusalCause,
): void {
  if (openQuarantineQuestion(db, kind, value)) return;
  const row = QUARANTINES.find((r) => r.kind === kind)!;
  const { question, ...prose } = row.prose(value, reason, cause, db);
  registerTask(
    db,
    {
      type: "question",
      ...prose,
      question: question ?? [
        { title: prose.title, options: [REPAIRED_BY_HAND], recommendation: REPAIRED_BY_HAND },
      ],
      question_kind: { kind: "quarantine", quarantine: kind, value },
    },
    now,
    BOARD_ACTOR_ID,
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
  now: () => Date,
): Promise<boolean> {
  if (openQuarantineQuestion(db, kind, value)) return true;
  const result = await check();
  if (result.available) return false;
  // ADR 0404 決定1: Quarantine は検査が答えた後に読んだ時刻を持つ
  registerQuarantine(db, kind, value, result.reason, now());
  return true;
}

/** 行でない Interview の対象を Provider が断った(ADR 0199 決定4): 対象を名指す question を立てる(開いていれば何もしない)。
 *  鍵は原因で決まり、一覧が effort を広告しないときだけ (provider, model, effort)(ADR 0218 決定2)。理由は断られた子の Interview を名指す。 */
export function questionRefusedTarget(
  db: Db,
  child: Task,
  refusal: TargetKey & { cause: RowRefusalCause | ListedRefusal["cause"] },
  evidence: string,
  now: Date,
): void {
  // 受験者の root は対象の行から引く(ADR 0267 決定1)
  const root = getTask(db, interviewRootIdOf(db, child)!)!;
  const reason = `Task ${child.id} of Interview "${root.title}" (${root.id}) ${evidence}`;
  if (refusal.cause === "effort_not_advertised") {
    registerQuarantine(db, "interviewTargetEffort", tableRowEffortValue(refusal.provider, refusal.model, refusal.effort), reason, now);
  } else {
    const cause = refusal.cause === "model_not_listed" ? undefined : refusal.cause;
    registerQuarantine(db, "interviewTarget", tableRowValue(refusal.provider, refusal.model), reason, now, cause);
  }
}

/** この対象に当たる開いた question(model の鍵か effort の鍵)。開いているあいだ、その対象を pin した子は pickup されない。 */
export function refusedTargetQuestion(db: Db, target: TargetKey): { id: string } | undefined {
  return (
    openQuarantineQuestion(db, "interviewTarget", tableRowValue(target.provider, target.model)) ??
    openQuarantineQuestion(db, "interviewTargetEffort", tableRowEffortValue(target.provider, target.model, target.effort))
  );
}
