import json,sys
# fila da 2a etapa: topo 3 + o que a 1a etapa manteve fora do topo (protecao 1)
fila,ver,out=sys.argv[1],sys.argv[2],sys.argv[3]
Q=json.load(open(fila)); V=json.load(open(ver))['prs']; Q2={}
for c,reps in Q.items():
    d=lambda r:V[c]['decisoes'].get(str(r),{}).get('v1')
    Q2[c]=reps[:3]+[r for r in reps[3:] if not (d(r) and d(r)['keep']==False and d(r)['leuCitado'])]
json.dump(Q2,open(out,'w')); print(out, sum(len(v)-min(3,len(v)) for v in Q2.values()), 'sugestões fora do topo seguem para a 2ª etapa')
