#!/usr/bin/env python3
"""Tokens e tempo da rodada de 27/10 (#1821), por lado, modelo e etapa: media, p75 e p90 por PR.

  python3 uso.py <dir da rodada> <saida.json>   (le <dir>/<lado>/dump-<modelo>/*.raw.txt)

Etapas (stages do dump, eval-kit inStage):
  finder+verify  finder.generalist + finder.synthesis-rescue + finder.verify
  dedup, severity, enrichment (so o fluxo novo), formatter, repeat-drop
  total          o PR inteiro: tokens de todas as etapas; tempo de parede do caso
                 (prepare + sandbox + review), baselineUse.wallMs do submission.
Tokens: input fresco (input - cache read), cache read, output."""
import json, os, sys, glob, math
RODADA, SAIDA = sys.argv[1], sys.argv[2]
ETAPAS = {
    'finder+verify': ['finder.generalist', 'finder.synthesis-rescue', 'finder.verify'],
    'repeat-drop': ['repeat-drop'],
    'dedup': ['dedup'],
    'severity': ['severity'],
    'enrichment': ['enrichment'],
    'formatter': ['formatter'],
}

def pct(v, q):
    v = sorted(v); k = (len(v) - 1) * q; lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)

def resumo(v):
    return {'media': sum(v) / len(v), 'p75': pct(v, 0.75), 'p90': pct(v, 0.90)} if v else None

def uso(stages, nomes):
    s = [stages[n] for n in nomes if n in stages]
    if not s:
        return None
    inp = sum(x['in'] for x in s); cr = sum(x['cacheRead'] for x in s)
    return {'fresco': inp - cr, 'cacheRead': cr, 'output': sum(x['out'] for x in s), 'ms': sum(x['ms'] for x in s), 'calls': sum(x['calls'] for x in s)}

out = {}
for lado in ('prod', 'novo'):
    for d in sorted(glob.glob(f'{RODADA}/{lado}/dump-*')):
        mod = os.path.basename(d)[5:]
        wall = {}
        sub = f'{RODADA}/{lado}/{mod}.submission.json'
        if os.path.exists(sub):
            for r in json.load(open(sub)).get('results', []):
                if r.get('baselineUse'):
                    wall[r['caseId']] = r['baselineUse']['wallMs']
        porEtapa = {e: [] for e in ETAPAS}; total = []
        for f in sorted(glob.glob(f'{d}/*.raw.txt')):
            o = json.load(open(f)); st = o.get('stages') or {}
            for e, nomes in ETAPAS.items():
                u = uso(st, nomes)
                if u:
                    porEtapa[e].append(u)
            t = uso(st, [n for n in st if n not in ('agent-review',)])
            t['ms'] = wall.get(o['caseId'])
            total.append(t)
        linha = {}
        for e, L in list(porEtapa.items()) + [('total', total)]:
            if not L:
                continue
            linha[e] = {'prs': len(L), **{m: resumo([x[m] for x in L if x[m] is not None]) for m in ('fresco', 'cacheRead', 'output', 'ms')}}
        out[f'{lado}-{mod}'] = linha
        print(lado, mod, 'PRs', len(total), 'total p75 ms', round(linha['total']['ms']['p75']) if linha['total']['ms'] else None)
json.dump(out, open(SAIDA, 'w'), indent=1)
