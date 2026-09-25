#!/usr/bin/env python3
"""Reajusta a logistica de 8 termos com um `ver` DIFERENTE, fora do PR avaliado.

Por que existe. Os pesos publicados foram ajustados com `ver` = a nota do
prompt de veracidade. Enfiar o verify-score naquele mesmo slot e reusar os
pesos assume que os dois sinais tem a mesma escala e a mesma relacao com o
alvo — e nao tem: a veracidade espalha de 0 a 100, o verify-score empilha 128
de 132 em 90-100. Um peso ajustado para um sinal espalhado subaproveita um
sinal concentrado.

Reajustar e de graca (nao chama LLM) e responde quanto do resultado era o
sinal e quanto era o peso errado. Leave-one-out por PR: o PR avaliado nunca
entra no fit.
"""
import json, math, glob, sys

CORE={'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
SEVN={'low':.25,'medium':.5,'high':.75,'critical':1.0}
BASE=['nota','ver','prod','conf','tam','sev','nag','vies']

def montar(pool, matrizes, fonte_ver, arquivo_ver=None, veracidade=None):
    MAT={}
    for m in matrizes: MAT.update(json.load(open(f'results/{m}')))
    V=json.load(open(f'results/{arquivo_ver}'))['saida'] if arquivo_ver else {}
    dados={}
    for cid,v in V.items():
        if cid not in MAT: continue
        j=json.load(open(f'pools/{pool}/{cid}.raw.txt'))
        cands=j['trace'].get('preFilterCandidates') or []
        keep=[i for i,x in enumerate(cands)
              if str(x.get('severity','')).lower() in SEVN and x.get('reason')]
        gs,conf=MAT[cid]['goldens'],MAT[cid]['conf']
        coreG=[i for i,g in enumerate(gs) if g.get('category') in CORE]
        dono={}
        for gi in coreG:
            b,q=0,-1
            for pos,ci in enumerate(keep):
                x=conf[gi][ci] if ci<len(conf[gi]) else 0
                if x>b: b,q=x,pos
            if q>=0: dono[gi]=q
        gr=[]
        for g in v.get('grupos',[]):
            idx=[i for i in g['indices'] if i<len(keep)]
            if not idx: continue
            mem=[cands[keep[i]] for i in idx]
            ags={m.get('producedBy') for m in mem}
            nota=(g.get('nota') or 0)/100
            if fonte_ver=='score':
                ver=(g.get('score') if g.get('score') is not None else 50)/100
            elif fonte_ver=='veracidade':
                x=(veracidade or {}).get(cid,{}).get(str(g.get('origem')))
                ver=(x if x is not None else 50)/100
            else:
                ver=0.5
            f={'nota':nota,'ver':ver,'prod':nota*ver,
               'conf':max((m.get('confidence') or 0) for m in mem)/100,
               'tam':min(len(idx),4)/4,
               'sev':max(SEVN.get(str(m.get('severity','')).lower(),.5) for m in mem),
               'nag':min(len(ags),3)/3,'vies':1.0}
            cobre=[gi for gi,pos in dono.items() if pos in idx]
            gr.append({'f':f,'cobre':cobre,'core':[x for x in cobre if x in coreG]})
        dados[cid]={'g':gr,'core':len(coreG)}
    return dados

def fit(amostras, feats, it=300, lr=0.5, reg=0.01):
    w={k:0.0 for k in feats}
    for _ in range(it):
        gr={k:0.0 for k in feats}
        for f,y in amostras:
            z=sum(w[k]*f.get(k,0.0) for k in feats)
            p=1/(1+math.exp(-max(-30,min(30,z))))
            e=p-y
            for k in feats: gr[k]+=e*f.get(k,0.0)
        n=len(amostras) or 1
        for k in feats: w[k]-=lr*(gr[k]/n+reg*w[k])
    return w

def prob(w,f):
    z=sum(w[k]*f.get(k,0.0) for k in w)
    return 1/(1+math.exp(-max(-30,min(30,z))))

PESOS_PUBLICADOS={'nota':0.8021,'ver':-0.9322,'prod':1.064,'conf':-0.0787,
                  'tam':1.0001,'sev':-0.797,'nag':0.7929,'vies':-1.2458}

def avaliar(dados, pesos=None, cotas=(3,5,6,7), lim=0.22, feats=BASE):
    prs=list(dados)
    probs={}
    if pesos:
        for c in prs: probs[c]=[prob(pesos,g['f']) for g in dados[c]['g']]
    else:   # leave-one-out
        for fora in prs:
            am=[(g['f'],1.0 if g['core'] else 0.0)
                for c in prs if c!=fora for g in dados[c]['g']]
            w=fit(am,feats)
            probs[fora]=[prob(w,g['f']) for g in dados[fora]['g']]
    out=[]
    for K in cotas:
        tp=fp=tot=n=0
        for c in prs:
            tot+=dados[c]['core']; cob=set()
            ordem=sorted(range(len(dados[c]['g'])),key=lambda i:-probs[c][i])[:K]
            for i in ordem:
                if probs[c][i]<lim: continue
                n+=1
                g=dados[c]['g'][i]
                if g['core']: cob.update(g['core'])
                elif not g['cobre']: fp+=1
            tp+=len(cob)
        r=tp/max(1,tot); p=tp/max(1,tp+fp)
        out.append((K,r,p,2*r*p/max(1e-9,r+p),5*r*p/max(1e-9,4*p+r),n/len(prs)))
    return out

def tabela(nome, linhas):
    print(f'\n{nome}')
    print(f"{'cota':>5} {'recall':>8} {'precis':>8} {'F1':>7} {'F2':>7} {'c/PR':>6}")
    for K,r,p,f1,f2,c in linhas:
        print(f"{K:>5} {r*100:>7.1f}% {p*100:>7.1f}% {f1:>7.3f} {f2:>7.3f} {c:>6.1f}")
