#!/usr/bin/env python3
"""Placar da correcao so no topo N: publica o topo N da fila de 65% menos o que a correcao derruba."""
import json, sys
fus, fila, ver = sys.argv[1:4]; N = int(sys.argv[4]) if len(sys.argv) > 4 else 4
F = json.load(open(fus))['prs']; Q = json.load(open(fila)); V = json.load(open(ver))['prs']
falt = [c for c in Q if Q[c] and (c not in V or V[c].get('erro'))]
if falt: print('INCOMPLETO:', len(falt), 'PRs')
ch = lambda d: d.get('checagem') or {}
R = [('nada (só topo 4)', lambda d: False),
     ('sem correção necessária', lambda d: d.get('fixNeeded') is False),
     ('+ patch não aplica', lambda d: d.get('fixNeeded') is False or (d.get('fixNeeded') and not ch(d).get('aplica'))),
     ('+ só comentário/texto', lambda d: d.get('fixNeeded') is False or (d.get('fixNeeded') and not ch(d).get('aplica')) or bool(ch(d).get('soComentario')) or bool(ch(d).get('soTexto'))),
     ('+ patch longe das linhas', lambda d: d.get('fixNeeded') is False or (d.get('fixNeeded') and not ch(d).get('aplica')) or bool(ch(d).get('soComentario')) or bool(ch(d).get('soTexto')) or (d.get('fixNeeded') and ch(d).get('aplica') and not ch(d).get('perto')))]
def win(sel, conf):
    ng = len(next(iter(conf.values()))) if conf else 0; venc = set(); g = 0
    for gi in range(ng):
        b, q = 0, None
        for r in sel:
            if conf[r][gi] > b: b, q = conf[r][gi], r
        if q is not None: g += 1; venc.add(q)
    return g, venc
print('| regra que derruba | publicados | goldens | recall | precisão | TPs derrubados | FPs derrubados |\n|---|---|---|---|---|---|---|')
for nome, cai in R:
    g = fp = n = tpd = fpd = 0
    for c, reps in Q.items():
        conf = {it['rep']: it['confs'] for it in F[c]['itens']}; top = reps[:N]
        _, v0 = win(top, conf); dec = V.get(c, {}).get('decisoes', {})
        drop = [r for r in top if dec.get(str(r), {}).get('temVeredito') and cai(dec[str(r)])]
        tpd += sum(r in v0 for r in drop); fpd += sum(r not in v0 for r in drop)
        sel = [r for r in top if r not in drop]; gg, vv = win(sel, conf); g += gg; n += len(sel); fp += len(sel) - len(vv)
    print(f'| {nome} | {n} | {g} | {g/111:.1%} | {g/(g+fp):.1%} | {tpd} | {fpd} |')
