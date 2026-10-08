/** The claude CLI's `--output-format stream-json` line vocabulary, in one
 *  place. Two readers share it: the live tee in `claude-worker.ts` (result
 *  line, ADR 0039's tool surface, issue #33's advisor observations) and the
 *  after-the-fact projector in `precedent.ts` (ADR 0083 追記 2). The issue that
 *  asked for the projector (#356) also asked that the two not spell the same
 *  vendor shape twice — one place to fix when the CLI moves, and no import
 *  cycle between the adapter and the projector. */

import type { ModelSwap } from "./events.js";

/** One stream-json line, decoded once. The board reads several independent
 *  things off the worker's stdout — the result event, ADR 0039's tool surface,
 *  and issue #33's advisor observations — and each used to re-decode the line
 *  itself, so a session paid one `JSON.parse` per concern per line on lines
 *  that can be large (a whole assistant message). Decode here, and let each
 *  reader below take the decoded object.
 *
 *  Fail-closed, as every vendor-shape read here is: a blank line, or one split
 *  mid-chunk or genuinely malformed, is simply not a line anyone can read
 *  anything from. */
export function parseStreamLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Is this the `type: "system", subtype: "init"` line — the CLI's own report of
 *  what it resolved for the session? One per session, even when the session
 *  raised subagents (measured). */
const isInitLine = (parsed: Record<string, unknown> | null): boolean =>
  parsed !== null && parsed.type === "system" && parsed.subtype === "init";

/** The init line's string-array fields. `skills` is ADR 0025's enumeration;
 *  `tools` is the surface ADR 0039 compares against the board's Tool allowlist.
 *  Fail-closed: a non-init line, or a field that isn't an array of strings,
 *  reads as "not the init report" rather than as an empty answer. */
export function readInitField(
  parsed: Record<string, unknown> | null,
  field: "skills" | "tools",
): string[] | null {
  if (!isInitLine(parsed)) return null;
  const value = (parsed as Record<string, unknown>)[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value as string[];
}

/** The init line's `mcp_servers` — **the names only** (ADR 0108 決定2). Beside
 *  `readInitField` rather than inside it: that one's contract is "a field that
 *  is an array of strings", and this field is an array of `{name, status}`
 *  objects, so generalizing it would dirty the `skills`/`tools` contract for
 *  one caller.
 *
 *  `status` is deliberately dropped on the floor. The board compares names and
 *  only in the excess direction — a `tidepool` that shows up `status: "failed"`
 *  is a *missing*-side event, which ADR 0039 決定3 chose not to fail containment
 *  on; returning the status here would invite that back in through the side
 *  door. Reading the surface at all (rather than counting `mcp__` verbs in
 *  `tools`) is what catches a server that is attached but hands out no verbs.
 *
 *  Fail-closed like every vendor-shape read here: a non-init line, a field that
 *  isn't an array, or an element with no name reads as "not the init report"
 *  rather than as an empty surface. */
export function readInitMcpServers(parsed: Record<string, unknown> | null): string[] | null {
  if (!isInitLine(parsed)) return null;
  const value = (parsed as Record<string, unknown>).mcp_servers;
  if (!Array.isArray(value)) return null;
  const names = value.map((entry) => (entry as { name?: unknown } | null)?.name);
  if (!names.every((name) => typeof name === "string")) return null;
  return names as string[];
}

/** The init line's `memory_paths.auto` — the host auto-memory directory the CLI
 *  loaded into this session (ADR 0156; measured 2.1.283: `memory_paths: {auto:
 *  <dir>}` while auto-memory is on, the whole field gone with
 *  `autoMemoryEnabled: false`). **Null here means closed** — `memory_paths`
 *  absent, or carrying only other kinds of memory — unlike the readers above,
 *  where null means "not the init report". Only `auto` is read, so a vendor
 *  adding another kind of memory does not quarantine the board.
 *
 *  A shape it cannot read is **not** closed: an `auto` that is not a string, or a
 *  `memory_paths` that is not an object, comes back as its JSON text so the caller
 *  fails it — the same fail-closed reading as `readInitMcpServers`. */
export function readInitAutoMemoryPath(parsed: Record<string, unknown> | null): string | null {
  if (!isInitLine(parsed)) return null;
  const paths = (parsed as Record<string, unknown>).memory_paths;
  if (paths === undefined || paths === null) return null;
  if (typeof paths !== "object" || Array.isArray(paths)) return JSON.stringify(paths);
  const auto = (paths as { auto?: unknown }).auto;
  if (auto === undefined) return null;
  return typeof auto === "string" ? auto : JSON.stringify(auto);
}

/** The init line's `model` — the CLI's **resolved** main model id, e.g.
 *  `claude-sonnet-5` for a `--model sonnet` spawn (issue #33, measured). Only
 *  used to decide whether the advisor's own usage is separable from the main
 *  model's. Scalar, hence not `readInitField`'s array read. */
export function readInitModel(parsed: Record<string, unknown> | null): string | null {
  if (!isInitLine(parsed)) return null;
  const model = (parsed as Record<string, unknown>).model;
  return typeof model === "string" ? model : null;
}

/** The init line's `claude_code_version` — the version of the CLI that wrote
 *  this transcript (ADR 0083 追記 2 の「版は3つ」の3本目). Null for a session
 *  whose init line predates the field: the projector records the absence
 *  rather than guessing, because this stamp is the only thing that separates
 *  "the projector changed" from "the CLI changed" when unknown-line counts
 *  move. Never a gate on running the session (ADR 0083 追記 2 / ADR 0042). */
export function readInitVersion(parsed: Record<string, unknown> | null): string | null {
  if (!isInitLine(parsed)) return null;
  const version = (parsed as Record<string, unknown>).claude_code_version;
  return typeof version === "string" ? version : null;
}

/** One advisor call's outcome: advice came back, or an error with its
 *  `error_code` verbatim (ADR 0214). */
export type AdvisorOutcome = "consulted" | { failed: string | null };

/** What one content block says about an advisor call (issue #33 / ADR 0214):
 *  `"consulted"` when it is an `advisor_tool_result` carrying advice
 *  (`advisor_redacted_result` — encrypted, so the fact is all that is
 *  observable), `{ failed }` when it carries `advisor_tool_result_error`
 *  (`error_code` verbatim, null when absent), and null for anything else.
 *
 *  The **result** decides, not the `server_tool_use` call: a call that comes
 *  back as an error never advised anything (ADR 0214 決定1). The result block
 *  alone settles it, so the call and the result may sit on one assistant line
 *  or on two (the real shape) without any pairing state. A result of neither
 *  observed type counts as neither — if the vendor renames the success type,
 *  consultations drop to 0 and ADR 0042's ratio shows it.
 *
 *  ADR 0039's init-line observation cannot substitute: a server tool appears
 *  neither in init's `tools` array nor as an `advisorModel` field (measured).
 *
 *  Two readers ask this — the live tee counts them, the projector places them
 *  as markers (ADR 0083 追記 2) — and the vendor's spelling is what would move,
 *  so it is spelled once. */
export function readAdvisorOutcome(block: unknown): AdvisorOutcome | null {
  if (typeof block !== "object" || block === null) return null;
  const { type, content } = block as Record<string, unknown>;
  if (type !== "advisor_tool_result" || typeof content !== "object" || content === null) return null;
  const { type: resultType, error_code } = content as Record<string, unknown>;
  if (resultType === "advisor_redacted_result") return "consulted";
  if (resultType === "advisor_tool_result_error") return { failed: typeof error_code === "string" ? error_code : null };
  return null;
}

/** The advisor outcomes one assistant line carries, in stream order (issue #33 / ADR 0214). */
export function readAdvisorOutcomes(parsed: Record<string, unknown> | null): AdvisorOutcome[] {
  if (parsed === null || parsed.type !== "assistant") return [];
  const content = (parsed.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.map(readAdvisorOutcome).filter((outcome) => outcome !== null);
}

/** `system/model_refusal_fallback` 行の差し替え(ADR 0215 決定2)。判定は `subtype` 1点で、欄は逐語 ——
 *  文字列でない欄は null(`scope` は schema の2値以外を null)。`direction` は読まない。 */
export function readModelSwap(parsed: Record<string, unknown> | null): ModelSwap | null {
  if (parsed?.type !== "system" || parsed.subtype !== "model_refusal_fallback") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const { original_model, fallback_model, scope, api_refusal_category } = parsed;
  return {
    from: text(original_model),
    to: text(fallback_model),
    scope: scope === "session" || scope === "local" ? scope : null,
    category: text(api_refusal_category),
  };
}

/** root のモデルの assistant 行か —— subagent の行は `parent_tool_use_id` を持つ。 */
export function isRootAssistant(parsed: Record<string, unknown> | null): parsed is Record<string, unknown> {
  return parsed?.type === "assistant" && parsed.parent_tool_use_id == null;
}

/** root(`isRootAssistant`)の assistant 行の拒否(ADR 0215 決定3)。
 *  `id` は `message.id` —— 1 message は block ごとに複数行に割れるので、数える側が重複を除く。
 *  `category` は `stop_details.category` の逐語で、無ければ null。 */
export function readRootRefusal(parsed: Record<string, unknown> | null): { id: unknown; category: string | null } | null {
  if (!isRootAssistant(parsed)) return null;
  const message = parsed.message as { id?: unknown; stop_reason?: unknown; stop_details?: { category?: unknown } } | undefined;
  if (message?.stop_reason !== "refusal") return null;
  const category = message.stop_details?.category;
  return { id: message.id, category: typeof category === "string" ? category : null };
}
