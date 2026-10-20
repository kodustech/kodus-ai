"""Projecao do novo heavy + rescue: os comentarios do novo light + rescue (julgados pelo Opus) somados aos das lentes M3
do heavy que ja rodou (gold-v2 hv*, producedBy micro-exp-p3-*, classe pelo sugestoes.json). Nada roda de novo.
Cada TP conta uma vez; a segunda sugestao sobre o mesmo TP e FP nit. Regua Martian.
  python3 projecao.py  ->  projecao-heavy.json"""
import json, os, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..'); G2 = os.path.join(V3, '..', 'gold-v2')
sn = json.load(open(f'{V3}/sugestoes.json'))['sugestoes']
cr = {r['issueId']: r['class_reviewed'] for f in ('golden.json', 'fps-conhecidos.json') for l in json.load(open(f'{V3}/{f}'))['prs'].values() for r in l}
TOTAL = sum(1 for v in cr.values() if v == 'TP')
HV = {'ds': ('deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'hv'), 'gpt': ('gpt-6.1-sol', 'gpt-6.1-sol', 'hv'),
      'sonnet': ('sonnet-5.5', 'sonnet-5.5@loop', 'hvsnloop'), 'opus': ('opus-5.5', 'opus-5.5@api', 'hvopa'),
      'muse': ('muse-spark-1.3', 'muse-spark-1.3@novo', 'hvmuse'), 'kimi': ('kimi-k2.7-code', 'kimi-k2.7-code@novo', 'hvkimi')}
# <chave>20: a mesma rodada com a regra de passos da producao (RECALL_PROD_STEPS=1); as lentes M3 sao as mesmas.
HV.update({'ds20': HV['ds'], 'kimi20': HV['kimi']})
out = {}
for k, (model, mapa, hv) in HV.items():
    W = f'{AQUI}/{k}'
    if not os.path.exists(f'{W}/fp/opus-out0.json'): continue
    com = json.load(open(f'{W}/comentarios.json'))
    m1 = {}; [m1.update(json.load(open(f))) for f in glob.glob(f'{W}/opus-out*.json')]
    m2 = json.load(open(f'{W}/fp/opus-out0.json'))
    itens = []  # (issueId ou None, classe)
    for c, cs in com.items():
        a = {x['id']: x['match'] for x in m1.get(c, [])}; b = {x['id']: x['match'] for x in m2.get(c, [])}
        for i in cs:
            iss = a.get(i['id'], 'new')
            if iss == 'new': iss = b.get(i['id'], 'new')
            itens.append((None, 'FP nit') if iss == 'new' else (iss, cr[iss]))
    s = json.load(open(f'{G2}/{hv}_{model}.json')); lentes = 0
    for c, v in s['prs'].items():
        for x in v['suggestions']:
            if x['producedBy'] == 'generalist-base': continue
            i = sn[f'{mapa}|{c}|{x["id"]}']; itens.append((i, cr[i])); lentes += 1
    n = {'TP': 0, 'FP nit': 0, 'FP hallucination': 0}; vistos = set()
    for i, cl in itens:
        if cl == 'TP':
            if i in vistos: cl = 'FP nit'
            else: vistos.add(i)
        n[cl] += 1
    tot = len(itens); R = n['TP'] / TOTAL; P = n['TP'] / tot
    f = lambda bb: (1 + bb * bb) * P * R / (bb * bb * P + R) if P + R else 0
    out[k] = {'comentarios': tot, 'comentariosLentes': lentes, 'tp': n['TP'], 'fpNit': n['FP nit'], 'fpAlucinacao': n['FP hallucination'], 'totalTp': TOTAL,
              'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
    print(k, out[k])
json.dump(out, open(f'{AQUI}/projecao-heavy.json', 'w'), indent=1)
