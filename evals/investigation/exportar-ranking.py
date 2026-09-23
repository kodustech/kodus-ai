#!/usr/bin/env python3
"""Champion ranking per PR (leave-one-PR-out probabilities) + the pairs to compare.
Window: every group when a PR has <= W groups, otherwise ranks 2..W+1 (0-based)."""
import os, json, importlib.util, itertools
AQUI = os.path.dirname(os.path.abspath(__file__))
s = importlib.util.spec_from_file_location('af', os.path.join(AQUI, 'ajustar-formula.py'))
A = importlib.util.module_from_spec(s); s.loader.exec_module(A)
DROP = ['micro-scale-and-blocking', 'micro-repeated-work', 'micro-resource-and-growth']
BASE = ['nota', 'ver', 'prod', 'conf', 'tam', 'sev', 'nag', 'vies']
W = int(os.environ.get('PW_WINDOW', '10'))
d = A.montar([], DROP)
_, _, probs = A.avaliar(d, BASE, [0.2])
out = {}; npairs = 0
for cid in d:
    gs = d[cid]['grupos']
    order = sorted(range(len(gs)), key=lambda i: -probs[cid][i])
    win = order if len(order) <= W else order[2:W+2]
    pairs = list(itertools.combinations(sorted(win), 2))
    npairs += len(pairs)
    out[cid] = {'order': order, 'window': win, 'pairs': pairs,
                'orig': [g['orig'] for g in gs], 'p': probs[cid]}
json.dump(out, open(os.path.join(AQUI, 'results', 'pw-ranking.json'), 'w'))
print(f'{len(out)} PRs, {npairs} pairs, {2*npairs} calls (both orders)')
