#!/usr/bin/env python3
"""Quantos achados sao TESTAVEIS isoladamente num sandbox sem install.

Nao e opiniao: para cada achado das linguagens que o sandbox roda, extrai a
funcao que contem as linhas citadas, no commit do PR, e conta de quantas coisas
de fora ela depende. Funcao que so mexe em valor local da para testar com um
driver. Funcao que chama banco, rede, ORM ou framework nao da — quem escreve o
stub decide o resultado.
"""
import json, os, re, subprocess, glob, sys
AQUI=os.path.dirname(os.path.abspath(__file__))
import importlib.util
s=importlib.util.spec_from_file_location('af',os.path.join(AQUI,'ajustar-formula.py'))
A=importlib.util.module_from_spec(s); s.loader.exec_module(A)
DIR={'calcom/cal.com':'cal.com','getsentry/sentry':'sentry','keycloak/keycloak':'keycloak',
     'grafana/grafana':'grafana','discourse/discourse':'discourse',
     'ai-code-review-evaluation/sentry-greptile':'sentry'}
ROOT=os.path.expanduser('~/projects/benchmark')
RODA={'python','javascript'}          # sandbox: python 3.11 + node 20, sem install
TRANSP={'typescript','typescript react','typescript (react)'}
# marcadores de dependencia que nao da para stubar honestamente
PESADO=re.compile(r'\b(prisma|sqlalchemy|django|models\.|session\.|db\.|await\s+fetch|requests\.|axios|http|client\.|redis|kafka|boto3|orm|queryset|\.objects\.|transaction|connection)\b', re.I)
FRAMEWORK=re.compile(r'\b(app\.|router\.|express|flask|fastapi|react|useState|useEffect|Component|decorator|@app|@router)\b', re.I)

meta={}
for f in glob.glob(os.path.join(AQUI,'datasets','*.json')):
    try:
        v=json.load(open(f))[0]['vars']
        meta[v['caseId']]={'repo':v.get('repositoryFullName'),'head':v.get('benchmarkHeadRef')}
    except Exception: pass

def arquivo_no_head(cid, arq):
    m=meta.get(cid)
    if not m or not m.get('head'): return None
    d=os.path.join(ROOT, DIR.get(m['repo'],''))
    try:
        r=subprocess.run(['git','-C',d,'show',f"{m['head']}:{arq}"],capture_output=True,text=True,timeout=30)
        return r.stdout if r.returncode==0 else None
    except Exception: return None

def funcao_em_volta(txt, linha, lang):
    """devolve o corpo da funcao que contem `linha` (1-indexed), grosseiro mas suficiente"""
    ls=txt.split('\n'); i=min(max(0,linha-1), len(ls)-1)
    if lang=='python':
        ini=i
        while ini>0 and not re.match(r'\s*(def|async def)\s', ls[ini]): ini-=1
        if not re.match(r'\s*(def|async def)\s', ls[ini]): return None
        ind=len(ls[ini])-len(ls[ini].lstrip())
        fim=ini+1
        while fim<len(ls) and (not ls[fim].strip() or (len(ls[fim])-len(ls[fim].lstrip()))>ind): fim+=1
        return '\n'.join(ls[ini:fim])
    else:
        ini=i
        while ini>0 and not re.search(r'(function\s|=>\s*\{|^\s*(export\s+)?(async\s+)?(function|const|let)\s)', ls[ini]): ini-=1
        return '\n'.join(ls[max(0,ini):min(len(ls), ini+80)])

if __name__=='__main__':
    DROP={'micro-scale-and-blocking','micro-repeated-work','micro-resource-and-growth'}
    pool=A.pool_filtrado(); sel=json.load(open(os.path.join(AQUI,'results','rep-seletor.json')))['saida']
    d=A.montar([],list(DROP))
    cat={'nao roda: linguagem':[], 'typescript (precisa transpile)':[], 'sem codigo no head':[],
         'roda mas depende de infra':[], 'roda mas depende de framework':[], 'TESTAVEL ISOLADO':[]}
    for cid in d:
        cands,keep=pool[cid]; vivos=[]
        for g in sel[cid]['grupos']:
            ms=[cands[keep[i]] for i in g['indices'] if i<len(keep)]
            if not ms or {m.get('producedBy') for m in ms} <= DROP: continue
            vivos.append(ms)
        for g,ms in zip(d[cid]['grupos'], vivos):
            m=ms[0]; L=str(m.get('language') or '').lower()
            reg=(cid, m.get('relevantFile'), m.get('relevantLinesStart'), bool(g['core']))
            if L in TRANSP: cat['typescript (precisa transpile)'].append(reg); continue
            if L not in RODA: cat['nao roda: linguagem'].append(reg); continue
            txt=arquivo_no_head(cid, m.get('relevantFile'))
            if not txt: cat['sem codigo no head'].append(reg); continue
            fn=funcao_em_volta(txt, int(m.get('relevantLinesStart') or 1), L)
            corpo=fn or str(m.get('existingCode') or '')
            if PESADO.search(corpo): cat['roda mas depende de infra'].append(reg)
            elif FRAMEWORK.search(corpo): cat['roda mas depende de framework'].append(reg)
            else: cat['TESTAVEL ISOLADO'].append(reg)
    tot=sum(len(v) for v in cat.values())
    print(f'{"categoria":36s} {"grupos":>7} {"share":>7} {"cobrem golden":>14}')
    for k in ['nao roda: linguagem','typescript (precisa transpile)','sem codigo no head',
              'roda mas depende de infra','roda mas depende de framework','TESTAVEL ISOLADO']:
        v=cat[k]; gv=sum(1 for x in v if x[3])
        print(f'{k:36s} {len(v):7d} {len(v)/tot:7.0%} {gv:14d}')
    print(f'{"TOTAL":36s} {tot:7d}')
    print('\nos testaveis isolados:')
    for cid,arq,l,venceu in cat['TESTAVEL ISOLADO']:
        print(f'   {"GOLDEN" if venceu else "  fp  "}  {str(arq)[-58:]}:{l}')
    json.dump({k:[list(x) for x in v] for k,v in cat.items()},
              open(os.path.join(AQUI,'results','viabilidade-sandbox.json'),'w'), indent=1)
