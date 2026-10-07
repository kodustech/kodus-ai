import json,sys
# placar de cadeia: fila65 -> 1a etapa (protecao 1) -> 2a etapa (protecao 1 ou painel P1/P2)
fus,fila,v1,v2,tipo=sys.argv[1:6]
F=json.load(open(fus))['prs'];Q=json.load(open(fila));V1=json.load(open(v1))['prs']
V2=json.load(open(v2))['prs'] if v2!='-' else None
confs={c:{it['rep']:it['confs'] for it in F[c]['itens']} for c in Q}
def cai(V,c,r):
    d=V.get(c,{}).get('decisoes',{}).get(str(r),{}).get('v1')
    return bool(d and d['keep']==False and d['leuCitado'])
def cai2(c,r):
    if V2 is None: return False
    if tipo=='painel':
        s=V2.get(c,{}).get('sinais',{}).get(str(r))
        return bool(s and (not s['p1Matches'] or s['p2Prevented']))
    return cai(V2,c,r)
gold=fp=n=0
for c,reps in Q.items():
    sel=reps[:3]+[r for r in reps[3:] if not cai(V1,c,r) and not cai2(c,r)]
    n+=len(sel);venc=set()
    ng=len(next(iter(confs[c].values()))) if confs[c] else 0
    for gi in range(ng):
        b,q=0,None
        for r in sel:
            if confs[c][r][gi]>b:b,q=confs[c][r][gi],r
        if q is not None:gold+=1;venc.add(q)
    fp+=len(sel)-len(venc)
print(f'{tipo:8} coment {n:3}  goldens {gold:3}  recall {gold/111:.1%}  precisao {gold/(gold+fp):.1%}')
