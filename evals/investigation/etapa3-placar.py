#!/usr/bin/env python3
"""#1821, etapa 3: placar do verify (so o juiz) sobre a fila da etapa 2.

Linhas: a fila sem verify; o verify bruto (1a sessao); com a protecao 1 (derrubar
so vale se leu o arquivo citado); com as protecoes 1 e 2 (segunda sessao
confirma). Para cada uma, a variante "topo N garantido": as N primeiras da fila
de cada PR nao passam pelo verify.

  python3 etapa3-placar.py <fusao.json> <fila.json> <verify.json> [total-goldens]
"""
import json, sys
F = json.load(open(sys.argv[1]))['prs']; Q = json.load(open(sys.argv[2])); V = json.load(open(sys.argv[3]))['prs']
TOTAL = int(sys.argv[4]) if len(sys.argv) > 4 else 111
faltam = [c for c in Q if c not in V or V[c].get('erro')]
if faltam: print('INCOMPLETO, PRs sem verify:', len(faltam))
confs = {c: {it['rep']: it['confs'] for it in F[c]['itens']} for c in Q}

def placar(fica):
    gold = fp = n = 0
    for c, reps in Q.items():
        if c in faltam: continue
        sel = [r for p, r in enumerate(reps) if fica(c, p, r)]; venc = set(); n += len(sel)
        ng = len(next(iter(confs[c].values()))) if confs[c] else 0
        for gi in range(ng):
            b, q = 0, None
            for r in sel:
                if confs[c][r][gi] > b: b, q = confs[c][r][gi], r
            if q is not None: gold += 1; venc.add(q)
        fp += len(sel) - len(venc)
    return n, gold, gold / TOTAL, gold / (gold + fp) if gold + fp else 0

d = lambda c, r: V[c]['decisoes'][str(r)]
REGRAS = {
    'sem verify': lambda c, r: False,
    'verify bruto': lambda c, r: not d(c, r)['v1']['keep'],
    'protecao 1': lambda c, r: not d(c, r)['v1']['keep'] and d(c, r)['v1']['leuCitado'],
    'protecoes 1+2': lambda c, r: not d(c, r)['v1']['keep'] and d(c, r)['v1']['leuCitado'] and 'v2' in d(c, r) and not d(c, r)['v2']['keep'] and d(c, r)['v2']['leuCitado'],
}
tem_v2 = any('v2' in x for c in Q if c not in faltam for x in V[c]['decisoes'].values())
base = placar(lambda c, p, r: True)
for nome, cai in REGRAS.items():
    if nome == 'protecoes 1+2' and not tem_v2: continue
    for topo in ([0] if nome == 'sem verify' else [0, 2, 3, 4]):
        n, gold, R, P = placar(lambda c, p, r: p < topo or not cai(c, r))
        rot = nome + (f', topo {topo} garantido' if topo else '')
        print(f'{rot:36s} {n:3d} coment | gold {gold} (perde {base[1] - gold}) | R {R:.1%} | P {P:.1%}')
