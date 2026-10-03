#!/usr/bin/env python3
"""#1821, precisao: cortes sobre a saida do atribuidor (seletor-vA) no heavy sem
verify. Gera, para cada corte, os comentarios que seriam publicados (o
representante de cada grupo escolhido), para a medicao pela regua da Martian.

  python3 atribuidor-cortes.py <sufixo> <pool-heavysv> <pool-original>

Cortes:
  nota-topK   os K grupos de maior nota do atribuidor por PR (K = 3..7);
  formula-L   prioridade pela logistica (nota, tam, nag, vies; sem severidade,
              confianca nem veracidade), reajustada leave-one-out por PR, e
              mantidos os grupos com probabilidade >= L (0.15 e 0.22).
O alvo do ajuste e o grupo conter um candidato que casa golden core (matrizes
do nosso juiz, mesmas da pagina de recall)."""
import json, math, sys, os
CORE={'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
suf, poolsv, pool = sys.argv[1:4]
A=json.load(open(f'results/atribuidor/{suf}.json'))['saida']
M=json.load(open(f'results/matriz-{pool}.json')); D=json.load(open(f'results/matriz-descartados-{pool}.json'))
L30=json.load(open('light-30.json'))
dados={}
for cid in L30:
    cands=json.load(open(f'pools/{poolsv}/{cid}.raw.txt'))['trace']['preFilterCandidates']
    gs=(M.get(cid) or D.get(cid) or {}).get('goldens',[])
    def casa(i):
        c=cands[i]; mm=(M if c['_src']=='M' else D).get(cid)
        return mm is not None and any(mm['conf'][gi][c['_col']]>0 for gi,g in enumerate(gs) if g.get('category') in CORE)
    gr=[]
    for g in (A.get(cid) or {}).get('grupos') or []:
        idx=[i for i in g.get('indices') or [] if isinstance(i,int) and 0<=i<len(cands)]
        if not idx: continue
        rep=g.get('representante') if g.get('representante') in idx else idx[0]
        labs={cands[i].get('producedBy','') for i in idx}
        nota=float(g.get('nota') or 0)
        gr.append({'rep':rep,'texto':cands[rep].get('suggestionContent',''),'nota':nota,
                   'f':{'nota':nota/100,'tam':min(len(idx),4)/4,'nag':min(len(labs),3)/3,'vies':1.0},
                   'y':1.0 if any(casa(i) for i in idx) else 0.0})
    dados[cid]=gr
FEATS=['nota','tam','nag','vies']
def fit(am,it=400,lr=0.5,reg=0.01):
    w={k:0.0 for k in FEATS}
    for _ in range(it):
        g={k:0.0 for k in FEATS}
        for f,y in am:
            z=sum(w[k]*f[k] for k in FEATS); p=1/(1+math.exp(-max(-30,min(30,z)))); e=p-y
            for k in FEATS: g[k]+=e*f[k]
        n=len(am) or 1
        for k in FEATS: w[k]-=lr*(g[k]/n+reg*w[k])
    return w
prob=lambda w,f: 1/(1+math.exp(-max(-30,min(30,sum(w[k]*f[k] for k in FEATS)))))
probs={}
for fora in dados:
    w=fit([(g['f'],g['y']) for c,gr in dados.items() if c!=fora for g in gr])
    probs[fora]=[prob(w,g['f']) for g in dados[fora]]
wall=fit([(g['f'],g['y']) for gr in dados.values() for g in gr])
cortes={}
for K in (3,4,5,6,7):
    cortes[f'nota-top{K}']={c:[g['texto'] for g in sorted(gr,key=lambda g:-g['nota'])[:K]] for c,gr in dados.items()}
for L in (0.15,0.22):
    cortes[f'formula-{L}']={c:[g['texto'] for g,p in zip(gr,probs[c]) if p>=L] for c,gr in dados.items()}
cortes['sem-corte']={c:[g['texto'] for g in gr] for c,gr in dados.items()}
os.makedirs('results/atribuidor/cortes',exist_ok=True)
for nome,cm in cortes.items():
    json.dump(cm,open(f'results/atribuidor/cortes/{suf}-{nome}.json','w'))
    print(f'{suf} {nome:<13} {sum(len(v) for v in cm.values()):>4} comentarios')
print('pesos (todos os PRs):',' '.join(f'{k}={v:+.2f}' for k,v in wall.items()),'· grupos',sum(len(g) for g in dados.values()))
