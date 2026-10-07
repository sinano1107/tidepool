#!/usr/bin/env node
// PreToolUse hook (Claude Code and Codex): when a shell command files an issue or sets labels with
// `gh`, put docs/agents/triage-labels.md in front of the agent. The labels' meaning lives in that file
// only; a recalled copy drifts (#1540 / #1541 were filed without `verify:production`). Never blocks.

import { readFileSync } from 'node:fs';

const FILES_OR_LABELS = [/\bgh\s+issue\s+create\b/, /\bgh\s+(?:issue|pr)\s+(?:create|edit)\b[\s\S]*\s--(?:add-|remove-)?label\b/];

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = String(JSON.parse(input).tool_input?.command ?? '');
  } catch {
    return;
  }
  if (!FILES_OR_LABELS.some((pattern) => pattern.test(command))) return;
  const labels = readFileSync(new URL('../docs/agents/triage-labels.md', import.meta.url), 'utf8');
  const additionalContext =
    "This command files an issue or sets labels. The labels' meaning is defined only by " +
    'docs/agents/triage-labels.md, reproduced below; check every label on the command against it ' +
    '(state role, `verify:production`, blocked-by) before relying on memory.\n\n' +
    labels;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }));
});
