#!/usr/bin/env node
// PreToolUse hook (Claude Code and Codex): when a shell command files an issue or sets labels with
// `gh`, put docs/agents/triage-labels.md in front of the agent. The labels' meaning lives in that file
// only; a recalled copy drifts (#1540 / #1541 were filed without `verify:production`). The injection
// never blocks, and it arrives with the command's result — after the labels were chosen (#1596 was
// still filed without `verify:production`). Once per session: a marker keyed by `session_id` suppresses
// repeats, and the SessionStart hook (compact / clear) removes it, since compaction can summarize the
// injected text away.
// The one combination that keeps slipping — `needs-info` without a `verify:*` label — is denied before it
// runs, once per command in a session: a needs-info issue observed in CI or the Lima VM goes through
// when the same command is run again.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILES_OR_LABELS = [/\bgh\s+issue\s+create\b/, /\bgh\s+(?:issue|pr)\s+(?:create|edit)\b[\s\S]*\s--(?:add-|remove-)?label\b/];
const MARKERS = join(tmpdir(), 'tidepool-triage-labels-injected');
const ISSUE_LABELS = /\bgh\s+issue\s+(?:create|edit)\b/;
const LABEL_VALUES = /\s--(?:add-)?label(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
const VERIFY_REASON =
  'This command gives `needs-info` without a `verify:*` label. A needs-info issue waits on an observation, ' +
  'and docs/agents/triage-labels.md labels it by where that observation can happen. If only a running ' +
  'board can give it (the confirmation of a merged change, or whether something hurts in real use), add ' +
  '`verify:production`. If the venue is CI or the Lima VM, run the same command again unchanged: this ' +
  'check stops each command once per session.';

/** The labels a `gh issue create / edit` command adds (`--label` / `--add-label`, comma-separated or repeated). */
function addedLabels(command) {
  return [...command.matchAll(LABEL_VALUES)].flatMap((m) => (m[1] ?? m[2] ?? m[3]).split(',')).map((l) => l.trim());
}

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }
  const marker = event.session_id ? join(MARKERS, encodeURIComponent(String(event.session_id))) : undefined;
  if (event.hook_event_name === 'SessionStart') {
    if (marker) rmSync(marker, { force: true });
    return;
  }
  const command = String(event.tool_input?.command ?? '');
  if (!FILES_OR_LABELS.some((pattern) => pattern.test(command))) return;
  const added = ISSUE_LABELS.test(command) ? addedLabels(command) : [];
  if (event.session_id && added.includes('needs-info') && !added.some((l) => l.startsWith('verify:'))) {
    const hash = createHash('sha256').update(command).digest('hex').slice(0, 16);
    const denied = join(MARKERS, `${encodeURIComponent(String(event.session_id))}.verify.${hash}`);
    if (!existsSync(denied)) {
      mkdirSync(MARKERS, { recursive: true });
      writeFileSync(denied, '');
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: VERIFY_REASON },
        }),
      );
      return;
    }
  }
  if (marker && existsSync(marker)) return;
  const labels = readFileSync(new URL('../docs/agents/triage-labels.md', import.meta.url), 'utf8');
  const additionalContext =
    "This command files an issue or sets labels. The labels' meaning is defined only by " +
    'docs/agents/triage-labels.md, reproduced below; check every label on the command against it ' +
    '(state role, `verify:production`, blocked-by) before relying on memory.\n\n' +
    labels;
  if (marker) {
    mkdirSync(MARKERS, { recursive: true });
    writeFileSync(marker, '');
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }));
});
