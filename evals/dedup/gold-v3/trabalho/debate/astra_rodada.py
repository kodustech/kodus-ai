"""Turno do Astra: para cada PR com debate aberto cuja ultima fala e do Opus, uma chamada com worktree.
  python3 astra_rodada.py <rodada: 1|2|3> [--par=2]"""
import json,subprocess,os,tempfile,time,sys,threading
W=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R=sys.argv[1]; PAR=int(next((a.split('=')[1] for a in sys.argv if a.startswith('--par=')),'2'))
OUT=f'{W}/debate/astra_r{R}'; os.makedirs(OUT,exist_ok=True)
S=json.load(open(f'{W}/debate/estado.json')); REP=json.load(open(f'{W}/repos.json'))
RUB=open(f'{W}/classif/RUBRICA.md').read()
REGRAS="""Two rulings both reviewers apply:
- Code that the pull request only moves or re-indents without changing its logic counts as pre-existing: a defect in it is FP (no subclass).
- A known-issue text that describes code this pull request does not touch at all is FP (no subclass), not a hallucination."""
SCHEMA={"type":"object","additionalProperties":False,"required":["items"],"properties":{"items":{"type":"array","items":{"type":"object","additionalProperties":False,
 "required":["issueId","class","subclass","severity","reply"],"properties":{"issueId":{"type":"string"},"class":{"type":"string","enum":["TP","FP"]},
 "subclass":{"type":"string","enum":["nit","hallucination","none"]},"severity":{"type":"string","enum":["low","medium","high","critical","none"]},"reply":{"type":"string"}}}}}}
por={}
for k,v in S.items():
    if not v.get('fechado') and v['hist'][-1]['who']=='opus': por.setdefault(v['caseId'],[]).append(k)
fila=sorted(por); lock=threading.Lock(); i=0
def fala(h): return f"[{'You' if h['who']=='astra' else 'Other reviewer'}] {h['class']}{'/'+h['subclass'] if h['subclass']!='none' else ''}{' severity '+h['severity'] if h['severity']!='none' else ''}\n{h['text']}"
def um(cid):
    if os.path.exists(f'{OUT}/{cid}.json'): return
    p=REP[cid]; wt=f'{W}/debate/wt_{abs(hash(cid))%10**8}'
    subprocess.run(['git','-C',p['repo'],'worktree','add','--detach',wt,p['head']],check=True,capture_output=True)
    try:
        blocos=[]
        for k in por[cid]:
            v=S[k]; it=v['issue']
            cs='\n'.join(f"  [{c['gid']}] {c['file']}:{(c['lines'] or ['?'])[0]}\n  {c['texto'].strip()}" for c in it['comentarios'])
            gs='\n'.join(f'  - {g}' for g in it['goldens'])
            blocos.append(f"<issue id=\"{k}\" needSeverity=\"{str(v['precisaSeveridade']).lower()}\">\nReview comments:\n{cs or '  (none)'}\nKnown-issue texts:\n{gs or '  (none)'}\n<discussion>\n"+'\n\n'.join(fala(h) for h in v['hist'])+"\n</discussion>\n</issue>")
        prompt=f"""{RUB}

{REGRAS}

You are in a checkout of the repository at the pull request head (base {p['base']}; use read-only git and file reads). You classified each issue below earlier, and another reviewer who reads the same repository disagrees. Read their argument and the code they cite, check the code again, and give your classification now. Keep it if you still think it is right and say why in at most five sentences; change it if their evidence shows you were wrong. Give severity only when needSeverity is true, else "none". Return one item per issue id.

{chr(10).join(blocos)}"""
        tmp=tempfile.mkdtemp(); json.dump(SCHEMA,open(f'{tmp}/s.json','w')); ids=set(por[cid])
        for t in range(4):
            r=subprocess.run(['codex','exec','--skip-git-repo-check','--sandbox','read-only','-m','gpt-6-astra','-c','model_reasoning_effort=high','-C',wt,'--output-schema',f'{tmp}/s.json','-o',f'{tmp}/o.json','-'],input=prompt,text=True,capture_output=True)
            if r.returncode==0 and os.path.exists(f'{tmp}/o.json'):
                d=json.load(open(f'{tmp}/o.json'))
                if ids<={x['issueId'] for x in d['items']}:
                    json.dump({'caseId':cid,'items':[x for x in d['items'] if x['issueId'] in ids]},open(f'{OUT}/{cid}.json','w'),indent=1); print('ok',cid,len(ids),flush=True); break
            print('falha',t,cid,r.stderr[-200:],flush=True); time.sleep(60 if '429' in r.stderr else 10)
    finally:
        subprocess.run(['git','-C',p['repo'],'worktree','remove','--force',wt],capture_output=True)
    time.sleep(20)
def worker():
    global i
    while True:
        with lock:
            if i>=len(fila): return
            cid=fila[i]; i+=1
        um(cid)
ts=[threading.Thread(target=worker) for _ in range(PAR)]; [t.start() for t in ts]; [t.join() for t in ts]
print('rodada',R,'PRs',len(fila))
