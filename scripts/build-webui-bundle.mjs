#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const outRootArg = process.argv.includes("--check") ? process.argv.indexOf("--out-root") : -1;
const OUT_ROOT = outRootArg === -1 ? ROOT : process.argv[outRootArg + 1];
const SOURCES = [
  "webui/queue-screen.tsx",
  "webui/triage-screen.tsx",
  "webui/single-question-view.tsx",
  "webui/board-screen.tsx",
  "webui/register-screen.tsx",
  "webui/settings-screen.tsx",
  "webui/app.tsx",
];

function compile(relPath) {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const { code } = esbuild.transformSync(source, {
    loader: "tsx",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  });
  return `// ${relPath}\n${code.trimEnd()}\n`;
}

const require = createRequire(import.meta.url);

// UMD files aren't in package "exports"; resolve the package dir via
// package.json (which is exported) and read the file relative to it.
function readVendorFile(pkg, relPath) {
  const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
  return readFileSync(join(pkgDir, relPath));
}

// サーバーの規則の leaf の入口だけは bundle して1つのグローバルにする(ADR 0209)。WebUI 自身のファイルは上の連結のまま。
// absWorkingDir を固定するのは、esbuild が出力に書く `// src/...` の相対パスを実行場所によらず揃え、--check を安定させるため。
// tsconfigRaw を空にするのは、ルートの strict から esbuild が先頭に "use strict" を出し、連結した app.js 全体を strict にするのを防ぐため。
const [rules] = esbuild.buildSync({
  entryPoints: ["src/webui-rules.ts"],
  absWorkingDir: ROOT,
  tsconfigRaw: {},
  bundle: true,
  format: "iife",
  globalName: "TidepoolRules",
  platform: "browser",
  write: false,
}).outputFiles;
const out = [rules.text, ...SOURCES.map(compile)].join("\n");
const outputs = new Map([
  ["public/app.js", Buffer.from(out)],
  ["public/vendor/react.js", readVendorFile("react", "umd/react.production.min.js")],
  ["public/vendor/react-dom.js", readVendorFile("react-dom", "umd/react-dom.production.min.js")],
  ["public/vendor/lucide.js", readVendorFile("lucide", "dist/umd/lucide.min.js")],
]);

if (process.argv.includes("--check")) {
  const stale = [...outputs].filter(([relPath, expected]) => {
    const path = join(OUT_ROOT, relPath);
    return !existsSync(path) || !readFileSync(path).equals(expected);
  });
  if (stale.length > 0) {
    console.error(`stale generated assets: ${stale.map(([path]) => path).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("WebUI generated assets are fresh");
  }
} else {
  for (const [relPath, content] of outputs) {
    const path = join(ROOT, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`built public/app.js from ${SOURCES.length} sources`);
}
