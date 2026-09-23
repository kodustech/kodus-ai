#!/usr/bin/env python3
"""Nested-CV evaluation (same procedure as reproduzir.py) for alternative feature sets.
Usage: REP_SELETOR=... REP_VERACIDADE=... REP_EXTRA=cls=<file> python3 avaliar-cls.py"""
import os, importlib.util, math
from collections import Counter
AQUI = os.path.dirname(os.path.abspath(__file__))
def load(n):
    s = importlib.util.spec_from_file_location(n.replace('-', '_'), os.path.join(AQUI, n + '.py'))
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
A = load('ajustar-formula')
DROP = ['micro-scale-and-blocking', 'micro-repeated-work', 'micro-resource-and-growth']
TUDO = [('g', round(0.02*i, 2)) for i in range(4, 22)] + [('q', (K, c)) for K in range(2, 9) for c in [0.0, 0.18, 0.22, 0.26, 0.30]]
def ap(reg, ps, n):
    t, par = reg
    if t == 'g': return [i for i in range(n) if ps[i] >= par]
    K, c = par; return [i for i in sorted(range(n), key=lambda i: -ps[i])[:K] if ps[i] >= c]
def met(sel, d, quais):
    tp = fp = tot = n = 0
    for c in quais:
        tot += d[c]['core_goldens']; gs = d[c]['grupos']; cob = set()
        for i in sel[c]:
            n += 1
            if gs[i]['core']: cob.update(gs[i]['core'])
            elif not gs[i]['cobre']: fp += 1
        tp += len(cob)
    r = tp/max(1, tot); p = tp/max(1, tp+fp)
    return r, p, 2*r*p/max(1e-9, r+p), 5*r*p/max(1e-9, 4*p+r), n
def auc1(d, k):
    pos = [g['f'][k] for c in d for g in d[c]['grupos'] if g['core']]
    neg = [g['f'][k] for c in d for g in d[c]['grupos'] if not g['core']]
    return sum((1 if a > b else .5 if a == b else 0) for a in pos for b in neg)/max(1, len(pos)*len(neg))
def corr(d, a, b):
    xs = [(g['f'][a], g['f'][b]) for c in d for g in d[c]['grupos']]
    n = len(xs); ma = sum(x for x, _ in xs)/n; mb = sum(y for _, y in xs)/n
    cov = sum((x-ma)*(y-mb) for x, y in xs); va = sum((x-ma)**2 for x, _ in xs); vb = sum((y-mb)**2 for _, y in xs)
    return cov/math.sqrt(va*vb)
extras = [e for e in os.environ.get('CLS_EXTRAS', 'cls').split(',') if e]
d = A.montar(extras, DROP); prs = list(d)
for c in prs:
    for g in d[c]['grupos']:
        for e in extras: g['f']['p_' + e] = g['f']['nota'] * g['f'][e]
for e in extras:
    print(f'{e}: AUC alone {auc1(d, e):.3f} | corr with attributor score {corr(d, e, "nota"):+.3f} | corr with veracity {corr(d, e, "ver"):+.3f}')
print(f'attributor score alone AUC {auc1(d, "nota"):.3f}   groups {sum(len(d[c]["grupos"]) for c in prs)}  PRs {len(prs)}\n')
BASE = ['nota', 'ver', 'prod', 'conf', 'tam', 'sev', 'nag', 'vies']
NOVER = ['nota', 'conf', 'tam', 'sev', 'nag', 'vies']
SETS = [('champion (with veracity)', BASE), ('without veracity', NOVER)]
for e in extras:
    SETS += [(f'{e} replaces veracity', NOVER + [e, 'p_' + e]), (f'champion + {e}', BASE + [e, 'p_' + e])]
print(f'{"feature set":34s} {"AUC":>6} | {"precision cut (F1)":>30} | {"recall cut (F2)":>30} | quota 7 fixed')
for nome, feats in SETS:
    auc, _, probs = A.avaliar(d, feats, [0.2])
    cols = []
    for obj in ['F1', 'F2']:
        sel = {}; esc = []
        for fora in prs:
            dentro = [c for c in prs if c != fora]; melhor = None
            for reg in TUDO:
                sx = {c: ap(reg, probs[c], len(d[c]['grupos'])) for c in dentro}
                m = met(sx, d, dentro); k = m[2] if obj == 'F1' else m[3]
                if melhor is None or k > melhor[0]: melhor = (k, reg)
            sel[fora] = ap(melhor[1], probs[fora], len(d[fora]['grupos'])); esc.append(str(melhor[1]))
        r, p, f1, f2, n = met(sel, d, prs)
        cols.append(f'{r*100:5.1f}% / {p*100:5.1f}%  F1 {f1:.3f} {n/len(prs):3.1f}/PR')
    q = {c: ap(('q', (7, 0.0)), probs[c], len(d[c]['grupos'])) for c in prs}
    r, p, f1, f2, n = met(q, d, prs)
    print(f'{nome:34s} {auc:6.3f} | {cols[0]:>30} | {cols[1]:>30} | {r*100:5.1f}% / {p*100:5.1f}%')
