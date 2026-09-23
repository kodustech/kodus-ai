import json, os, sys, numpy as np
from common import text_of, text_only, embed
P = '../pools/sol-teto2'
rows, keys = [], []
for f in sorted(os.listdir(P)):
    if not f.endswith('.raw.txt'): continue
    j = json.load(open(os.path.join(P, f)))
    for i, c in enumerate((j.get('trace') or {}).get('preFilterCandidates') or []):
        rows.append({'label': c.get('label'), 'severity': c.get('severity'), 'lang': c.get('language'),
                     'summary': c.get('oneSentenceSummary'), 'content': c.get('suggestionContent'),
                     'existing': c.get('existingCode'), 'improved': c.get('improvedCode')})
        keys.append([j['caseId'], i])
json.dump(keys, open('pool_keys.json', 'w'))
for mode, fn in [('full', text_of), ('text', text_only)]:
    np.save(f'pool_{mode}.npy', embed([fn(r) for r in rows]).astype(np.float16))
print(len(rows), 'pool candidates')
