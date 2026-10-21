#!/usr/bin/env python3
"""Placar so do finder no gold v3, lendo apenas o dataset (sugestoes.json + class_reviewed):
producao (loopFindings, <modelo>@prod-finder) e fluxo novo light (generalista) e heavy (generalista + lentes M3).
TP conta uma vez; a segunda sugestao sobre o mesmo TP conta como FP nit. Recall = TPs distintos / TPs do gold;
precisao = TPs distintos / comentarios (a conta da Martian, offline/code_review_benchmark/step3_judge_comments.py).
  python3 placar-finder-v3.py  ->  placar-finder-v3.json"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from ancora import ok as ancora_ok
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..'); G2 = os.path.join(V3, '..', 'gold-v2')
sn = json.load(open(f'{V3}/sugestoes.json'))['sugestoes']
cr = {r['issueId']: r['class_reviewed'] for f in ('golden.json', 'fps-conhecidos.json') for l in json.load(open(f'{V3}/{f}'))['prs'].values() for r in l}
TOTAL = sum(1 for v in cr.values() if v == 'TP')
MOD = {'deepseek': ('deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'gen', 'hv'), 'gpt': ('gpt-6.1-sol', 'gpt-6.1-sol', 'gen', 'hv'),
       'sonnet-sdk': ('sonnet-5.5', 'sonnet-5.5@cc', 'gensncc', 'hvsncc'), 'sonnet-api': ('sonnet-5.5', 'sonnet-5.5@loop', 'gensnloop', 'hvsnloop'),
       'opus': ('opus-5.5', 'opus-5.5@api', 'genopa', 'hvopa'), 'muse': ('muse-spark-1.3', 'muse-spark-1.3@novo', 'genmuse', 'hvmuse'),
       'kimi': ('kimi-k2.7-code', 'kimi-k2.7-code@novo', 'genkimi', 'hvkimi')}
PASTA = {'deepseek': 'ds', 'gpt': 'gpt', 'sonnet-sdk': 'sonnet', 'sonnet-api': 'sonnet', 'opus': 'opus', 'muse': 'muse', 'kimi': 'kimi'}
PROD = {'deepseek': 'deepseek-v4.1-flash', 'gpt': 'gpt-6.1-sol', 'sonnet-sdk': 'sonnet-5.5', 'sonnet-api': 'sonnet-5.5', 'opus': 'opus-5.5', 'muse': 'muse-spark-1.3', 'kimi': 'kimi-k2.7-code'}
def placar(chaves):
    vistos, n = set(), {'TP': 0, 'FP nit': 0, 'FP hallucination': 0}
    for k in chaves:
        i = sn[k]; c = cr[i]
        if c == 'TP':
            if i in vistos: c = 'FP nit'
            else: vistos.add(i)
        n[c] += 1
    tot = len(chaves); R = n['TP'] / TOTAL; P = n['TP'] / tot
    f = lambda b: (1 + b * b) * P * R / (b * b * P + R) if P + R else 0
    return {'comentarios': tot, 'tp': n['TP'], 'fpNit': n['FP nit'], 'fpAlucinacao': n['FP hallucination'], 'totalTp': TOTAL,
            'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
out = {}
for nome, (model, mapa, gen, hv) in MOD.items():
    # O finder da producao e o loopFindings (L<n>). O publicado fora do loop (P<n>) e um achado do loop que o
    # stage reancorou noutra linha: ja esta no L que o originou, entao nao conta de novo.
    fin = json.load(open(f'{AQUI}/{PASTA[nome]}/finder.json'))
    loc = {(c, x['id']): x for c, v in fin.items() for x in v}
    # So o que vira comentario: ancora valida (parseFinderSchema + arquivo do PR).
    out[f'{nome}|producao'] = placar([k for k in sn if k.startswith(f'{PROD[nome]}@prod-finder|') and k.split('|')[-1].startswith('L')
                                      and ancora_ok(k.split('|')[1], *(lambda x: (x.get('file'), *(x.get('lines') or [None, None])))(loc[(k.split('|')[1], k.split('|')[2])]))])
    for modo, P in (('light', gen), ('heavy', hv)):
        s = json.load(open(f'{G2}/{P}_{model}.json'))
        out[f'{nome}|{modo}'] = placar([f'{mapa}|{c}|{x["id"]}' for c in s['prs'] for x in s['prs'][c]['suggestions']
                                         if ancora_ok(c, x.get('relevantFile'), x.get('relevantLinesStart'), x.get('relevantLinesEnd'), x.get('suggestionContent'), x.get('label'))])
for k, v in out.items(): print(f'{k:22}', v)
json.dump(out, open(f'{AQUI}/placar-finder-v3.json', 'w'), indent=1)
