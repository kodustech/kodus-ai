"""Tabela do diagnostico Muse/Kimi: de onde vem a diferenca entre o finder de producao e o novo light/heavy.
TPs por conjunto (class_reviewed TP, distintos). Producao = V2 (placar.json); light/heavy = gold-v2 hv*.
  python3 diag.py  ->  diag.json"""
import json, os
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..'); G2 = os.path.join(V3, '..', 'gold-v2')
sn = json.load(open(f'{V3}/sugestoes.json'))['sugestoes']
cr = {r['issueId']: r['class_reviewed'] for f in ('golden.json', 'fps-conhecidos.json') for l in json.load(open(f'{V3}/{f}'))['prs'].values() for r in l}
pl = json.load(open(f'{AQUI}/placar.json'))
M = [('ds', 'deepseek-v4.1-flash@', 'deepseek-v4.1-flash', 'hv'), ('gpt', 'gpt-6.1-sol@', 'gpt-6.1-sol', 'hv'),
     ('sonnet', 'sonnet-5.5@loop', 'sonnet-5.5', 'hvsnloop'), ('opus', 'opus-5.5@api', 'opus-5.5', 'hvopa'),
     ('muse', 'muse-spark-1.3@novo', 'muse-spark-1.3', 'hvmuse'), ('kimi', 'kimi-k2.7-code@novo', 'kimi-k2.7-code', 'hvkimi')]
out = {}
for k, mapa, model, hv in M:
    mapa = mapa.rstrip('@')
    s = json.load(open(f'{G2}/{hv}_{model}.json')); L, X = set(), set()
    for c, v in s['prs'].items():
        for x in v['suggestions']:
            i = sn.get(f'{mapa}|{c}|{x["id"]}')
            if i and cr.get(i) == 'TP': (L if x['producedBy'] == 'generalist-base' else X).add(i)
    po = pl[k]['porOrigem']; G = set(po['generalist']['tpIds']); R = set(po['synthesis-rescue']['tpIds']); P = G | R; H = L | X
    out[k] = {'prodG': len(G), 'light': len(L), 'enxuta': len(L) - len(G), 'rescueX': len(R - G), 'lentesX': len(X - L),
              'prod': len(P), 'heavy': len(H), 'prodForaHeavy': len(P - H), 'heavyForaProd': len(H - P),
              'repete': round(100 * len(G & L) / len(G | L))}
json.dump(out, open(f'{AQUI}/diag.json', 'w'), indent=1)
for k, v in out.items(): print(k, v)
