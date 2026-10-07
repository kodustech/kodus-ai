#!/usr/bin/env python3
"""Placar do descarte por cota (selecao-descarte.js): fila 65% -> verify em tudo -> selecao."""
import json, sys
fus, fila, *sels = sys.argv[1:]
F = json.load(open(fus))['prs']; Q = json.load(open(fila))
def placar(cai):
    g = fp = n = 0
    for c, reps in Q.items():
        conf = {it['rep']: it['confs'] for it in F[c]['itens']}
        sel = [r for r in reps if not cai(c, r)]; n += len(sel); venc = set()
        ng = len(next(iter(conf.values()))) if conf else 0
        for gi in range(ng):
            b, q = 0, None
            for r in sel:
                if conf[r][gi] > b: b, q = conf[r][gi], r
            if q is not None: g += 1; venc.add(q)
        fp += len(sel) - len(venc)
    return n, g, g / (g + fp) if g + fp else 0
n0, g0, p0 = placar(lambda c, r: False)
print(f'| fila 65% (sem verify) | {n0} | {g0} | {g0/111:.1%} | {p0:.1%} |')
S0 = json.load(open(sels[0]))['prs']
falt = [c for c in Q if c not in S0 or S0[c].get('erro')]
if falt: print('INCOMPLETO:', len(falt), 'PRs sem selecao')
n, g, p = placar(lambda c, r: r in (S0.get(c, {}).get('verify') or []))
print(f'| verify em todos (sem topo) | {n} | {g} ({g-g0:+d}) | {g/111:.1%} | {p:.1%} |')
for f in sels:
    S = json.load(open(f)); P = S['prs']
    n, g, p = placar(lambda c, r: r in (P.get(c, {}).get('verify') or []) or r in (P.get(c, {}).get('descarte') or []))
    print(f'| verify + seleção ({S["variante"]}, {S["pct"]}%) | {n} | {g} ({g-g0:+d}) | {g/111:.1%} | {p:.1%} |')
