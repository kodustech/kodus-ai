import json, os, re, time, urllib.request, concurrent.futures as cf
import numpy as np

def cfg(key):
    for line in open(os.path.expanduser('~/.kodus-dev/config')):
        line = line.strip()
        if line.startswith('export '): line = line[7:]
        if line.startswith(key + '='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise KeyError(key)

def text_of(r):
    g = lambda k: (r.get(k) or '').strip()
    t = f"[{g('label')}/{g('severity')}/{g('lang')}] {g('summary')}\n{g('content')[:2000]}"
    if g('existing'): t += f"\n--- existing code:\n{g('existing')[:1200]}"
    if g('improved'): t += f"\n--- suggested code:\n{g('improved')[:1200]}"
    return t[:6000]

def text_only(r):  # comment text without code, for the ablation
    g = lambda k: (r.get(k) or '').strip()
    return f"[{g('label')}/{g('severity')}/{g('lang')}] {g('summary')}\n{g('content')[:2000]}"[:6000]

URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents'
DIM = 768

def _call(batch, key):
    body = json.dumps({'requests': [{'model': 'models/gemini-embedding-001', 'content': {'parts': [{'text': t or ' '}]},
                                     'taskType': 'CLASSIFICATION', 'outputDimensionality': DIM} for t in batch]}).encode()
    last = None
    for attempt in range(8):
        try:
            req = urllib.request.Request(URL, body, {'x-goog-api-key': key, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.load(resp)
            return [e['values'] for e in d['embeddings']]
        except Exception as e:
            last = e; time.sleep(min(60, 2 ** attempt))
    raise last

def embed(texts, bs=100, workers=8):
    key = cfg('BYOK_GOOGLE_API_KEY')
    batches = [texts[i:i+bs] for i in range(0, len(texts), bs)]
    out = [None] * len(batches)
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(_call, b, key): i for i, b in enumerate(batches)}
        for n, fu in enumerate(cf.as_completed(futs)):
            out[futs[fu]] = fu.result()
            if n % 50 == 0: print(f'  {n}/{len(batches)} batches', flush=True)
    return np.array([v for b in out for v in b], dtype=np.float32)
