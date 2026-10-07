#!/usr/bin/env bash
# Take one of the K Lima VM slots a triage sweep may hold at once, and print its name.
# The slot is the clone itself: `limactl clone` claims the name with mkdir, so two
# sub-agents racing for the same slot cannot both get it.
#
# K=2 is bounded by memory, measured on this Mac (32 GiB, 4 GiB per VM) with `tidepool` and one
# more VM already running (issue #1518): two clones running the full suite kept memory pressure
# normal; a third put it at warn just by being up, and a fourth made swap grow.
#
# Exit 0: the clone is started; its name is on stdout. Release it with `limactl delete -f <name>`.
# Exit 75: every slot stayed busy for about 9 minutes. Run this again.
# Any other exit: cloning or starting failed for a reason other than a busy slot.
set -u

K=2
BASE=tidepool-sweep-base
deadline=$((SECONDS + 540))
announced=

while :; do
  for i in $(seq 1 "$K"); do
    name="sweep-slot-$i"
    if err=$(limactl clone "$BASE" "$name" --tty=false 2>&1); then
      if limactl start "$name" --tty=false >&2; then
        echo "$name"
        exit 0
      fi
      limactl delete -f "$name" >&2
      echo "Could not start $name." >&2
      exit 1
    fi
    if ! limactl list --quiet | grep -qx "$name"; then
      echo "$err" >&2
      exit 1
    fi
  done
  if ((SECONDS >= deadline)); then
    echo "All $K slots busy; run this again." >&2
    exit 75
  fi
  if [ -z "$announced" ]; then
    echo "All $K slots busy (limactl list | grep sweep-slot-); waiting..." >&2
    announced=1
  fi
  sleep 30
done
