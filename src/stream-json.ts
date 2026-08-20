/** The claude CLI's `--output-format stream-json` line vocabulary, in one
 *  place. Two readers share it: the live tee in `claude-worker.ts` (result
 *  line, ADR 0039's tool surface, issue #33's advisor observations) and the
 *  after-the-fact projector in `precedent.ts` (ADR 0083 追記 2). The issue that
 *  asked for the projector (#356) also asked that the two not spell the same
 *  vendor shape twice — one place to fix when the CLI moves, and no import
 *  cycle between the adapter and the projector. */

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

/** The line-taking form, for the `/usage` init ping — it reads its own stdout
 *  and has no other concern to share a decode with. */
export const parseInitField = (line: string, field: "skills" | "tools"): string[] | null =>
  readInitField(parseStreamLine(line), field);

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

/** How many advisor consultations one assistant line carries (issue #33).
 *  The advisor is a **server tool**: it shows up as a `server_tool_use` block
 *  named `advisor` beside ordinary `tool_use` blocks in the same stream, so the
 *  block type has to be checked too — an ordinary tool that happened to be
 *  named `advisor` is not a consultation. The advice itself is encrypted
 *  (`advisor_redacted_result`), so the fact and the count are all that is
 *  observable; that is exactly what is being counted here.
 *
 *  ADR 0039's init-line observation cannot substitute: a server tool appears
 *  neither in init's `tools` array nor as an `advisorModel` field (measured). */
export function countAdvisorConsultations(parsed: Record<string, unknown> | null): number {
  if (parsed === null || parsed.type !== "assistant") return 0;
  const content = (parsed.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => {
    if (typeof block !== "object" || block === null) return false;
    const { type, name } = block as Record<string, unknown>;
    return type === "server_tool_use" && name === "advisor";
  }).length;
}
