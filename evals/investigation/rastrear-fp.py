#!/usr/bin/env python3
"""Para cada falso positivo: o codigo que o revisor viu, e o codigo de hoje.

Squash merge reescreve o commit, entao `merge-base --is-ancestor` nao diz se o
PR entrou. O que responde a pergunta e outra coisa: o defeito descrito ainda
esta la no main de hoje?
"""
import json, subprocess, os, sys, re
DIR={'calcom/cal.com':'cal.com','getsentry/sentry':'sentry','keycloak/keycloak':'keycloak',
     'grafana/grafana':'grafana','discourse/discourse':'discourse',
     'ai-code-review-evaluation/sentry-greptile':'sentry'}
ROOT=os.path.expanduser('~/projects/benchmark')
def g(d,*a,timeout=60):
    try:
        r=subprocess.run(['git','-C',d]+list(a),capture_output=True,text=True,timeout=timeout)
        return r.stdout if r.returncode==0 else ''
    except Exception: return ''
def trecho(txt, l0, l1, folga=8):
    if not txt: return ''
    ls=txt.split('\n'); a=max(0,(l0 or 1)-1-folga); b=min(len(ls),(l1 or l0 or 1)+folga)
    return '\n'.join(f'{i+1:5d} {ls[i]}' for i in range(a,b))
top=json.load(open('results/top31-fp.json'))
ini=int(sys.argv[1]) if len(sys.argv)>1 else 0
fim=int(sys.argv[2]) if len(sys.argv)>2 else len(top)
for n,x in enumerate(top[ini:fim], ini+1):
    d=os.path.join(ROOT, DIR.get(x['repo'],''))
    br=g(d,'symbolic-ref','--short','refs/remotes/origin/HEAD').strip()
    main=br.split('/')[-1] if br else 'main'
    arq=x['arquivo']; head=str(x['head'])
    antes=g(d,'show',f'{head}:{arq}')
    agora=g(d,'show',f'origin/{main}:{arq}')
    print('='*100)
    print(f"[{n}] p={x['p']:.3f}  {x['repo']}  agentes={x['nag']}  sev={x['sev']}  {x['agente']}")
    print(f"    {arq}:{x['l0']}-{x['l1']}")
    print(f"    ACHADO: {x['resumo']}")
    print(f"    RACIOCINIO: {x['reason'][:400]}")
    if not antes: print('    !! arquivo nao existe no head do PR'); continue
    print(f"\n--- CODIGO NO PR (o que o revisor viu) ---\n{trecho(antes,x['l0'],x['l1'])}")
    if not agora:
        print(f"\n--- HOJE em origin/{main} ---\n    ARQUIVO REMOVIDO/RENOMEADO")
        continue
    # acha a regiao correspondente hoje: ancora pela primeira linha nao-trivial do trecho
    ls=antes.split('\n'); idx=(x['l0'] or 1)-1
    ancora=''
    for i in range(max(0,idx-2), min(len(ls), idx+6)):
        s=ls[i].strip()
        if len(s)>12 and not s.startswith(('//','#','*','/*')): ancora=s; break
    hoje=agora.split('\n'); pos=-1
    if ancora:
        for i,l in enumerate(hoje):
            if l.strip()==ancora: pos=i+1; break
        if pos<0:
            chave=re.sub(r'\s+',' ',ancora)[:40]
            for i,l in enumerate(hoje):
                if chave in re.sub(r'\s+',' ',l): pos=i+1; break
    if pos>0:
        print(f"\n--- HOJE em origin/{main} (mesma ancora, linha {pos}) ---\n{trecho(agora,pos,pos)}")
    else:
        print(f"\n--- HOJE em origin/{main} ---\n    ANCORA SUMIU (codigo reescrito). primeiras linhas do arquivo hoje:\n{trecho(agora,1,12,0)}")
