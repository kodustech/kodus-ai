#!/usr/bin/env python3
"""Tokens e tempo so do finder do fluxo novo, por PR (mesma conta do gold-v2/placar-v3.py):
tokens das passadas somados; tempo = a passada mais lenta (correm em paralelo). Light = generalista; heavy = generalista + lentes M3.
  python3 uso-finder.py  ->  uso-finder.json"""
import json, os, math
AQUI = os.path.dirname(os.path.abspath(__file__)); G2 = os.path.join(AQUI, '..', '..', '..', 'gold-v2'); INV = os.path.join(AQUI, '..', '..', '..', '..', 'investigation')
RODADAS = {'deepseek': ('deepseek-v4.1-flash', 'gen', 'hv'), 'gpt': ('gpt-6.1-sol', 'gen', 'hv'), 'sonnet-sdk': ('sonnet-5.5', 'gensncc', 'hvsncc'),
           'sonnet-api': ('sonnet-5.5', 'gensnloop', 'hvsnloop'), 'opus': ('opus-5.5', 'genopa', 'hvopa'), 'muse': ('muse-spark-1.3', 'genmuse', 'hvmuse'), 'kimi': ('kimi-k2.7-code', 'genkimi', 'hvkimi')}
tec = lambda pb: 'G' if pb == 'generalist-base' else 'M3' if str(pb).startswith('micro-exp-p3-') else None
lights = set(json.load(open(f'{INV}/light-30.json')))
def pct(v, q):
    v = sorted(v); k = (len(v) - 1) * q; lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)
out = {}
for nome, (model, *prefs) in RODADAS.items():
    for modo, P in zip(('light', 'heavy'), prefs):
        sug = json.load(open(f'{G2}/{P}_{model}.json')); TECS = sug.get('tec', 'G,M3').split(',')
        if modo == 'light': TECS = ['G']
        pools = dict(zip(sug.get('origem', []), sug.get('sourcePools', [])))
        por = []
        for c in sug['prs']:
            pool = pools['09.10.26' if c in lights else 'ho'] if pools else sug['sourcePool']
            t = json.load(open(f'{INV}/pools/{pool}/{c}.raw.txt'))['trace']
            ps = [p for p in t.get('recallPasses') or [] if tec(p['label']) in TECS]
            por.append({'input': sum(p.get('inputTokens') or 0 for p in ps), 'cacheRead': sum(p.get('cacheReadTokens') or 0 for p in ps),
                        'output': sum(p.get('outputTokens') or 0 for p in ps), 'ms': max([p.get('ms') or 0 for p in ps] or [0]),
                        'passadas': len(ps)})
        r = {k: {q: round(pct([x[k] for x in por], v)) for q, v in (('p50', .5), ('p75', .75), ('p90', .9))} for k in ('input', 'cacheRead', 'output', 'ms')}
        r['prs'] = len(por); r['passadasPorPr'] = sorted({x['passadas'] for x in por})
        out[f'{nome}|{modo}'] = r
        print(nome, modo, r['prs'], r['passadasPorPr'], 'input', r['input'], 'ms', r['ms'])
json.dump(out, open(f'{AQUI}/uso-finder.json', 'w'), indent=1)
