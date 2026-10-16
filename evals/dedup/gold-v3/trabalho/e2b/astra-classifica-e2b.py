"""(e2b) Astra classifica os problemas novos da rodada GPT+E2B com o repositorio no head (worktree), cego ao Opus.
  python3 astra/roda.py [--par=2] [--pausa=30]"""
import json,subprocess,os,tempfile,time,sys,threading
W=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
arg=lambda n,d: next((a.split('=',1)[1] for a in sys.argv[1:] if a.startswith(f'--{n}=')),d)
PAR=int(arg('par','2')); PAUSA=int(arg('pausa','30'))
RUB=open(f'{W}/classif/RUBRICA.md').read()
SCHEMA={"type":"object","additionalProperties":False,"required":["items"],"properties":{"items":{"type":"array","items":{"type":"object","additionalProperties":False,
 "required":["issueId","class","subclass","reason","severity"],"properties":{"issueId":{"type":"string"},"class":{"type":"string","enum":["TP","FP"]},
 "subclass":{"type":"string","enum":["nit","hallucination","none"]},"reason":{"type":"string"},"severity":{"type":"string","enum":["low","medium","high","critical","none"]}}}}}}
SEVR=open('/Users/juniorsartori/Projects/Kody/kodus-ai/evals/dedup/gold-v2/severidade/rubrica.md').read()
prs=json.load(open(f'{W}/e2b/classif-in.json'))
fila=sorted(prs); lock=threading.Lock(); log=open(f'{W}/e2b/astra-classif/astra.log','a')
def um(cid):
    out=f'{W}/e2b/astra-classif/{cid}.json'
    if os.path.exists(out): return
    p=prs[cid]; wt=f'{W}/e2b/astra-classif/wt_{abs(hash(cid))%10**8}'
    subprocess.run(['git','-C',p['repo'],'worktree','add','--detach',wt,p['head']],check=True,capture_output=True)
    try:
        blocos=[]
        for it in p['issues']:
            cs='\n'.join(f"  [{c['gid']}] {c['file']}:{(c['lines'] or ['?'])[0]}-{(c['lines'] or ['?','?'])[-1]}\n  {c['texto'].strip()}" for c in it['comentarios'])
            gs='\n'.join(f'  - {g}' for g in it['goldens'])
            blocos.append(f"<issue id=\"{it['issueId']}\" needSeverity=\"{str(it['precisaSeveridade']).lower()}\">\nReview comments (same problem):\n{cs or '  (none)'}\nKnown-issue texts:\n{gs or '  (none)'}\n</issue>")
        prompt=f"""{RUB.replace('/Users/juniorsartori/Projects/Kody/kodus-ai/evals/dedup/gold-v2/severidade/rubrica.md','the severity rubric below')}

Severity rubric:
{SEVR}

You are in a checkout of the repository at the head commit of the pull request "{p['prTitle']}". The base commit is {p['base']}; use read-only commands (git diff {p['base']}...HEAD, git show, git grep, reading files). Check every issue below in the code and classify it. Return one item per issue id. subclass "none" means no subclass. Give severity only when needSeverity is true, otherwise "none". In reason, cite the decisive file:line evidence in 2-3 sentences.

{chr(10).join(blocos)}"""
        tmp=tempfile.mkdtemp(); json.dump(SCHEMA,open(f'{tmp}/s.json','w'))
        ids={it['issueId'] for it in p['issues']}
        for t in range(4):
            r=subprocess.run(['codex','exec','--skip-git-repo-check','--sandbox','read-only','-m','gpt-6-astra','-c','model_reasoning_effort=high','-C',wt,'--output-schema',f'{tmp}/s.json','-o',f'{tmp}/o.json','-'],input=prompt,text=True,capture_output=True)
            ok=r.returncode==0 and os.path.exists(f'{tmp}/o.json')
            if ok:
                d=json.load(open(f'{tmp}/o.json')); got={x['issueId'] for x in d['items']}
                if ids<=got:
                    json.dump({'caseId':cid,'items':[x for x in d['items'] if x['issueId'] in ids]},open(out,'w'),indent=1)
                    with lock: log.write(f"{time.strftime('%H:%M:%S')} ok {cid} {len(ids)}\n"); log.flush()
                    break
                err=f'faltaram {ids-got}'
            else: err=r.stderr[-300:]
            with lock: log.write(f"{time.strftime('%H:%M:%S')} falha {t} {cid} {err}\n"); log.flush()
            time.sleep(60 if '429' in err else 10)
    finally:
        subprocess.run(['git','-C',p['repo'],'worktree','remove','--force',wt],capture_output=True)
    time.sleep(PAUSA)
i=0
def worker():
    global i
    while True:
        with lock:
            if i>=len(fila): return
            cid=fila[i]; i+=1
        um(cid)
ts=[threading.Thread(target=worker) for _ in range(PAR)]
[t.start() for t in ts]; [t.join() for t in ts]
print('feitos',len([f for f in os.listdir(f'{W}/astra') if f.endswith('.json')]),'de',len(fila))
