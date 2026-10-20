#!/usr/bin/env python3
"""Placar do finder da producao (loopFindings) no gold v3, regra oficial:
TP = TP do gold confirmado ou descontinuado no upstream, cada um uma vez. FP nit = TP nit, TP pendente ou que nao entrou
no original, FP e a segunda sugestao sobre o mesmo TP. FP alucinacao = alucinacao.
Os publicados herdam o rotulo do gold; os cortados vem de rotulos-cortados.json (juiz Opus; o que nao casou: Opus + Astra, debate, upstream).
  python3 placar-finder.py [--novos]   (--novos: os TPs novos confirmados daqui entram no denominador)"""
import json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
CH = {'ds': 'deepseek-v4.1-flash@prod', 'gpt': 'gpt-6.1-sol@prod', 'opus': 'opus-5.5@prod', 'sonnet': 'sonnet-5.5@prod', 'muse': 'muse-spark-1.3@prod', 'kimi': 'kimi-k2.7-code@prod'}
FPST = {'pendente', 'nao_entrou_no_original'}
classe = {}
for f in ('golden.json', 'fps-conhecidos.json'):
    for l in json.load(open(f'{V3}/{f}'))['prs'].values():
        for i in l: classe[i['issueId']] = (i['class'], i['subclass'])
st = {k: t['status'] for p in json.load(open(f'{V3}/verificacao-upstream.json'))['prs'].values() for k, t in p['tps'].items()}
valido = {i for i, (c, s) in classe.items() if c == 'TP' and not s and st.get(i) not in FPST}
rot = json.load(open(f'{AQUI}/rotulos-cortados.json'))
for r in rot.values():
    if r['via'] == 'classificacao':
        classe[r['issue']] = (r['class'], None if r['subclass'] in ('none', None) else r['subclass'])
        if r['class'] == 'TP' and r['subclass'] in ('none', None) and r['upstream'] not in FPST and '--novos' in sys.argv: valido.add(r['issue'])
total = len(valido)
out = {}
for k, ch in CH.items():
    fin = json.load(open(f'{AQUI}/{k}/finder.json'))
    vistos, n = set(), {'tp': 0, 'fp_nit': 0, 'fp_alucinacao': 0, 'fp_duplicata': 0}
    tot = 0
    for c, itens in fin.items():
        for it in itens:
            tot += 1
            iss = it['issue'] if it['origem'] != 'cortado' else rot[f'{k}|{c}|{it["id"]}']['issue']
            cl, sub = classe[iss]
            if iss in valido:
                if iss in vistos: n['fp_nit'] += 1; n['fp_duplicata'] += 1
                else: vistos.add(iss); n['tp'] += 1
            elif sub == 'hallucination': n['fp_alucinacao'] += 1
            else: n['fp_nit'] += 1
    R = n['tp'] / total; P = n['tp'] / tot
    f = lambda b: (1 + b * b) * P * R / (b * b * P + R) if P + R else 0
    out[k] = {'comentarios': tot, **n, 'totalTp': total, 'recall': round(100 * R, 1), 'precisao': round(100 * P, 1), 'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1)}
    print(k, out[k])
json.dump(out, open(f'{AQUI}/placar-finder{"-novos" if "--novos" in sys.argv else ""}.json', 'w'), indent=1)
