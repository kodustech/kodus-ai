#!/usr/bin/env python3
"""Recall contra o gold v3 de cada snapshot julgado (mesma regra de TP valido da rodada-2710).

  python3 placar.py   ->  por snapshot: light 30 e controlled 15, finder e dedup
"""
import json, os, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
FPST = {'pendente', 'nao_entrou_no_original'}
LIGHT = set(json.load(open(os.path.join(V3, '..', '..', 'investigation', 'light-30.json'))))
CTL = set(json.load(open(os.path.join(AQUI, 'controlled-15.json'))))
g = json.load(open(f'{V3}/golden.json'))['prs']
st = {k: t['status'] for p in json.load(open(f'{V3}/verificacao-upstream.json'))['prs'].values() for k, t in p['tps'].items()}
valido = {c: {r['issueId'] for r in l if r['class'] == 'TP' and not r['subclass'] and st[r['issueId']] not in FPST} for c, l in g.items() if c in LIGHT}

for W in sorted(glob.glob(f'{AQUI}/*/mapa.json')):
    W = os.path.dirname(W)
    match = {(c, x['id']): x['match'] for f in glob.glob(f'{W}/opus-out*.json') for c, L in json.load(open(f)).items() for x in L}
    mapa = json.load(open(f'{W}/mapa.json'))
    for nome, prs in (('light-30', LIGHT), ('controlled-15', CTL)):
        prs = [c for c in prs if c in mapa]
        for etapa in ('finder', 'dedup'):
            vistos = {(c, match.get((c, i))) for c in prs for i in mapa[c][etapa]}
            tp = sum(1 for c in prs for v in valido[c] if (c, v) in vistos)
            tot = sum(len(valido[c]) for c in prs)
            porPR = [sum(1 for v in valido[c] if (c, v) in vistos) / len(valido[c]) for c in prs if valido[c]]
            print(f'{os.path.basename(W):12} {nome:14} {etapa:7} PRs {len(prs):2}  recall {tp}/{tot} = {tp / tot:.3f}  media por PR {sum(porPR) / len(porPR):.3f}')
