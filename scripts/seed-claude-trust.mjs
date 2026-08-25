#!/usr/bin/env node
// Seeds Claude Code workspace trust for a given board cwd into ~/.claude.json,
// so the interactive `claude --safe-mode` usage scrape (ADR 0028) never hits the
// folder-trust dialog. Merges without disturbing any other content in the file.
// No dependencies (node only — the Pi has no jq).
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function main(argv, env, cwd) {
  const cwdArg = argv[2];
  if (!cwdArg) {
    process.stderr.write("Error: cwd argument is required\n");
    return 1;
  }
  if (!env.HOME) {
    process.stderr.write("Error: HOME is not set\n");
    return 1;
  }

  const projectCwd = isAbsolute(cwdArg) ? cwdArg : resolve(cwd, cwdArg);
  // Resolve a symlinked ~/.claude.json so the rename replaces the real file,
  // not the link.
  const target = existsSync(join(env.HOME, ".claude.json"))
    ? realpathSync(join(env.HOME, ".claude.json"))
    : join(env.HOME, ".claude.json");

  let data = {};
  let mode;
  if (existsSync(target)) {
    mode = statSync(target).mode & 0o777;
    try {
      data = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      process.stderr.write(`Error: ${target} is not valid JSON\n`);
      return 1;
    }
    if (!isPlainObject(data) || (data.projects !== undefined && !isPlainObject(data.projects))) {
      process.stderr.write(`Error: ${target} does not have the expected shape\n`);
      return 1;
    }
  }

  if (data.projects?.[projectCwd]?.hasTrustDialogAccepted === true) {
    return 0;
  }

  const next = {
    ...data,
    projects: {
      ...data.projects,
      [projectCwd]: { ...data.projects?.[projectCwd], hasTrustDialogAccepted: true },
    },
  };

  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    process.stderr.write(`Error: could not write ${target}: ${error.message}\n`);
    return 1;
  } finally {
    rmSync(temp, { force: true });
  }
  return 0;
}

process.exit(main(process.argv, process.env, process.cwd()));
