#!/usr/bin/env python3
"""Idade das linhas citadas, via git blame no commit do PR.

A intuicao: uma linha escrita POR este PR e outra coisa de uma linha que esta
la ha tres anos. O segundo caso e o defeito pre-existente que o revisor nao
comenta porque nao e sobre esta mudanca. E a mesma pergunta do score de escopo,
so que mecanica e exata em vez de perguntada ao modelo.
"""
import json, os, subprocess, sys, glob
from datetime import datetime
AQUI=os.path.dirname(os.path.abspath(__file__))
DIR={'calcom/cal.com':'cal.com','getsentry/sentry':'sentry','keycloak/keycloak':'keycloak',
     'grafana/grafana':'grafana','discourse/discourse':'discourse',
     'ai-code-review-evaluation/sentry-greptile':'sentry'}
ROOT=os.path.expanduser('~/projects/benchmark')
meta={}
for f in glob.glob(os.path.join(AQUI,'datasets','*.json')):
    try:
        v=json.load(open(f))[0]['vars']
        meta[v['caseId']]={'repo':v.get('repositoryFullName'),'head':v.get('benchmarkHeadRef')}
    except Exception: pass

def blame(cid, arquivo, l0, l1):
    m=meta.get(cid)
    if not m or not m.get('head'): return None
    d=os.path.join(ROOT, DIR.get(m['repo'],''))
    if not os.path.isdir(d): return None
    a=max(1,int(l0 or 1)); b=max(a,int(l1 or a))
    try:
        r=subprocess.run(['git','-C',d,'blame','-l','--line-porcelain',
                          f'-L{a},{b}', m['head'], '--', arquivo],
                         capture_output=True, text=True, timeout=45)
        if r.returncode!=0: return None
    except Exception: return None
    tempos=[]; shas=[]
    for ln in r.stdout.split('\n'):
        if ln.startswith('author-time '): tempos.append(int(ln.split()[1]))
        elif len(ln)>=40 and all(c in '0123456789abcdef' for c in ln[:40]) and ' ' in ln:
            shas.append(ln[:40])
    if not tempos: return None
    # data do commit do PR, para medir idade relativa
    try:
        rr=subprocess.run(['git','-C',d,'show','-s','--format=%ct',m['head']],
                          capture_output=True,text=True,timeout=20)
        agora=int(rr.stdout.strip())
    except Exception:
        agora=max(tempos)
    dias=[max(0,(agora-t)/86400.0) for t in tempos]
    # linha "do proprio PR": autorada no head ou muito perto dele
    dopr=sum(1 for t in tempos if agora-t < 86400*2)/len(tempos)
    return {'n':len(dias), 'mediana':sorted(dias)[len(dias)//2], 'max':max(dias),
            'min':min(dias), 'dopr':dopr, 'nshas':len(set(shas))}

if __name__=='__main__':
    import importlib.util
    s=importlib.util.spec_from_file_location('af',os.path.join(AQUI,'ajustar-formula.py'))
    A=importlib.util.module_from_spec(s); s.loader.exec_module(A)
    DROP={'micro-scale-and-blocking','micro-repeated-work','micro-resource-and-growth'}
    pool=A.pool_filtrado(); sel=json.load(open(os.path.join(AQUI,'results','rep-seletor.json')))['saida']
    d=A.montar([],list(DROP))
    out={}; ok=0; falha=0
    for cid in d:
        cands,keep=pool[cid]; vivos=[]
        for g in sel[cid]['grupos']:
            ms=[cands[keep[i]] for i in g['indices'] if i<len(keep)]
            if not ms or {m.get('producedBy') for m in ms} <= DROP: continue
            vivos.append(ms)
        for g,ms in zip(d[cid]['grupos'], vivos):
            m=ms[0]
            b=blame(cid, m.get('relevantFile'), m.get('relevantLinesStart'), m.get('relevantLinesEnd'))
            if b: ok+=1
            else: falha+=1
            out.setdefault(cid,{})[str(g['orig'])]=b
        print(f'  {cid[:50]:52s} ok={ok} falha={falha}', file=sys.stderr)
    json.dump(out, open(os.path.join(AQUI,'results','blame-sol-teto2.json'),'w'), indent=1)
    print(f'\n{ok} com blame, {falha} sem', file=sys.stderr)
