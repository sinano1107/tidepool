#!/usr/bin/env node
// Builds design-system/pkg/dist/index.js — the standard-shape package entry
// the design-sync skill's converter (package-build.mjs) consumes. This is
// separate from build-ds-bundle.mjs, which still builds the production
// _ds_bundle.js consumed by public/index.html; the two must not be conflated.
//
// Usage: node scripts/build-ds-package.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The design-sync converter's cssEntry copies only the single entry file —
// it doesn't follow local @import chains — and bounds that file to the
// package directory (design-system/pkg/). design-system/styles.css is just
// @import tokens/*.css + a handful of local rules, so inline the token
// files' real content into one self-contained design-system/pkg/styles.css
// (fonts.css's remote Google Fonts @import is left as-is; it's not a local
// file). Generated — not hand-edited.
const rootStyles = readFileSync(join(ROOT, 'design-system/styles.css'), 'utf8');
const inlined = rootStyles.replace(
  /@import "tokens\/([^"]+)";\n/g,
  (_match, file) => readFileSync(join(ROOT, 'design-system/tokens', file), 'utf8') + '\n',
);
mkdirSync(join(ROOT, 'design-system/pkg'), { recursive: true });
writeFileSync(join(ROOT, 'design-system/pkg/styles.css'), inlined);

await esbuild.build({
  entryPoints: [join(ROOT, 'design-system/pkg/src/index.js')],
  outfile: join(ROOT, 'design-system/pkg/dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
});

console.log('built design-system/pkg/dist/index.js');
