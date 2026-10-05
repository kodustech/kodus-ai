#!/usr/bin/env python3
"""#1821, etapa 2: formula + corte sobre a saida do dedup + v5 (dedup-fusao.js),
com as notas de uma variante do atribuidor (seletor-etapa2.js).

Termos: nota (atribuidor/100), tam (membros ate 4, /4), nag (agentes distintos
sem os fracos, ate 3, /3), forte, fraco, vies; opcionais por versao:
  sev   severidade dada pelo ATRIBUIDOR (low .25 .. critical 1)
  rank  posicao da nota dentro do PR (1 = maior), 1 - pos/n
Pesos reajustados deixando o PR avaliado de fora (alvo: o texto publicado casa
golden core, ja julgado na etapa 1). Ordena, corta K com piso.
Perda = goldens presentes depois da etapa 1 que saem no corte.

  python3 etapa2-formula.py <fusao.json> <pool> <notas.json> [termos] [K] [piso] [pct] [dump]

pct > 0: o teto de cada PR vira ceil(pct% dos comentarios que o modelo gerou no PR,
antes do dedup), no lugar do K fixo. dump: grava a fila publicada de cada PR
({caseId: [rep, ...]} na ordem), para a etapa de verify.
"""
import json, math, sys
FUS, pool, NOTAS = sys.argv[1], sys.argv[2], sys.argv[3]
TERMOS = (sys.argv[4] if len(sys.argv) > 4 else 'nota,tam,nag,forte,fraco').split(',') + ['vies']
K = int(sys.argv[5]) if len(sys.argv) > 5 else 7
PISO = float(sys.argv[6]) if len(sys.argv) > 6 else 0.22
PCT = float(sys.argv[7]) if len(sys.argv) > 7 else 0
DUMP = sys.argv[8] if len(sys.argv) > 8 else None
FORTES = {'micro-exp-p3-says-one-thing-does-another', 'micro-exp-p3-invalid-state-and-concurrency', 'micro-exp-p3-changed-files-disagree'}
FRACOS = {'micro-exp-p3-contract-not-followed', 'micro-exp-p3-test-does-not-verify'}
SEV = {'low': .25, 'medium': .5, 'high': .75, 'critical': 1.0}
F = json.load(open(FUS))['prs']; N = json.load(open(NOTAS))['prs']
# PR em que o atribuidor falhou fica de fora (e e reportado em 'semNota').
SEM_NOTA = [c for c in json.load(open('light-30.json')) if 'itens' not in N.get(c, {})]
L30 = [c for c in json.load(open('light-30.json')) if c not in SEM_NOTA]
dados = {}; npre = {}
for cid in L30:
    cs = json.load(open(f'pools/{pool}-heavysv/{cid}.raw.txt'))['trace']['preFilterCandidates']
    npre[cid] = len(cs)
    nota = {x['rep']: x for x in N[cid]['itens']}
    itens = F[cid]['itens']
    ords = sorted(range(len(itens)), key=lambda j: -nota[itens[j]['rep']]['nota'])
    pos = {j: p for p, j in enumerate(ords)}
    gs = []
    for j, it in enumerate(itens):
        ags = {cs[k]['producedBy'] for k in it['membros']}
        x = nota[it['rep']]
        f = {'nota': x['nota'] / 100, 'tam': min(len(it['membros']), 4) / 4, 'nag': min(len(ags - FRACOS), 3) / 3,
             'forte': 1.0 if ags & FORTES else 0.0, 'fraco': 1.0 if ags <= FRACOS else 0.0, 'vies': 1.0,
             'sev': SEV.get(str(x.get('severidade', '')).lower(), .5), 'rank': 1 - pos[j] / max(1, len(itens))}
        gs.append({'f': f, 'rep': it['rep'], 'confs': it['confs'], 'y': 1.0 if any(c > 0 for c in it['confs']) else 0.0})
    dados[cid] = gs

def fit(am, it=2000, lr=0.5, reg=0.01):
    w = {k: 0.0 for k in TERMOS}
    for _ in range(it):
        gr = {k: 0.0 for k in TERMOS}
        for f, y in am:
            z = sum(w[k] * f[k] for k in TERMOS); e = 1 / (1 + math.exp(-max(-30, min(30, z)))) - y
            for k in TERMOS: gr[k] += e * f[k]
        for k in TERMOS: w[k] -= lr * (gr[k] / len(am) + reg * w[k])
    return w
prob = lambda w, f: 1 / (1 + math.exp(-max(-30, min(30, sum(w[k] * f[k] for k in TERMOS)))))

def placar(sel):
    gold = fp = n = 0
    for cid, gs in sel.items():
        venc = set(); n += len(gs)
        for gi in range(len(dados[cid][0]['confs']) if dados[cid] else 0):
            b, q = 0, None
            for i, g in enumerate(gs):
                if g['confs'][gi] > b: b, q = g['confs'][gi], i
            if q is not None: gold += 1; venc.add(q)
        fp += len(gs) - len(venc)
    return n, gold, gold / 111, gold / (gold + fp) if gold + fp else 0

antes = placar(dados)
sel = {}
for cid in L30:
    w = fit([(g['f'], g['y']) for c, gs in dados.items() if c != cid for g in gs])
    ps = [prob(w, g['f']) for g in dados[cid]]
    sel[cid] = [dados[cid][i] for i in sorted(range(len(ps)), key=lambda i: -ps[i]) if ps[i] >= PISO][:(max(1, math.ceil(PCT / 100 * npre[cid])) if PCT > 0 else K)]
depois = placar(sel)
if DUMP: json.dump({cid: [g['rep'] for g in gs] for cid, gs in sel.items()}, open(DUMP, 'w'))
wall = fit([(g['f'], g['y']) for gs in dados.values() for g in gs])
print(json.dumps({'semNota': SEM_NOTA, 'termos': TERMOS, 'K': K, 'pct': PCT, 'piso': PISO, 'goldensEtapa1': antes[1], 'goldensDepois': depois[1], 'perdidos': antes[1] - depois[1],
                  'comentarios': depois[0], 'recall': round(depois[2], 4), 'precisao': round(depois[3], 4), 'pesos': {k: round(v, 3) for k, v in wall.items()}}))
