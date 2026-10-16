#!/usr/bin/env python3
"""#1821: regua Martian (golden unico, goldens core) sobre a saida final do fluxo de
producao (dedup real -> verify C -> nit protegido): cada comentario que sobra e o
keep do dedup e vale so a linha dele na matriz do juiz.

  python3 evals/dedup/gold-v2/placar-martian-final.py <model> --prefixo=<p> --matrizes=<a.json>,<b.json> [--saida=<json>]
"""
import json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
os.chdir(AQUI)
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}
ESPECIALISTAS = {'micro-exp-p3-' + x for x in ('value-boundary-and-position', 'contract-not-followed',
                 'says-one-thing-does-another', 'invalid-state-and-concurrency', 'changed-files-disagree')}
a = [x for x in sys.argv[1:] if not x.startswith('--')]
o = dict(x[2:].split('=', 1) for x in sys.argv[1:] if x.startswith('--'))
MODEL, P = a[0], o['prefixo']
ler = lambda p: json.load(open(p))
sug = ler(f'{P}_{MODEL}.json')['prs']
fin = ler(f'{P}_{MODEL}.final.json')
assert str(fin.get('fonte', '')).startswith('dedup-real/'), 'grupos precisam vir do dedup real'
fin = fin['prs']
real = ler(f'dedup-real/{P}-dedup/{MODEL}.json')['prs']
h1f = ler(f'verify/resultados/aluc-{P}-h1t10f/{MODEL}.json')['prs']
nit = ler(f'verify/resultados/{P}-nit-v3d-so1/{MODEL}.json')['prs']
M = {}
for f in o['matrizes'].split(','):
    M.update(ler(f))

caiu = {(c, g['rep']) for c, p in h1f.items() for g in p.get('grupos', []) if g.get('nit')}
for c, p in nit.items():
    pb = {s['id']: s['producedBy'] for s in sug[c]['suggestions']}
    for g in p.get('grupos', []):
        if g.get('nit') and not any(pb[x] in ESPECIALISTAS for x in g['membros']):
            caiu.add((c, g['rep']))

total = gold = fp = n = 0
for cid in sug:
    gs = M[cid]['goldens']
    total += sum(1 for g in gs if g.get('category') in CORE)
    col = {s['id']: s['finderIndex'] for s in sug[cid]['suggestions']}
    chegou = set(real[cid].get('idsEntradaDedup') or [])
    keeps = []
    vistos = set()
    for s in sug[cid]['suggestions']:
        if s['id'] not in chegou:
            continue
        k = fin[cid].get(s['id'], {}).get('grupo') or s['id']
        if k not in vistos:
            vistos.add(k); keeps.append(k)
    vet = [[M[cid]['conf'][gi][col[k]] for gi in range(len(gs))] for k in keeps if (cid, k) not in caiu]
    n += len(vet)
    venc = set()
    for gi, g in enumerate(gs):
        if g.get('category') not in CORE:
            continue
        b, q = 0, None
        for k, v in enumerate(vet):
            if v[gi] > b:
                b, q = v[gi], k
        if q is not None:
            gold += 1; venc.add(q)
    fp += len(vet) - len(venc)
R, Pr = gold / total, gold / max(1, gold + fp)
f = lambda b: (1 + b * b) * Pr * R / (b * b * Pr + R) if Pr + R else 0
out = {'model': MODEL, 'prefixo': P, 'comentarios': n, 'goldens': gold, 'totalGoldens': total, 'fp': fp,
       'recall': round(100 * R, 1), 'precisao': round(100 * Pr, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
if 'saida' in o:
    json.dump(out, open(o['saida'], 'w'), indent=1)
print(out)
