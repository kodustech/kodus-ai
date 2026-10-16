"""Juiz Astra: casa cada sugestao de uma rodada nova com os TPs do gold v3 do PR (ou 'new'),
com o repositorio no head (worktree). Tudo que nao casar com um TP e FP.
  python3 evals/dedup/gold-v3/trabalho/juiz-astra.py --dir=<pasta em trabalho/> [--par=2]
Entrada: <dir>/juiz-in.json; regra: loc/REGRA-juiz.md; saida: <dir>/astra/<caseId>.json"""
import json, subprocess, os, tempfile, time, sys, threading
T = os.path.dirname(os.path.abspath(__file__))
arg = lambda n, d: next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith(f'--{n}=')), d)
W = os.path.join(T, arg('dir', 'loc'))
PAR = int(arg('par', '2'))
REGRA = open(f'{T}/loc/REGRA-juiz.md').read()
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {"type": "array", "items": {"type": "object", "additionalProperties": False,
          "required": ["id", "match", "newGroup", "reason"], "properties": {"id": {"type": "string"}, "match": {"type": "string"}, "newGroup": {"type": ["string", "null"]}, "reason": {"type": "string"}}}}}}
IN = json.load(open(f'{W}/juiz-in.json'))
os.makedirs(f'{W}/astra', exist_ok=True)
fila = sorted(IN); lock = threading.Lock(); log = open(f'{W}/astra/astra.log', 'a')

def bloco(p):
    iss = []
    for it in p['issues']:
        cs = '\n'.join(f"    - {c['file']}:{c['lines'][0]}-{c['lines'][1]}: {c['texto'].strip()}" for c in it['comentarios'])
        iss.append(f"<issue id=\"{it['issueId']}\">\n  Description: {it['descricao']}\n" + (f"  Known-issue text: {it['textoGolden']}\n" if it['textoGolden'] else '') + (f"  Comments that reported it:\n{cs}\n" if cs else '') + '</issue>')
    novos = [f"<comment id=\"{s['id']}\" at=\"{s['file']}:{s['lines'][0]}-{s['lines'][1]}\">\n{s['texto'].strip()}\n</comment>" for s in p['sugestoes']]
    return '\n'.join(iss), '\n'.join(novos)

def um(cid):
    out = f'{W}/astra/{cid}.json'
    if os.path.exists(out): return
    p = IN[cid]
    if not p['sugestoes']:
        json.dump({'caseId': cid, 'items': []}, open(out, 'w')); return
    wt = f'{W}/astra/wt_{abs(hash(cid)) % 10**8}'
    subprocess.run(['git', '-C', p['repo'], 'worktree', 'add', '--detach', wt, p['head']], check=True, capture_output=True)
    try:
        iss, novos = bloco(p)
        prompt = f"""{REGRA}

You are in a checkout of the repository at the head commit of the pull request. The base commit is {p['base']}; use read-only commands (git diff {p['base']}...HEAD, git show, git grep, reading files).

Real problems (golden-set issues) of this pull request:
{iss}

New comments:
{novos}

Return one item per new comment id."""
        tmp = tempfile.mkdtemp(); json.dump(SCHEMA, open(f'{tmp}/s.json', 'w'))
        ids = {s['id'] for s in p['sugestoes']}; validos = {i['issueId'] for i in p['issues']} | {'new'}
        for t in range(4):
            r = subprocess.run(['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', '-C', wt, '--output-schema', f'{tmp}/s.json', '-o', f'{tmp}/o.json', '-'], input=prompt, text=True, capture_output=True)
            if r.returncode == 0 and os.path.exists(f'{tmp}/o.json'):
                d = json.load(open(f'{tmp}/o.json')); got = {x['id'] for x in d['items']}
                ruins = [x['match'] for x in d['items'] if x['match'] not in validos]
                if ids <= got and not ruins:
                    json.dump({'caseId': cid, 'items': [x for x in d['items'] if x['id'] in ids]}, open(out, 'w'), indent=1)
                    with lock: log.write(f"{time.strftime('%H:%M:%S')} ok {cid} {len(ids)}\n"); log.flush()
                    break
                err = f'faltaram {ids - got} invalidos {ruins}'
            else:
                err = r.stderr[-300:]
            with lock: log.write(f"{time.strftime('%H:%M:%S')} falha {t} {cid} {err}\n"); log.flush()
            time.sleep(60 if '429' in err else 10)
    finally:
        subprocess.run(['git', '-C', p['repo'], 'worktree', 'remove', '--force', wt], capture_output=True)

i = 0
def worker():
    global i
    while True:
        with lock:
            if i >= len(fila): return
            cid = fila[i]; i += 1
        um(cid)
ts = [threading.Thread(target=worker) for _ in range(PAR)]
[t.start() for t in ts]; [t.join() for t in ts]
print('ok', len([f for f in os.listdir(f'{W}/astra') if f.endswith('.json')]))
