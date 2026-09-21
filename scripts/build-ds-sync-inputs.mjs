#!/usr/bin/env node
// Builds the two design-sync inputs that used to be hand-maintained (issue #742):
//   1. `.design-sync/config.json`'s `dtsPropsFor` block — one <Name>Props interface
//      body per `componentSrcMap` entry, extracted from the component's `.d.ts`.
//   2. `design-system/pkg/docs/<Name>.md` — a byte copy of the component's
//      `<Name>.prompt.md`, for every `componentSrcMap` entry.
// `componentSrcMap` is the single component list; nothing else enumerates components.
//
// config.json is hand-formatted (inline `overrides` objects) — only the `dtsPropsFor`
// block is rewritten; every other byte is preserved. Extracting `componentSrcMap`
// and splicing `dtsPropsFor` both find a top-level `"<key>": { ... }` block by its
// closing `\n  }` line: safe because real newline bytes never occur inside a JSON
// string (an embedded "\n" is the two-character escape sequence, not a byte 0x0A),
// so the first `\n  }` after a block's opening brace is always that block's own close.
//
// Usage: node scripts/build-ds-sync-inputs.mjs [--check]

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(ROOT, '.design-sync/config.json');
const CONFIG_REL = '.design-sync/config.json';
const PKG_DIR = join(ROOT, 'design-system/pkg');
const DOCS_DIR = join(PKG_DIR, 'docs');

// Finds a top-level `"<key>": { ... }` block in raw JSON text and returns
// [start, end) where `start` is the index of the leading two-space indent and
// `end` is the index right after the block's closing `}`.
function findBlock(raw, key) {
  const marker = `  "${key}": {`;
  const start = raw.indexOf(marker);
  if (start === -1) throw new Error(`${CONFIG_REL}: no "${key}" block found`);
  const closeLine = raw.indexOf('\n  }', start + marker.length);
  if (closeLine === -1) throw new Error(`${CONFIG_REL}: unterminated "${key}" block`);
  return [start, closeLine + 4];
}

function extractInterfaceBody(src, name, dtsRelPath) {
  const marker = `export interface ${name}Props`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${dtsRelPath}: no "${marker}" found`);
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

const configRaw = readFileSync(CONFIG_PATH, 'utf8');
const [srcMapStart, srcMapEnd] = findBlock(configRaw, 'componentSrcMap');
const { componentSrcMap } = JSON.parse(`{${configRaw.slice(srcMapStart, srcMapEnd)}}`);

const staleAssets = [];
const docWrites = []; // { path, relPath, content }

for (const [name, relPath] of Object.entries(componentSrcMap)) {
  const jsxAbsPath = resolve(PKG_DIR, relPath);
  const dtsAbsPath = jsxAbsPath.replace(/\.jsx$/, '.d.ts');
  const promptAbsPath = jsxAbsPath.replace(/\.jsx$/, '.prompt.md');
  const dtsRelPath = `design-system/${dtsAbsPath.slice(join(ROOT, 'design-system').length + 1)}`;

  const dtsSrc = readFileSync(dtsAbsPath, 'utf8');
  const propsBody = extractInterfaceBody(dtsSrc, name, dtsRelPath);
  componentSrcMap[name] = { relPath, propsBody };

  const docRelPath = `design-system/pkg/docs/${name}.md`;
  const docAbsPath = join(DOCS_DIR, `${name}.md`);
  const promptContent = readFileSync(promptAbsPath, 'utf8');
  const isFresh = existsSync(docAbsPath) && readFileSync(docAbsPath, 'utf8') === promptContent;
  if (!isFresh) staleAssets.push(docRelPath);
  docWrites.push({ path: docAbsPath, relPath: docRelPath, content: promptContent });
}

// Any pkg/docs/*.md not backed by a componentSrcMap entry is stale (deleted on write).
const expectedDocNames = new Set(Object.keys(componentSrcMap));
const extraDocFiles = existsSync(DOCS_DIR)
  ? readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md') && !expectedDocNames.has(f.slice(0, -3)))
  : [];
for (const f of extraDocFiles) staleAssets.push(`design-system/pkg/docs/${f}`);

// Rebuild the dtsPropsFor block, in componentSrcMap order.
const dtsPropsForLines = Object.entries(componentSrcMap).map(
  ([name, { propsBody }]) => `    "${name}": ${JSON.stringify(propsBody)}`,
);
const freshDtsPropsForBlock = `  "dtsPropsFor": {\n${dtsPropsForLines.join(',\n')}\n  }`;

const [dtsStart, dtsEnd] = findBlock(configRaw, 'dtsPropsFor');
// Bound the untouched tail at the file's actual top-level close (a bare `\n}` at
// column 0 — every nested block's own close is indented) so bytes appended past
// the real end of the JSON (e.g. a stale-detection test's trailing garbage) are
// dropped from the freshly-built text instead of being carried through unchanged.
const topCloseIdx = configRaw.lastIndexOf('\n}');
const tail = configRaw.slice(dtsEnd, topCloseIdx + 2);
const freshConfigRaw = configRaw.slice(0, dtsStart) + freshDtsPropsForBlock + tail + '\n';

if (freshConfigRaw !== configRaw) staleAssets.push(CONFIG_REL);

if (process.argv.includes('--check')) {
  if (staleAssets.length > 0) {
    for (const asset of staleAssets) console.error(`stale generated asset: ${asset}`);
    process.exitCode = 1;
  } else {
    console.log('design-sync inputs are fresh');
  }
} else {
  if (freshConfigRaw !== configRaw) writeFileSync(CONFIG_PATH, freshConfigRaw);
  for (const { path, content } of docWrites) writeFileSync(path, content);
  for (const f of extraDocFiles) unlinkSync(join(DOCS_DIR, f));
  console.log(`built design-sync inputs for ${docWrites.length} components`);
}
