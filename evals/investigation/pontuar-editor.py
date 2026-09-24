#!/usr/bin/env python3
"""Avalia o editor por PR: (a) a escolha crua dele, (b) a ordem dele como
feature na formula, (c) a ordem combinada com cota por PR."""
import json, os, sys, importlib.util
AQUI=os.path.dirname(os.path.abspath(__file__))
s=importlib.util.spec_from_file_location('af',os.path.join(AQUI,'ajustar-formula.py'))
A=importlib.util.module_from_spec(s); s.loader.exec_module(A)
ED=json.load(open(os.path.join(AQUI,'results','editor-sol-teto2.json')))['saida']
d=A.montar([])
for c in d:
    e=ED.get(c,{}) or {}
    itens=e.get('itens',{}) or {}
    n=len(d[c]['grupos'])
    for g in d[c]['grupos']:
        r=itens.get(str(g['orig']))
        pos = r['pos'] if r else n
        g['pos']=pos; g['dentro']=bool(r and r.get('dentro'))
        g['f']['rank']=1.0/(pos+1)
        g['f']['ed']=1.0 if g['dentro'] else 0.0

def medir(sel):
    tp=fp=tot=0
    for c in d:
        tot+=d[c]['core_goldens']; cob=set(); gs=d[c]['grupos']
        for g in sel(c,gs):
            if g['core']: cob.update(g['core'])
            elif not g['cobre']: fp+=1
        tp+=len(cob)
    r=tp/max(1,tot); p=tp/max(1,tp+fp)
    return r,p,2*r*p/max(1e-9,r+p),5*r*p/max(1e-9,4*p+r),tp,fp
def linha(nome,*m):
    r,p,f1,f2,tp,fp=m
    flag=' <<< META' if r>=0.55 and p>=0.50 else ''
    print(f'{nome:34s} {r:7.1%} {p:7.1%} {f1:6.3f} {f2:6.3f}  {tp}/{fp}{flag}')

print(f'{"regra":34s} {"rec":>7} {"pre":>7} {"F1":>6} {"F2":>6}  tp/fp')
linha('escolha crua do editor', *medir(lambda c,gs: [g for g in gs if g['dentro']]))
for K in [2,3,4,5,6]:
    linha(f'ordem do editor, top-{K}/PR', *medir(lambda c,gs,K=K: sorted(gs,key=lambda g:g['pos'])[:K]))
print()
BASE=['nota','ver','prod','conf','tam','sev','nag','vies']
for nome,feats in [('formula base',BASE),('formula + rank',BASE+['rank']),
                   ('formula + rank + ed',BASE+['rank','ed'])]:
    auc,linhas,probs=A.avaliar(d,feats,[0.14,0.18,0.22,0.26,0.30,0.34,0.38])
    ok=[l for l in linhas if l[3]>=0.55]
    m=max(ok,key=lambda l:l[4]) if ok else None
    best=max(linhas,key=lambda l:l[5])
    txt=f'rec {m[3]:.1%} pre {m[4]:.1%} (corte {m[0]:.2f})' if m else 'rec>=55% inalcancavel'
    mark=' <<< META' if m and m[4]>=0.50 else ''
    print(f'{nome:24s} AUC {auc:.3f}  {txt:36s} melhorF1 {best[5]:.3f} ({best[3]:.1%}/{best[4]:.1%}){mark}')
    if feats is not BASE:
        for K in [3,4,5]:
            r,p,f1,f2,tp,fp=medir(lambda c,gs,K=K,pr=probs: [gs[i] for i in sorted(range(len(gs)),key=lambda i:-pr[c][i])[:K]])
            linha(f'   ^ com top-{K}/PR',r,p,f1,f2,tp,fp)
