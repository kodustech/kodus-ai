#!/usr/bin/env python3
"""Placar da rodada de 27/10 (#1821) no gold v3, por lado, modelo e etapa (finder, dedup, final).
Regra oficial (prod/placar.py): TP = TP do gold confirmado ou descontinuado no upstream, nos 30 PRs
do light; cada TP conta uma vez; todo o resto que a etapa entregou e FP.

  python3 placar.py <saida.json>   (le <lado>-<modelo>/opus-out*.json e mapa.json)"""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
FPST = {'pendente', 'nao_entrou_no_original'}
LIGHT = set(json.load(open(os.path.join(V3, '..', '..', 'investigation', 'light-30.json'))))
g = json.load(open(f'{V3}/golden.json'))['prs']
st = {k: t['status'] for p in json.load(open(f'{V3}/verificacao-upstream.json'))['prs'].values() for k, t in p['tps'].items()}
valido = {r['issueId'] for c, l in g.items() if c in LIGHT for r in l if r['class'] == 'TP' and not r['subclass'] and st[r['issueId']] not in FPST}

out = {}
for W in sorted(glob.glob(f'{AQUI}/*-*/mapa.json')):
    W = os.path.dirname(W); chave = os.path.basename(W)
    outs = glob.glob(f'{W}/opus-out*.json')
    if not outs:
        continue
    match = {}
    for f in outs:
        for c, L in json.load(open(f)).items():
            for x in L:
                match[(c, x['id'])] = x['match']
    mapa = json.load(open(f'{W}/mapa.json'))
    faltam = [(c, i) for c, m in mapa.items() for e in m.values() for i in e if (c, i) not in match]
    linha = {'faltamJulgar': len(set(faltam))}
    for etapa in ('finder', 'dedup', 'final'):
        vistos, tot = set(), 0
        for c, m in mapa.items():
            for i in m[etapa]:
                tot += 1
                iss = match.get((c, i))
                if iss in valido:
                    vistos.add(iss)
        tp = len(vistos); R = tp / len(valido); P = tp / tot if tot else 0
        f = lambda b: (1 + b * b) * P * R / (b * b * P + R) if P + R else 0
        linha[etapa] = {'comentarios': tot, 'tp': tp, 'fp': tot - tp, 'totalTp': len(valido),
                        'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
    out[chave] = linha
    print(chave, json.dumps(linha))
json.dump(out, open(sys.argv[1], 'w'), indent=1)
