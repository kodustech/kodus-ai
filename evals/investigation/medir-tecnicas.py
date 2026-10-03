#!/usr/bin/env python3
"""#1821, precisao: monta o que seria publicado em cada tecnica (consenso passa
direto + unicos aprovados) e mede na NOSSA regua (juiz sobre cada comentario
como ele e). Grava os comentarios para a regua da Martian.

  python3 medir-tecnicas.py <sufixo> <pool-original>"""
import json, sys, os
CORE={'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
suf,pool=sys.argv[1:3]
L30=json.load(open('light-30.json'))
M=json.load(open(f'results/matriz-{pool}.json')); D=json.load(open(f'results/matriz-descartados-{pool}.json'))
DD=json.load(open(f'results/dedup-prod2/{suf}.json'))['prs']
T={t:(json.load(open(f'results/tecnicas/{suf}-{t}.json'))['prs'] if os.path.exists(f'results/tecnicas/{suf}-{t}.json') else {}) for t in ['base','defesa','correcao','torneio']}
cands={c:json.load(open(f'pools/{pool}-heavysv/{c}.raw.txt'))['trace']['preFilterCandidates'] for c in L30}
def unicos(c): mb=DD[c].get('membros',{}); return [k for k in DD[c]['kept'] if len(mb.get(str(k),[k]))==1]
def consenso(c): mb=DD[c].get('membros',{}); return [k for k in DD[c]['kept'] if len(mb.get(str(k),[k]))>1]
cenarios={'depois do dedup': lambda c: DD[c]['kept']}
for t in ['base','defesa','correcao']:
    if T[t]: cenarios[t]=lambda c,t=t: consenso(c)+[k for k in unicos(c) if (T[t].get(c,{}).get('decisoes',{}).get(str(k)) or {'fica':True}).get('fica',True)]
if T['torneio']:
    for K in (2,3): cenarios[f'torneio top{K}']=lambda c,K=K: consenso(c)+(T['torneio'].get(c,{}).get('ranking') or unicos(c))[:K]
os.makedirs('results/tecnicas/comentarios',exist_ok=True)
for nome,sel in cenarios.items():
    gold=fp=n=0; com={}
    for c in L30:
        idx=sel(c); n+=len(idx); venc=set(); cs=cands[c]
        com[c]=[cs[i].get('suggestionContent','') for i in idx]
        gs=(M.get(c) or D.get(c))['goldens']
        for gi,g in enumerate(gs):
            if g.get('category') not in CORE: continue
            b,q=0,None
            for i in idx:
                mm=(M if cs[i]['_src']=='M' else D).get(c); x=mm['conf'][gi][cs[i]['_col']] if mm else 0
                if x>b: b,q=x,i
            if q is not None: gold+=1; venc.add(q)
        fp+=len(idx)-len(venc)
    arq=f"results/tecnicas/comentarios/{suf}-{nome.replace(' ','_')}.json"; json.dump(com,open(arq,'w'))
    print(json.dumps({'sufixo':suf,'cenario':nome,'comentarios':n,'gold':gold,'recall':gold/111,'precisao':gold/(gold+fp) if gold+fp else 0,'arquivo':arq}))
