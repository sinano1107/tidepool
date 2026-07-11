#!/usr/bin/env node
// Builds _ds_bundle.js from the real component sources under components/.
// This repo now holds the Tidepool Design System's real component source
// (pulled from the Claude Design project on 2026-07-11 — see issue #18);
// this script is the local equivalent of the design-sync "converter" for
// the standard repo-is-source direction, so component fixes land here
// without a manual round trip through /design-sync.
//
// Usage: node scripts/build-ds-bundle.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Order and grouping mirror the manifest already shipped in _ds_bundle.js.
const COMPONENTS = [
  ['Button', 'components/actions/Button.jsx'],
  ['IconButton', 'components/actions/IconButton.jsx'],
  ['AgentChip', 'components/board/AgentChip.jsx'],
  ['LogEntry', 'components/board/LogEntry.jsx'],
  ['QueueItem', 'components/board/QueueItem.jsx'],
  ['RiskFlag', 'components/board/RiskFlag.jsx'],
  ['StatusBadge', 'components/board/StatusBadge.jsx'],
  ['TaskCard', 'components/board/TaskCard.jsx'],
  ['TypeBadge', 'components/board/TypeBadge.jsx'],
  ['Checkbox', 'components/forms/Checkbox.jsx'],
  ['Input', 'components/forms/Input.jsx'],
  ['Select', 'components/forms/Select.jsx'],
  ['Switch', 'components/forms/Switch.jsx'],
  ['Card', 'components/surfaces/Card.jsx'],
  ['Dialog', 'components/surfaces/Dialog.jsx'],
  ['Tag', 'components/surfaces/Tag.jsx'],
  ['Toast', 'components/surfaces/Toast.jsx'],
];

function compileComponent(name, relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  let { code } = esbuild.transformSync(src, {
    loader: 'jsx',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    format: 'esm',
  });

  // Local imports (./Other.jsx) become references into the shared __ds_scope
  // object — every component in the bundle runs in one shared IIFE scope,
  // not as separate modules.
  const importedNames = [];
  code = code
    .split('\n')
    .filter((line) => {
      const m = line.match(/^import \{ (\w+) \} from ['"]\.\/[^'"]+['"];?$/);
      if (m) { importedNames.push(m[1]); return false; }
      return true;
    })
    .join('\n');
  code = code.replace(/\nexport \{\n(?:\s*\w+,?\n)+\};\s*$/, '\n');
  for (const imported of importedNames) {
    code = code.replace(new RegExp(`\\b${imported}\\b`, 'g'), `__ds_scope.${imported}`);
  }
  code = code.trimEnd() + '\n';

  return (
    `// ${relPath}\n` +
    `try { (() => {\n` +
    code +
    `Object.assign(__ds_scope, { ${name} });\n` +
    `})(); } catch (e) { __ds_ns.__errors.push({ path: "${relPath}", error: String((e && e.message) || e) }); }\n`
  );
}

const body = COMPONENTS.map(([name, relPath]) => compileComponent(name, relPath)).join('\n');
const exportsBlock = COMPONENTS.map(([name]) => `__ds_ns.${name} = __ds_scope.${name};`).join('\n\n');

const manifest = {
  format: 4,
  namespace: 'TidepoolDesignSystem_8a0ead',
  components: COMPONENTS.map(([name, sourcePath]) => ({ name, sourcePath })),
};

const out =
  `/* @ds-bundle: ${JSON.stringify(manifest)} */\n\n` +
  `(() => {\n\n` +
  `const __ds_ns = (window.TidepoolDesignSystem_8a0ead = window.TidepoolDesignSystem_8a0ead || {});\n\n` +
  `const __ds_scope = {};\n\n` +
  `(__ds_ns.__errors = __ds_ns.__errors || []);\n\n` +
  body + '\n' +
  exportsBlock + '\n\n' +
  `})();\n`;

writeFileSync(join(ROOT, '_ds_bundle.js'), out);
console.log(`built _ds_bundle.js from ${COMPONENTS.length} components`);
