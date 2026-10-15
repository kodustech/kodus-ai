#!/usr/bin/env python3
"""Junta Claude x Astra. Igual -> concordancia; 1 nivel -> Claude; 2+ -> debate (ate 3 rodadas com o Astra).
  python3 mesclar.py <dir de trabalho> abrir      # cria debates.json com as divergencias de 2+ niveis
  python3 mesclar.py <dir de trabalho> gravar     # grava severidade/<modelo>.json com o veredito final"""
import json, glob, os, sys, collections
W, acao = sys.argv[1], sys.argv[2]
N = {'low': 0, 'medium': 1, 'high': 2, 'critical': 3}
pac = {f"{x['chave']}|{x['caseId']}|{x['id']}": x for v in json.load(open(f'{W}/pacotes.json')).values() for x in v for _ in [x.update(chave=f"{x['model']}|{x['conjunto']}")]}
cl = json.load(open(f'{W}/claude-final.json'))
ast = {}
for f in glob.glob(f'{W}/astra/*.json'):
    d = json.load(open(f))
    for it in d['items']: ast[f"{d['chave']}|{d['caseId']}|{it['id']}"] = it
faltam = [k for k in pac if k not in cl or k not in ast]
if faltam: sys.exit(f'faltam {len(faltam)}: claude {sum(k not in cl for k in pac)} astra {sum(k not in ast for k in pac)}')
DF = f'{W}/debates.json'
if acao == 'abrir':
    D = json.load(open(DF)) if os.path.exists(DF) else {}
    for k in pac:
        if abs(N[cl[k]['severity']] - N[ast[k]['severity']]) >= 2 and k not in D:
            D[k] = {'pacote': pac[k], 'historico': [{'autor': 'astra', 'severity': ast[k]['severity'], 'texto': ast[k]['reason']}], 'claudeInicial': cl[k]}
    json.dump(D, open(DF, 'w'), indent=1)
    c = collections.Counter(abs(N[cl[k]['severity']] - N[ast[k]['severity']]) for k in pac)
    print('diferenca de niveis:', dict(sorted(c.items())), '| debates:', len(D))
elif acao == 'gravar':
    D = json.load(open(DF)) if os.path.exists(DF) else {}
    por = collections.defaultdict(lambda: collections.defaultdict(dict))
    orig = collections.Counter()
    for k, x in pac.items():
        c, a = cl[k]['severity'], ast[k]['severity']
        reg = {'conjunto': x['conjunto'], 'claude': c, 'claudeMotivo': cl[k]['reason'], 'astra': a, 'astraMotivo': ast[k]['reason']}
        if c == a: reg.update(severidade=c, origem='concordancia')
        elif abs(N[c] - N[a]) == 1: reg.update(severidade=c, origem='um-nivel-claude')
        else:
            d = D[k]; h = d['historico']
            ultC = next(z['severity'] for z in reversed(h) if z['autor'] == 'claude')
            ultA = h[-1]['severity'] if h[-1]['autor'] == 'astra' else next(z['severity'] for z in reversed(h) if z['autor'] == 'astra')
            rod = sum(z['autor'] == 'astra' for z in h) - 1
            if ultC == ultA: reg.update(severidade=ultC, origem='debate-consenso')
            elif abs(N[ultC] - N[ultA]) == 1: reg.update(severidade=ultC, origem='debate-um-nivel-claude')
            else: reg.update(severidade=ultC, origem='debate-sem-consenso')
            reg.update(rodadas=rod, debate=h)
        orig[reg['origem']] += 1
        por[x['model']][x['caseId']][x['id']] = reg
    for m, v in por.items():
        json.dump({'model': m, 'escala': ['low', 'medium', 'high', 'critical'], 'regra': 'severidade alegada; Claude x Astra (gpt-6-astra) cegos a TP/FP', 'prs': v}, open(f'{m}.json', 'w'), indent=1, ensure_ascii=False)
    print(dict(orig))
