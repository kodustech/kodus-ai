#!/usr/bin/env python3
"""Compara duas rodadas (com e sem grafo) na regra da metrica, varrendo a cota.

Os grupos vem da trace do reducer quando ela existe (rodada no fluxo) e dos
artefatos offline quando nao (as rodadas anteriores ao reducer estar no fluxo).
Nos dois casos a formula e o corte sao os mesmos.
"""
import json, glob, math, sys, os

CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
SEV = {'low':.25,'medium':.5,'high':.75,'critical':1.0}
W = {'nota':0.8021,'ver':-0.9322,'prod':1.064,'conf':-0.0787,'tam':1.0001,
     'sev':-0.797,'nag':0.7929,'vies':-1.2458}
FRACOS = {'micro-scale-and-blocking','micro-repeated-work','micro-resource-and-growth'}
R = lambda f: json.load(open(os.path.join('results', f)))

def prob(f):
    z = sum(W[k]*f.get(k,0) for k in W)
    return 1/(1+math.exp(-max(-30,min(30,z))))

def dono_dos_goldens(gs, conf, keep):
    d = {}
    for gi in range(len(gs)):
        melhor, quem = 0, -1
        for pos, ci in enumerate(keep):
            x = conf[gi][ci] if ci < len(conf[gi]) else 0
            if x > melhor: melhor, quem = x, pos
        if quem >= 0: d[gi] = quem
    return d

def da_trace(pools, matrizes):
    """Grupos como o fluxo os produziu: probabilidade ja calculada dentro da run."""
    out = {}
    MAT = {}
    for m in matrizes: MAT.update(R(m))
    for pool in pools:
        for f in glob.glob(f'pools/{pool}/*.raw.txt'):
            j = json.load(open(f)); cid = j['caseId']; t = j['trace']
            if cid not in MAT: continue
            cands = t.get('preFilterCandidates') or []
            keep = [i for i,x in enumerate(cands)
                    if str(x.get('severity','')).lower() in SEV and x.get('reason')]
            gs, conf = MAT[cid]['goldens'], MAT[cid]['conf']
            coreG = [i for i,g in enumerate(gs) if g.get('category') in CORE]
            dono = dono_dos_goldens(gs, conf, keep)
            gr = []
            for g in (((t.get('dedup') or {}).get('reducer') or {}).get('groups') or []):
                idx = g.get('indices') or []
                cobre = [gi for gi,pos in dono.items() if pos in idx]
                gr.append({'p': g['probability'], 'cobre': cobre,
                           'core': [gi for gi in cobre if gi in coreG]})
            out[cid] = {'g': gr, 'core': len(coreG)}
    return out

def do_offline(pool, seletores, veracidades, matrizes, tirar_fracos=True):
    """Grupos dos artefatos offline, para rodadas anteriores ao reducer no fluxo."""
    SEL, VER, MAT = {}, {}, {}
    for s in seletores: SEL.update(R(s)['saida'])
    for v in veracidades: VER.update(R(v)['saida'])
    for m in matrizes: MAT.update(R(m))
    out = {}
    for f in glob.glob(f'pools/{pool}/*.raw.txt'):
        j = json.load(open(f)); cid = j['caseId']
        cands = j['trace'].get('preFilterCandidates') or []
        keep = [i for i,x in enumerate(cands)
                if str(x.get('severity','')).lower() in SEV and x.get('reason')]
        v, m = SEL.get(cid), MAT.get(cid)
        if not v or not m or len(keep) != v['candidatos']: continue
        gs, conf = m['goldens'], m['conf']
        coreG = [i for i,g in enumerate(gs) if g.get('category') in CORE]
        dono = dono_dos_goldens(gs, conf, keep)
        gr = []
        for g in v['grupos']:
            idx = [i for i in g['indices'] if i < len(keep)]
            if tirar_fracos:
                idx = [i for i in idx if cands[keep[i]].get('producedBy') not in FRACOS]
            if not idx: continue
            membros = [cands[keep[i]] for i in idx]
            rep = g['representante'] if g['representante'] in idx else idx[0]
            nota = (g.get('nota') or 0)/100
            vv = VER.get(cid, {}).get(str(keep[rep]))
            vv = (vv if vv is not None else 50)/100
            ags = {x.get('producedBy') for x in membros}
            fe = {'nota':nota,'ver':vv,'prod':nota*vv,
                  'conf':max((x.get('confidence') or 0) for x in membros)/100,
                  'tam':min(len(idx),4)/4,
                  'sev':max(SEV.get(str(x.get('severity','')).lower(),.5) for x in membros),
                  'nag':min(len(ags),3)/3,'vies':1.0}
            cobre = [gi for gi,pos in dono.items() if pos in idx]
            gr.append({'p':prob(fe),'cobre':cobre,'core':[gi for gi in cobre if gi in coreG]})
        out[cid] = {'g': gr, 'core': len(coreG)}
    return out

def medir(d, prs, K, lim=0.22):
    tp=fp=tot=n=0
    for cid in prs:
        x = d[cid]; tot += x['core']; cob = set()
        for g in sorted(x['g'], key=lambda y:-y['p'])[:K]:
            if g['p'] < lim: continue
            n += 1
            if g['core']: cob.update(g['core'])
            elif not g['cobre']: fp += 1
        tp += len(cob)
    r = tp/max(1,tot); p = tp/max(1,tp+fp)
    return dict(tp=tp, fp=fp, r=r, p=p,
                f1=2*r*p/max(1e-9,r+p), f2=5*r*p/max(1e-9,4*p+r), cpr=n/len(prs))

def tabela(titulo, sem, com):
    prs = sorted(set(sem) & set(com))
    print(f'\n{titulo}  —  {len(prs)} PRs em comum')
    print(f"{'cota':>5} │ {'SEM GRAFO':^33} │ {'COM GRAFO':^33} │ {'ΔF1':>7}")
    print(f"{'':>5} │ {'recall':>7} {'precis':>7} {'F1':>7} {'F2':>7} │ {'recall':>7} {'precis':>7} {'F1':>7} {'F2':>7} │")
    print('─'*95)
    for K in (3,4,5,6,7):
        a, b = medir(sem, prs, K), medir(com, prs, K)
        print(f"{K:>5} │ {a['r']*100:>6.1f}% {a['p']*100:>6.1f}% {a['f1']:>7.3f} {a['f2']:>7.3f} │ "
              f"{b['r']*100:>6.1f}% {b['p']*100:>6.1f}% {b['f1']:>7.3f} {b['f2']:>7.3f} │ {b['f1']-a['f1']:>+7.3f}")
    a, b = medir(sem, prs, 7), medir(com, prs, 7)
    print('─'*95)
    print(f"cota 7: tp {a['tp']}→{b['tp']} · fp {a['fp']}→{b['fp']} · comentarios/PR {a['cpr']:.1f}→{b['cpr']:.1f}")
