#!/usr/bin/env bash
#
# Phase 03 NOLC / parser-bypass gate (plan 03-13, the FINAL gate).
#
# Proves the LangChain LLM execution half is unreachable and deleted:
#   - D-03 / REQ-SEC-01: no runtime consumer can reach kodus-common's
#     ZodOutputParser._runCorrectionChain (the system-key repair leak), because
#     no runtime .builder().execute() and no `new BYOKPromptRunnerService` remain.
#   - D-04: @langchain is confined to the embeddings path (document.ts);
#     nothing on the LLM chat/review execution path imports @langchain.
#
# It is the DURABLE regression guard (T-03-24 / T-03-25): a future .builder() executor
# or a re-introduced wrapper construction in libs fails this gate.
#
# Comment-only lines are stripped before matching (a line whose text after ':NN:'
# starts with '*' or '//'), so the two kody-rules collaborators that mention
# .builder()/BYOKPromptRunnerService ONLY in doc comments
# (kody-rules-sharded.judge.ts, kody-rules-detector.compiler.ts) never false-positive.
# The empirical grep over libs is the source of truth — not any consumer count.
#
# Exit 0 only when GATE-A, GATE-B and GATE-D produce no output. GATE-C and GATE-E
# are informational (printed for review), not fail conditions.

set -uo pipefail

# Run from the repo root regardless of caller cwd.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 2

# Strip comment-only matches: drop any line whose content after ':<lineno>:' begins
# with '*' (JSDoc continuation) or '//' (line comment).
strip_comments() { grep -vE ':[0-9]+:[[:space:]]*(\*|//)'; }

fail=0

echo "== GATE-A: runtime .builder() executors in libs (MUST be empty) =="
gate_a="$(grep -rn --include='*.ts' -E '\.builder\(\)' libs \
    | grep -v '.spec.ts' \
    | strip_comments \
    | grep -v 'byokPromptRunner.service.ts')"
if [ -n "$gate_a" ]; then
    echo "FAIL — a runtime .builder() executor remains (a consumer was missed):"
    echo "$gate_a"
    fail=1
else
    echo "ok — none"
fi
echo

echo "== GATE-B: runtime 'new BYOKPromptRunnerService' in libs (MUST be empty) =="
# The wrapper's own internal withConfig() self-reference is not a consumer; the
# must_haves truth scopes this to constructions OUTSIDE the wrapper's own file
# (and after Task 2 the wrapper file is deleted, so this is empty either way).
gate_b="$(grep -rn --include='*.ts' 'new BYOKPromptRunnerService' libs \
    | grep -v '.spec.ts' \
    | strip_comments \
    | grep -v 'byokPromptRunner.service.ts')"
if [ -n "$gate_b" ]; then
    echo "FAIL — a runtime consumer constructs the LangChain wrapper (reopens the leak):"
    echo "$gate_b"
    fail=1
else
    echo "ok — none"
fi
echo

echo "== GATE-C: remaining PromptRunnerService lines in libs (INFORMATIONAL) =="
echo "   each MUST be a type-only usage (DI param / type import) with no reachable .builder();"
echo "   these are the DEFERRED 01-05 codemod's job, not this gate's."
gate_c="$(grep -rn --include='*.ts' 'PromptRunnerService' libs \
    | grep -v '.spec.ts' \
    | strip_comments)"
if [ -n "$gate_c" ]; then
    echo "$gate_c"
else
    echo "   (none)"
fi
echo

echo "== GATE-D: runtime @langchain imports in libs (MUST list ONLY document.ts) =="
gate_d="$(grep -rln --include='*.ts' '@langchain/' libs \
    | grep -v '.spec.ts' \
    | grep -v 'document.ts')"
if [ -n "$gate_d" ]; then
    echo "FAIL — @langchain is on the LLM execution path (only the embeddings document.ts is allowed):"
    echo "$gate_d"
    fail=1
else
    echo "ok — @langchain confined to libs/common/utils/document.ts (embeddings, out of scope)"
fi
echo

echo "== GATE-E: importers of byokPromptRunner.service in libs (INFORMATIONAL — for the Task 2 delete) =="
gate_e="$(grep -rn --include='*.ts' 'byokPromptRunner.service' libs \
    | grep -v '.spec.ts' \
    | strip_comments)"
if [ -n "$gate_e" ]; then
    echo "$gate_e"
else
    echo "   (none — the wrapper has zero runtime importers; safe to delete)"
fi
echo

if [ "$fail" -ne 0 ]; then
    echo "RESULT: FAIL — the LangChain execution path is still reachable; delete nothing, report the offending file."
    exit 1
fi

echo "RESULT: PASS — no runtime .builder()/new BYOKPromptRunnerService remains and @langchain is confined to the embeddings document.ts."
exit 0
