#!/bin/bash
#
# benchmark-sweep.sh — run the code-review benchmark across multiple BYOK
# model configurations, switching the org's BYOK config via the local API
# between runs.
#
# For each config it:
#   1. POST /auth/login                              (once, up front)
#   2. POST /organization-parameters/test-byok       (skip config if it fails)
#   3. POST /organization-parameters/create-or-update (key=byok_config)
#   4. GET  /organization-parameters/find-by-key      (verify)
#   5. ./benchmark-create.sh sweep-<label> <N>
#   6. wait for all reviews to finish (worker log quiescence)
#   7. ./benchmark-evaluate.sh sweep-<label> [--extract-only]
#
# Results land in scripts/benchmark/results/sweep-<label>/ and a roll-up
# is written to scripts/benchmark/results/sweep-summary.txt.
#
# Usage:
#   ./benchmark-sweep.sh [options]
#     --pr-count N        PRs per config            (default: 20)
#     --configs a,b,c     only run these labels     (default: all)
#     --list              print the model matrix and exit
#     --dry-run           login + test-byok only, no benchmark runs
#     --judge             run the Sonnet judge (needs a working Anthropic key);
#                         default is --extract-only because the judge is
#                         scored separately
#
# Examples:
#   ./benchmark-sweep.sh --list
#   ./benchmark-sweep.sh --dry-run
#   ./benchmark-sweep.sh --configs gemini-direct,kimi-openrouter
#   ./benchmark-sweep.sh --pr-count 20
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_DIR/.env"
RESULTS_DIR="$SCRIPT_DIR/results"
SUMMARY_FILE="$RESULTS_DIR/sweep-summary.txt"

API="${KODUS_API_URL:-http://localhost:3001}"
EMAIL="${KODUS_BENCH_EMAIL:-benchmark@kodus.io}"
PASSWORD="${KODUS_BENCH_PASSWORD:-Kodus@2024}"

# ─── Model matrix ───────────────────────────────────────────────────────
# Pipe-separated: label | provider | model | baseURL | apiKeyEnvVar [| maxInputTokens]
#
# provider values: google_gemini | open_router | openai_compatible | novita
#                  openai | anthropic | google_vertex | amazon_bedrock
#
# "without OpenRouter" for Kimi/GLM uses Novita — there is no direct
# Moonshot / z.AI key in .env. Swap to openai_compatible + a vendor
# baseURL if you add those keys.
#
# Capability gate (see shouldEnableJsonSchema in byok-to-vercel.ts):
#   open_router + openai/|anthropic/|google/|moonshotai/  → json_schema ON
#   open_router + anything else (z-ai/, meta-llama/, ...) → json_object
#   novita / unknown openai_compatible                    → json_object
#   google_gemini                                         → native, no flag
#
# The 6th field `maxInputTokens` overrides the resolved context window
# (see resolveContextWindow in model-context-window.ts) without needing
# an actual small-window deployment. Used by the `baseline-*` entries to
# simulate the adaptive-fit bug condition while keeping the model
# variable constant (cheap Gemini, well-understood quality floor).
CONFIGS=(
  "gemini-direct|google_gemini|gemini-2.5-flash||API_GOOGLE_AI_API_KEY"
  "gemini-openrouter|open_router|google/gemini-2.5-flash|https://openrouter.ai/api/v1|API_OPENROUTER_KEY"
  "kimi-openrouter|open_router|moonshotai/kimi-k2-thinking|https://openrouter.ai/api/v1|API_OPENROUTER_KEY"
  "kimi-novita|novita|moonshotai/kimi-k2-instruct|https://api.novita.ai/v3/openai|API_NOVITA_AI_API_KEY"
  "glm-openrouter|open_router|z-ai/glm-4.6|https://openrouter.ai/api/v1|API_OPENROUTER_KEY"
  "glm-novita|novita|zai-org/glm-4.6|https://api.novita.ai/v3/openai|API_NOVITA_AI_API_KEY"
  # "no json mode" slot — a small model exercised through Novita so the
  # gate keeps json_schema OFF; stresses the json_object / prompt-injected
  # fallback path. Swap the model if you have a specific target in mind.
  "nojson-llama|novita|meta-llama/llama-3.1-8b-instruct|https://api.novita.ai/v3/openai|API_NOVITA_AI_API_KEY"
  # Adaptive-fit baselines: same model, varying simulated window. The
  # 12k entry must preflight-fail today (CONTEXT_OVERFLOW); 16k may
  # partially succeed; full establishes the regression floor for PR2/PR3.
  "baseline-12k|google_gemini|gemini-2.5-flash||API_GOOGLE_AI_API_KEY|12288"
  "baseline-16k|google_gemini|gemini-2.5-flash||API_GOOGLE_AI_API_KEY|16384"
  "baseline-full|google_gemini|gemini-2.5-flash||API_GOOGLE_AI_API_KEY"
)

# ─── Args ───────────────────────────────────────────────────────────────
PR_COUNT=20
ONLY_CONFIGS=""
DRY_RUN=0
DO_JUDGE=0
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --pr-count) PR_COUNT="$2"; shift 2 ;;
    --configs)  ONLY_CONFIGS="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --judge)    DO_JUDGE=1; shift ;;
    --list)     LIST_ONLY=1; shift ;;
    -h|--help)  grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Helpers ────────────────────────────────────────────────────────────
get_env() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//'
}

selected() {
  [ -z "$ONLY_CONFIGS" ] && return 0
  case ",$ONLY_CONFIGS," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

if [ "$LIST_ONLY" -eq 1 ]; then
  echo "Model matrix:"
  printf '  %-20s %-18s %-32s %s\n' LABEL PROVIDER MODEL KEY-ENV
  for c in "${CONFIGS[@]}"; do
    IFS='|' read -r label provider model baseurl keyenv maxtokens <<< "$c"
    printf '  %-20s %-18s %-32s %s\n' "$label" "$provider" "$model" "$keyenv"
  done
  exit 0
fi

# ─── Login ──────────────────────────────────────────────────────────────
echo "============================================================"
echo "Benchmark sweep — $(date '+%Y-%m-%d %H:%M:%S')"
echo "API: $API   PRs/config: $PR_COUNT   judge: $([ "$DO_JUDGE" -eq 1 ] && echo on || echo 'off (extract-only)')"
echo "============================================================"

LOGIN_RESP=$(curl -sS -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" 2>&1)
TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.accessToken // empty' 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "✗ Login failed for $EMAIL. Response:"
  echo "$LOGIN_RESP" | head -c 500
  exit 1
fi
echo "✓ Logged in as $EMAIL"

mkdir -p "$RESULTS_DIR"
{
  echo "Benchmark sweep — started $(date '+%Y-%m-%d %H:%M:%S')"
  echo "PRs/config: $PR_COUNT"
  echo ""
} > "$SUMMARY_FILE"

# ─── Per-config helpers ─────────────────────────────────────────────────
build_main_json() {
  # args: provider model apikey baseurl maxInputTokens
  # maxInputTokens is optional — omit (empty string) to let
  # resolveContextWindow fall back to LiteLLM lookup by model name.
  jq -nc --arg p "$1" --arg m "$2" --arg k "$3" --arg b "$4" --arg t "$5" \
    '{provider:$p, model:$m, apiKey:$k}
      + (if $b == "" then {} else {baseURL:$b} end)
      + (if $t == "" then {} else {maxInputTokens:($t|tonumber)} end)'
}

test_byok() {
  # args: main-json  →  echoes "ok" or an error string
  # Response shape: {"data":{"ok":true,"code":"ok","latencyMs":N},...}
  local resp ok
  resp=$(curl -sS -X POST "$API/organization-parameters/test-byok" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$1" 2>&1)
  ok=$(echo "$resp" | jq -r '.data.ok // empty' 2>/dev/null)
  if [ "$ok" = "true" ]; then
    echo "ok"
  else
    echo "$resp" \
      | jq -r '(.data.error // .data.message // .data.code // .error // .message) // "unknown error"' \
        2>/dev/null | head -c 200
  fi
}

set_byok() {
  # args: main-json  →  returns 0 on success
  # Response shape: {"data":true,...}
  local payload resp
  payload=$(jq -nc --argjson main "$1" '{key:"byok_config", configValue:{main:$main}}')
  resp=$(curl -sS -X POST "$API/organization-parameters/create-or-update" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$payload" 2>&1)
  [ "$(echo "$resp" | jq -r '.data // empty' 2>/dev/null)" = "true" ]
}

verify_byok() {
  # args: expected-model  →  returns 0 if the stored config matches
  # Response shape: {"data":{"configValue":{"main":{"model":"..."}}}}
  local resp got
  resp=$(curl -sS "$API/organization-parameters/find-by-key?key=byok_config" \
    -H "authorization: Bearer $TOKEN" 2>&1)
  got=$(echo "$resp" | jq -r '.data.configValue.main.model // empty' 2>/dev/null)
  [ "$got" = "$1" ]
}

wait_for_reviews() {
  local worker zeros n started
  worker=$(docker ps --format '{{.Names}}' | grep worker | head -1)
  worker="${worker:-kodus_worker}"
  echo "  waiting for reviews (worker=$worker)..."

  # Phase 1 — wait for the first AGENT activity to appear (≤ 10 min).
  started=0
  for _ in $(seq 1 40); do
    n=$(docker logs "$worker" --since 60s 2>&1 | grep -c "AGENT" || true)
    if [ "${n:-0}" -gt 0 ]; then started=1; echo "  reviews started"; break; fi
    sleep 15
  done
  [ "$started" -eq 0 ] && echo "  WARN: no AGENT activity after 10min — proceeding to wait anyway"

  # Phase 2 — wait for quiescence: 4 consecutive idle polls (~3 min silent).
  # Hard cap ≈ 90 min.
  zeros=0
  for _ in $(seq 1 120); do
    n=$(docker logs "$worker" --since 60s 2>&1 | grep -c "AGENT" || true)
    if [ "${n:-0}" -eq 0 ]; then
      zeros=$((zeros + 1))
      [ "$zeros" -ge 4 ] && { echo "  reviews idle — done"; return 0; }
    else
      zeros=0
    fi
    sleep 45
  done
  echo "  WARN: hit 90min cap — proceeding to evaluate with whatever finished"
}

# ─── Sweep ──────────────────────────────────────────────────────────────
RAN=0
for c in "${CONFIGS[@]}"; do
  IFS='|' read -r label provider model baseurl keyenv maxtokens <<< "$c"
  selected "$label" || continue
  RAN=$((RAN + 1))

  echo ""
  echo "────────────────────────────────────────────────────────────"
  echo "▸ Config: $label   ($provider / $model)"
  echo "────────────────────────────────────────────────────────────"

  apikey=$(get_env "$keyenv")
  if [ -z "$apikey" ]; then
    echo "  ✗ SKIP — $keyenv not set in .env"
    echo "$label  SKIP  ($keyenv missing)" >> "$SUMMARY_FILE"
    continue
  fi

  main_json=$(build_main_json "$provider" "$model" "$apikey" "$baseurl" "${maxtokens:-}")

  echo "  testing credentials..."
  tb=$(test_byok "$main_json")
  if [ "$tb" != "ok" ]; then
    echo "  ✗ SKIP — test-byok failed: $tb"
    echo "$label  SKIP  (test-byok: $tb)" >> "$SUMMARY_FILE"
    continue
  fi
  echo "  ✓ credentials valid"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  (dry-run — not setting BYOK or running benchmark)"
    echo "$label  DRY-OK  ($provider / $model)" >> "$SUMMARY_FILE"
    continue
  fi

  echo "  setting BYOK config..."
  if ! set_byok "$main_json"; then
    echo "  ✗ SKIP — create-or-update failed"
    echo "$label  SKIP  (set-byok failed)" >> "$SUMMARY_FILE"
    continue
  fi
  if ! verify_byok "$model"; then
    echo "  ✗ SKIP — verify mismatch (stored model != $model)"
    echo "$label  SKIP  (verify mismatch)" >> "$SUMMARY_FILE"
    continue
  fi
  echo "  ✓ BYOK set to $provider / $model"

  run_name="sweep-$label"
  echo "  running benchmark-create ($PR_COUNT PRs)..."
  if ! "$SCRIPT_DIR/benchmark-create.sh" "$run_name" "$PR_COUNT"; then
    echo "  ✗ benchmark-create failed for $label"
    echo "$label  FAIL  (create)" >> "$SUMMARY_FILE"
    continue
  fi

  wait_for_reviews

  echo "  running benchmark-evaluate..."
  if [ "$DO_JUDGE" -eq 1 ]; then
    "$SCRIPT_DIR/benchmark-evaluate.sh" "$run_name" \
      || echo "  WARN: evaluate (with judge) returned non-zero"
  else
    "$SCRIPT_DIR/benchmark-evaluate.sh" "$run_name" --extract-only \
      || echo "  WARN: evaluate (extract-only) returned non-zero"
  fi

  echo "$label  DONE  ($provider / $model) → results/$run_name/" >> "$SUMMARY_FILE"
  echo "  ✓ $label done → $RESULTS_DIR/$run_name/"
done

echo ""
echo "============================================================"
echo "Sweep complete — $(date '+%Y-%m-%d %H:%M:%S')   ($RAN configs)"
echo "============================================================"
cat "$SUMMARY_FILE"
echo ""
echo "Roll-up: $SUMMARY_FILE"
[ "$DO_JUDGE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && \
  echo "Judge skipped — re-run with --judge once the Anthropic key works, or judge results/sweep-*/ manually."
