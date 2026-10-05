#!/usr/bin/env python3
"""#1821: deriva pools/<pool>-heavysv — os candidatos G + M3 do Heavy sem verify
(mantidos + os que o verificador derrubou), cada um com _src (M = matriz do pool,
D = matriz-descartados) e _col (coluna na matriz), para o dedup e o juiz.

  python3 derivar-heavysv.py <pool> [--checar]
"""
import json, os, sys
pool = sys.argv[1]; checar = '--checar' in sys.argv
tec = lambda l: 'G' if l == 'generalist-base' else 'M3' if l.startswith('micro-exp-p3-') else None
L30 = json.load(open('light-30.json'))
out = f'pools/{pool}-heavysv'
if not checar: os.makedirs(out, exist_ok=True)
dif = 0
for cid in L30:
    t = json.load(open(f'pools/{pool}/{cid}.raw.txt'))['trace']
    cs = [{**c, '_src': 'M', '_col': i} for i, c in enumerate(t.get('preFilterCandidates') or []) if tec(c.get('producedBy') or '')]
    drops = [d for d in (t.get('verification') or {}).get('decisions') or [] if d.get('action') == 'drop' and d.get('droppedFinding')]
    cs += [{**d['droppedFinding'], 'relevantFile': d.get('relevantFile') or d['droppedFinding'].get('relevantFile'), '_src': 'D', '_col': i} for i, d in enumerate(drops) if tec(d['droppedFinding'].get('producedBy') or '')]
    if checar:
        ref = json.load(open(f'{out}/{cid}.raw.txt'))['trace']['preFilterCandidates']
        if [(c['_src'], c['_col'], c['producedBy']) for c in ref] != [(c['_src'], c['_col'], c['producedBy']) for c in cs]: dif += 1
    else:
        json.dump({'caseId': cid, 'trace': {'preFilterCandidates': cs}}, open(f'{out}/{cid}.raw.txt', 'w'))
print(f'{pool}: {"PRs diferentes do existente: " + str(dif) if checar else "gravado em " + out}')
