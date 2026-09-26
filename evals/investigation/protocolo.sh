#!/usr/bin/env bash
# O PROCESSO PADRAO. Uma rodada completa, sem parametro para esquecer de passar.
#
#   ./protocolo.sh <modelo> <nome-da-rodada>
#
# Fases, na ordem em que dependem umas das outras:
#   1. geracao      13 microagentes + simulacao (a simulacao NAO ve o cross-file)
#   2. judge  ||  atribuidor        — independentes, rodam juntos
#   3. veracidade  ||  verify       — os dois precisam do agrupamento, e so
#   4. relatorio    offline, sem LLM
#   5. debugger     pagina HTML do trace, tambem offline
#
# O judge julga TODOS os candidatos, nao os representantes: sem isso nao existe
# TP/FP por agente, nem pre-reducer, e a cobertura de um grupo passaria a
# significar "o representante casa", que e outra regra e outro numero.
set -euo pipefail
MODELO="${1:?uso: ./protocolo.sh <modelo> [nome]}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI"

# Nome da rodada: DD.MM.AA_vN[_titulo]. Sem o segundo argumento ele se nomeia
# sozinho com a data de hoje e o proximo vN livre — uma rodada nunca sobrescreve
# outra por engano, e o nome sozinho ja diz quando foi.
NOME="${2:-}"
if [ -z "$NOME" ]; then
    HOJE="$(date +%d.%m.%y)"
    N=1
    while [ -d "pools/${HOJE}_v${N}" ]; do N=$((N+1)); done
    NOME="${HOJE}_v${N}"
fi
case "$NOME" in
    [0-9][0-9].[0-9][0-9].[0-9][0-9]_v[0-9]*) ;;
    *) echo "nome fora do padrao DD.MM.AA_vN[_titulo]: $NOME" >&2; exit 1 ;;
esac
if [ -d "pools/$NOME" ]; then echo "pools/$NOME ja existe — escolha outro vN" >&2; exit 1; fi

export RECALL_SET=light
export RECALL_MODEL="$MODELO"
export RECALL_MICRO_AGENTS=1+sim
export RECALL_FINDING_REASON=1
export RECALL_SKIP_SYNTHESIS=1
export RECALL_SKIP_BASE_PASS=1
export RECALL_REAL_REPO=1
export RECALL_REDUCER=v2
export RECALL_GATE=0
export RECALL_DUMP="$AQUI/pools/$NOME"
export RECALL_CONCURRENCY="${RECALL_CONCURRENCY:-4}"
export POOL_ROOT="$AQUI/pools"
# GPT so roda com esforco baixo nesta investigacao; o DeepSeek pensa por padrao
# e nao aceita "ligar" — ver a medicao do reasoning_effort na Fireworks.
case "$MODELO" in gpt-*) export RECALL_REASONING_EFFORT=low ;; esac

echo "modelo $MODELO | rodada $NOME | concorrencia $RECALL_CONCURRENCY"
mkdir -p "$RECALL_DUMP"

echo; echo "==== 1/4 geracao ===="
# `|| true`: o run-recall sai com codigo 1 quando algum PR fica abaixo do limiar
# de qualidade — um veredito sobre a REVISAO, nao sobre a execucao. Com
# `set -e pipefail` isso matava o protocolo inteiro depois de 2h de geracao, com
# os 30 dumps ja gravados. Quem decide se a rodada presta e o portao abaixo.
node run-recall.js --model "$MODELO" --output "results/run-$NOME.json" 2>&1 | tee "results/run-$NOME.log" || true

# PORTAO: 30 dumps ou nada. Uma rodada com PR faltando nao e uma rodada menor,
# e um conjunto diferente — e as fases seguintes custam judge e atribuidor por
# cima de dado que nao vai poder ser comparado com nada. Cota estourada, rate
# limit e agente com zero passos aparecem todos aqui, como dump ausente.
DUMPS=$(ls "$RECALL_DUMP"/*.raw.txt 2>/dev/null | wc -l | tr -d ' ')
INFRA=$(grep -cE '^INFRA ' "results/run-$NOME.log" || true)
if [ "$DUMPS" != "30" ] || [ "$INFRA" != "0" ]; then
    echo
    echo "ABORTADO: $DUMPS/30 dumps, $INFRA casos de infraestrutura."
    grep -E '^INFRA ' "results/run-$NOME.log" | head -5
    echo "Nada de judge/atribuidor — o conjunto esta incompleto e nao seria comparavel."
    exit 1
fi

echo; echo "==== 2/4 judge (todos os candidatos)  ||  atribuidor ===="
node matriz-prefilter.js --dump="$NOME" --par=10 --out="results/matriz-$NOME.json" \
    > "results/matriz-$NOME.log" 2>&1 &
PID_J=$!
node seletor-vA.js --dump="$NOME" --parpr=5 --out="results/seletor-$NOME.json" \
    > "results/seletor-$NOME.log" 2>&1 &
PID_A=$!
wait $PID_J; wait $PID_A
echo "judge e atribuidor prontos"

echo; echo "==== 3/4 veracidade  ||  verify 8 passos ===="
node score2-veracidade.js --dump="$NOME" --grupos="results/seletor-$NOME.json" \
    --parpr=5 --out="results/score2-$NOME.json" > "results/score2-$NOME.log" 2>&1 &
PID_V=$!
RECALL_VERIFY_SCORE=1 RECALL_VERIFY_PASSOS=8 \
node verify-apos-atribuidor.js --dump="$NOME" --grupos="results/seletor-$NOME.json" \
    --parpr=4 --out="results/verify-$NOME.json" > "results/verify-$NOME.log" 2>&1 &
PID_F=$!
wait $PID_V; wait $PID_F

echo; echo "==== 4/5 relatorio ===="
python3 relatorio.py --run="$NOME"

echo; echo "==== 5/5 trace debugger ===="
# So le artefato ja gravado: nenhuma chamada de LLM, instantaneo. Pode ser
# regerado a qualquer momento depois (ex.: depois de acrescentar o verify).
node build-trace-debugger.js --run="$NOME"
