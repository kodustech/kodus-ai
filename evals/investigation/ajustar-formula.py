#!/usr/bin/env python3
"""
Ajusta a formula de corte sobre os GRUPOS do atribuidor e mede recall/precisao
com a regra da metrica (tp = golden coberto; grupo que nao cobre nenhum = fp).

O ajuste e leave-one-out POR PR: o PR avaliado nunca entra no fit dos pesos.
Sem isso, 29 PRs e 9 pesos decoram o conjunto e o numero nao vale nada.
"""
import json, math, os, sys, re

AQUI = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(AQUI, 'results')
# Pool de candidatos pre-reducer. POOL_ROOT aponta para outro lugar se preciso.
S = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))
CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
SEV = {'low':0.25,'medium':0.5,'high':0.75,'critical':1.0}

def pool_filtrado(dump='sol-teto2'):
    """indices sobreviventes do filtro de contrato, na ordem de preFilterCandidates."""
    out = {}
    for f in sorted(os.listdir(os.path.join(S, dump))):
        if not f.endswith('.raw.txt'): continue
        j = json.load(open(os.path.join(S, dump, f)))
        cands = (j.get('trace') or {}).get('preFilterCandidates') or []
        keep = [i for i,c in enumerate(cands)
                if str(c.get('severity','')).lower() in SEV and c.get('reason')]
        out[j['caseId']] = (cands, keep)
    return out

SEL = os.environ.get('REP_SELETOR', 'seletor-vA-teto2-filtrado.json')
VER = os.environ.get('REP_VERACIDADE', 'score2-sol-teto2.json')

def carregar():
    mat = {}
    for f in ['matriz-pre-teto2-30.json','matriz-pre-teto2-grandes.json']:
        mat.update(json.load(open(os.path.join(R,f))))
    sel = json.load(open(os.path.join(R, SEL)))['saida']
    pool = pool_filtrado()
    return mat, sel, pool

def score2(nome):
    p = os.path.join(R, nome)
    if not os.path.exists(p): return None
    return json.load(open(p))['saida']

def montar(extras=(), sem_agentes=()):
    """Devolve por PR: lista de grupos com features e rotulo de golden coberto."""
    mat, sel, pool = carregar()
    ver = score2(VER) or {}
    # REP_EXTRA="nome=arquivo.json,nome2=outro.json"
    mapa = dict(kv.split('=', 1) for kv in os.environ.get('REP_EXTRA', '').split(',') if '=' in kv)
    tabelas = {n: (score2(mapa.get(n, f'score2{n}-sol-teto2.json')) or {}) for n in extras}
    dados = {}
    for cid, v in sel.items():
        if cid not in mat: continue
        cands, keep = pool[cid]
        if len(keep) != v['candidatos']:
            print(f'  ! {cid}: filtro {len(keep)} != seletor {v["candidatos"]}', file=sys.stderr)
            continue
        conf = mat[cid]['conf']                     # [golden][candidato-do-pool-inteiro]
        gs   = mat[cid]['goldens']
        core_g = [gi for gi,g in enumerate(gs) if g.get('category') in CORE]
        # dono de cada golden entre os candidatos filtrados
        dono = {}
        for gi in range(len(gs)):
            melhor, quem = 0, -1
            for pos, ci in enumerate(keep):
                c = conf[gi][ci] if ci < len(conf[gi]) else 0
                if c > melhor: melhor, quem = c, pos
            if quem >= 0: dono[gi] = quem
        grupos = []
        for g in v['grupos']:
            idx = g['indices']
            membros = [cands[keep[i]] for i in idx if i < len(keep)]
            if not membros: continue
            agentes = {m.get('producedBy') for m in membros}
            if sem_agentes and agentes <= set(sem_agentes): continue
            rep = g.get('representante', idx[0])
            # as tabelas de 2o escore sao indexadas pelo indice ORIGINAL do
            # candidato; `representante` e indice no pool JA filtrado.
            orig = keep[rep] if rep < len(keep) else rep
            nota = (g.get('nota') or 0)/100.0
            vv = ver.get(cid, {}).get(str(orig))
            vv = (vv if vv is not None else 50)/100.0
            f = {
                'nota': nota, 'ver': vv, 'prod': nota*vv,
                'conf': max((m.get('confidence') or 0) for m in membros)/100.0,
                'tam': min(len(idx),4)/4.0,
                'sev': max(SEV.get(str(m.get('severity','')).lower(),0.5) for m in membros),
                'nag': min(len(agentes),3)/3.0,
                'vies': 1.0,
            }
            for n in extras:
                x = tabelas[n].get(cid, {}).get(str(orig))
                f[n] = (x if x is not None else 50)/100.0
            cobre = [gi for gi,pos in dono.items() if pos in idx]
            grupos.append({'f': f, 'rep': rep, 'orig': orig, 'cobre': cobre,
                           'core': [gi for gi in cobre if gi in core_g]})
        dados[cid] = {'grupos': grupos, 'core_goldens': len(core_g)}
    return dados

def fit(amostras, feats, it=300, lr=0.5, reg=0.01):
    w = {k:0.0 for k in feats}
    for _ in range(it):
        gr = {k:0.0 for k in feats}
        for f,y in amostras:
            z = sum(w[k]*f.get(k,0.0) for k in feats)
            p = 1/(1+math.exp(-max(-30,min(30,z))))
            e = p-y
            for k in feats: gr[k] += e*f.get(k,0.0)
        n = len(amostras) or 1
        for k in feats: w[k] -= lr*(gr[k]/n + reg*w[k])
    return w

def prob(w,f):
    z = sum(w[k]*f.get(k,0.0) for k in w)
    return 1/(1+math.exp(-max(-30,min(30,z))))

def avaliar(dados, feats, cortes):
    prs = list(dados)
    # leave-one-out por PR
    probs = {}
    for fora in prs:
        am = [(g['f'], 1.0 if g['core'] else 0.0)
              for c in prs if c != fora for g in dados[c]['grupos']]
        w = fit(am, feats)
        probs[fora] = [prob(w,g['f']) for g in dados[fora]['grupos']]
    # AUC global
    pos = [p for c in prs for p,g in zip(probs[c],dados[c]['grupos']) if g['core']]
    neg = [p for c in prs for p,g in zip(probs[c],dados[c]['grupos']) if not g['core']]
    auc = sum((1 if a>b else 0.5 if a==b else 0) for a in pos for b in neg)/max(1,len(pos)*len(neg))
    linhas = []
    for corte in cortes:
        tp=fp=0; total_g=0
        for c in prs:
            total_g += dados[c]['core_goldens']
            cob=set()
            for p,g in zip(probs[c],dados[c]['grupos']):
                if p < corte: continue
                if g['core']: cob.update(g['core'])
                elif not g['cobre']: fp+=1
            tp += len(cob)
        rec = tp/max(1,total_g); pre = tp/max(1,tp+fp)
        f1 = 2*rec*pre/max(1e-9,rec+pre); f2 = 5*rec*pre/max(1e-9,4*pre+rec)
        linhas.append((corte,tp,fp,rec,pre,f1,f2))
    return auc, linhas, probs

if __name__ == '__main__':
    extras = [a.split('=')[1] for a in sys.argv[1:] if a.startswith('--extra=')]
    extras = [e for x in extras for e in x.split(',') if e]
    sem = [a.split('=')[1] for a in sys.argv[1:] if a.startswith('--sem=')]
    sem = [e for x in sem for e in x.split(',') if e]
    dados = montar(extras, sem)
    feats = ['nota','ver','prod','conf','tam','sev','nag','vies'] + extras
    auc, linhas, _ = avaliar(dados, feats, [0.10,0.14,0.18,0.22,0.26,0.30,0.35,0.40])
    print(f'features: {",".join(feats)}   AUC(LOO) {auc:.3f}   PRs {len(dados)}')
    print(f'{"corte":>6} {"tp":>4} {"fp":>4} {"recall":>8} {"precis":>8} {"F1":>6} {"F2":>6}')
    for c,tp,fp,r,p,f1,f2 in linhas:
        print(f'{c:6.2f} {tp:4d} {fp:4d} {r:8.1%} {p:8.1%} {f1:6.3f} {f2:6.3f}')
