"""Step 0: does a production-outcome classifier generalise to orgs it never saw?
Group 5-fold CV by organization; AUC on the held-out orgs."""
import json, sys, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

d = json.load(open('prod.json'))
st = np.array([r['st'] for r in d]); down = np.array([int(r['down']) > 0 for r in d])
org = np.array([r['org'] for r in d])
pos = np.isin(st, ['implemented', 'partially_implemented'])
neg_clean = (st == 'not_implemented') & down
neg_noisy = (st == 'not_implemented') & ~down

def cv(X, mask, y, C=0.1, name=''):
    Xm, ym, gm = X[mask], y[mask], org[mask]
    oof = np.zeros(len(ym))
    for tr, te in GroupKFold(5).split(Xm, ym, gm):
        m = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=2000, class_weight='balanced'))
        m.fit(Xm[tr], ym[tr]); oof[te] = m.predict_proba(Xm[te])[:, 1]
    auc = roc_auc_score(ym, oof)
    print(f'{name:48s} n={mask.sum():6d} pos={ym.sum():6d} AUC(held-out orgs)={auc:.3f}', flush=True)
    return oof

def onehot(keys):
    vals = sorted(set(keys)); idx = {v: i for i, v in enumerate(vals)}
    M = np.zeros((len(keys), len(vals)), np.float32)
    for i, k in enumerate(keys): M[i, idx[k]] = 1
    return M

y = pos.astype(int)
meta = onehot([f"{r['label']}|{r['severity']}|{r['lang']}" for r in d])
A = pos | neg_clean          # implemented vs thumbs-down
B = pos | neg_clean | neg_noisy  # implemented vs every unimplemented
print('--- baselines (no text) ---')
cv(meta, A, y, 1.0, 'label+severity+lang only, A: impl vs 👎')
cv(meta, B, y, 1.0, 'label+severity+lang only, B: impl vs not impl')
for mode in sys.argv[1:] or ['full', 'text']:
    X = np.load(f'prod_{mode}.npy').astype(np.float32)
    print(f'--- embeddings: {mode} ---')
    for C in [0.01, 0.1]:
        cv(X, A, y, C, f'{mode} C={C}, A: impl vs 👎')
    cv(X, B, y, 0.01, f'{mode} C=0.01, B: impl vs not impl')
