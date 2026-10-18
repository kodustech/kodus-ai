#!/usr/bin/env python3
"""Segunda passada: os comentarios que nao casaram com TP (Opus e Astra) contra os FPs ja conhecidos do PR.
  python3 monta-fp.py <chave>  ->  <chave>/fp/juiz-in.json, <chave>/casamento-tp.json
Casa com TP pelo juiz Opus; o Astra confere e as divergencias ficam em casamento-tp.json."""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
K = sys.argv[1]; W = os.path.join(AQUI, K)
IN = json.load(open(f'{W}/juiz-in.json'))
op = {}
for f in glob.glob(f'{W}/opus-out*.json'): op.update(json.load(open(f)))
ast = {}
for f in glob.glob(f'{W}/astra/*.json'):
    d = json.load(open(f)); ast[d['caseId']] = {x['id']: x for x in d['items']}
fps = json.load(open(os.path.join(V3, 'fps-conhecidos.json')))['prs']
tp, ent, div = {}, {}, []
for c, p in IN.items():
    o = {x['id']: x for x in op.get(c, [])}
    resto = []
    for s in p['sugestoes']:
        om, am = o[s['id']]['match'], ast[c][s['id']]['match']
        # O Opus e o juiz oficial; o Astra confere. Divergencia fica registrada.
        if om != 'new':
            tp.setdefault(c, {})[s['id']] = om
            if om != am: div.append((c, s['id'], om, am))
        else:
            resto.append(s)
            if om != am: div.append((c, s['id'], om, am))
    if resto:
        ent[c] = {**{k: p[k] for k in ('repo', 'head', 'base')}, 'sugestoes': resto,
                  'issues': [{'issueId': r['issueId'], 'descricao': r.get('commentOpus') or r['comment'], 'textoGolden': None, 'comentarios': []} for r in fps.get(c, [])]}
os.makedirs(f'{W}/fp', exist_ok=True)
json.dump(ent, open(f'{W}/fp/juiz-in.json', 'w'), indent=1)
json.dump({'tp': tp, 'divergencias': div}, open(f'{W}/casamento-tp.json', 'w'), indent=1)
print(K, 'casam TP', sum(len(v) for v in tp.values()), '| segunda passada', sum(len(v['sugestoes']) for v in ent.values()), 'em', len(ent), 'PRs | FPs conhecidos', sum(len(v['issues']) for v in ent.values()), '| divergencias', len(div))
