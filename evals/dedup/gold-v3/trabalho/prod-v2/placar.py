#!/usr/bin/env python3
"""Placar da Producao V2 (finder de producao: generalista + synthesis rescue, sem verify) no gold v3, regua Martian.
Cada comentario herda o class_reviewed do problema do gold com que o juiz Opus o casou (passada 1 contra o golden,
passada 2 contra os FPs conhecidos); o que nao casou com nada e FP nit. Cada TP conta uma vez: a segunda sugestao
sobre o mesmo TP e FP nit. Recall = TPs distintos / TPs do gold; precisao = TPs distintos / comentarios.
Por origem (generalista, synthesis rescue): um TP achado pelas duas passadas conta nas duas.
Uso por PR (do dump): tokens e tempo de cada passada; o finder e o generalista seguido do rescue.
  python3 placar.py <chave> <dir dos dumps> [<chave> <dir> ...]  ->  placar.json (acumula)"""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
cr = {r['issueId']: r['class_reviewed'] for f in ('golden.json', 'fps-conhecidos.json') for l in json.load(open(f'{V3}/{f}'))['prs'].values() for r in l}
TOTAL = sum(1 for v in cr.values() if v == 'TP')
ORIG = ('generalist', 'synthesis-rescue')
def metr(tp, tot):
    R = tp / TOTAL; P = tp / tot if tot else 0
    f = lambda b: (1 + b * b) * P * R / (b * b * P + R) if P + R else 0
    return {'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
def placar(k, D):
    W = f'{AQUI}/{k}'; com = json.load(open(f'{W}/comentarios.json'))
    m1 = {}; [m1.update(json.load(open(f))) for f in glob.glob(f'{W}/opus-out*.json')]
    m2 = json.load(open(f'{W}/fp/opus-out0.json')) if os.path.exists(f'{W}/fp/opus-out0.json') else {}
    n = {'TP': 0, 'FP nit': 0, 'FP hallucination': 0}; por_pr = {}; vistos = set()
    o = {x: {'comentarios': 0, 'tps': set(), 'FP nit': 0, 'FP hallucination': 0} for x in ORIG}
    novos = 0
    for c, itens in com.items():
        a = {x['id']: x['match'] for x in m1.get(c, [])}; b = {x['id']: x['match'] for x in m2.get(c, [])}
        pr = {'comentarios': len(itens), 'tp': 0, 'fp': 0}
        for i in itens:
            iss = a.get(i['id'], 'new')
            if iss == 'new': iss = b.get(i['id'], 'new')
            assert iss == 'new' or iss.split('#')[0] == c, (c, iss)
            cl = 'FP nit' if iss == 'new' else cr[iss]
            novos += iss == 'new'
            oo = o[i['origem']]; oo['comentarios'] += 1
            if cl == 'TP': oo['tps'].add(iss)
            else: oo[cl] += 1
            if cl == 'TP':
                if iss in vistos: cl = 'FP nit'
                else: vistos.add(iss)
            n[cl] += 1; pr['tp' if cl == 'TP' else 'fp'] += 1
        por_pr[c] = pr
    tot = sum(len(v) for v in com.values())
    # uso por PR
    uso = {}
    for f in glob.glob(f'{D}/*.raw.txt'):
        d = json.loads(open(f).read()); st = d.get('stages') or {}
        u = {}
        for x in ORIG:
            s = st.get(f'finder.{x}') or {}
            u[x] = {'input': s.get('in', 0), 'cacheRead': s.get('cacheRead', 0), 'output': s.get('out', 0), 'ms': s.get('ms', 0), 'calls': s.get('calls', 0)}
        ss = [st[f'finder.{x}'] for x in ORIG if st.get(f'finder.{x}', {}).get('firstStart')]
        fin = {q: sum(u[x][q] for x in ORIG) for q in ('input', 'cacheRead', 'output', 'calls')}
        fin['ms'] = max(s['lastEnd'] for s in ss) - min(s['firstStart'] for s in ss) if ss else 0
        u['finder'] = fin
        u['depoisDoFinder'] = sum(v.get('calls', 0) for kk, v in st.items() if kk not in ('finder.generalist', 'finder.synthesis-rescue'))
        uso[d['caseId']] = u
    return {'comentarios': tot, 'tp': n['TP'], 'fpNit': n['FP nit'], 'fpAlucinacao': n['FP hallucination'], 'totalTp': TOTAL, 'semCasamento': novos,
            **metr(n['TP'], tot),
            'porOrigem': {x: {'comentarios': o[x]['comentarios'], 'tp': len(o[x]['tps']), 'fpNit': o[x]['FP nit'], 'fpAlucinacao': o[x]['FP hallucination'], **metr(len(o[x]['tps']), o[x]['comentarios'])} for x in ORIG},
            'porPr': por_pr, 'uso': uso}
P = f'{AQUI}/placar.json'; out = json.load(open(P)) if os.path.exists(P) else {}
for k, D in zip(sys.argv[1::2], sys.argv[2::2]):
    out[k] = placar(k, D); q = out[k]
    print(k, {x: q[x] for x in ('comentarios', 'tp', 'fpNit', 'fpAlucinacao', 'semCasamento', 'recall', 'precisao', 'f1', 'f2')}, {x: (v['comentarios'], v['tp']) for x, v in q['porOrigem'].items()})
json.dump(out, open(P, 'w'), indent=1)
