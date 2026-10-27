#!/usr/bin/env python3
"""Rodada de 27/10 (#1821): producao (worktree congelado) contra o fluxo novo, 30 PRs do light.
Entrada do juiz Opus para um lado e um modelo, contra os TPs e TP nits do gold v3.

  python3 monta.py <lado> <modelo> <dir dos dumps>   ->  <lado>-<modelo>/juiz-in.json, opus-in<n>.json, mapa.json

Cada sugestao e julgada uma vez: o finder (loopFindings, ja depois do verify) e o que o dedup
manteve que nao esta no finder com o mesmo texto. O final e o texto reescrito pelo formatter no
mesmo arquivo e linha de um item do dedup, e herda o rotulo dele (mapa.json); um final sem item
unico do dedup naquele lugar e julgado a parte.
"""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__))
V3 = os.path.join(AQUI, '..', '..')
LADO, MOD, DUMP = sys.argv[1], sys.argv[2], sys.argv[3]
W = os.path.join(AQUI, f'{LADO}-{MOD}'); os.makedirs(W, exist_ok=True)
base = json.load(open(os.path.join(AQUI, '..', 'e2b', 'casamento-in.json')))
g = json.load(open(os.path.join(V3, 'golden.json')))['prs']
LOTE = 40

key = lambda s: (s.get('relevantFile'), s.get('relevantLinesStart'), s.get('relevantLinesEnd'), s.get('suggestionContent') or '')
loc = lambda s: (s.get('relevantFile'), s.get('relevantLinesStart'))

ent, mapa = {}, {}
for f in sorted(glob.glob(f'{DUMP}/*.raw.txt')):
    o = json.loads(open(f).read()); c = o['caseId']
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
    finder = [add(s) for s in o['loopFindings']]
    dedup = [add(s) for s in (o.get('dedupFindings') or [])]
    porLugar = {}
    for s, i in zip(o.get('dedupFindings') or [], dedup):
        porLugar.setdefault(loc(s), set()).add(i)
    final = []
    for s in o['findings']:
        lugar = porLugar.get(loc(s), set())
        final.append(next(iter(lugar)) if len(lugar) == 1 else add(s))
    ent[c] = {**{k: base[c][k] for k in ('repo', 'head', 'base')}, 'sugestoes': itens, 'issues': issues}
    mapa[c] = {'finder': finder, 'dedup': dedup, 'final': final}

json.dump(ent, open(f'{W}/juiz-in.json', 'w'), indent=1)
json.dump(mapa, open(f'{W}/mapa.json', 'w'), indent=1)
total = sum(len(v['sugestoes']) for v in ent.values())
n = max(1, -(-total // LOTE))
lotes, peso = [[] for _ in range(n)], [0] * n
for k in sorted(ent, key=lambda k: -len(ent[k]['sugestoes'])):
    j = peso.index(min(peso)); lotes[j].append(k); peso[j] += len(ent[k]['sugestoes'])
for j, l in enumerate(lotes):
    json.dump({k: ent[k] for k in l}, open(f'{W}/opus-in{j}.json', 'w'), indent=1)
print(LADO, MOD, 'PRs', len(ent), 'julgadas', total, 'finder', sum(len(m['finder']) for m in mapa.values()),
      'dedup', sum(len(m['dedup']) for m in mapa.values()), 'final', sum(len(m['final']) for m in mapa.values()), 'lotes', peso)
