#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# E2E test: simula exatamente o que o Claude Code faz ao disparar hooks.
#
# Uso:
#   chmod +x test-e2e-sessions.sh
#   ./test-e2e-sessions.sh
#
# O que testa:
#   1. Hooks não bloqueiam (cada comando retorna rápido)
#   2. Local state (.kody/sessions/) criado no TurnStart, limpo no SessionEnd
#   3. Buffering (.kody/pending-events.jsonl) quando API unreachable
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

SESSION_ID="test-e2e-$(date +%s)"
TRANSCRIPT_PATH="/tmp/kodus-test-transcript-${SESSION_ID}.jsonl"

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
section() { echo -e "\n${BOLD}$1${NC}"; }

FAILURES=0

# ---------------------------------------------------------------------------
section "Setup"
# ---------------------------------------------------------------------------

cat > "$TRANSCRIPT_PATH" << 'TRANSCRIPT'
{"message":{"role":"human","content":"create a login endpoint"}}
{"message":{"role":"assistant","content":[{"type":"text","text":"I will create the login endpoint."},{"type":"tool_use","name":"Read","id":"r1","input":{"file_path":"src/routes.ts"}}],"usage":{"input_tokens":500,"output_tokens":100}}}
{"message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","id":"w1","input":{"file_path":"src/auth.ts","content":"export function login() {}"}},{"type":"tool_use","name":"Edit","id":"e1","input":{"file_path":"src/routes.ts","old_string":"// routes","new_string":"import { login } from './auth';"}}],"usage":{"input_tokens":800,"output_tokens":200}}}
{"message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","id":"b1","input":{"command":"npm test"}}],"usage":{"input_tokens":300,"output_tokens":50}}}
{"message":{"role":"assistant","content":"All tests pass. The login endpoint is ready.","usage":{"input_tokens":200,"output_tokens":30}}}
TRANSCRIPT

echo "  Transcript: $TRANSCRIPT_PATH"
echo "  Session ID: $SESSION_ID"

rm -f "$REPO_ROOT/.kody/pending-events.jsonl"
rm -f "$REPO_ROOT/.kody/sessions/${SESSION_ID}.json"

NODE="node ./dist/index.js"

run_hook() {
  local hook_name="$1"
  local payload="$2"
  echo "$payload" | $NODE decisions hooks claude-code "$hook_name" 2>/dev/null
}

# ---------------------------------------------------------------------------
section "1. SessionStart"
# ---------------------------------------------------------------------------

START_MS=$(($(date +%s%N)/1000000))
run_hook session-start "{\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\"}"
ELAPSED=$(( $(date +%s%N)/1000000 - START_MS ))

if [ "$ELAPSED" -lt 10000 ]; then
  pass "Completed in ${ELAPSED}ms"
else
  fail "Took ${ELAPSED}ms (too slow)"
fi

# ---------------------------------------------------------------------------
section "2. TurnStart (user-prompt-submit)"
# ---------------------------------------------------------------------------

START_MS=$(($(date +%s%N)/1000000))
run_hook user-prompt-submit "{\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\",\"prompt\":\"create a login endpoint\"}"
ELAPSED=$(( $(date +%s%N)/1000000 - START_MS ))

if [ "$ELAPSED" -lt 10000 ]; then
  pass "Completed in ${ELAPSED}ms"
else
  fail "Took ${ELAPSED}ms (too slow)"
fi

# Check local state
if [ -f "$REPO_ROOT/.kody/sessions/${SESSION_ID}.json" ]; then
  TURN_ID=$(python3 -c "import json; print(json.load(open('$REPO_ROOT/.kody/sessions/${SESSION_ID}.json'))['turnId'])" 2>/dev/null || echo "")
  if [ -n "$TURN_ID" ]; then
    pass "Local state saved: turnId=$TURN_ID"
  else
    fail "Local state has no turnId"
  fi

  T_PATH=$(python3 -c "import json; print(json.load(open('$REPO_ROOT/.kody/sessions/${SESSION_ID}.json'))['transcriptPath'])" 2>/dev/null || echo "")
  if [ "$T_PATH" = "$TRANSCRIPT_PATH" ]; then
    pass "Transcript path saved correctly"
  else
    fail "Transcript path mismatch: $T_PATH"
  fi
else
  fail "Local state NOT created at .kody/sessions/${SESSION_ID}.json"
fi

# ---------------------------------------------------------------------------
section "3. SubagentStart (pre-task)"
# ---------------------------------------------------------------------------

run_hook pre-task "{\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\",\"tool_use_id\":\"toolu_abc123\",\"tool_name\":\"Agent\",\"tool_input\":{\"prompt\":\"find auth files\",\"subagent_type\":\"Explore\",\"description\":\"find auth files\"}}"
pass "Dispatched subagent_start"

# ---------------------------------------------------------------------------
section "4. SubagentEnd (post-task)"
# ---------------------------------------------------------------------------

run_hook post-task "{\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\",\"tool_use_id\":\"toolu_abc123\",\"tool_name\":\"Agent\"}"
pass "Dispatched subagent_end"

# ---------------------------------------------------------------------------
section "5. TurnEnd (post-todo)"
# ---------------------------------------------------------------------------

sleep 0.3  # let transcript "stabilize"

START_MS=$(($(date +%s%N)/1000000))
run_hook post-todo "{\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\"}"
ELAPSED=$(( $(date +%s%N)/1000000 - START_MS ))

if [ "$ELAPSED" -lt 10000 ]; then
  pass "Completed in ${ELAPSED}ms (includes transcript flush wait)"
else
  fail "Took ${ELAPSED}ms"
fi

# ---------------------------------------------------------------------------
section "6. SessionEnd"
# ---------------------------------------------------------------------------

run_hook session-end "{\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\"}"

if [ ! -f "$REPO_ROOT/.kody/sessions/${SESSION_ID}.json" ]; then
  pass "Local state cleaned up on session-end"
else
  fail "Local state still exists after session-end"
fi

# ---------------------------------------------------------------------------
section "7. Buffering (network error simulation)"
# ---------------------------------------------------------------------------

echo -e "${DIM}  Simulating unreachable API with KODUS_API_URL=http://localhost:1${NC}"

BUFFER_SESSION="test-buffer-$(date +%s)"
rm -f "$REPO_ROOT/.kody/pending-events.jsonl"

KODUS_API_URL=http://localhost:1 bash -c "echo '{\"session_id\":\"${BUFFER_SESSION}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\"}' | $NODE decisions hooks claude-code session-start" 2>/dev/null || true

sleep 2

if [ -f "$REPO_ROOT/.kody/pending-events.jsonl" ]; then
  BUFFER_COUNT=$(wc -l < "$REPO_ROOT/.kody/pending-events.jsonl" | tr -d ' ')
  pass "Events buffered: $BUFFER_COUNT event(s) in pending-events.jsonl"

  echo -e "${DIM}  Buffered events:${NC}"
  while IFS= read -r line; do
    EVENT_TYPE=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('type','?'))" <<< "$line" 2>/dev/null || echo "?")
    echo -e "  ${DIM}  - ${EVENT_TYPE}${NC}"
  done < "$REPO_ROOT/.kody/pending-events.jsonl"
else
  fail "No buffer file created — events lost on network error!"
fi

# ---------------------------------------------------------------------------
section "Cleanup"
# ---------------------------------------------------------------------------

rm -f "$TRANSCRIPT_PATH"
rm -f "$REPO_ROOT/.kody/pending-events.jsonl"
rm -f "$REPO_ROOT/.kody/sessions/${SESSION_ID}.json"
rm -f "$REPO_ROOT/.kody/sessions/${BUFFER_SESSION}.json"
pass "Temp files removed"

# ---------------------------------------------------------------------------
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All checks passed!${NC}"
else
  echo -e "${RED}${BOLD}${FAILURES} check(s) failed.${NC}"
  exit 1
fi
