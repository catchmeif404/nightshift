#!/bin/bash
# A stand-in coding agent for tests. Each run takes the next line of $FAKE_PLAN_FILE:
#   BUILD          commit a file and write "BRANCH <branch>"
#   BUILD_PR       commit a file and write "PR https://example.com/pr/<n>"
#   BUILD_BLOCKED  write "BLOCKED <reason>"
#   REVIEW <word>  write <word> as the verdict (and a review note)
#   REVIEW_EDIT <word>  like REVIEW, but first commit a 3-line addition to work.txt
#   EXIT <code>    exit with <code> without writing anything
#   GARBAGE        write a result the runner must reject
#   RELEASE_DONE / RELEASE_BLOCKED  answer a release run
#   LIMIT          fail the way Claude Code does at its usage limit
# Every run appends "<session mode> <session id> <first prompt line>" to $FAKE_CALLS_FILE,
# and saves its prompt to $FAKE_CALLS_FILE.<n>.
set -euo pipefail
prompt="$(cat)"
calls=0
[ -f "$FAKE_CALLS_FILE" ] && calls=$(wc -l < "$FAKE_CALLS_FILE")
n=$(( calls + 1 ))
printf '%s\n' "$prompt" > "$FAKE_CALLS_FILE.$n"
echo "$NIGHTSHIFT_SESSION_MODE $NIGHTSHIFT_SESSION_ID $(printf '%s' "$prompt" | head -n 1 | cut -c1-40)" >> "$FAKE_CALLS_FILE"

action="$(sed -n "${n}p" "$FAKE_PLAN_FILE")"
# A resumed session gets only "you were cut off": like a real agent, it remembers its files from the first run.
memory="$FAKE_CALLS_FILE.session.$NIGHTSHIFT_SESSION_ID"
if [ "$NIGHTSHIFT_SESSION_MODE" = resume ] && [ -f "$memory" ]; then
  result="$(sed -n 1p "$memory")"
  review="$(sed -n 2p "$memory")"
else
  result="$(printf '%s' "$prompt" | grep -oE '(one line|one word) to `[^`]+`' | head -n 1 | sed -E 's/.*`([^`]+)`/\1/' || true)"
  review="$(printf '%s' "$prompt" | grep -oE 'findings for the developer to `[^`]+`|findings to `[^`]+`|short review to `[^`]+`' | head -n 1 | sed -E 's/.*`([^`]+)`/\1/' || true)"
  printf '%s\n%s\n' "$result" "$review" > "$memory"
fi
handoff="$(printf '%s' "$prompt" | grep -oE 'short handoff to `[^`]+`' | head -n 1 | sed -E 's/.*`([^`]+)`/\1/' || true)"
branch="$(git rev-parse --abbrev-ref HEAD)"

case "$action" in
  BUILD)
    echo "change $n" >> work.txt
    git add work.txt
    git -c user.name=fake -c user.email=fake@example.com commit -q -m "fake change $n"
    [ -n "$handoff" ] && echo "HANDOFF-NOTE from build $n" > "$handoff"
    echo "BRANCH $branch" > "$result"
    ;;
  BUILD_PR)
    echo "change $n" >> work.txt
    git add work.txt
    git -c user.name=fake -c user.email=fake@example.com commit -q -m "fake change $n"
    echo "PR https://example.com/pr/$n" > "$result"
    ;;
  BUILD_BLOCKED) echo "BLOCKED missing access to the staging database" > "$result" ;;
  RELEASE_DONE) echo "DONE v1.2.3 tagged, health check 200" > "$result" ;;
  RELEASE_BLOCKED) echo "BLOCKED the deploy workflow failed" > "$result" ;;
  REVIEW_EDIT\ *)
    word="${action#REVIEW_EDIT }"
    printf 'reviewer 1\nreviewer 2\nreviewer 3\n' >> work.txt
    git add work.txt
    git -c user.name=fake -c user.email=fake@example.com commit -q -m "reviewer fix $n"
    [ -n "$review" ] && echo "review note round $n: $word" > "$review"
    echo "$word" > "$result"
    ;;
  REVIEW\ *)
    word="${action#REVIEW }"
    [ -n "$review" ] && echo "review note round $n: $word" > "$review"
    echo "$word" > "$result"
    ;;
  EXIT\ *) exit "${action#EXIT }" ;;
  LIMIT) echo "You've hit your 5-hour limit · resets 3:30pm (Asia/Seoul)" >&2; exit 1 ;;
  GARBAGE) echo "all done, trust me" > "$result" ;;
  *) echo "fake agent: no plan line $n" >&2; exit 3 ;;
esac
echo "fake agent ran: $action"
