#!/usr/bin/env python3
"""Fase 1 do #1821: uma rodada superset por modelo, lida por tecnica e por corte.

  python3 analisar-fase1.py <rodada>

Tecnicas: G (generalista), S (synthesis-rescue, depois do G), M1 (9 lentes x 1
passo + grafo), M3 (9 lentes x <=3 passos). Tudo PRE-reducer, regra da Martian
(por golden vence o candidato de maior confianca do judge; candidato que nao
vence nenhum golden e FP).

Por tecnica: goldens, exclusivos, candidatos, tokens (fresco, cache, output),
tempo, custo do verificador sobre os achados dela, e goldens que o verificador
derrubou. Por corte: recall, candidatos/PR, FP, tokens e latencia (o ramo mais
lento: G->S em serie, M1 e M3 em paralelo com ele).
"""
import json, glob, os, sys, collections

AQUI = os.path.dirname(os.path.abspath(__file__))
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}
run = sys.argv[1]
POOL = os.path.join(AQUI, 'pools', run)
M = json.load(open(os.path.join(AQUI, 'results', f'matriz-{run}.json')))
D_PATH = os.path.join(AQUI, 'results', f'matriz-descartados-{run}.json')
D = json.load(open(D_PATH)) if os.path.exists(D_PATH) else {}
L30 = json.load(open(os.path.join(AQUI, 'light-30.json')))


def tec(label):
    if label == 'generalist-base': return 'G'
    if label == 'synthesis-rescue': return 'S'
    if label.startswith('micro-exp-p1g-'): return 'M1'
    if label.startswith('micro-exp-p3-'): return 'M3'
    return '?'


# ---------- goldens por tecnica (mantidos e derrubados pelo verificador) ----------
total = sum(1 for c in L30 for g in (M.get(c) or {}).get('goldens', []) if g.get('category') in CORE)


def pontua(m, keep):
    venc, cand, fp = set(), 0, 0
    for cid in L30:
        mm = m.get(cid)
        if not mm: continue
        idx = [j for j, c in enumerate(mm['candidatos']) if keep(tec(c.get('producedBy') or ''))]
        cand += len(idx); ganhou = set()
        for i, g in enumerate(mm['goldens']):
            if g.get('category') not in CORE: continue
            b, q = 0, None
            for j in idx:
                if mm['conf'][i][j] > b: b, q = mm['conf'][i][j], j
            if q is not None: venc.add((cid, i)); ganhou.add(q)
        fp += len(idx) - len(ganhou)
    return venc, cand, fp


# ---------- tokens, tempo e verificador por tecnica ----------
tok = collections.defaultdict(lambda: collections.Counter())
tempos = collections.defaultdict(list)  # por PR: duracao do ramo
ver = collections.defaultdict(lambda: collections.Counter())
ramo_pr = []
for f in glob.glob(os.path.join(POOL, '*.raw.txt')):
    t = json.load(open(f))['trace']
    ps = t.get('recallPasses') or []
    por = collections.defaultdict(list)
    for p in ps:
        k = tec(p['label']); por[k].append(p)
        tok[k]['fresco'] += (p.get('inputTokens', 0) or 0) - (p.get('cacheReadTokens', 0) or 0)
        tok[k]['cache'] += p.get('cacheReadTokens', 0) or 0
        tok[k]['output'] += p.get('outputTokens', 0) or 0
        tok[k]['passadas'] += 1
    parede = lambda lst: (max(p['startEpochMs'] + p['ms'] for p in lst) - min(p['startEpochMs'] for p in lst)) / 1000 if lst else 0
    r = {'G': parede(por['G']), 'S': parede(por['S']), 'M1': parede(por['M1']), 'M3': parede(por['M3'])}
    ramo_pr.append(r)
    achados = list(t.get('preFilterCandidates') or [])
    achados += [d.get('droppedFinding') or {} for d in (t.get('verification') or {}).get('decisions') or [] if d.get('action') == 'drop']
    for a in achados:
        vc = a.get('verifyCost') or {}
        k = tec(a.get('producedBy') or '')
        ver[k]['input'] += vc.get('inputTokens', 0); ver[k]['cache'] += vc.get('cacheReadTokens', 0)
        ver[k]['output'] += vc.get('outputTokens', 0); ver[k]['ms'] += vc.get('ms', 0); ver[k]['achados'] += 1
n_pr = len(ramo_pr) or 1
media = lambda k: sum(r[k] for r in ramo_pr) / n_pr

print(f'rodada {run} · {n_pr} PRs · {total} goldens core · pre-reducer\n')
print('== POR TECNICA (medias por PR)')
print(f'{"tec":<4} {"gold":>4} {"excl":>4} {"cand/PR":>7} {"derrub.":>7} {"fresco":>8} {"cache":>8} {"output":>7} {"tempo":>6}  {"verif. tokens":>13} {"verif. s":>8}')
todas = pontua(M, lambda k: True)[0]
for k in ['G', 'S', 'M1', 'M3']:
    v, c, fp = pontua(M, lambda x, k=k: x == k)
    resto = pontua(M, lambda x, k=k: x != k)[0]
    dv = pontua(D, lambda x, k=k: x == k)[0] if D else set()
    so_derrubados = len(dv - todas)
    tk = tok[k]; vv = ver[k]
    print(f'{k:<4} {len(v):>4} {len(v - resto):>4} {c / n_pr:>7.1f} {so_derrubados:>7} {tk["fresco"] / n_pr / 1e3:>7.0f}k {tk["cache"] / n_pr / 1e3:>7.0f}k {tk["output"] / n_pr / 1e3:>6.1f}k {media(k):>5.0f}s  {(vv["input"] + vv["output"]) / n_pr / 1e3:>12.0f}k {vv["ms"] / n_pr / 1000:>7.0f}s')
print('   excl = goldens que so esta tecnica acha · derrub. = goldens que so apareceram em achados que o verificador derrubou')

print('\n== POR CORTE')
cortes = {
    'G': {'G'}, 'G+S': {'G', 'S'}, 'M1': {'M1'}, 'M3': {'M3'}, 'M1+M3': {'M1', 'M3'},
    'G+M1': {'G', 'M1'}, 'G+M3': {'G', 'M3'}, 'G+M1+M3': {'G', 'M1', 'M3'},
    'G+S+M1': {'G', 'S', 'M1'}, 'G+S+M3': {'G', 'S', 'M3'}, 'G+S+M1+M3': {'G', 'S', 'M1', 'M3'},
}
print(f'{"corte":<10} {"gold":>4} {"recall":>7} {"cand/PR":>7} {"FP":>5} {"prec":>6} {"tokens/PR":>10} {"latencia":>9}')
# Sem nenhum golden do S, os cortes com ele repetem os sem ele e so custam mais.
linhas = []
for nome, ks in cortes.items():
    v, c, fp = pontua(M, lambda x, ks=ks: x in ks)
    toks = sum(tok[k]['fresco'] + tok[k]['cache'] + tok[k]['output'] + ver[k]['input'] + ver[k]['output'] for k in ks) / n_pr
    lat = sum(max((r['G'] + (r['S'] if 'S' in ks else 0)) if 'G' in ks else 0,
                  r['M1'] if 'M1' in ks else 0, r['M3'] if 'M3' in ks else 0) for r in ramo_pr) / n_pr
    prec = len(v) / (len(v) + fp) if (len(v) + fp) else 0
    linhas.append({'corte': nome, 'goldens': len(v), 'recall': len(v) / total, 'candPR': c / n_pr, 'fp': fp, 'prec': prec, 'tokensPR': toks, 'latencia': lat})
    print(f'{nome:<10} {len(v):>4} {len(v) / total:>6.1%} {c / n_pr:>7.1f} {fp:>5} {prec:>6.1%} {toks / 1e3:>9.0f}k {lat:>8.0f}s')
print('   tokens/PR = geracao (fresco + cache + output) + verificador dos achados do corte')
print('   latencia = ramo mais lento em media por PR (G->S em serie; M1 e M3 em paralelo); sem o verificador')
if len(sys.argv) > 2:
    json.dump({'rodada': run, 'prs': n_pr, 'total': total, 'cortes': linhas}, open(sys.argv[2], 'w'))
