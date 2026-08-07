#!/usr/bin/env node
// One-off helper: extracts each component's <Name>Props interface body from
// its hand-authored components/**/<Name>.d.ts, for pasting into
// .design-sync/config.json's dtsPropsFor (synth-entry mode has no real TS
// build to infer props from, so we supply the existing hand-written props
// directly instead of letting extraction fall back to something weaker).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPONENTS = [
  ['Button', 'components/actions/Button.d.ts'],
  ['IconButton', 'components/actions/IconButton.d.ts'],
  ['AgentChip', 'components/board/AgentChip.d.ts'],
  ['IdChip', 'components/board/IdChip.d.ts'],
  ['LogEntry', 'components/board/LogEntry.d.ts'],
  ['QueueItem', 'components/board/QueueItem.d.ts'],
  ['RiskFlag', 'components/board/RiskFlag.d.ts'],
  ['StatusBadge', 'components/board/StatusBadge.d.ts'],
  ['TaskCard', 'components/board/TaskCard.d.ts'],
  ['TypeBadge', 'components/board/TypeBadge.d.ts'],
  ['Checkbox', 'components/forms/Checkbox.d.ts'],
  ['FieldRow', 'components/forms/FieldRow.d.ts'],
  ['Input', 'components/forms/Input.d.ts'],
  ['Select', 'components/forms/Select.d.ts'],
  ['Switch', 'components/forms/Switch.d.ts'],
  ['NavRow', 'components/navigation/NavRow.d.ts'],
  ['ScreenHeader', 'components/navigation/ScreenHeader.d.ts'],
  ['Card', 'components/surfaces/Card.d.ts'],
  ['Dialog', 'components/surfaces/Dialog.d.ts'],
  ['Tag', 'components/surfaces/Tag.d.ts'],
  ['Toast', 'components/surfaces/Toast.d.ts'],
];

function extractInterfaceBody(src, name) {
  const marker = `export interface ${name}Props`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${name}: no "${marker}" found`);
  const openBrace = src.indexOf('{', start);
  let depth = 0;
  let i = openBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(openBrace + 1, i).trim();
}

const result = {};
for (const [name, relPath] of COMPONENTS) {
  const src = readFileSync(join(process.cwd(), relPath), 'utf8');
  result[name] = extractInterfaceBody(src, name);
}

console.log(JSON.stringify(result, null, 2));
