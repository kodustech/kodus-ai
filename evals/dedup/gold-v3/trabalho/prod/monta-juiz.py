#!/usr/bin/env python3
"""Baseline de producao (main 1a7041085, light): entrada do juiz Opus por modelo.

  python3 monta-juiz.py <chave> <dir dos dumps>   ->  <chave>/juiz-in.json, <chave>/opus-in{0,1,2}.json
O que o review publica (findings do dump) contra os TPs e TP nits do gold v3 de cada PR.
"""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__))
V3 = os.path.join(AQUI, '..', '..')
K, DUMP = sys.argv[1], sys.argv[2]
W = os.path.join(AQUI, K); os.makedirs(W, exist_ok=True)
base = json.load(open(os.path.join(AQUI, '..', 'e2b', 'casamento-in.json')))
g = json.load(open(os.path.join(V3, 'golden.json')))['prs']
ent = {}
for f in sorted(glob.glob(f'{DUMP}/*.raw.txt')):
    o = json.loads(open(f).read()); c = o['caseId']
    tps = {r['issueId'] for r in g.get(c, [])}
    issues = [i for i in base[c]['issues'] if i['issueId'] in tps]
    for r in g.get(c, []):
        if r['issueId'] not in {i['issueId'] for i in issues}:
            issues.append({'issueId': r['issueId'], 'descricao': r.get('commentOpus') or r['comment'], 'textoGolden': None, 'comentarios': []})
    sug = [{'id': f'S{j}', 'file': s.get('relevantFile'), 'lines': [s.get('relevantLinesStart'), s.get('relevantLinesEnd')], 'texto': s.get('suggestionContent') or ''}
           for j, s in enumerate(o['findings'], 1)]
    ent[c] = {**{k: base[c][k] for k in ('repo', 'head', 'base')}, 'sugestoes': sug, 'issues': issues}
json.dump(ent, open(f'{W}/juiz-in.json', 'w'), indent=1)
lotes, peso = [[] for _ in range(3)], [0] * 3
for k in sorted(ent, key=lambda k: -len(ent[k]['sugestoes'])):
    j = peso.index(min(peso)); lotes[j].append(k); peso[j] += len(ent[k]['sugestoes'])
for j, l in enumerate(lotes):
    json.dump({k: ent[k] for k in l}, open(f'{W}/opus-in{j}.json', 'w'), indent=1)
print(K, 'PRs', len(ent), 'sugestoes', sum(len(v['sugestoes']) for v in ent.values()), 'lotes', peso)
