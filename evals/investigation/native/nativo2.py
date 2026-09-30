#!/usr/bin/env python3
# Sonnet 5.5 no Claude Code (headless, assinatura) revisando os 30 PRs do light, sem o nosso harness.
# Uso: nativo.py [--limit N] [--conc 3]
import json,os,subprocess,sys,glob,time,re,concurrent.futures as cf
H=os.path.expanduser('~'); B=f'{H}/kodus-ai-bench-1821/evals/investigation'; OUT=f'{H}/native'
os.makedirs(f'{OUT}/wt',exist_ok=True); os.makedirs(f'{OUT}/diffs',exist_ok=True)
args=sys.argv[1:]; MODO=args[args.index('--modo')+1] if '--modo' in args else 'base'; LIMIT=int(args[args.index('--limit')+1]) if '--limit' in args else 0; CONC=int(args[args.index('--conc')+1]) if '--conc' in args else 3
RES=f'{OUT}/res-'+MODO if MODO!='base' else f'{OUT}/res'
os.makedirs(RES,exist_ok=True)
PP=json.load(open(f'{OUT}/prompts-prod.json')) if MODO.startswith('n1') or MODO in ('n2','n3','n4','n5a','n5b','n6') else {}
L=json.load(open(f'{B}/light-30.json')); L=L[:LIMIT] if LIMIT else L
ds={}
for f in glob.glob(f'{B}/datasets/*.json'):
    v=json.load(open(f))[0]['vars']
    if v['caseId'] in L: ds[v['caseId']]=v
def repo_dir(full):
    for k in ('keycloak','grafana','cal.com','sentry','discourse'):
        if k in full.lower(): return f'{H}/projects/benchmark/{k}'
TOKEN=open(f'{H}/.claude-oauth').read().strip()
PROMPT="""You are reviewing a pull request in this repository. The working directory is checked out at the PR's head commit.

Title: {title}

Description:
{body}

The complete diff of the pull request (base...head) is in {diff}.

Review this pull request. Report the real bugs, security problems and performance problems that this change introduces or makes worse. Read the code you need with your tools.

When you are done, answer with only a JSON array inside a ```json fence, one object per issue:
[{{"file": "path/in/repo", "line": 123, "issue": "what is wrong and why it matters"}}]
If you find no issue, answer with an empty array."""
def um(c):
    v=ds[c]; rd=repo_dir(v['repositoryFullName']); head=v['benchmarkHeadRef']; base=v.get('benchmarkBaseRef')
    if not base: base=subprocess.run(['git','-C',rd,'rev-parse',f'{head}^'],capture_output=True,text=True).stdout.strip()
    wt=f'{OUT}/wt/{MODO}-{c}'; dfile=f'{OUT}/diffs/{c}.diff'; rf=f'{RES}/{c}.json'
    if os.path.exists(rf): return c,'ja feito'
    subprocess.run(['git','-C',rd,'worktree','remove','--force',wt],capture_output=True)
    r=subprocess.run(['git','-C',rd,'worktree','add','--detach',wt,head],capture_output=True,text=True)
    if r.returncode: return c,'worktree falhou: '+r.stderr[-200:]
    open(dfile,'w').write(subprocess.run(['git','-C',rd,'diff',f'{base}...{head}'],capture_output=True,text=True).stdout)
    p=PROMPT.format(title=v['prTitle'],body=(v.get('prBody') or '')[:4000],diff=dfile)
    extra=[]
    if MODO=='n1': p=PP[c]['user']
    MODO_BASE='n1h' if MODO in ('n3','n4','n5a','n5b','n6') else MODO
    if MODO_BASE in ('n1a','n1b','n1c','n1d','n1e','n1f','n1g','n1h'):
        u=PP[c]['user']
        def tira(tag, novo=''):
            i=u.find(f'  <{tag}>'); j=u.find(f'</{tag}>', i)
            assert i>=0 and j>i, (c, tag)
            return u[:i]+novo+u[j+len(f'</{tag}>'):]
        if MODO_BASE=='n1a': u=tira('CoverageContract')
        if MODO_BASE=='n1b': u=tira('Rules')
        if MODO_BASE=='n1c': u=tira('OutputFormat', """  <OutputFormat>
Answer with only a JSON array inside a ```json fence, one object per issue:
[{"file": "path/in/repo", "line": 123, "issue": "what is wrong and why it matters"}]
If you find no issue, answer with an empty array.
  </OutputFormat>""")
        if MODO_BASE in ('n1e','n1f','n1g','n1h'):
            i=u.find('  <OutputFormat>'); j=u.find('</OutputFormat>', i); bloco=u[i:j]
            linhas=bloco.split('\n')
            fora={'n1e':('"reasoning":',),'n1f':('"existingCode":','"improvedCode":'),'n1g':('"severity":','"confidence":')}.get(MODO_BASE,())
            if MODO_BASE=='n1h':
                raz=[l for l in linhas if l.strip().startswith('"reasoning":')][0]
                novo='  <OutputFormat>\n```json\n{\n'+raz+'\n  "suggestions": [\n    {\n      "relevantFile": "path/to/file.ext",\n      "relevantLinesStart": 10,\n      "suggestionContent": "what is wrong and why it matters"\n    }\n  ]\n}\n```\n  '
            else:
                assert all(any(l.strip().startswith(f) for l in linhas) for f in fora), (c, MODO)
                novo='\n'.join(l for l in linhas if not any(l.strip().startswith(f) for f in fora))
                novo=novo.replace(',\n    }','\n    }')
            u=u[:i]+novo+u[j:]
        if MODO_BASE=='n1d': u=tira('Diffs', f"  <Diffs>\nThe complete diff of the pull request (base...head) is in {dfile}.\n  </Diffs>")
        p=u
    if MODO=='n3': p=p+'\n\n'+PP[c]['coverage']
    if MODO=='n4': extra=['--system-prompt',PP[c]['system']]
    if MODO=='n6': extra=['--append-system-prompt',PP[c]['system']]
    if MODO in ('n5a','n5b'):
        CCP=json.load(open(f'{OUT}/cc-partes.json'))
        extra=['--system-prompt',CCP['A' if MODO=='n5a' else 'B']+'\n\n'+PP[c]['system']]
    if MODO=='n2': extra=['--append-system-prompt',PP[c]['system']]
    env={k:val for k,val in os.environ.items() if k not in ('ANTHROPIC_API_KEY',)}; env['CLAUDE_CODE_OAUTH_TOKEN']=TOKEN
    t0=time.time()
    r=subprocess.run(['claude','-p','--model','claude-sonnet-5-5','--output-format','json','--add-dir',f'{OUT}/diffs']+extra+[
                      '--allowedTools','Read','Grep','Glob','Bash(git diff:*)','Bash(git log:*)','Bash(git show:*)',
                      '--disallowedTools','Edit','Write','NotebookEdit','WebFetch','WebSearch'],
                     input=p,cwd=wt,env=env,capture_output=True,text=True,timeout=3600)
    txt=r.stdout; i=txt.find('{'); d={}
    try: d=json.loads(txt[i:])
    except Exception: d={'parse_cli':'falhou','stdout':txt[-2000:],'stderr':r.stderr[-2000:]}
    achados=None; res=d.get('result') or ''
    m=re.search(r'```(?:json)?\s*(\[.*?\]|\{.*\})\s*```',res,re.S)
    try:
        j=json.loads(m.group(1) if m else res)
        if isinstance(j,dict): j=[{'file':x.get('relevantFile'),'line':x.get('relevantLinesStart'),'issue':x.get('suggestionContent') or x.get('oneSentenceSummary')} for x in (j.get('suggestions') or [])]
        achados=j
    except Exception: achados=None
    json.dump({'caseId':c,'segundos':round(time.time()-t0),'is_error':d.get('is_error'),'num_turns':d.get('num_turns'),'custo_equivalente':d.get('total_cost_usd'),
               'usage':d.get('usage'),'modelos':list((d.get('modelUsage') or {}).keys()),'result':res,'achados':achados},open(rf,'w'))
    subprocess.run(['git','-C',rd,'worktree','remove','--force',wt],capture_output=True)
    return c,f"ok {round(time.time()-t0)}s turns={d.get('num_turns')} achados={None if achados is None else len(achados)} erro={d.get('is_error')}"
with open(f'{OUT}/status-{MODO}','a') as st: st.write(f"inicio {time.strftime('%H:%M')} casos={len(L)}\n")
with cf.ThreadPoolExecutor(CONC) as ex:
    for c,msg in ex.map(um,L):
        with open(f'{OUT}/status-{MODO}','a') as st: st.write(f'{c[:50]} {msg}\n')
with open(f'{OUT}/status-{MODO}','a') as st: st.write(f"END {time.strftime('%H:%M')}\n")
