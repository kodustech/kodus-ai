"""Novo light + rescue x2 (Kimi): duas rodadas independentes do light + rescue somadas, cada uma julgada pelo Opus.
E o heavy + rescue x2: as duas rodadas mais as lentes M3 do heavy que ja rodou. Nada roda de novo aqui.
Todos os comentarios contam; cada TP conta uma vez; a repeticao de um TP e FP nit. Regua Martian.
  python3 x2.py  ->  x2.json"""
import json, os, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..'); G2 = os.path.join(V3, '..', 'gold-v2')
sn = json.load(open(f'{V3}/sugestoes.json'))['sugestoes']
cr = {r['issueId']: r['class_reviewed'] for f in ('golden.json', 'fps-conhecidos.json') for l in json.load(open(f'{V3}/{f}'))['prs'].values() for r in l}
TOTAL = sum(1 for v in cr.values() if v == 'TP')
def julgados(k):
    W = f'{AQUI}/{k}'; com = json.load(open(f'{W}/comentarios.json'))
    m1 = {}; [m1.update(json.load(open(f))) for f in glob.glob(f'{W}/opus-out*.json')]
    m2 = json.load(open(f'{W}/fp/opus-out0.json')); out = []
    for c, cs in com.items():
        a = {x['id']: x['match'] for x in m1.get(c, [])}; b = {x['id']: x['match'] for x in m2.get(c, [])}
        for i in cs:
            iss = a.get(i['id'], 'new')
            if iss == 'new': iss = b.get(i['id'], 'new')
            out.append((None, 'FP nit') if iss == 'new' else (iss, cr[iss]))
    return out
def lentes(model, mapa, hv):
    s = json.load(open(f'{G2}/{hv}_{model}.json'))
    return [(sn[f'{mapa}|{c}|{x["id"]}'], cr[sn[f'{mapa}|{c}|{x["id"]}']]) for c, v in s['prs'].items() for x in v['suggestions'] if x['producedBy'] != 'generalist-base']
def placar(itens):
    n = {'TP': 0, 'FP nit': 0, 'FP hallucination': 0}; vistos = set()
    for i, cl in itens:
        if cl == 'TP':
            if i in vistos: cl = 'FP nit'
            else: vistos.add(i)
        n[cl] += 1
    tot = len(itens); R = n['TP'] / TOTAL; P = n['TP'] / tot
    f = lambda bb: (1 + bb * bb) * P * R / (bb * bb * P + R) if P + R else 0
    return {'comentarios': tot, 'tp': n['TP'], 'fpNit': n['FP nit'], 'fpAlucinacao': n['FP hallucination'], 'totalTp': TOTAL,
            'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
r1, r2 = julgados('kimi'), julgados('kimi2'); m3 = lentes('kimi-k2.7-code', 'kimi-k2.7-code@novo', 'hvkimi')
out = {'kimi': {'rodada2': placar(r2), 'lightX2': placar(r1 + r2), 'heavyX2': placar(r1 + r2 + m3)}}
for k, v in out['kimi'].items(): print(k, v)
json.dump(out, open(f'{AQUI}/x2.json', 'w'), indent=1)
