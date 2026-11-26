#!/bin/bash
# A stand-in gh for pull request merges. Logs every call to $FAKE_GH_LOG.
# Each "pr merge" takes the next word of $FAKE_MERGE_PLAN (space separated):
#   OK        the merge succeeds (the pull request is MERGED afterwards)
#   CONFLICT  fails with "Pull Request has merge conflicts"; the base branch moves on in $FAKE_REPO first
#   DENIED    fails with a permission error; the pull request stays MERGEABLE
# "pr view" answers state and mergeable from the last merge attempt.
set -u
echo "$*" >> "$FAKE_GH_LOG"
dir="$(dirname "$FAKE_GH_LOG")"
last="$dir/last-merge"
attempts="$dir/merge-attempts"
case "$1 $2" in
  "pr merge")
    n=$(( $(cat "$attempts" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$attempts"
    word="$(echo "$FAKE_MERGE_PLAN" | cut -d' ' -f"$n")"
    echo "$word" > "$last"
    case "$word" in
      OK) exit 0 ;;
      CONFLICT)
        echo "base moved $n" > "$FAKE_REPO/work.txt"
        git -C "$FAKE_REPO" add work.txt
        git -C "$FAKE_REPO" -c user.name=t -c user.email=t@example.com commit -q -m "base moved $n"
        echo "X Pull request is not mergeable: Pull Request has merge conflicts" >&2
        exit 1 ;;
      *) echo "GraphQL: Resource not accessible by personal access token" >&2; exit 1 ;;
    esac ;;
  "pr view")
    word="$(cat "$last" 2>/dev/null || echo NONE)"
    case "$*" in
      *mergeable*) [ "$word" = CONFLICT ] && echo CONFLICTING || echo MERGEABLE ;;
      *) [ "$word" = OK ] && echo MERGED || echo OPEN ;;
    esac ;;
esac
