#!/usr/bin/env python3
"""#1821, teste 5: filtros deterministicos antes do verify, sobre a fila de 65%.
A: comentario fora do diff e sem ligacao no grafo (CALLS/USES_TYPE/IMPORTS/IMPLEMENTS,
   nos dois sentidos) com o codigo alterado -> sai. Sem grafo para o trecho -> fica.
B: comentario em arquivo de teste (no do grafo com is_test, ou caminho de teste).
Conta quantos comentarios cada filtro tiraria e quantos deles venciam golden."""
import json, glob, re, sys, collections
MOD = [('DeepSeek','results/correcao/ds-fila65.json','results/dedup-meta/t9-v5-fresco.json','01.10.26_f1_deepseek_together'),
 ('GPT','results/correcao/gpt-fila65.json','results/dedup-meta/gpt61-r1-v5.json','01.10.26_f2_gpt61_sub'),
 ('Sonnet','results/correcao/sonnet55-fila65.json','results/meio/sonnet55-v5.json','01.10.26_f2_sonnet55_sdk'),
 ('Opus','results/meio/opus55-fila65.json','results/meio/opus55-v5.json','01.10.26_f2_opus55_cc'),
 ('Muse','results/etapa3/muse-fila65.json','results/dedup-meta/muse-r1-v5.json','01.10.26_f2_muse'),
 ('Kimi','results/etapa3/kimi3-fila65.json','results/dedup-meta/kimi3-r1-v5.json','01.10.26_f1_kimi3_together'),
 ('GLM','results/etapa3/glm53-fila65.json','results/dedup-meta/glm53-r1-v5.json','01.10.26_f2_glm53_together')]
LIGA = {'CALLS','USES_TYPE','IMPORTS','IMPLEMENTS'}
CONTEINER = {'Class','Interface','File','Module'}
TESTE = re.compile(r'(^|/)(tests?|__tests__|spec|specs)(/|$)|[._-](test|spec)\.[a-z]+$|_test\.(go|py)$|(^|/)test_[^/]+\.py$|Test\.java$', re.I)
norm = lambda p: str(p or '').replace('\\','/').lstrip('./')

V = {}
for f in glob.glob('datasets/*.json'):
    try: x = json.load(open(f))[0]['vars']
    except Exception: continue
    if x.get('caseId'): V[x['caseId']] = x

def contexto(c):
    x = V[c]; arr = x.get('changedFilesFull') or []; arr = json.loads(arr) if isinstance(arr, str) else arr
    hunks, mud = collections.defaultdict(list), collections.defaultdict(set)
    for fl in arr:
        fn = norm(fl['filename'])
        for ln in (fl.get('patchWithLinesStr') or '').split('\n'):
            m = re.match(r'@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', ln)
            if m:
                a = int(m.group(1)); n = int(m.group(2) or 1); hunks[fn].append((a, a + max(n, 1) - 1))
                if n == 0: mud[fn].add(a)
                continue
            m = re.match(r'\s*(\d+) \+', ln)
            if m: mud[fn].add(int(m.group(1)))
            elif re.match(r'\s*-', ln) and hunks[fn]: mud[fn].add(hunks[fn][-1][0])
    g = x.get('callGraphJson'); g = json.loads(g) if isinstance(g, str) else (g or {'nodes': [], 'edges': []})
    nos = [n for n in g['nodes'] if n.get('kind') not in CONTEINER]
    viz = collections.defaultdict(set)
    for e in g['edges']:
        if e.get('kind') in LIGA: viz[e['source_qualified']].add(e['target_qualified']); viz[e['target_qualified']].add(e['source_qualified'])
    alterados = {n['qualified_name'] for n in nos if any(n['line_start'] <= l <= n['line_end'] for l in mud.get(norm(n['file_path']), ()))}
    testes = {norm(n['file_path']) for n in g['nodes'] if n.get('is_test')}
    return hunks, nos, viz, alterados, testes

def mesmo(a, b): a, b = norm(a), norm(b); return a == b or a.endswith('/' + b) or b.endswith('/' + a)

def classifica(c, cand, ctx, saltos):
    hunks, nos, viz, alterados, testes = ctx
    arq = norm(cand.get('relevantFile')); ci = int(cand.get('relevantLinesStart') or 0); cf = int(cand.get('relevantLinesEnd') or ci or 0)
    teste = bool(TESTE.search(arq)) or any(mesmo(arq, t) for t in testes)
    noDiff = any(mesmo(arq, f) and a <= cf and b >= ci for f, hs in hunks.items() for a, b in hs)
    if noDiff: return 'no-diff', teste
    meus = [n for n in nos if mesmo(n['file_path'], arq) and n['line_start'] <= cf and n['line_end'] >= ci]
    if not meus: return 'sem-grafo', teste
    fronteira = {n['qualified_name'] for n in meus}
    if fronteira & alterados: return 'ligado', teste
    vistos = set(fronteira)
    for _ in range(saltos):
        fronteira = {w for q in fronteira for w in viz.get(q, ())} - vistos
        if fronteira & alterados: return 'ligado', teste
        vistos |= fronteira
    return 'solto', teste

def vencedores(sel, conf):
    ng = len(next(iter(conf.values()))) if conf else 0; venc = set(); g = 0
    for gi in range(ng):
        b, q = 0, None
        for r in sel:
            if conf[r][gi] > b: b, q = conf[r][gi], r
        if q is not None: g += 1; venc.add(q)
    return g, venc

for saltos in (1, 2):
    print(f'\n### Filtro A com {saltos} passo(s) no grafo; filtro B = arquivo de teste')
    print('| modelo | fila | A tira | A: venciam golden | B tira | B: venciam golden | recall fila → A+B | precisão fila → A+B |')
    print('|---|---|---|---|---|---|---|---|')
    for nome, fq, ff, pool in MOD:
        Q = json.load(open(fq)); F = json.load(open(ff))['prs']
        n = ta = tb = ga = gb = 0; G0 = G1 = FP0 = FP1 = 0; motivos = collections.Counter()
        for c, reps in Q.items():
            cs = json.load(open(f'pools/{pool}-heavysv/{c}.raw.txt'))['trace']['preFilterCandidates']
            conf = {it['rep']: it['confs'] for it in F[c]['itens']}; ctx = contexto(c)
            g0, venc0 = vencedores(reps, conf); G0 += g0; FP0 += len(reps) - len(venc0)
            fica = []
            for r in reps:
                k, t = classifica(c, cs[r], ctx, saltos); motivos[k] += 1; n += 1
                if k == 'solto': ta += 1; ga += r in venc0
                if t: tb += 1; gb += r in venc0
                if k != 'solto' and not t: fica.append(r)
            g1, venc1 = vencedores(fica, conf); G1 += g1; FP1 += len(fica) - len(venc1)
        print(f'| {nome} | {n} | {ta} | {ga} | {tb} | {gb} | {G0} → {G1} | {G0/(G0+FP0):.1%} → {G1/(G1+FP1):.1%} |')
        if saltos == 1: print(f'|  | motivos: {dict(motivos)} | | | | | | |')
