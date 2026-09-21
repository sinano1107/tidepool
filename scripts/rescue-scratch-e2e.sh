#!/usr/bin/env bash
# Claude Code の WorktreeRemove フック。worktree で書いた使い捨て E2E
# (e2e/*.scratch.spec.ts、.gitignore 済み)は worktree ごと消えるので、削除直前に
# 本体 checkout の e2e/ へ退避する。本体に同名で中身の違うファイルがあれば上書きせず
# <name>.<worktree名>.scratch.spec.ts として置く。失敗しても削除は止めない(常に exit 0)。
set -u

wt=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).worktree_path??"")}catch{}})')
[ -n "$wt" ] && [ -d "$wt/e2e" ] || exit 0

common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
dest="$(dirname "$common")/e2e"
[ -d "$dest" ] && [ "$dest" != "$wt/e2e" ] || exit 0

tag=$(basename "$wt")
for f in "$wt"/e2e/*.scratch.spec.ts; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  target="$dest/$name"
  if [ -e "$target" ] && ! cmp -s "$f" "$target"; then
    target="$dest/${name%.scratch.spec.ts}.$tag.scratch.spec.ts"
  fi
  cp "$f" "$target" && echo "rescued $name -> $target" >&2
done
exit 0
