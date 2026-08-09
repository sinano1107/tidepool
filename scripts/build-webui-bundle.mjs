#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES = [
  "ui_kits/tidepool-webui/queue-screen.jsx",
  "ui_kits/tidepool-webui/triage-screen.jsx",
  "ui_kits/tidepool-webui/single-question-view.jsx",
  "ui_kits/tidepool-webui/board-screen.jsx",
  "webui/app.jsx",
];

function compile(relPath) {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const { code } = esbuild.transformSync(source, {
    loader: "jsx",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  });
  return `// ${relPath}\n${code.trimEnd()}\n`;
}

const out = SOURCES.map(compile).join("\n");
const outputs = new Map([
  ["public/app.js", Buffer.from(out)],
  ["public/vendor/react.js", readFileSync(join(ROOT, "node_modules/react/umd/react.production.min.js"))],
  ["public/vendor/react-dom.js", readFileSync(join(ROOT, "node_modules/react-dom/umd/react-dom.production.min.js"))],
  ["public/vendor/lucide.js", readFileSync(join(ROOT, "node_modules/lucide/dist/umd/lucide.min.js"))],
]);

if (process.argv.includes("--check")) {
  const stale = [...outputs].filter(([relPath, expected]) => {
    const path = join(ROOT, relPath);
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
