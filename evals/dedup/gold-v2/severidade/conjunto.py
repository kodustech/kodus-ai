#!/usr/bin/env python3
"""Conjunto de avaliacao do prompt de severidade: o representante de cada grupo que
sobrevive ao fluxo padrao (dedup -> verify C -> nit protegido), com a severidade
rotulada e o recorte do head (+-10 linhas, '+' = linha alterada pelo PR, '>' = citada).
O recorte fica fora do repo: grava em <saida>.
  python3 conjunto.py <saida.json>"""
import json, os, sys, subprocess, re
G = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DS = os.path.join(G, '..', '..', 'investigation', 'datasets')
B = os.path.expanduser('~/projects/benchmark')
ESPEC = {'micro-exp-p3-' + x for x in ('value-boundary-and-position', 'contract-not-followed', 'says-one-thing-does-another', 'invalid-state-and-concurrency', 'changed-files-disagree')}
CFG = {  # modelo -> conjunto -> (prefixo das sugestoes, verify C, nit)
    'deepseek-v4.1-flash': {'light': ('09.10.26', 'aluc-h1t10f', 'nit-v3d-so1b'), 'holdout': ('ho', 'aluc-ho-h1t10f', 'ho-nit-v3d-so1')},
    'gpt-6.1-sol': {'light': ('09.10.26', 'aluc-h1t10f', 'nit-v3d-so1b'), 'holdout': ('ho', 'aluc-ho-h1t10f', 'ho-nit-v3d-so1')},
    'sonnet-5.5': {'light': ('09.10.26', 'aluc-h1t10f', 'nit-v3d-so1'), 'holdout': ('ho', 'aluc-ho-h1t10f', 'ho-nit-v3d-so1')},
    'muse-spark-1.3': {'light': ('m13l', 'aluc-m13l-h1t10f', 'm13l-nit-v3d-so1'), 'holdout': ('m13h', 'aluc-m13h-h1t10f', 'm13h-nit-v3d-so1')},
}
IDX = {}
for f in os.listdir(DS):
    if not f.endswith('.json'): continue
    try: v = json.load(open(os.path.join(DS, f)))[0]['vars']
    except Exception: continue
    fm = json.loads(v.get('fullDiffMeta') or '{}')
    nome = next((r for r in ('cal.com', 'discourse', 'grafana', 'keycloak', 'sentry') if r in v['repositoryFullName'].split('/')[1]), None)
    if not nome: continue
    IDX[v['caseId']] = (nome, v.get('benchmarkBaseRef') or fm.get('base'), v.get('benchmarkHeadRef') or fm.get('head'))
git = lambda d, *a: subprocess.run(['git', '-C', d, *a], capture_output=True, text=True)
cache = {}
def arquivo(cid, path):
    repo, base, head = IDX[cid]; d = f'{B}/{repo}'
    if (cid, path) in cache: return cache[(cid, path)]
    if path and ('/' not in path or git(d, 'cat-file', '-e', f'{head}:{path}').returncode):
        nomes = git(d, 'diff', '--name-only', f'{base}...{head}').stdout.split()
        cand = [n for n in nomes if n.endswith('/' + path.split('/')[-1]) or n == path]
        if not cand: cand = [n for n in git(d, 'ls-tree', '-r', '--name-only', head).stdout.split() if n.endswith('/' + path.lstrip('/'))]
        if len(cand) == 1: path = cand[0]
    r = git(d, 'show', f'{head}:{path}')
    txt = r.stdout.split('\n') if r.returncode == 0 else None
    alt = set()
    if txt is not None:
        for m in re.finditer(r'^@@ -\S+ \+(\d+)(?:,(\d+))? @@', git(d, 'diff', '-U0', f'{base}...{head}', '--', path).stdout, re.M):
            s = int(m.group(1)); n = int(m.group(2)) if m.group(2) is not None else 1
            alt.update(range(s, s + n))
    cache[(cid, path)] = (txt, alt); return txt, alt
def recorte(cid, s):
    txt, alt = arquivo(cid, s.get('relevantFile') or '')
    a = s.get('relevantLinesStart'); e = s.get('relevantLinesEnd') or a
    if txt is None: return ''
    if not a: return ''
    lo, hi = max(1, a - 10), min(len(txt), e + 10)
    return '\n'.join(f"{'+' if i in alt else ' '}{'>' if a <= i <= e else ' '}{i:5d}| {txt[i-1]}" for i in range(lo, hi + 1))
out = []
for m, conjs in CFG.items():
    gold = json.load(open(os.path.join(G, 'severidade', f'{m}.json')))['prs']
    for conj, (pref, c, nit) in conjs.items():
        sug = json.load(open(os.path.join(G, f'{pref}_{m}.json')))['prs']
        C = json.load(open(os.path.join(G, 'verify', 'resultados', c, f'{m}.json')))['prs']
        NIT = json.load(open(os.path.join(G, 'verify', 'resultados', nit, f'{m}.json')))['prs']
        for cid, p in C.items():
            S = {s['id']: s for s in sug[cid]['suggestions']}
            nt = {g['rep']: g for g in NIT.get(cid, {}).get('grupos', [])}
            for g in p.get('grupos', []):
                if g.get('nit'): continue
                n = nt.get(g['rep'])
                if n and n.get('nit') and not any(S[x]['producedBy'] in ESPEC for x in g['membros']): continue
                s = S[g['rep']]
                out.append({'model': m, 'conjunto': conj, 'caseId': cid, 'id': s['id'], 'file': s.get('relevantFile'),
                            'lines': [s.get('relevantLinesStart'), s.get('relevantLinesEnd')], 'label': s.get('label'),
                            'texto': s['suggestionContent'], 'recorte': recorte(cid, s), 'gold': gold[cid][s['id']]['severidade']})
json.dump(out, open(sys.argv[1], 'w'), indent=1)
import collections
for m in CFG:
    xs = [x for x in out if x['model'] == m]
    print(m, len(xs), dict(collections.Counter(x['gold'] for x in xs)), 'sem recorte', sum(not x['recorte'] for x in xs))
