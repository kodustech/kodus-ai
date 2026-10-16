#!/usr/bin/env bash
# #1821: o fluxo pos-finder como em producao, sobre sugestoes ja rodadas do finder:
#   dedup real -> grupos do dedup (keep segue) -> verify C (h1 ate 10 passos, depois c3)
#   -> nit protegido (v3d, grupos de um membro que o verify manteve).
# Nada do gabarito entra no fluxo.
#
#   evals/dedup/gold-v2/fluxo-producao.sh <prefixo> <gold model> <RECALL_MODEL> [lista de PRs]
#   ex.: fluxo-producao.sh gen sonnet-5.5 claude-sonnet-5.5@sdk
# <prefixo>_<gold model>.json: as sugestoes do finder (ids S1..Sn).
set -euo pipefail
P=$1 G=$2 M=$3
RAIZ=$(cd "$(dirname "$0")/../../.." && pwd)
PRS=${4:-$RAIZ/evals/investigation/light-holdout-50.json}
D=$RAIZ/evals/dedup/gold-v2
export RECALL_MODEL=$M NODE_PATH=$RAIZ/node_modules
export RECALL_CLAUDE_SDK_DIR=${RECALL_CLAUDE_SDK_DIR:-$HOME/.cache/kodus-eval-claude-sdk}
[[ $M == *gpt* ]] && export RECALL_REASONING_EFFORT=${RECALL_REASONING_EFFORT:-low}
cd "$RAIZ"

erros() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]))['prs'];print(sum(1 for p in d.values() if p.get('erro')))" "$1"; }
# Roda a etapa; os scripts retomam so os PRs com erro, entao repete ate 3 vezes.
etapa() {
    local saida=$1; shift
    for t in 1 2 3; do
        echo "[$P/$G] $(date +%T) $*" >&2
        local rc=0
        node "$@" >&2 || rc=$?
        [[ $rc == 0 && -f $saida && $(erros "$saida") == 0 ]] && return 0
    done
    echo "[$P/$G] etapa com erro depois de 3 tentativas: $saida" >&2; return 1
}

etapa "$D/dedup-real/$P-dedup/$G.json" "$D/pipeline-ate-dedup.js" --model="$G" --fonte=gold --prefixo="$P" --versao="$P-dedup" --prs="$PRS"
node "$D/final-de-dedup.js" --model="$G" --prefixo="$P" --dedup="$P-dedup" >&2
etapa "$D/verify/resultados/aluc-$P-h1t10/$G.json" "$D/verify/alucinacao.js" --model="$G" --prefixo="$P" --dedup="$P-dedup" --versao="$P-h1t10" --prompt=h1 --teto=10
etapa "$D/verify/resultados/aluc-$P-h1t10f/$G.json" "$D/verify/alucinacao-confirma.js" --model="$G" --prefixo="$P" --sobre="$P-h1t10" --versao="$P-h1t10f" --prompt=c3
etapa "$D/verify/resultados/$P-nit-v3d-so1/$G.json" "$D/verify/nit.js" --model="$G" --prefixo="$P" --dedup="$P-dedup" --versao=v3d --so1=1 --sobre="aluc-$P-h1t10f" --saida="$P-nit-v3d-so1"
echo "[$P/$G] fim" >&2
