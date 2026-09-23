"""Train on all production rows, score every pool candidate, write a REP_EXTRA table."""
import json, sys, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
mode, variant, C = sys.argv[1], sys.argv[2], float(sys.argv[3])
d = json.load(open('prod.json'))
st = np.array([r['st'] for r in d]); down = np.array([int(r['down']) > 0 for r in d])
pos = np.isin(st, ['implemented', 'partially_implemented'])
neg = (st == 'not_implemented') & (down if variant == 'A' else np.ones(len(d), bool))
mask = pos | neg
X = np.load(f'prod_{mode}.npy').astype(np.float32)
m = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=3000, class_weight='balanced'))
m.fit(X[mask], pos[mask].astype(int))
P = np.load(f'pool_{mode}.npy').astype(np.float32)
p = m.predict_proba(P)[:, 1]
pct = (p.argsort().argsort() + 0.5) / len(p) * 100   # rank within the pool, label-free
keys = json.load(open('pool_keys.json'))
out = {}
for (cid, i), v in zip(keys, pct): out.setdefault(cid, {})[str(i)] = round(float(v), 2)
name = f'cls-{mode}-{variant}'
json.dump({'saida': out, 'modelo': name}, open(f'../results/{name}.json', 'w'))
print('wrote', name, 'pool p range', p.min().round(3), p.max().round(3))
