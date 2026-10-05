#!/usr/bin/env python3
"""#1821, precisao: a formula (logistica) sobre as sugestoes do dedup de producao.

Termos por sugestao (grupo do dedup):
  nota  nota do atribuidor so de nota / 100 (results/seletor-nota)
  ver   veracidade de producao / 100 (results/veracidade-dedup)
  prod  nota x ver
  tam   membros do grupo, ate 4, / 4
  nag   agentes distintos, ate 3, / 3 (sem os fracos nas versoes v3/v4)
  forte 1 se algum agente do grupo e forte
  fraco 1 se todos os agentes do grupo sao fracos
  vies  1
Versoes: v1 tudo; v2 sem ver/prod; v3 = v1 com nag sem fracos; v4 = v2 com nag sem fracos.
Pesos reajustados por versao, deixando o PR avaliado de fora (alvo: a sugestao casa
golden core, rotulo do nosso juiz; so para ajustar). Ordena por probabilidade;
publica os K primeiros (3..7) com piso de probabilidade 0,22.

  python3 formula-dedup.py <sufixo> <pool> <dir-saida> [dir-dedup] [arq-nota]
"""
import json, math, os, sys
suf, pool, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
DEDUP = sys.argv[4] if len(sys.argv) > 4 else 'dedup-prod2'
ARQ_NOTA = sys.argv[5] if len(sys.argv) > 5 else f'results/seletor-nota/{suf}.json'
os.makedirs(OUT, exist_ok=True)
CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
FORTES = {'micro-exp-p3-says-one-thing-does-another','micro-exp-p3-invalid-state-and-concurrency','micro-exp-p3-changed-files-disagree'}
FRACOS = {'micro-exp-p3-contract-not-followed','micro-exp-p3-test-does-not-verify'}
PISO = 0.22
L30 = json.load(open('light-30.json'))
DD = json.load(open(f'results/{DEDUP}/{suf}.json'))['prs']
NOTA = json.load(open(ARQ_NOTA))['prs']
VER = json.load(open(f'results/veracidade-dedup/{suf}.json'))['prs'] if DEDUP == 'dedup-prod2' else None
M = json.load(open(f'results/matriz-{pool}.json')); D = json.load(open(f'results/matriz-descartados-{pool}.json'))

def acerta(cid, c):
    m = (M if c['_src'] == 'M' else D).get(cid)
    return any(g['category'] in CORE and (m['conf'][gi][c['_col']] if c['_col'] < len(m['conf'][gi]) else 0) > 0 for gi, g in enumerate(m['goldens']))

dados = {}
for cid in L30:
    p = DD[cid]; cands = json.load(open(f'pools/{pool}-heavysv/{cid}.raw.txt'))['trace']['preFilterCandidates']
    nota = {x['k']: x['nota'] for x in NOTA[cid]['itens']}; ver = {x['k']: x['veracidade'] for x in VER[cid]['itens']} if VER else {}
    gs = []
    for k in p['kept']:
        mem = p['membros'].get(str(k), [k])
        ags = {cands[x]['producedBy'] for x in mem}
        n, v = nota[k] / 100, ver.get(k, 50) / 100
        base = {'nota': n, 'ver': v, 'prod': n * v, 'tam': min(len(mem), 4) / 4,
                'forte': 1.0 if ags & FORTES else 0.0, 'fraco': 1.0 if ags <= FRACOS else 0.0, 'vies': 1.0,
                'nag': min(len(ags), 3) / 3, 'nag_sf': min(len(ags - FRACOS), 3) / 3}
        gs.append({'k': k, 'f': base, 'y': 1.0 if any(acerta(cid, cands[x]) for x in mem) else 0.0, 'texto': cands[k]['suggestionContent']})
    dados[cid] = gs

VERSOES = {
    'v1': ['nota','ver','prod','tam','nag','forte','fraco','vies'],
    'v2': ['nota','tam','nag','forte','fraco','vies'],
    'v3': ['nota','ver','prod','tam','nag_sf','forte','fraco','vies'],
    'v4': ['nota','tam','nag_sf','forte','fraco','vies'],
}
def fit(am, F, it=2000, lr=0.5, reg=0.01):
    w = {k: 0.0 for k in F}
    for _ in range(it):
        gr = {k: 0.0 for k in F}
        for f, y in am:
            z = sum(w[k] * f[k] for k in F); e = 1 / (1 + math.exp(-max(-30, min(30, z)))) - y
            for k in F: gr[k] += e * f[k]
        for k in F: w[k] -= lr * (gr[k] / len(am) + reg * w[k])
    return w
prob = lambda w, f, F: 1 / (1 + math.exp(-max(-30, min(30, sum(w[k] * f[k] for k in F)))))

resumo = {}
for v, F in VERSOES.items():
    probs = {}
    for cid in L30:
        w = fit([(g['f'], g['y']) for c, gs in dados.items() if c != cid for g in gs], F)
        probs[cid] = [prob(w, g['f'], F) for g in dados[cid]]
    wall = fit([(g['f'], g['y']) for gs in dados.values() for g in gs], F)
    resumo[v] = {'pesos': {k: round(x, 3) for k, x in wall.items()}}
    for K in range(3, 8):
        com = {}
        for cid in L30:
            ordem = sorted(range(len(dados[cid])), key=lambda i: -probs[cid][i])
            com[cid] = [dados[cid][i]['texto'] for i in ordem if probs[cid][i] >= PISO][:K]
        json.dump(com, open(f'{OUT}/{v}-k{K}.comentarios.json', 'w'))
        resumo[v][f'k{K}'] = sum(len(x) for x in com.values())
json.dump({cid: [g['texto'] for g in gs] for cid, gs in dados.items()}, open(f'{OUT}/sem-corte.comentarios.json', 'w'))
json.dump(resumo, open(f'{OUT}/resumo.json', 'w'), indent=1)
for v, r in resumo.items(): print(v, {k: x for k, x in r.items() if k != 'pesos'}, r['pesos'])
