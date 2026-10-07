#!/usr/bin/env python3
"""tree-sitter x classificador LLM x flags do proprio verify, na correcao so do topo 4."""
import json, sys, os
m = sys.argv[1]
FU = {'gpt': 'results/dedup-meta/gpt61-r1-v5.json', 'sonnet': 'results/meio/sonnet55-v5.json'}[m]
FQ = {'gpt': 'results/correcao/gpt-fila65.json', 'sonnet': 'results/correcao/sonnet55-fila65.json'}[m]
F = json.load(open(FU))['prs']; Q = json.load(open(FQ))
ld = lambda f: json.load(open(f))['prs'] if os.path.exists(f) else None
V1 = ld(f'results/novo/{m}-correcao-topo4.json'); CL = ld(f'results/novo/{m}-classifica2-topo4.json'); V2 = ld(f'results/novo/{m}-autoflag2-topo4.json')
def win(sel, conf):
    ng = len(next(iter(conf.values()))) if conf else 0; venc = set(); g = 0
    for gi in range(ng):
        b, q = 0, None
        for r in sel:
            if conf[r][gi] > b: b, q = conf[r][gi], r
        if q is not None: g += 1; venc.add(q)
    return g, venc
def placar(nome, cai):
    g = fp = n = tpd = fpd = 0
    for c, reps in Q.items():
        conf = {it['rep']: it['confs'] for it in F[c]['itens']}; top = reps[:4]; _, v0 = win(top, conf)
        drop = [r for r in top if cai(c, str(r))]
        tpd += sum(r in v0 for r in drop); fpd += sum(r not in v0 for r in drop)
        sel = [r for r in top if r not in drop]; gg, vv = win(sel, conf); g += gg; n += len(sel); fp += len(sel) - len(vv)
    f1 = 2 * (g/111) * (g/(g+fp)) / ((g/111) + (g/(g+fp))); p = g/(g+fp); r = g/111; f2 = 5*p*r/(4*p+r)
    print(f'| {nome} | {n} | {g} | {r:.1%} | {p:.1%} | {f1:.3f} | {f2:.3f} | {tpd} | {fpd} |')
d = lambda V, c, r: (V or {}).get(c, {}).get('decisoes', {}).get(r) or {}
semfix = lambda V: (lambda c, r: d(V, c, r).get('fixNeeded') is False)
ts = lambda V: (lambda c, r: bool((d(V, c, r).get('checagem') or {}).get('soComentario') or (d(V, c, r).get('checagem') or {}).get('soTexto')))
print('| regra | publicados | goldens | recall | precisão | F1 | F2 | TPs derrubados | FPs derrubados |\n|---|---|---|---|---|---|---|---|---|')
placar('só topo 4', lambda c, r: False)
placar('1ª rodada: não precisa corrigir', semfix(V1))
placar('1ª rodada: + tree-sitter (comentário/texto)', lambda c, r: semfix(V1)(c, r) or ts(V1)(c, r))
if CL:
    cl = lambda c, r: (lambda x: bool(x.get('onlyCommentsOrWhitespace') or x.get('onlyStringText')))(CL.get(c, {}).get('cls', {}).get(r) or {})
    placar('1ª rodada: + classificador LLM (comentário/espaço ou só string)', lambda c, r: semfix(V1)(c, r) or cl(c, r))
if V2:
    placar('2ª rodada (autoflag): não precisa corrigir', semfix(V2))
    placar('2ª rodada: + flags do próprio verify', lambda c, r: semfix(V2)(c, r) or bool(d(V2, c, r).get('onlyCommentsOrWhitespace') or d(V2, c, r).get('onlyStringText')))
    placar('2ª rodada: + tree-sitter', lambda c, r: semfix(V2)(c, r) or ts(V2)(c, r))
