#!/usr/bin/env python3
"""Os goldens CROSS-FILE que a geracao nunca alcanca — nos dois modelos.

`alcancado` aqui e o criterio mais generoso possivel: existe ALGUM candidato no
pool (antes do filtro de contrato, antes do agrupamento, antes da formula) com
confianca > 0 contra aquele golden. Um golden que nao aparece nem assim nao foi
perdido por corte — nenhum dos 13 agentes chegou perto dele.
"""
import json, sys

R = 'results'
CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
CF = json.load(open(f'{R}/goldens-crossfile.json'))['saida']

def perdidos(pool, matrizes):
    MAT = {}
    for m in matrizes:
        MAT.update(json.load(open(f'{R}/{m}')))
    fora, achados = [], set()
    for cid, m in MAT.items():
        try:
            j = json.load(open(f'pools/{pool}/{cid}.raw.txt'))
        except FileNotFoundError:
            continue
        cands = j['trace'].get('preFilterCandidates') or []
        gs, conf = m['goldens'], m['conf']
        arr = CF.get(cid) or []
        por_texto = {str(x.get('comment',''))[:120]: x for x in arr}
        for gi, g in enumerate(gs):
            if g.get('category') not in CORE:
                continue
            c = por_texto.get(str(g.get('comment',''))[:120]) or (arr[gi] if gi < len(arr) else None)
            if not c or not c.get('crossFile'):
                continue
            alcanca = any((conf[gi][k] if k < len(conf[gi]) else 0) > 0
                          for k in range(len(cands)))
            chave = (cid, str(g.get('comment',''))[:120])
            if alcanca:
                achados.add(chave)
            else:
                fora.append({'cid': cid, 'chave': chave, 'cat': g.get('category'),
                             'sev': g.get('severity'), 'comment': g.get('comment',''),
                             'porque': c.get('porque',''), 'arquivos': c.get('arquivos') or []})
    return fora, achados

GPT = perdidos('gpt-30', ['matriz-fix.json','matriz-gpt6.json'])
DS  = perdidos('ds-completo', ['matriz-ds-completo.json'])
pg = {x['chave']: x for x in GPT[0]}
pd = {x['chave']: x for x in DS[0]}
ambos = set(pg) & set(pd)
print(f'cross-file core perdidos — GPT {len(pg)} · DeepSeek {len(pd)} · NOS DOIS {len(ambos)}')
print(f'perdidos so pelo GPT: {len(set(pg)-set(pd))} · so pelo DeepSeek: {len(set(pd)-set(pg))}')
cats = {}
for k in ambos:
    cats[pg[k]['cat']] = cats.get(pg[k]['cat'], 0) + 1
print('\ncategoria dos perdidos pelos dois:', dict(sorted(cats.items(), key=lambda x: -x[1])))
print('\n' + '=' * 100)
for n, k in enumerate(sorted(ambos), 1):
    x = pg[k]
    print(f"\n[{n}] {x['cid'][:60]}  · {x['cat']} · {x['sev']}")
    print(f"    arquivos: {', '.join(x['arquivos'][:3])}")
    print(f"    GOLDEN: {x['comment'][:320]}")
    print(f"    por que cross-file: {x['porque'][:260]}")
