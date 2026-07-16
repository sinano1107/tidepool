import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { UnknownAgentError } from "./agent.js";
import {
  assertValidAgentName,
  isSingleTwemojiGrapheme,
  loadRegistry,
  ownEntry,
  type AgentDefinition,
  type Registry,
} from "./registry.js";
import {
  assertRegistryCloneReady,
  pushRegistry,
  type RegistryCommitResult,
} from "./registry-write.js";
import { git, TIDEPOOL_GIT_IDENTITY } from "./workspace.js";

/** The WebUI's agent-creation verb (issue #70, #54 phase 1): every field an
 *  agent definition carries except `version` — that one is machine-stamped
 *  (create → "1"), never caller-supplied, so the input type simply doesn't
 *  have it. */
export interface CreateAgentInput {
  name: string;
  authority: string;
  description: string;
  icon?: string;
  model?: string;
  effort?: string;
  systemPrompt: string;
}

/** The input names an authority profile absent from the registry (issue #70,
 *  parent #54: the WebUI only offers picking an existing profile — a typo'd
 *  or stale name must not produce an agent no worker could ever spawn as). */
export class UnknownAuthorityProfileError extends Error {
  constructor(public readonly profileName: string) {
    super(`unknown authority profile: ${profileName}`);
    this.name = "UnknownAuthorityProfileError";
  }
}

/** The input's icon fails ADR 0026's structural check (a single
 *  Twemoji-covered emoji grapheme). Caught at the entrance, not left to the
 *  loader: a file written with an invalid icon would make every subsequent
 *  `loadRegistry` throw — one bad create must not brick the whole board. */
export class InvalidAgentIconError extends Error {
  constructor(public readonly icon: string) {
    super(`invalid agent icon "${icon}": must be a single Twemoji-covered emoji grapheme`);
    this.name = "InvalidAgentIconError";
  }
}

function assertValidIcon(icon: string | undefined): void {
  if (icon !== undefined && !isSingleTwemojiGrapheme(icon)) {
    throw new InvalidAgentIconError(icon);
  }
}

/** What every agent-admin verb needs: which registry clone to write
 *  `agents/<name>.md` into and commit — threaded in by the composition root,
 *  never read from env here (same shape as WorkspaceAdminDeps). */
export interface AgentAdminDeps {
  registryDir: string;
}

/** ADR 0020's agent half: write `agents/<name>.md` to the registry clone and
 *  commit it to local main directly — a WebUI-initiated registry change is
 *  the human's explicit act. */
export async function createAgent(
  input: CreateAgentInput,
  deps: AgentAdminDeps,
): Promise<RegistryCommitResult> {
  // 入口で検査してから読む: dirty tree の registry を検証の根拠にしない
  // (ADR 0020 の committed-main 読み取り規律 — workspace-create と同じ二段検査)
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir);
  assertValidAgentName(registry, input.name);
  assertKnownAuthority(registry, input.authority);
  assertValidIcon(input.icon);
  commitAgentFile(deps.registryDir, { ...input, version: "1" }, `create agent ${input.name} via WebUI`);
  return { pushed: pushRegistry(deps.registryDir) };
}

/** The edit half (issue #70): the same fields as creation — the form
 *  resubmits the whole definition and the file is rewritten wholesale
 *  (hand-written frontmatter comments are the accepted cost of an agent
 *  entering UI management; the systemPrompt body is kept verbatim). `name`
 *  picks the existing agent, and `version` stays machine-stamped: the last
 *  numeric segment of the stored version + 1. */
export type UpdateAgentInput = CreateAgentInput;

export async function updateAgent(
  input: UpdateAgentInput,
  deps: AgentAdminDeps,
): Promise<RegistryCommitResult> {
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir);
  const existing = ownEntry(registry.agents, input.name);
  if (!existing) throw new UnknownAgentError(input.name);
  assertKnownAuthority(registry, input.authority);
  assertValidIcon(input.icon);
  // no-change 編集はコミットなしの成功(workspace-create.ts の porcelain
  // チェックと同じ狙い)— version はここで見ない: 刻印だけが動く「編集」は
  // 存在せず、実効フィールドが同じ再送で刻印だけ進めない
  if (!sameEffectiveFields(existing, input)) {
    commitAgentFile(
      deps.registryDir,
      { ...input, version: bumpVersion(existing.version) },
      `update agent ${input.name} via WebUI`,
    );
  }
  return { pushed: pushRegistry(deps.registryDir) };
}

/** version 以外の全フィールド(編集フォームが送るもの)の一致。systemPrompt
 *  は保存される正規形(trim 済み — serializeAgentFile 参照)で比較する。 */
function sameEffectiveFields(existing: AgentDefinition, input: UpdateAgentInput): boolean {
  return (
    existing.authority === input.authority &&
    existing.description === input.description &&
    existing.icon === input.icon &&
    existing.model === input.model &&
    existing.effort === input.effort &&
    existing.systemPrompt === input.systemPrompt.trim()
  );
}

/** One agent as the settings surface's edit form needs it (issue #70):
 *  the full definition, systemPrompt included — the form resubmits every
 *  field, so the view must carry every field. */
export type AgentView = AgentDefinition;

export function listAgentViews(deps: AgentAdminDeps): AgentView[] {
  return Object.values(loadRegistry(deps.registryDir).agents);
}

export type CreateAgentFn = (input: CreateAgentInput) => Promise<RegistryCommitResult>;
export type UpdateAgentFn = (input: UpdateAgentInput) => Promise<RegistryCommitResult>;

/** The settings surface's agent verbs as one bundle, WorkspaceAdmin's twin
 *  (issue #70): they exist together or not at all (a registry is configured,
 *  or none is), so the composition root binds them once. */
export interface AgentAdmin {
  create: CreateAgentFn;
  list: () => AgentView[];
  update: UpdateAgentFn;
}

function assertKnownAuthority(registry: Registry, profileName: string): void {
  if (!Object.hasOwn(registry.authority, profileName)) {
    throw new UnknownAuthorityProfileError(profileName);
  }
}

/** The machine stamp's edit half (issue #70): "0.3.1" → "0.3.2", "3" → "4" —
 *  the last run of digits + 1, whatever surrounds it. A version with no
 *  digits at all (hand-authored drift) restarts at "1": the stamp must
 *  always advance, never return the same string. */
function bumpVersion(version: string): string {
  if (!/\d/.test(version)) return "1";
  return version.replace(/(\d+)(?=\D*$)/, (n) => String(Number(n) + 1));
}

/** `AgentDefinition` → the `agents/<name>.md` file format `parseAgentFile`
 *  (registry.ts) reads back: frontmatter carries every field but the name
 *  (that's the filename) and the body is the system prompt verbatim. Optional
 *  fields are omitted, not serialized as null — round-trip keeps them
 *  undefined. */
function serializeAgentFile(definition: AgentDefinition): string {
  const meta: Record<string, string> = {
    version: definition.version,
    authority: definition.authority,
    description: definition.description,
  };
  if (definition.icon !== undefined) meta.icon = definition.icon;
  if (definition.model !== undefined) meta.model = definition.model;
  if (definition.effort !== undefined) meta.effort = definition.effort;
  // 外側の空白は trim して書く: parseAgentFile が body.trim() で読む以上、
  // 保存できるのは trim 済みの正規形だけ — 書き込み側も同じ正規形に揃える
  // ことでラウンドトリップと no-change 判定(sameEffectiveFields)が一致する
  return `---\n${stringifyYaml(meta)}---\n${definition.systemPrompt.trim()}\n`;
}

/** Writes `agents/<name>.md` and commits it under the board's own identity
 *  (ADR 0020) — the workspace admin's commitWorkspaceEntry, for agents.
 *  commitWorkspaceEntry と違い clone 検査の再実行はない: 入口の
 *  assertRegistryCloneReady からここまで await を挟まない同期処理で、
 *  workspace 側の「遅い外部手順の間にブランチが動く」窓が存在しない。 */
function commitAgentFile(registryDir: string, definition: AgentDefinition, message: string): void {
  const file = join("agents", `${definition.name}.md`);
  writeFileSync(join(registryDir, file), serializeAgentFile(definition));
  git(registryDir, "add", file);
  git(registryDir, ...TIDEPOOL_GIT_IDENTITY, "commit", "-m", message);
}
