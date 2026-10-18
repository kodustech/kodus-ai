#!/usr/bin/env python3
"""Placar do baseline de producao (main 1a7041085, light) no gold v3, regra oficial:
TP = TP do gold confirmado ou descontinuado no upstream; pendente e nao_entrou_no_original contam como FP.
Cada TP conta uma vez; todo o resto que o review publicou e FP.
  python3 placar.py <saida.json>"""
import json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
CH = {'ds': 'deepseek-v4.1-flash@prod', 'gpt': 'gpt-6.1-sol@prod', 'opus': 'opus-5.5@prod', 'sonnet': 'sonnet-5.5@prod'}
FPST = {'pendente', 'nao_entrou_no_original'}
g = json.load(open(f'{V3}/golden.json'))['prs']
st = {k: t['status'] for p in json.load(open(f'{V3}/verificacao-upstream.json'))['prs'].values() for k, t in p['tps'].items()}
valido = {r['issueId'] for l in g.values() for r in l if r['class'] == 'TP' and not r['subclass'] and st[r['issueId']] not in FPST}
mapa = json.load(open(f'{V3}/sugestoes.json'))['sugestoes']
out = {}
for k, ch in CH.items():
    IN = json.load(open(f'{AQUI}/{k}/juiz-in.json'))
    vistos, tot = set(), 0
    for c, p in IN.items():
        for s in p['sugestoes']:
            tot += 1
            iss = mapa[f'{ch}|{c}|{s["id"]}']
            if iss in valido: vistos.add(iss)
    tp = len(vistos); R = tp / len(valido); P = tp / tot if tot else 0
    f = lambda b: (1 + b * b) * P * R / (b * b * P + R) if P + R else 0
    out[k] = {'comentarios': tot, 'tp': tp, 'fp': tot - tp, 'totalTp': len(valido), 'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
    print(k, out[k])
json.dump(out, open(sys.argv[1], 'w'), indent=1)
