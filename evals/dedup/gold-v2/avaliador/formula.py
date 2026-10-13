#!/usr/bin/env python3
"""Avaliador (#1821), fase 2: a formula sobre as notas do atribuidor (notas/<model>.json).

A logistica v4 de investigation/formula-dedup.py, por grupo do dedup congelado:
  nota  nota do atribuidor / 100
  tam   membros do grupo, ate 4, / 4
  nag   agentes distintos sem os fracos, ate 3, / 3
  forte 1 se algum agente do grupo e forte
  fraco 1 se todos os agentes do grupo sao fracos
  vies  1
Pesos ajustados por modelo deixando de fora o PR avaliado. Alvo do ajuste: algum
membro do grupo casa golden core pela matriz do juiz da Martian (so para o
ajuste; a classificacao TP/FP fica para a simulacao do corte).
Saida: ordenado/<model>.json, os grupos de cada PR em ordem de probabilidade.

  python3 evals/dedup/gold-v2/avaliador/formula.py [model ...]
"""
import json, math, os, sys
DIR = os.path.dirname(os.path.abspath(__file__))
INV = os.path.join(DIR, '..', '..', '..', 'investigation')
CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
FORTES = {'micro-exp-p3-says-one-thing-does-another','micro-exp-p3-invalid-state-and-concurrency','micro-exp-p3-changed-files-disagree'}
FRACOS = {'micro-exp-p3-contract-not-followed','micro-exp-p3-test-does-not-verify'}
MATRIZ = {'deepseek-v4.1-flash': '09.10.26_finder-definitivo_deepseek', 'gpt-6.1-sol': '09.10.26_finder-definitivo_gpt',
          'muse-spark-1.2': '09.10.26_finder-muse-v1', 'sonnet-5.5': '09.10.26_finder-definitivo_sonnet'}
TERMOS = ['nota','tam','nag','forte','fraco','vies']
tec = lambda pb: pb == 'generalist-base' or str(pb).startswith('micro-exp-p3-')

def fit(am, it=2000, lr=0.5, reg=0.01):
    w = {k: 0.0 for k in TERMOS}
    for _ in range(it):
        gr = {k: 0.0 for k in TERMOS}
        for f, y in am:
            e = 1 / (1 + math.exp(-max(-30, min(30, sum(w[k] * f[k] for k in TERMOS))))) - y
            for k in TERMOS: gr[k] += e * f[k]
        for k in TERMOS: w[k] -= lr * (gr[k] / len(am) + reg * w[k])
    return w
prob = lambda w, f: 1 / (1 + math.exp(-max(-30, min(30, sum(w[k] * f[k] for k in TERMOS)))))

os.makedirs(os.path.join(DIR, 'ordenado'), exist_ok=True)
for model in sys.argv[1:] or list(MATRIZ):
    N = json.load(open(os.path.join(DIR, 'notas', f'{model}.json')))['prs']
    M = json.load(open(os.path.join(INV, 'results', f'matriz-pre-{MATRIZ[model]}.json')))
    dados = {}
    for cid, p in N.items():
        if p.get('erro'): continue
        x = M[cid]; idx = [j for j, c in enumerate(x['candidatos']) if tec(c.get('producedBy'))]
        casa = lambda sid: any(g.get('category') in CORE and x['conf'][gi][idx[int(sid[1:]) - 1]] > 0 for gi, g in enumerate(x['goldens']))
        gs = []
        for g in p['grupos']:
            ags = set(g['agentes'])
            f = {'nota': g['nota'] / 100, 'tam': min(len(g['membros']), 4) / 4, 'nag': min(len(ags - FRACOS), 3) / 3,
                 'forte': 1.0 if ags & FORTES else 0.0, 'fraco': 1.0 if ags <= FRACOS else 0.0, 'vies': 1.0}
            gs.append({**g, 'f': f, 'y': 1.0 if any(casa(s) for s in g['membros']) else 0.0})
        dados[cid] = gs
    out = {'model': model, 'termos': TERMOS, 'pesos': {k: round(v, 3) for k, v in fit([(g['f'], g['y']) for gs in dados.values() for g in gs]).items()}, 'prs': {}}
    for cid, gs in dados.items():
        w = fit([(g['f'], g['y']) for c, o in dados.items() if c != cid for g in o])
        for g in gs: g['prob'] = round(prob(w, g['f']), 4)
        out['prs'][cid] = [{k: g[k] for k in ('rep', 'membros', 'agentes', 'nota', 'prob', 'porque')} for g in sorted(gs, key=lambda g: -g['prob'])]
    json.dump(out, open(os.path.join(DIR, 'ordenado', f'{model}.json'), 'w'), indent=1, ensure_ascii=False)
    n = sum(len(v) for v in out['prs'].values())
    print(f'{model}: {len(out["prs"])} PRs, {n} grupos, pesos {out["pesos"]}')
