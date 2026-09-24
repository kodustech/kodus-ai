#!/usr/bin/env python3
"""Viabilidade de testar cada achado isoladamente, ASSUMINDO que o template do
sandbox tem Go, Java, Ruby, Node e Python instalados.

A pergunta deixa de ser linguagem e passa a ser: a funcao que contem as linhas
citadas depende de coisa DO PROJETO (import interno, framework, ORM) ou so de
biblioteca padrao e valores locais? So a segunda da para testar com um driver
sem instalar as dependencias do repositorio.
"""
import json, os, re, subprocess, glob, importlib.util
AQUI=os.path.dirname(os.path.abspath(__file__))
s=importlib.util.spec_from_file_location('af',os.path.join(AQUI,'ajustar-formula.py'))
A=importlib.util.module_from_spec(s); s.loader.exec_module(A)
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
def no_head(cid, arq):
    m=meta.get(cid)
    if not m or not m.get('head'): return None
    d=os.path.join(ROOT, DIR.get(m['repo'],''))
    try:
        r=subprocess.run(['git','-C',d,'show',f"{m['head']}:{arq}"],capture_output=True,text=True,timeout=30)
        return r.stdout if r.returncode==0 else None
    except Exception: return None
# imports que sao DO PROJETO (nao stdlib) por linguagem
INTERNO={
 'py':  re.compile(r'^\s*(from|import)\s+(sentry|calcom|discourse|\.)', re.M),
 'go':  re.compile(r'"(github\.com/grafana|github\.com/getsentry)[^"]*"'),
 'java':re.compile(r'^\s*import\s+(org\.keycloak|com\.)', re.M),
 'rb':  re.compile(r'^\s*(require_relative|require\s+[\'"](?!json|set|uri|date|time|digest|base64|securerandom|stringio|ostruct))', re.M),
 'ts':  re.compile(r'from\s+[\'"](@calcom|@grafana|\.\./|\./)'),
}
INTERNO['tsx']=INTERNO['ts']; INTERNO['js']=INTERNO['ts']; INTERNO['es6']=INTERNO['ts']
PESADO=re.compile(r'\b(prisma|sqlalchemy|django|ActiveRecord|\.objects\.|queryset|session\.|db\.|redis|kafka|http\.|requests\.|axios|fetch\(|Autowired|@Inject|@Entity|EntityManager|gorm|sql\.DB)\b', re.I)
def funcao(txt, linha, ext):
    ls=txt.split('\n'); i=min(max(0,linha-1), len(ls)-1)
    if ext=='py':
        ini=i
        while ini>0 and not re.match(r'\s*(async\s+)?def\s', ls[ini]): ini-=1
        if not re.match(r'\s*(async\s+)?def\s', ls[ini]): return None
        ind=len(ls[ini])-len(ls[ini].lstrip()); fim=ini+1
        while fim<len(ls) and (not ls[fim].strip() or (len(ls[fim])-len(ls[fim].lstrip()))>ind): fim+=1
        return '\n'.join(ls[ini:fim])
    pad={'go':r'^func\s','java':r'^\s+(public|private|protected).*\(','rb':r'^\s*def\s'}.get(ext, r'(function\s|=>\s*\{|^\s*(export\s+)?(async\s+)?(function|const)\s)')
    ini=i
    while ini>0 and not re.search(pad, ls[ini]): ini-=1
    return '\n'.join(ls[max(0,ini):min(len(ls), ini+70)])
if __name__=='__main__':
    DROP={'micro-scale-and-blocking','micro-repeated-work','micro-resource-and-growth'}
    pool=A.pool_filtrado(); sel=json.load(open(os.path.join(AQUI,'results','rep-seletor.json')))['saida']
    d=A.montar([],list(DROP))
    cat={'TESTAVEL ISOLADO':[], 'depende de import do projeto':[], 'depende de infra/ORM/framework':[],
         'arquivo nao e codigo':[], 'sem codigo / extensao desconhecida':[]}
    porlang={}
    for cid in d:
        cands,keep=pool[cid]; vivos=[]
        for g in sel[cid]['grupos']:
            ms=[cands[keep[i]] for i in g['indices'] if i<len(keep)]
            if not ms or {m.get('producedBy') for m in ms} <= DROP: continue
            vivos.append(ms)
        for g,ms in zip(d[cid]['grupos'], vivos):
            m=ms[0]; arq=str(m.get('relevantFile') or ''); ext=arq.rsplit('.',1)[-1].lower() if '.' in arq else ''
            reg=(cid,arq,m.get('relevantLinesStart'),bool(g['core']),ext)
            if ext in ('properties','json','yaml','yml','scss','erb','ftl','md','lock'):
                cat['arquivo nao e codigo'].append(reg); continue
            if ext not in INTERNO: cat['sem codigo / extensao desconhecida'].append(reg); continue
            txt=no_head(cid, arq)
            if not txt: cat['sem codigo / extensao desconhecida'].append(reg); continue
            fn=funcao(txt, int(m.get('relevantLinesStart') or 1), ext) or str(m.get('existingCode') or '')
            if PESADO.search(fn): cat['depende de infra/ORM/framework'].append(reg)
            elif INTERNO[ext].search(txt) and re.search(r'\b[A-Z][a-zA-Z]{3,}\b', fn):
                cat['depende de import do projeto'].append(reg)
            else:
                cat['TESTAVEL ISOLADO'].append(reg)
                porlang[ext]=porlang.get(ext,0)+1
    tot=sum(len(v) for v in cat.values())
    print(f'{"categoria":38s} {"grupos":>7} {"share":>7} {"goldens":>8}')
    for k,v in sorted(cat.items(), key=lambda x:-len(x[1])):
        print(f'{k:38s} {len(v):7d} {len(v)/tot:7.0%} {sum(1 for x in v if x[3]):8d}')
    print(f'{"TOTAL":38s} {tot:7d}')
    print(f'\ntestaveis por linguagem: {porlang}')
    t=cat['TESTAVEL ISOLADO']
    print(f'\nDOS TESTAVEIS: {sum(1 for x in t if x[3])} cobrem golden, {sum(1 for x in t if not x[3])} sao FP')
    print(f'arquivos de teste entre eles: {sum(1 for x in t if re.search(r"(^|/)(test|spec)", x[1], re.I))}')
    json.dump({k:[list(x) for x in v] for k,v in cat.items()}, open(os.path.join(AQUI,'results','viabilidade2.json'),'w'), indent=1)
