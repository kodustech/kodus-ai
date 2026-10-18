#!/usr/bin/env python3
"""Junta, por PR, os comentarios novos dos 4 modelos (novo para o Opus e o Astra nas duas passadas)
para agrupar em problemas entre modelos.  ->  pool/juiz-in.json (sugestoes com id <chave>:<S>, sem issues)"""
import json, os, glob
AQUI = os.path.dirname(os.path.abspath(__file__))
ent = {}
for k in ('ds', 'gpt', 'opus', 'sonnet'):
    W = f'{AQUI}/{k}/fp'
    IN = json.load(open(f'{W}/juiz-in.json'))
    op = json.load(open(f'{W}/opus-out0.json'))
    ast = {}
    for f in glob.glob(f'{W}/astra/*.json'):
        d = json.load(open(f)); ast[d['caseId']] = {x['id']: x for x in d['items']}
    for c, p in IN.items():
        o = {x['id']: x for x in op[c]}
        for s in p['sugestoes']:
            om, am = o[s['id']]['match'], ast[c][s['id']]['match']
            if om != 'new':  # o Opus decide; divergencia so registrada
                continue
            e = ent.setdefault(c, {**{x: p[x] for x in ('repo', 'head', 'base')}, 'sugestoes': [], 'issues': []})
            e['sugestoes'].append({**s, 'id': f'{k}:{s["id"]}'})
os.makedirs(f'{AQUI}/pool', exist_ok=True)
json.dump(ent, open(f'{AQUI}/pool/juiz-in.json', 'w'), indent=1)
print('PRs', len(ent), 'comentarios novos', sum(len(v['sugestoes']) for v in ent.values()))
