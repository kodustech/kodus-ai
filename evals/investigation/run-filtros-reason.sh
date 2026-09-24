#!/usr/bin/env bash
# Os quatro filtros sobre ds16b (o unico dump com `reason`), todos no mesmo
# modelo. A cota do gpt-5.6-sol acabou no meio do dia, entao o deepseek nao e
# escolha metodologica: e o que da para rodar. O ponto e que os cinco numeros
# saem do MESMO modelo e do MESMO dump, entao comparam entre si.
set -u
cd "$(dirname "$0")/../.."
export RECALL_MODEL=${RECALL_MODEL:-deepseek-v4.1-flash@fireworks}
R=evals/investigation/results
L=/tmp/filtros-reason
mkdir -p "$L"

# Passo 0: rotular o pool pre-reducer contra os goldens, uma vez. A bateria de
# scores e a do Jev precisam do rotulo por candidato, e o cache evita 900
# chamadas de judge repetidas entre as duas.
echo "== 0 rotulando pool pre-reducer"
node evals/investigation/label-candidates.js --dumps=ds16b >"$L/labels.log" 2>&1
tail -3 "$L/labels.log"

echo "== 1/4 reducer (controle)"
node evals/investigation/replay-reducer.js --dumps=ds16b \
    --out=$R/f-reducer-reason.json >"$L/reducer.log" 2>&1
tail -6 "$L/reducer.log"

echo "== 2/4 dedup -> walk (a aposta)"
node evals/investigation/dedup-then-verify.js --criterio=walk --dumps=ds16b \
    --limit=30 --parpr=3 --par=4 --maxsteps=24 --out=$R/f-walk.json >"$L/walk.log" 2>&1
tail -8 "$L/walk.log"

echo "== 3/4 bateria de scores 0-100"
node evals/investigation/question-battery.js --dumps=ds16b \
    --parpr=3 --par=4 --out=$R/f-bateria.json >"$L/bateria.log" 2>&1
tail -8 "$L/bateria.log"

echo "== 4/4 bateria Jev"
node evals/investigation/typesafe-filter.js --dumps=ds16b --contexto \
    --out=$R/f-jev.json >"$L/jev.log" 2>&1
tail -8 "$L/jev.log"

echo "== fim; logs em $L"
