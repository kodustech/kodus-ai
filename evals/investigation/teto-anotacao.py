#!/usr/bin/env python3
"""Quanto o proprio gabarito concorda consigo mesmo entre v001 e v002.

Se duas anotacoes dos MESMOS PRs discordam em X%, nenhum modelo pode concordar
com uma delas muito acima de (1-X). Esse e o teto de Bayes da metrica, e ele
diz se 57%/40% e fracasso nosso ou saturacao da regua.

Usa o mesmo judge da metrica para casar comentario com comentario.
"""
import json, os, sys, asyncio
AQUI=os.path.dirname(os.path.abspath(__file__))
v1=json.load(open(os.path.join(AQUI,'../benchmark-sets/v001/goldens.json')))
v2=json.load(open(os.path.join(AQUI,'../benchmark-sets/v002/goldens.json')))
def idx(v):
    o={}
    for p in v['prs']:
        o[p['caseId']]=[c['comment'] if isinstance(c,dict) else str(c) for c in (p.get('comments') or [])]
    return o
A=idx(v1); B=idx(v2)
comuns=sorted(set(A)&set(B))
print(f'v001: {len(A)} PRs, {sum(len(x) for x in A.values())} comentarios')
print(f'v002: {len(B)} PRs, {sum(len(x) for x in B.values())} comentarios')
print(f'PRs em comum: {len(comuns)}')
na=sum(len(A[c]) for c in comuns); nb=sum(len(B[c]) for c in comuns)
print(f'comentarios nos PRs comuns: v001 {na}, v002 {nb}\n')
# casamento exato por texto, primeiro (barato)
ex=0
for c in comuns:
    sa={' '.join(x.split()).lower() for x in A[c]}
    sb={' '.join(x.split()).lower() for x in B[c]}
    ex+=len(sa&sb)
print(f'casamento EXATO de texto: {ex}  ({ex/max(1,na):.0%} do v001, {ex/max(1,nb):.0%} do v002)')
print(f'-> {na-ex} comentarios do v001 sem par exato no v002')
