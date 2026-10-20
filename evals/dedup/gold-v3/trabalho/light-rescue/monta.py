#!/usr/bin/env python3
"""Novo light + synthesis rescue (so o finder, saida enxuta, sem lentes/dedup/verify) no gold v3.
Os comentarios sao os preFilterCandidates do generalista e do rescue, nos pools 20.10.26_lightrescue_<chave>-light e -holdout.
  python3 monta.py <chave> pools [partes]   ->  <chave>/comentarios.json, <chave>/opus-in<i>.json (passada 1, contra o golden)
  python3 monta.py <chave> --fp                       ->  <chave>/fp/juiz-in.json (passada 2: o que nao casou, contra os FPs conhecidos)"""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
base = json.load(open(os.path.join(AQUI, '..', 'e2b', 'casamento-in.json')))
gold = json.load(open(f'{V3}/golden.json'))['prs']; fps = json.load(open(f'{V3}/fps-conhecidos.json'))['prs']
k = sys.argv[1]; W = os.path.join(AQUI, k); os.makedirs(W, exist_ok=True)
chave = lambda s: '::'.join(str(x) for x in (s.get('relevantFile'), s.get('relevantLinesStart') if s.get('relevantLinesStart') is not None else '', s.get('relevantLinesEnd') if s.get('relevantLinesEnd') is not None else '', s.get('suggestionContent')))
def ent(c, sug, issues): return {**{x: base[c][x] for x in ('repo', 'head', 'base')}, 'sugestoes': sug, 'issues': issues}
if sys.argv[2] == '--fp':
    com = json.load(open(f'{W}/comentarios.json')); out = {}
    for f in glob.glob(f'{W}/opus-out*.json'): out.update(json.load(open(f)))
    fin = {}
    for c, itens in com.items():
        if not itens: continue
        m = {x['id']: x['match'] for x in out[c]}
        assert set(m) == {i['id'] for i in itens}, c
        sug = [{'id': i['id'], 'file': i['file'], 'lines': i['lines'], 'texto': i['texto']} for i in itens if m[i['id']] == 'new']
        iss = [{'issueId': r['issueId'], 'descricao': r.get('commentOpus') or r['comment'], 'textoGolden': None, 'comentarios': []} for r in fps.get(c, [])]
        if sug and iss: fin[c] = ent(c, sug, iss)
    os.makedirs(f'{W}/fp', exist_ok=True); json.dump(fin, open(f'{W}/fp/juiz-in.json', 'w'), indent=1)
    print(k, 'fp: PRs', len(fin), 'comentarios', sum(len(v['sugestoes']) for v in fin.values())); sys.exit()
D = sys.argv[2]; partes = int(sys.argv[3]) if len(sys.argv) > 3 else 2
com, juiz, origem = {}, {}, {'generalist': 0, 'synthesis-rescue': 0}
INV = os.path.join(V3, '..', '..', 'investigation', 'pools'); ORG = {'generalist-base': 'generalist', 'synthesis-rescue': 'synthesis-rescue'}
for f in sorted(glob.glob(f'{INV}/20.10.26_lightrescue_{k}-light/*.raw.txt') + glob.glob(f'{INV}/20.10.26_lightrescue_{k}-holdout/*.raw.txt')):
    o = json.loads(open(f).read()); c = o['caseId']; itens = []
    for s in o['trace'].get('preFilterCandidates') or []:
        lab = ORG[s['producedBy']]; origem[lab] += 1
        itens.append({'id': f'V{len(itens) + 1}', 'origem': lab, 'file': s.get('relevantFile'), 'lines': [s.get('relevantLinesStart'), s.get('relevantLinesEnd')], 'texto': s.get('suggestionContent') or ''})
    com[c] = itens
    if itens:
        issues = [i for i in base[c]['issues'] if i['issueId'] in {r['issueId'] for r in gold.get(c, [])}]
        for r in gold.get(c, []):
            if r['issueId'] not in {i['issueId'] for i in issues}:
                issues.append({'issueId': r['issueId'], 'descricao': r.get('commentOpus') or r['comment'], 'textoGolden': None, 'comentarios': []})
        juiz[c] = ent(c, [{x: i[x] for x in ('id', 'file', 'lines', 'texto')} for i in itens], issues)
json.dump(com, open(f'{W}/comentarios.json', 'w'), indent=1)
ps = sorted(juiz, key=lambda c: -len(json.dumps(juiz[c]))); grupos = [dict() for _ in range(partes)]; tam = [0] * partes
for c in ps:
    i = tam.index(min(tam)); grupos[i][c] = juiz[c]; tam[i] += len(json.dumps(juiz[c]))
for i, g in enumerate(grupos): json.dump(g, open(f'{W}/opus-in{i}.json', 'w'), indent=1)
print(k, 'PRs', len(com), 'comentarios', sum(len(v) for v in com.values()), origem, 'partes', [len(g) for g in grupos])
