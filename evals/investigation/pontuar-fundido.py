#!/usr/bin/env python3
"""Pontua os comentarios fundidos re-julgados, com a mesma regra da metrica."""
import json, math, os, sys
AQUI=os.path.dirname(os.path.abspath(__file__)); R=os.path.join(AQUI,'results')
CORE={'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
SEV={'low':0.25,'medium':0.5,'high':0.75,'critical':1.0}
import importlib.util
spec=importlib.util.spec_from_file_location('af',os.path.join(AQUI,'ajustar-formula.py'))
A=importlib.util.module_from_spec(spec); spec.loader.exec_module(A)

def montar(arq, extras=()):
    d=json.load(open(os.path.join(R,arq)))
    ver=json.load(open(os.path.join(R,'score2-sol-teto2.json')))['saida']
    dados={}
    for cid,v in d.items():
        gs=v['goldens']; conf=v['conf']; fds=v['fundidos']
        core_g=[gi for gi,g in enumerate(gs) if g.get('category') in CORE]
        dono={}
        for gi in range(len(gs)):
            melhor,quem=0,-1
            for fi in range(len(fds)):
                c=conf[gi][fi] if fi<len(conf[gi]) else 0
                if c>melhor: melhor,quem=c,fi
            if quem>=0: dono[gi]=quem
        grupos=[]
        for fi,fd in enumerate(fds):
            nota=(fd.get('nota') or 0)/100.0
            vs=[ver.get(cid,{}).get(str(r)) for r in fd.get('reps',[])]
            vs=[x for x in vs if x is not None]
            vv=(max(vs) if vs else 50)/100.0
            f={'nota':nota,'ver':vv,'prod':nota*vv,
               'conf':max([c or 0 for c in fd.get('confianca',[0])] or [0])/100.0,
               'tam':min(fd.get('nMembros',1),4)/4.0,
               'sev':max([SEV.get(str(s or '').lower(),0.5) for s in fd.get('severidade',[])] or [0.5]),
               'nag':min(len(fd.get('agentes',[])),3)/3.0,
               'ngr':min(fd.get('nGrupos',1),3)/3.0,
               'vies':1.0}
            cobre=[gi for gi,q in dono.items() if q==fi]
            grupos.append({'f':f,'cobre':cobre,'core':[gi for gi in cobre if gi in core_g]})
        dados[cid]={'grupos':grupos,'core_goldens':len(core_g)}
    return dados

if __name__=='__main__':
    arq=sys.argv[1] if len(sys.argv)>1 else 'fundido-sol-teto2.json'
    d=montar(arq)
    n=sum(len(v['grupos']) for v in d.values())
    feats=['nota','ver','prod','conf','tam','sev','nag','ngr','vies']
    auc,linhas,_=A.avaliar(d,feats,[0.10,0.14,0.18,0.22,0.26,0.30,0.34,0.38,0.42])
    print(f'{arq}: {len(d)} PRs, {n} comentarios fundidos, AUC(LOO) {auc:.3f}')
    print(f'{"corte":>6} {"tp":>4} {"fp":>4} {"recall":>8} {"precis":>8} {"F1":>6} {"F2":>6}')
    for c,tp,fp,r,p,f1,f2 in linhas:
        flag=' <<< META' if r>=0.55 and p>=0.50 else (' *' if r>=0.55 else '')
        print(f'{c:6.2f} {tp:4d} {fp:4d} {r:8.1%} {p:8.1%} {f1:6.3f} {f2:6.3f}{flag}')
