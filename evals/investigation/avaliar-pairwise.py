#!/usr/bin/env python3
"""Scores the pairwise votes (pairwise.js) against the champion order.

1. Accuracy on discordant pairs (one group covers a core golden, the other is
   a false positive): pairwise votes vs the champion probabilities.
2. Bradley-Terry strength inside the comparison window becomes a feature
   (`pw`, within-PR percentile) and is scored by avaliar-cls.py's nested CV.

Usage: REP_SELETOR=rep-seletor.json REP_VERACIDADE=rep-score2.json \
       python3 avaliar-pairwise.py [pw-votes.json]
"""
import os, sys, json, importlib.util, subprocess
AQUI = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(AQUI, 'results')
s = importlib.util.spec_from_file_location('af', os.path.join(AQUI, 'ajustar-formula.py'))
A = importlib.util.module_from_spec(s); s.loader.exec_module(A)
DROP = ['micro-scale-and-blocking', 'micro-repeated-work', 'micro-resource-and-growth']
VOTES = sys.argv[1] if len(sys.argv) > 1 else 'pw-votes.json'

rank = json.load(open(os.path.join(R, 'pw-ranking.json')))
votes = json.load(open(os.path.join(R, VOTES)))['votos']
d = A.montar([], DROP)

def bradley_terry(items, wins, it=200):
    """MM algorithm; wins[(i, j)] = times i beat j. Half a win of prior per pair keeps it finite."""
    s = {i: 1.0 for i in items}
    for _ in range(it):
        new = {}
        for i in items:
            w = 0.5 + sum(v for (a, _), v in wins.items() if a == i)
            den = sum((wins.get((i, j), 0) + wins.get((j, i), 0) + 1) / (s[i] + s[j]) for j in items if j != i)
            new[i] = w / den if den else s[i]
        tot = sum(new.values()); s = {k: v * len(items) / tot for k, v in new.items()}
    return s

agree = both = 0
disc = {'pairwise': [0, 0], 'champion': [0, 0]}
table = {}
for cid, r in rank.items():
    if cid not in d: continue
    gs = d[cid]['grupos']; v = votes.get(cid, {})
    wins = {}
    for i, j in r['pairs']:
        ab, ba = v.get(f'{i}|{j}'), v.get(f'{j}|{i}')
        for x in (ab, ba):
            if x: wins[(x['winner'], j if x['winner'] == i else i)] = wins.get((x['winner'], j if x['winner'] == i else i), 0) + 1
        if ab and ba:
            both += 1; agree += ab['winner'] == ba['winner']
        hit = {k: bool(gs[k]['core']) for k in (i, j)}
        fp = {k: not gs[k]['cobre'] for k in (i, j)}
        for good, bad in ((i, j), (j, i)):
            if hit[good] and fp[bad]:
                n = (wins.get((good, bad), 0), wins.get((bad, good), 0))
                if sum(n): disc['pairwise'][0] += n[0] / sum(n); disc['pairwise'][1] += 1
                disc['champion'][0] += r['p'][good] > r['p'][bad]; disc['champion'][1] += 1
    win = r['window']; order = r['order']
    bt = bradley_terry(win, wins) if len(win) > 1 else {k: 1.0 for k in win}
    pos = {k: n for n, k in enumerate(sorted(win, key=lambda k: bt[k]))}
    above = set(order[:order.index(win[0])]) if win else set()
    out = {}
    for k in range(len(gs)):
        if k in pos: val = 100 * (pos[k] + 0.5) / len(win)
        else: val = 100.0 if k in above else 0.0
        out[str(r['orig'][k])] = round(val, 2)
    table[cid] = out

print(f'position consistency (same winner in both orders): {agree}/{both} = {agree/max(1,both):.1%}')
for k, (a, n) in disc.items():
    print(f'discordant pairs (hit vs FP) ranked correctly by {k:9s}: {a:.1f}/{n} = {a/max(1,n):.1%}')
name = 'pw-bt-' + VOTES.replace('.json', '') + '.json'
json.dump({'saida': table, 'modelo': 'bradley-terry of ' + VOTES}, open(os.path.join(R, name), 'w'))
env = dict(os.environ, REP_EXTRA=f'pw={name}', CLS_EXTRAS='pw')
subprocess.run([sys.executable, os.path.join(AQUI, 'avaliar-cls.py')], env=env, check=True)
