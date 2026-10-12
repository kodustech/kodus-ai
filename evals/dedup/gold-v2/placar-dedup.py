#!/usr/bin/env python3
"""Gold de duplicatas v2 (#1821): recall e precisao da regua Martian se o dedup
agrupasse exatamente como o gold final (09.10.26_<model>.final.json).

Usa as matrizes candidato x golden do juiz Martian ja rodadas no finder
(evals/investigation/results/matriz-pre-09.10.26_*.json); nao chama LLM.
  - antes: todas as sugestoes G + M3;
  - grupo une: cada grupo vira um comentario com o credito de todos os membros;
  - 1 por grupo: o dedup mantem um membro (o melhor possivel; teto do dedup real).
Lista os grupos cujos membros casam goldens diferentes (candidatos a fusao errada).

  python3 evals/dedup/gold-v2/placar-dedup.py
"""
import json, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CORE={'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}; TOTAL=111
pairs={'deepseek-v4.1-flash':'finder-definitivo_deepseek','gpt-6.1-sol':'finder-definitivo_gpt','muse-spark-1.2':'finder-muse-v1','sonnet-5.5':'finder-definitivo_sonnet'}
tec=lambda pb: pb=='generalist-base' or str(pb).startswith('micro-exp-p3-')
def score(cases):
    gold=fp=n=0
    for gs,cols in cases:  # cols: list of conf vectors (per golden)
        n+=len(cols); venc=set()
        for gi,g in enumerate(gs):
            if g.get('category') not in CORE: continue
            b,q=0,None
            for k,v in enumerate(cols):
                if v[gi]>b: b,q=v[gi],k
            if q is not None: gold+=1; venc.add(q)
        fp+=len(cols)-len(venc)
    return n,gold,gold/TOTAL,gold/(gold+fp)
conflitos=[]
for mod,mz in pairs.items():
    m=json.load(open(f'investigation/results/matriz-pre-09.10.26_{mz}.json'))
    fin=json.load(open(f'dedup/gold-v2/09.10.26_{mod}.final.json'))['prs']
    A=[];U=[];R=[]
    for c,pr in fin.items():
        gs=m[c]['goldens']; core=[gi for gi,g in enumerate(gs) if g.get('category') in CORE]
        idx=[j for j,x in enumerate(m[c]['candidatos']) if tec(x.get('producedBy'))]
        vec={f'S{i+1}':[m[c]['conf'][gi][j] for gi in range(len(gs))] for i,j in enumerate(idx)}
        A.append((gs,list(vec.values())))
        grupos={}
        for sid,s in pr.items():
            if s.get('grupo'): grupos.setdefault(s['grupo'],[]).append(sid)
        soltas=[sid for sid,s in pr.items() if not s.get('grupo')]
        uc=[vec[s] for s in soltas]; rc=[vec[s] for s in soltas]
        for gid,mem in grupos.items():
            uc.append([max(vec[s][gi] for s in mem) for gi in range(len(gs))])
            hit=lambda s:{gi for gi in core if vec[s][gi]>0}
            best=max(mem,key=lambda s:(len(hit(s)),sum(vec[s])))
            rc.append(vec[best])
            todos=set().union(*[hit(s) for s in mem])
            if todos-hit(best): conflitos.append((mod,c,mem,{s:sorted(hit(s)) for s in mem if hit(s)}))
        U.append((gs,uc)); R.append((gs,rc))
    for nome,cs in [('antes',A),('dedup (grupo une)',U),('dedup (1 por grupo)',R)]:
        n,g,r,p=score(cs); print(f'{mod:22} {nome:22} n={n:4} goldens={g:3} recall={r:.1%} prec={p:.1%}')
print('\nGRUPOS COM MEMBROS CASANDO GOLDENS DIFERENTES:')
for x in conflitos: print(x)
