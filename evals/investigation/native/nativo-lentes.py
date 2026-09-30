#!/usr/bin/env python3
# As 9 lentes como passadas do Sonnet no Claude Code (assinatura), system prompt padrao do CC, saida enxuta.
import json,os,subprocess,glob,time,re,concurrent.futures as cf
H=os.path.expanduser('~'); B=f'{H}/kodus-ai-bench-1821/evals/investigation'; OUT=f'{H}/native'
RES=f'{OUT}/res-lentes'; os.makedirs(RES,exist_ok=True)
LP=json.load(open(f'{OUT}/lentes-prompts.json')); TOKEN=open(f'{H}/.claude-oauth').read().strip()
ds={}
for f in glob.glob(f'{B}/datasets/*.json'):
    v=json.load(open(f))[0]['vars']; ds[v['caseId']]=v
def repo_dir(full):
    for k in ('keycloak','grafana','cal.com','sentry','discourse'):
        if k in full.lower(): return f'{H}/projects/benchmark/{k}'
def wt_de(c):
    v=ds[c]; rd=repo_dir(v['repositoryFullName']); wt=f'{OUT}/wt/ver-{c}'
    if not os.path.isdir(wt): subprocess.run(['git','-C',rd,'worktree','add','--detach',wt,v['benchmarkHeadRef']],capture_output=True)
    return wt
tarefas=[(c,lid) for c in LP for lid in LP[c]]
def um(t):
    c,lid=t; rf=f'{RES}/{c}__{lid}.json'
    if os.path.exists(rf): return
    env={x:y for x,y in os.environ.items() if x!='ANTHROPIC_API_KEY'}; env['CLAUDE_CODE_OAUTH_TOKEN']=TOKEN
    t0=time.time()
    r=subprocess.run(['claude','-p','--model','claude-sonnet-5-5','--output-format','json',
                      '--allowedTools','Read','Grep','Glob','Bash(git diff:*)','Bash(git log:*)','Bash(git show:*)',
                      '--disallowedTools','Edit','Write','NotebookEdit','WebFetch','WebSearch'],
                     input=LP[c][lid],cwd=wt_de(c),env=env,capture_output=True,text=True,timeout=3600)
    txt=r.stdout; i=txt.find('{'); d={}
    try: d=json.loads(txt[i:])
    except Exception: d={'stdout':txt[-1500:],'stderr':r.stderr[-1500:]}
    res=d.get('result') or ''; achados=None
    m=re.search(r'```(?:json)?\s*(\[.*?\])\s*```',res,re.S)
    try: achados=json.loads(m.group(1) if m else res)
    except Exception: achados=None
    json.dump({'caseId':c,'lente':lid,'segundos':round(time.time()-t0),'is_error':d.get('is_error'),'num_turns':d.get('num_turns'),'modelos':list((d.get('modelUsage') or {}).keys()),'result':res,'achados':achados},open(rf,'w'))
with open(f'{OUT}/status-lentes','w') as st: st.write(f"inicio {time.strftime('%H:%M')} tarefas={len(tarefas)}\n")
with cf.ThreadPoolExecutor(4) as ex: list(ex.map(um,tarefas))
with open(f'{OUT}/status-lentes','a') as st: st.write(f"END {time.strftime('%H:%M')}\n")
