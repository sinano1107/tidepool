#!/usr/bin/env node
// ADR 0349 決定2: install repo-owned hooks without failing package installation.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function git(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

try {
  if (!existsSync(join(ROOT, '.git')) || realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(ROOT)) {
    throw new Error('package is not the root of its own Git checkout');
  }
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' });
  if (current.stdout?.trim() === '.githooks') {
    console.log('Git hooks already configured as .githooks');
  } else if (current.status === 0) {
    console.log(`Git hooks skipped: existing core.hooksPath=${current.stdout.trim()}`);
  } else {
    if (current.error || current.status !== 1) {
      throw new Error(current.error?.message || current.stderr.trim() || 'cannot read core.hooksPath');
    }
    const hooks = resolve(ROOT, git('rev-parse', '--git-path', 'hooks'));
    if (existsSync(hooks)) {
      const active = readdirSync(hooks).filter((name) => {
        if (name.endsWith('.sample')) return false;
        const file = statSync(join(hooks, name));
        return file.isFile() && (file.mode & 0o111) !== 0;
      });
      if (active.length) throw new Error(`active default hooks: ${active.join(', ')}`);
    }
    git('config', '--local', 'core.hooksPath', '.githooks');
    console.log('Git hooks configured as .githooks');
  }
} catch (error) {
  console.log(`Git hooks skipped: ${error.message}`);
}
