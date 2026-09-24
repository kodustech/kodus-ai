#!/usr/bin/env bash
# Uma rodada completa: geracao com o reducer DENTRO do fluxo, e a pontuacao
# logo em seguida. Nao existe mais etapa offline entre as duas.
#
#   ./rodar.sh deepseek-v4.1-flash@fireworks ds-1
#   ./rodar.sh gpt-5.6-sol@sub gpt-1
#
# O segundo argumento nomeia a rodada: os dumps vao para pools/<nome>/ e a
# pontuacao para results/v002-<nome>.json.
#
# Para varrer a curva de orcamento sem mexer em codigo:
#   RECALL_REDUCER_COTA=5 ./rodar.sh <modelo> <nome>
#
# Para mandar o <CallGraph> junto no prompt dos agentes (teste A/B):
#   GRAFO=1 ./rodar.sh <modelo> <nome>
set -euo pipefail

MODELO="${1:?uso: ./rodar.sh <modelo> <nome-da-rodada>}"
NOME="${2:?uso: ./rodar.sh <modelo> <nome-da-rodada>}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL="$AQUI/pools/$NOME"

# --- o que definiu a configuracao medida -------------------------------------
export RECALL_SET=light               # os 30 PRs do conjunto leve
export RECALL_MODEL="$MODELO"
export RECALL_MICRO_AGENTS=1+sim      # os 12 microagentes E a simulacao
export RECALL_FINDING_REASON=1        # todo achado traz o percurso; o filtro
                                      # de contrato e o reducer dependem dele
export RECALL_SKIP_SYNTHESIS=1        # sem synthesis-rescue
export RECALL_SKIP_BASE_PASS=1        # sem a passada generalista
export RECALL_REAL_REPO=1             # worktree de verdade, nao fixture
export RECALL_REDUCER=v2              # o reducer de producao, dentro da rodada

# GRAFO=1 liga o <CallGraph> no prompt dos doze agentes E da simulacao, logo
# abaixo do diff. As duas variaveis andam juntas: RECALL_CALL_GRAPH constroi o
# blob e RECALL_MICRO_GRAPH manda ele. Ligar so a segunda nao faz nada, em
# silencio, que e como esse blob ja passou por toda medicao que temos sem nunca
# ter chegado em lugar nenhum.
if [ "${GRAFO:-0}" = "1" ]; then
    export RECALL_CALL_GRAPH=1
    export RECALL_MICRO_GRAPH=1
fi
export RECALL_GATE=0                  # o gate da prova nao faz parte do campeao
export RECALL_DUMP="$POOL"
export RECALL_CONCURRENCY="${RECALL_CONCURRENCY:-4}"

# Os tres agentes fracos ja saem desligados em micro-agents.ts. RECALL_SKIP_AGENTS
# so acrescenta — nao precisa (e nao adianta) repeti-los aqui.

echo "modelo    $MODELO"
echo "rodada    $NOME"
echo "dumps     $POOL"
echo "reducer   v2 (cota ${RECALL_REDUCER_COTA:-padrao}, limiar ${RECALL_REDUCER_LIMIAR:-padrao})"
echo "grafo     ${RECALL_MICRO_GRAPH:+LIGADO no prompt dos agentes}${RECALL_MICRO_GRAPH:-desligado (so marca tier)}"
echo

mkdir -p "$POOL"
node "$AQUI/run-recall.js" --model "$MODELO" \
    --output "$AQUI/results/run-$NOME.json" 2>&1 | tee "$AQUI/results/run-$NOME.log"

echo
echo "==== pontuando contra o golden v002 ===="
POOL_ROOT="$AQUI/pools" node "$AQUI/pontuar-v002.js" \
    --dump="$NOME" --out="$AQUI/results/v002-$NOME.json"
