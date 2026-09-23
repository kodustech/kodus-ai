#!/usr/bin/env python3
"""Reproduz EXATAMENTE o procedimento que gerou a tabela publicada.

Para cada uma das tres linhas: validacao cruzada aninhada por PR — pesos e
regra de corte ajustados nos outros 28 PRs, aplicados no 29o. Nada aqui olha
o resultado do PR avaliado.

Rodar num refinamento novo (atribuidor e veracidade re-executados) diz se os
numeros publicados reproduzem.
"""
import os, importlib.util
from collections import Counter
AQUI=os.path.dirname(os.path.abspath(__file__))
s=importlib.util.spec_from_file_location('af',os.path.join(AQUI,'ajustar-formula.py'))
A=importlib.util.module_from_spec(s); s.loader.exec_module(A)
BASE=['nota','ver','prod','conf','tam','sev','nag','vies']
DROP=['micro-scale-and-blocking','micro-repeated-work','micro-resource-and-growth']
GLOBAL=[('g',round(0.02*i,2)) for i in range(4,22)]
TUDO=GLOBAL+[('q',(K,c)) for K in range(2,9) for c in [0.0,0.18,0.22,0.26,0.30]]
LINHAS=[
 ('15 agentes, corte global',    [],   GLOBAL, 'F1', (45.4,52.1,0.485,0.466)),
 ('12 agentes, corte precisao',  DROP, TUDO,   'F1', (45.4,51.0,0.480,0.464)),
 ('12 agentes, corte recall',    DROP, TUDO,   'F2', (57.4,40.8,0.477,0.531)),
]
def ap(reg,ps,n):
    t,par=reg
    if t=='g': return [i for i in range(n) if ps[i]>=par]
    K,c=par; return [i for i in sorted(range(n),key=lambda i:-ps[i])[:K] if ps[i]>=c]
def met(sel,d,quais):
    tp=fp=tot=n=0
    for c in quais:
        tot+=d[c]['core_goldens']; gs=d[c]['grupos']; cob=set()
        for i in sel[c]:
            n+=1
            if gs[i]['core']: cob.update(gs[i]['core'])
            elif not gs[i]['cobre']: fp+=1
        tp+=len(cob)
    r=tp/max(1,tot); p=tp/max(1,tp+fp)
    return r,p,2*r*p/max(1e-9,r+p),5*r*p/max(1e-9,4*p+r),n
print(f'seletor    : {A.SEL}\nveracidade : {A.VER}\n')
print(f'{"linha":28s} {"recall":>15} {"precisao":>15} {"F1":>15} {"F2":>15}  cmt/PR  regra')
print('-'*122)
for nome, sem, grid, obj, ref in LINHAS:
    d=A.montar([], sem); prs=list(d)
    _,_,probs=A.avaliar(d,BASE,[0.2])
    sel={}; esc=[]
    for fora in prs:
        dentro=[c for c in prs if c!=fora]; melhor=None
        for reg in grid:
            sx={c:ap(reg,probs[c],len(d[c]['grupos'])) for c in dentro}
            m=met(sx,d,dentro); k=m[2] if obj=='F1' else m[3]
            if melhor is None or k>melhor[0]: melhor=(k,reg)
        sel[fora]=ap(melhor[1],probs[fora],len(d[fora]['grupos'])); esc.append(str(melhor[1]))
    r,p,f1,f2,n=met(sel,d,prs)
    R,P,F1,F2=ref; e=Counter(esc).most_common(1)[0]
    def f(x,y,pc=True):
        dd=x-y; sg='+' if dd>=0 else ''
        return f'{x:5.1f}% ({sg}{dd:.1f})' if pc else f'{x:.3f} ({sg}{dd:.3f})'
    print(f'{nome:28s} {f(r*100,R):>15} {f(p*100,P):>15} {f(f1,F1,0):>15} {f(f2,F2,0):>15}  {n/len(d):5.1f}  {e[0]} {e[1]}/29')
print('-'*122)
print('entre parenteses: diferenca contra o valor publicado')
