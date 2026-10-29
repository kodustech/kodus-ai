#!/usr/bin/env python3
"""Snapshot do funnel (evals/funnel/snapshot) julgado contra o gold v3, como a rodada-2710.

  python3 monta.py <nome> <snapshot.json>   ->  <nome>/juiz-in.json, opus-in<n>.json, mapa.json

finder: o que cada agente entregou ao anchoring (saida do loop, ja depois do verify).
dedup: o que a severity recebeu (saida do dedup). O snapshot guarda so a contagem do que sai no final.
"""
import json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
V3 = os.path.join(AQUI, '..', '..')
NOME, SNAP = sys.argv[1], sys.argv[2]
W = os.path.join(AQUI, NOME); os.makedirs(W, exist_ok=True)
base = json.load(open(os.path.join(AQUI, '..', 'e2b', 'casamento-in.json')))
g = json.load(open(os.path.join(V3, 'golden.json')))['prs']
LOTE = 40
key = lambda s: (s.get('relevantFile'), s.get('relevantLinesStart'), s.get('relevantLinesEnd'), s.get('suggestionContent') or '')

ent, mapa = {}, {}
for caso in json.load(open(SNAP))['cases']:
    c = caso['caseId']
    if c not in base:
        continue
    tps = {r['issueId'] for r in g.get(c, [])}
    issues = [i for i in base[c]['issues'] if i['issueId'] in tps]
    for r in g.get(c, []):
        if r['issueId'] not in {i['issueId'] for i in issues}:
            issues.append({'issueId': r['issueId'], 'descricao': r.get('commentOpus') or r['comment'], 'textoGolden': None, 'comentarios': []})
    itens, ids = [], {}
    def add(s):
        k = key(s)
        if k not in ids:
            ids[k] = f'S{len(itens) + 1}'
            itens.append({'id': ids[k], 'file': s.get('relevantFile'), 'lines': [s.get('relevantLinesStart'), s.get('relevantLinesEnd')], 'texto': s.get('suggestionContent') or ''})
        return ids[k]
    finder = [add(x['finding']) for a in caso['anchoring']['agents'] for x in a['candidates']]
    dedup = [add(x['finding']) for x in caso['severity']['candidates']]
    ent[c] = {**{k: base[c][k] for k in ('repo', 'head', 'base')}, 'sugestoes': itens, 'issues': issues}
    mapa[c] = {'finder': finder, 'dedup': dedup}

json.dump(ent, open(f'{W}/juiz-in.json', 'w'), indent=1)
json.dump(mapa, open(f'{W}/mapa.json', 'w'), indent=1)
total = sum(len(v['sugestoes']) for v in ent.values())
n = max(1, -(-total // LOTE))
lotes, peso = [[] for _ in range(n)], [0] * n
for k in sorted(ent, key=lambda k: -len(ent[k]['sugestoes'])):
    j = peso.index(min(peso)); lotes[j].append(k); peso[j] += len(ent[k]['sugestoes'])
for j, l in enumerate(lotes):
    json.dump({k: ent[k] for k in l}, open(f'{W}/opus-in{j}.json', 'w'), indent=1)
print(NOME, 'PRs', len(ent), 'julgadas', total, 'finder', sum(len(m['finder']) for m in mapa.values()), 'dedup', sum(len(m['dedup']) for m in mapa.values()), 'lotes', peso)
