import json, sys, numpy as np
from common import text_of, text_only, embed
d = json.load(open('prod.json'))
mode = sys.argv[1]
fn = text_of if mode == 'full' else text_only
X = embed([fn(r) for r in d])
np.save(f'prod_{mode}.npy', X.astype(np.float16))
