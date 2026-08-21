#!/bin/bash
# fugu 本文 A/B を隔離環境で再現する。
#   usage: docs/experiments/fugu-body-ab/run.sh <variant> <body-file|empty> [port]
#   例:    run.sh A empty 4700           # 本文空
#          run.sh B my-body.md 4710      # 本文を my-body.md の内容にする
# 作業ディレクトリは $FUGU_AB_DIR(既定 /tmp/fugu-ab)。本番 registry / DB には触れない。
# 前提: claude CLI がログイン済み、sqlite3 / jq / node がある。
# 注意: 5h session を使い切って credit 消費に移っている間は /usage が窓を返さず盤面は
#       fail-closed throttle で pickup しない(2026-08-21 に観測、未起票)。窓のリセット後に走らせる。
set -euo pipefail
V=$1; BODY=$2; P=${3:-4700}
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
D=${FUGU_AB_DIR:-/tmp/fugu-ab}/$V; rm -rf "$D"; mkdir -p "$D/ws" "$D/logs"

# 1. 空の bare remote を種まき(template から)。変種は種まき後に fugu.md の本文を差し替える。
git init -q --bare "$D/remote.git"; git clone -q "$D/remote.git" "$D/registry"
git -C "$D/registry" config user.name exp; git -C "$D/registry" config user.email exp@example.com
(cd "$ROOT" && TIDEPOOL_REGISTRY="$D/registry" TIDEPOOL_WORKSPACES_DIR="$D/ws" npm run -s init-registry >/dev/null)
FM=$(awk 'NR==1{print;next} /^---$/{print;exit} {print}' "$D/registry/agents/fugu.md")
{ echo "$FM"; [ "$BODY" != "empty" ] && cat "$BODY"; } > "$D/registry/agents/fugu.md"
printf 'sandbox:\n  review_allowed_commands:\n    - "node --test"\n    - "node -e"\n' > "$D/registry/workspaces.yaml"
git -C "$D/registry" commit -qam "variant $V" && git -C "$D/registry" push -q origin HEAD:main

# 2. review 対象を workspace に載せる
cp -r "$HERE/targets/"* "$D/ws/sandbox/"
git -C "$D/ws/sandbox" add -A; git -C "$D/ws/sandbox" -c user.name=exp -c user.email=exp@example.com commit -qm "Add three modules for review"

# 3. 盤面を起動し、ルート review 3本を登録、spend-down で pace を外す
export TIDEPOOL_REGISTRY="$D/registry" TIDEPOOL_DB="$D/board.sqlite" TIDEPOOL_WORKER_LOGS="$D/logs" \
       TIDEPOOL_WORKSPACES_DIR="$D/ws" TIDEPOOL_API_TOKEN_FILE="$D/api-token" PORT=$P MCP_PORT=$((P+1))
T=$(cd "$ROOT" && npm run -s token | awk '/token:/{print $2}')
(cd "$ROOT" && npm run -s start > "$D/board.out" 2>&1 &) ; sleep 8
H=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
for i in 0 1 2; do jq ".[$i]" "$HERE/tasks.json" | curl -s "${H[@]}" -d @- "http://127.0.0.1:$P/api/tasks" >/dev/null; done
poke() { curl -s -o /dev/null "${H[@]}" -d '{"active":true,"window":"session"}' "http://127.0.0.1:$P/api/spend-down"; }
poke

# 4. 3本のログが揃うまで待つ。worker 終了は poll を起こさない(hourly tick)ので、slot が空くたびに poke で即 poll させる。
for _ in $(seq 1 120); do
  sleep 30
  ip=$(sqlite3 "$D/board.sqlite" "select count(*) from tasks where status='in_progress'")
  ran=0; for id in $(sqlite3 "$D/board.sqlite" "select id from tasks where type='review' and parent_id is null"); do ls "$D/logs/$id".*.stream.jsonl >/dev/null 2>&1 && ran=$((ran+1)); done
  [ "$ip" = 0 ] && [ "$ran" = 3 ] && break
  [ "$ip" = 0 ] && poke
done
pkill -f "tsx src/main.ts" || true

# 5. 盤面 verb の呼び出しと費用だけを results/ と同じ形に抽出
for f in "$D"/logs/*.stream.jsonl; do id=$(basename "$f" | cut -d. -f1)
  jq -c 'select((.type=="assistant" and (.message.content[]? | select(.type=="tool_use" and (.name|test("tidepool"))))) or .type=="result") | if .type=="result" then {type,total_cost_usd,num_turns,duration_ms} else {type:"tool_use",calls:[.message.content[]|select(.type=="tool_use" and (.name|test("tidepool")))|{name,input}]} end' "$f" > "$D/$V-$id.jsonl"
done
echo "done: $D ($ran/3 ran)"; sqlite3 "$D/board.sqlite" "select status,substr(parent_id,1,8),title from tasks"
