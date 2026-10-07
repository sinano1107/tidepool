#!/usr/bin/env node
// PreToolUse hook (Claude Code and Codex): when a shell command files an issue or sets labels with
// `gh`, put docs/agents/triage-labels.md in front of the agent. The labels' meaning lives in that file
// only; a recalled copy drifts (#1540 / #1541 were filed without `verify:production`). Never blocks.
// Once per session: a marker keyed by `session_id` suppresses repeats, and the SessionStart hook
// (compact / clear) removes it, since compaction can summarize the injected text away.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILES_OR_LABELS = [/\bgh\s+issue\s+create\b/, /\bgh\s+(?:issue|pr)\s+(?:create|edit)\b[\s\S]*\s--(?:add-|remove-)?label\b/];
const MARKERS = join(tmpdir(), 'tidepool-triage-labels-injected');

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
