#!/usr/bin/env python3
"""Placar dos verifies novos (verify-novo.js): fila de 65%, topo 3 intacto, regras combinadas offline."""
import json, sys
fus, fila, ver = sys.argv[1:4]
F = json.load(open(fus))['prs']; Q = json.load(open(fila)); D = json.load(open(ver)); V = D['prs']
faltam = [c for c in Q if c not in V or V[c].get('erro')]
if faltam: print('INCOMPLETO:', len(faltam), 'PRs')
def regras_correcao():
    def r1(d): return d.get('fixNeeded') is False
    def r2(d): return r1(d) or (d.get('fixNeeded') and not (d.get('checagem') or {}).get('aplica'))
    def r3(d): return r2(d) or bool((d.get('checagem') or {}).get('soComentario')) or bool((d.get('checagem') or {}).get('soTexto'))
    def r4(d): return r3(d) or (d.get('fixNeeded') and not d.get('comportamento'))
    def r5(d): return r4(d) or (d.get('fixNeeded') and (d.get('checagem') or {}).get('aplica') and not d['checagem'].get('perto'))
    return [('sem correção necessária', r1), ('+ patch não aplica', r2), ('+ só comentário/texto', r3), ('+ sem mudança de comportamento', r4), ('+ patch longe das linhas citadas', r5)]
ENTROPIA = [('maior grupo < 3 de 5', lambda d: d['maior'] < 3), ('maior grupo < 4 de 5', lambda d: d['maior'] < 4),
            ('grupo majoritário é NONE', lambda d: d['maiorNone']), ('3+ amostras NONE', lambda d: d['none'] >= 3),
            ('maior < 3 ou majoritário NONE', lambda d: d['maior'] < 3 or d['maiorNone'])]
regras = regras_correcao() if D['variante'] == 'correcao' else ENTROPIA if D['variante'] == 'entropia' else [('keep = false', lambda d: d.get('keep') is False)]
def placar(cai):
    g = fp = n = 0
    for c, reps in Q.items():
        if c in faltam: continue
        dec = V[c]['decisoes']; conf = {it['rep']: it['confs'] for it in F[c]['itens']}
        sel = [r for p, r in enumerate(reps) if p < 3 or not (dec.get(str(r), {}).get('temVeredito') and cai(dec[str(r)]))]
        n += len(sel); ng = len(next(iter(conf.values()))) if conf else 0; venc = set()
        for gi in range(ng):
            b, q = 0, None
            for r in sel:
                if conf[r][gi] > b: b, q = conf[r][gi], r
            if q is not None: g += 1; venc.add(q)
        fp += len(sel) - len(venc)
    return n, g, g / (g + fp)
n, g, p = placar(lambda d: False)
print(f'| fila (sem verify) | {n} | {g} | {g/111:.1%} | {p:.1%} |')
for nome, f in regras:
    n, g2, p = placar(f); print(f'| {nome} | {n} | {g2} ({g2-g:+d}) | {g2/111:.1%} | {p:.1%} |')
