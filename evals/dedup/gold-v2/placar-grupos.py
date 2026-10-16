#!/usr/bin/env python3
"""#1821: recall e precisao da regua Martian (golden unico) sobre os grupos do
dedup, depois dos cortes do verify, sem rotulos TP/FP: cada grupo vale o melhor
casamento do juiz entre os seus membros. Serve para conjuntos sem gold rotulado
(ex.: holdout).

  python3 evals/dedup/gold-v2/placar-grupos.py <model> --prefixo=<rotulo> --dedup=<versao> \
      --matriz=<matriz-pre.json> [<resultado> ...] [--nit=<resultado>] [--regra=1]

<resultado>: pasta em verify/resultados (ex.: ho-aluc-h1t10f); derruba os grupos com nit.
--nit: resultado do nit.js; nao derruba grupo com membro de lente especializada.
--regra=1: derruba o grupo de um membro so da lente test-does-not-verify.
"""
import json, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}
ESPECIALISTAS = {'micro-exp-p3-' + x for x in ('value-boundary-and-position', 'contract-not-followed',
                 'says-one-thing-does-another', 'invalid-state-and-concurrency', 'changed-files-disagree')}
tec = lambda pb: pb == 'generalist-base' or str(pb).startswith('micro-exp-p3-')

a = [x for x in sys.argv[1:] if not x.startswith('--')]
o = dict(x[2:].split('=', 1) for x in sys.argv[1:] if x.startswith('--'))
model, fontes = a[0], a[1:]
sug = json.load(open(f"{o['prefixo']}_{model}.json"))['prs']
fin = json.load(open(f"{o['prefixo']}_{model}.final.json"))['prs']
real = json.load(open(f"dedup-real/{o['dedup']}/{model}.json"))['prs']
m = json.load(open(o['matriz']))

def cortes(pasta, protege):
    out = set()
    R = json.load(open(f'verify/resultados/{pasta}/{model}.json'))['prs']
    for cid, p in R.items():
        S = {s['id']: s for s in sug[cid]['suggestions']}
        for g in p.get('grupos', []):
            if g.get('nit') and not (protege and any(S[x]['producedBy'] in ESPECIALISTAS for x in g['membros'])):
                out.add((cid, g['rep']))
    return out

drop = set().union(*[cortes(f, False) for f in fontes]) if fontes else set()
if 'nit' in o:
    drop |= cortes(o['nit'], True)

total = gold = fp = n = 0
for cid, x in m.items():
    gs = x['goldens']
    if cid not in sug:
        continue  # PR fora da rodada (ex.: --prs com um subconjunto)
    total += sum(1 for g in gs if g.get('category') in CORE)
    if cid not in sug or cid not in real or real[cid].get('erro'):
        continue
    # coluna da matriz = indice do candidato no finder (finderIndex); sem ele, a ordem G/M3 do build.
    col = ({s['id']: s['finderIndex'] for s in sug[cid]['suggestions']} if cid in sug and all('finderIndex' in s for s in sug[cid]['suggestions'])
           else {f'S{i + 1}': j for i, j in enumerate(k for k, c in enumerate(x['candidatos']) if tec(c.get('producedBy')))})
    S = {s['id']: s for s in sug[cid]['suggestions']}
    chegou = set(real[cid].get('idsEntradaDedup') or [])
    por, grupos = {}, []
    for s in sug[cid]['suggestions']:
        if s['id'] not in chegou:
            continue
        g = fin[cid].get(s['id'], {}).get('grupo')
        if g:
            por.setdefault(g, []).append(s['id'])
        else:
            grupos.append([s['id']])
    grupos += list(por.values())
    vetores = []
    for mem in grupos:
        rep = max(mem, key=lambda i: len(str(S[i]['suggestionContent'])))
        if (cid, rep) in drop:
            continue
        if o.get('regra') == '1' and len(mem) == 1 and S[rep]['producedBy'] == 'micro-exp-p3-test-does-not-verify':
            continue
        vetores.append([max(x['conf'][gi][col[i]] for i in mem) for gi in range(len(gs))])
    n += len(vetores)
    venc = set()
    for gi, g in enumerate(gs):
        if g.get('category') not in CORE:
            continue
        b, q = 0, None
        for k, v in enumerate(vetores):
            if v[gi] > b:
                b, q = v[gi], k
        if q is not None:
            gold += 1
            venc.add(q)
    fp += len(vetores) - len(venc)
r, p = gold / total, gold / max(1, gold + fp)
print(f"| {model} | {'+'.join(fontes + ([o['nit']] if 'nit' in o else []) + (['regra'] if o.get('regra') == '1' else [])) or 'dedup'} | {n} | {gold}/{total} | fp {fp} | {r:.1%} | {p:.1%} | {2 * p * r / max(1e-9, p + r):.1%} |")
