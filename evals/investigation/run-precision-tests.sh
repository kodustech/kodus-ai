#!/usr/bin/env bash
# Os dois testes de precisao em cima da saida do reducer (ds16b, com reason).
set -u
cd "$(dirname "$0")/../.."
export RECALL_MODEL=${RECALL_MODEL:-deepseek-v4.1-flash@fireworks}
R=evals/investigation/results
L=/tmp/precision-tests
mkdir -p "$L"

echo "== A: refute-or-promote estagiado (onus da prova invertido)"
node evals/investigation/precision-tests.js --teste=gate \
    --parpr=4 --par=6 --out=$R/pt-gate.json >"$L/gate.log" 2>&1
tail -5 "$L/gate.log"

echo "== B: vanilla + self-consistency k=5 sobre contexto pre-extraido"
node evals/investigation/precision-tests.js --teste=vanilla --k=5 \
    --parpr=4 --par=6 --out=$R/pt-vanilla.json >"$L/vanilla.log" 2>&1
tail -5 "$L/vanilla.log"

echo
echo "== PLACAR"
node evals/investigation/pontuar.js $R/pt-gate.json $R/pt-vanilla.json
