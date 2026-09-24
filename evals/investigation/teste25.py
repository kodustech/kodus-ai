#!/usr/bin/env python3
"""Fusao por arquivo + cota por PR: os dois unicos movimentos que pagaram."""
import importlib.util, os, sys
AQUI=os.path.dirname(os.path.abspath(__file__))
def carregar(n,f):
    s=importlib.util.spec_from_file_location(n,os.path.join(AQUI,f))
    m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
A=carregar('af','ajustar-formula.py'); P=carregar('pf','pontuar-fundido.py')
arq=sys.argv[1] if len(sys.argv)>1 else 'fundido-sol-teto2.json'
d=P.montar(arq)
feats=['nota','ver','prod','conf','tam','sev','nag','ngr','vies']
auc,_,probs=A.avaliar(d,feats,[0.2])
def medir(sel):
    tp=fp=tot=0
    for c in d:
        tot+=d[c]['core_goldens']; cob=set(); gs=d[c]['grupos']; ps=probs[c]
        for i in sel(ps):
            g=gs[i]
            if g['core']: cob.update(g['core'])
            elif not g['cobre']: fp+=1
        tp+=len(cob)
    r=tp/max(1,tot); p=tp/max(1,tp+fp)
    return r,p,2*r*p/max(1e-9,r+p),5*r*p/max(1e-9,4*p+r),tp,fp
print(f'{arq}  AUC(LOO) {auc:.3f}')
print(f'{"regra":30s} {"rec":>7} {"pre":>7} {"F1":>6} {"F2":>6}  tp/fp')
for k in [2,3,4,5,6]:
    r,p,f1,f2,tp,fp=medir(lambda ps,k=k: sorted(range(len(ps)),key=lambda i:-ps[i])[:k])
    flag=' <<< META' if r>=0.55 and p>=0.50 else ''
    print(f'{"top-"+str(k)+" por PR":30s} {r:7.1%} {p:7.1%} {f1:6.3f} {f2:6.3f}  {tp}/{fp}{flag}')
print()
for k in [3,4,5,6]:
    for corte in [0.14,0.20,0.26,0.32]:
        r,p,f1,f2,tp,fp=medir(lambda ps,k=k,c=corte: [i for i in sorted(range(len(ps)),key=lambda i:-ps[i])[:k] if ps[i]>=c])
        flag=' <<< META' if r>=0.55 and p>=0.50 else ''
        print(f'{f"top-{k} e prob>={corte:.2f}":30s} {r:7.1%} {p:7.1%} {f1:6.3f} {f2:6.3f}  {tp}/{fp}{flag}')
