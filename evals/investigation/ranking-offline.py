#!/usr/bin/env python3
"""#1821, precisao: ranking offline dos grupos que o verify pontuou (modo score),
com a logistica antiga SEM severidade/confianca/nota (nao existem mais na saida
enxuta), reajustada leave-one-out por PR, e corte dos K melhores por PR.

  python3 ranking-offline.py <sufixo> <pool>

Variaveis: ver (score/100), tam (membros do grupo, ate 4), nag (passadas
distintas no grupo, ate 3), vies (intercepto). Alvo: o grupo casa algum golden
core. Recall/precisao pela regra Martian (vence o maior conf por golden)."""
import json, math, sys, os, glob
CORE={'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
suf, pool = sys.argv[1], sys.argv[2]
L30=json.load(open('light-30.json'))
st2=json.load(open(f'results/reducer/{suf}-heavy-pre-semdrop-desc.json'))['prs']
tec=lambda l:'G' if l=='generalist-base' else 'S' if l=='synthesis-rescue' else 'M1' if l.startswith('micro-exp-p1g-') else 'M3' if l.startswith('micro-exp-p3-') else '?'

def membros(cid):
    """k -> labels das passadas dos membros do grupo (mesma ordem de itens do verify)."""
    t=json.load(open(f'pools/{pool}/{cid}.raw.txt'))['trace']
    itens=[c for c in t['preFilterCandidates'] if tec(c.get('producedBy',''))in('G','M3')]
    itens+=[d['droppedFinding'] for d in (t['verification'].get('decisions') or []) if d.get('action')=='drop' and d.get('droppedFinding') and tec(d['droppedFinding'].get('producedBy',''))in('G','M3')]
    out={}
    for e in (st2[cid].get('decisoes',{}).get('keep') or []):
        k=int(e['index']); mem=[k]+[x for x in (e.get('mergedFrom') or []) if x<len(itens)]
        out[k]=[itens[x].get('producedBy','') for x in mem if x<len(itens)]
    return out

def dados_de(arq):
    R=json.load(open(arq))['prs']; D={}
    for cid,p in R.items():
        if not p.get('grupos'): continue
        mem=membros(cid); gr=[]
        for g in p['grupos']:
            labs=mem.get(g['k'],['?'])
            s=(g.get('v') or {}).get('score')
            ver=(s if isinstance(s,(int,float)) else 50)/100
            f={'ver':ver,'tam':min(len(labs),4)/4,'nag':min(len(set(labs)),3)/3,'vies':1.0}
            core=[gi for gi,c in enumerate(g['cat']) if c in CORE]
            gr.append({'f':f,'confs':g['confs'],'y':1.0 if any(g['confs'][gi]>0 for gi in core) else 0.0,'core':core})
        D[cid]={'g':gr,'core':sum(1 for c in (p['grupos'][0]['cat'] if p['grupos'] else []) if c in CORE)}
    return D

FEATS=['ver','tam','nag','vies']
def fit(am,it=400,lr=0.5,reg=0.01):
    w={k:0.0 for k in FEATS}
    for _ in range(it):
        gr={k:0.0 for k in FEATS}
        for f,y in am:
            z=sum(w[k]*f[k] for k in FEATS); p=1/(1+math.exp(-max(-30,min(30,z)))); e=p-y
            for k in FEATS: gr[k]+=e*f[k]
        n=len(am) or 1
        for k in FEATS: w[k]-=lr*(gr[k]/n+reg*w[k])
    return w
prob=lambda w,f: 1/(1+math.exp(-max(-30,min(30,sum(w[k]*f[k] for k in FEATS)))))

def placar(D, escolhe):
    gold=fp=cand=0; total=0
    for cid,d in D.items():
        sel=escolhe(cid,d['g']); cand+=len(sel); venc=set()
        ncats=len(d['g'][0]['confs']) if d['g'] else 0
        for gi in range(ncats):
            if not d['g'] or gi not in d['g'][0]['core']: continue
            b,q=0,None
            for i in sel:
                if d['g'][i]['confs'][gi]>b: b,q=d['g'][i]['confs'][gi],i
            if q is not None: gold+=1; venc.add(q)
        fp+=len(sel)-len(venc)
    total=111
    return gold, gold/total, cand, (gold/(gold+fp) if gold+fp else 0)

for arq in sorted(glob.glob(f'results/verify/{suf}-*-score-*.json')):
    if 'resumo' not in json.load(open(arq)): continue
    D=dados_de(arq)
    probs={}
    for fora in D:
        w=fit([(g['f'],g['y']) for c,d in D.items() if c!=fora for g in d['g']])
        probs[fora]=[prob(w,g['f']) for g in D[fora]['g']]
    wall=fit([(g['f'],g['y']) for d in D.values() for g in d['g']])
    nome=os.path.basename(arq)[len(suf)+1:-5]
    print(f'\n== {suf} · {nome} · pesos (todos os PRs): '+' '.join(f'{k}={v:+.2f}' for k,v in wall.items()))
    g,r,c,p=placar(D, lambda cid,gs: list(range(len(gs)))); print(f'   sem corte         : recall {g} {r:.1%} · prec {p:.1%} · {c} comentarios')
    for K in (3,4,5,6,7):
        g,r,c,p=placar(D, lambda cid,gs,K=K: sorted(range(len(gs)),key=lambda i:-probs[cid][i])[:K])
        print(f'   top {K} por PR      : recall {g} {r:.1%} · prec {p:.1%} · {c} comentarios')
    for lim in (0.3,0.4,0.5):
        g,r,c,p=placar(D, lambda cid,gs,lim=lim: [i for i in range(len(gs)) if probs[cid][i]>=lim])
        print(f'   prob >= {lim:<4}     : recall {g} {r:.1%} · prec {p:.1%} · {c} comentarios')
