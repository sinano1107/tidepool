#!/usr/bin/env node
import { randomUUID } from "node:crypto";
// Seeds Claude Code workspace trust for a given board cwd into ~/.claude.json,
// so the interactive `claude --safe-mode` usage scrape (ADR 0028) never hits the
// folder-trust dialog. Merges without disturbing any other content in the file.
// No dependencies (node only — the Pi has no jq).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function main(argv, env, cwd) {
  const cwdArg = argv[2];
  if (!cwdArg) {
    process.stderr.write("Error: cwd argument is required\n");
    return 1;
  }

  const projectCwd = isAbsolute(cwdArg) ? cwdArg : resolve(cwd, cwdArg);
  const target = join(env.HOME, ".claude.json");

  let data = {};
  if (existsSync(target)) {
    try {
      data = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      process.stderr.write(`Error: ${target} is not valid JSON\n`);
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

  const temp = join(dirname(target), `.claude.json.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, target);
  return 0;
}

process.exit(main(process.argv, process.env, process.cwd()));
