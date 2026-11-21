// #3334: env names that point git at a repo other than the one found from cwd. A caller inside a linked worktree
// (`git bisect run`, `git rebase --exec`, hooks) exports GIT_DIR; a child git that inherits it writes into the caller's repo.
// Not `git rev-parse --local-env-vars`: ADR 0349 決定2 keeps GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS as the caller's config
// restrictions, and GIT_NO_REPLACE_OBJECTS / GIT_REPLACE_REF_BASE do not redirect writes.
export const REPO_LOCATION_GIT_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_CONFIG',
];

export function stripRepoLocationGitEnv(env) {
  for (const name of REPO_LOCATION_GIT_ENV) delete env[name];
  return env;
}

// vitest's and Playwright's globalSetup: it runs in the runner's main process, whose env every worker inherits.
export default function stripRunnerEnv() {
  stripRepoLocationGitEnv(process.env);
}
