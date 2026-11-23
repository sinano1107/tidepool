# Raising the pinned gh version

The board runs `gh` only at the version `gh-cli-version` names. It reads `gh --version` before
every call, and a mismatch stops gh and raises the "gh version" Quarantine question (ADR 0402).
Raising that version is a deliberate change: re-measure what the board relies on gh for first
(ADR 0402 決定5). Do it in the Lima VM on the Mac. One measurement needs a disposable repo on real
GitHub, so CI cannot run it. Driving the VM is covered in
[machine-setup.md](agents/machine-setup.md#linux-devtest-in-the-lima-vm).

Run every step from the Mac, in this order. `<version>` is the gh version you are moving to.

First bring the VM checkout to the current `main` with its dependencies, as in
[Update Tidepool](mac-first-boot.md#update-tidepool):

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && git pull && npm install'
```

## 1. Point the VM checkout's pin at the new version

`gh-cli-version` holds the version and the sha256 of the two Linux release tarballs. Copy both
sha256 values from the release's own `gh_<version>_checksums.txt`:

```bash
gh release download v<version> -R cli/cli -p 'gh_<version>_checksums.txt' -O - | grep -E '_linux_(arm64|amd64)\.tar\.gz$'
```

Write them into the VM checkout's file, in this form:

```
version=<version>
linux_arm64=<sha256 of gh_<version>_linux_arm64.tar.gz>
linux_amd64=<sha256 of gh_<version>_linux_amd64.tar.gz>
```

Keep the change until step 4's PR merges, then put the file back before pulling:

```bash
limactl shell tidepool -- bash -lc 'git -C ~/tidepool checkout gh-cli-version'
```

## 2. Install the new version in the VM

The provision runs the same script on the next VM restart. To install now:

```bash
limactl shell tidepool -- bash -lc 'sudo ~/tidepool/scripts/install-gh.sh && gh --version'
```

The script refuses a tarball whose sha256 differs from the file and leaves the installed gh alone.

## 3. Re-measure what the board relies on gh for

Run each call from the VM with the new gh, against a disposable repo you own on GitHub:

- `gh pr merge <n> --merge --match-head-commit <head>` merges only while the PR's head is still
  `<head>`. Push one more commit to the PR's branch and check that the same call is refused.
- The `--json` fields the board reads in `src/github.ts` all come back, with exit 0:
  `gh pr view <n> --json state,statusCheckRollup,headRefOid,mergedBy,baseRefName,baseRefOid,headRefName,headRepository`,
  `gh issue view <n> --json title,body,comments,state` and `gh issue list --json number,title`. An
  `Unknown JSON field` error means the board cannot read PRs or issues at this version.
- `gh pr create` prints one line, the PR's URL. The board opens PRs over REST (ADR 0396), so this
  matters only if `src/github.ts` runs `gh pr create` again.
- `gh pr create` and `gh pr merge` run with the named place as cwd leave its local refs as they
  were. The procedure and the script that compares the refs before and after each call are in the
  comments of issue #3169.

## 4. Open the PR that changes the pinned version

Write the new `gh-cli-version` at the repo root. Paste what step 3 observed into the PR description.
