#!/bin/sh
# Runs the pre-registered order sequentially (never concurrent). Usage: run-all.sh  (anon ids come from the fixed list below)
cd "$(dirname "$0")" || exit 1
while read -r task cond id; do
  echo "$(date -u +%FT%TZ) start $task $cond $id"
  node run-one.mjs "$task" "$cond" "$id" && node finish-run.mjs "$id"
done <<LIST
t1 ON r-7f3a
t1 OFF r-2c9d
t2 OFF r-b415
t2 ON r-e08a
t3 ON r-5d62
t3 OFF r-91ce
LIST
echo "$(date -u +%FT%TZ) all done"
