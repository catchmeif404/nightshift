#!/bin/bash
# A stand-in for `codex exec --json`: logs its arguments to $FAKE_CODEX_LOG and prints a thread and a message.
printf '%s\n' "$*" >> "$FAKE_CODEX_LOG"
echo '{"type":"thread.started","thread_id":"thread-123"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"config warning"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"built it"}}'
echo '{"type":"turn.completed","usage":{}}'
exit "${FAKE_CODEX_EXIT:-0}"
