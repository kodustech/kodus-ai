#!/usr/bin/env python3
"""Finder da producao (main 1a7041085, light): loopFindings do dump de cada PR.
O que a producao publicou esta no loop (mesmo arquivo e linha; o texto e reescrito) e herda o rotulo do gold.
O que o finder achou e a producao cortou nunca foi julgado: sai em <chave>/juiz-in.json, contra os TPs e TP nits do gold.
finder.json: por PR, cada item do loopFindings na ordem (L1, L2, ...) com o publicado que ele virou (S<j> do dump) ou o
cortado (C<n> do juiz-in); o publicado que nao esta no loop (P<j>) entra no fim.
  python3 monta-cortados.py <dir dos dumps>   ->  <chave>/finder.json, <chave>/juiz-in.json"""
import json, os, sys, glob
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..')
DUMPS = sys.argv[1]
CH = {'ds': 'deepseek-v4.1-flash@prod', 'gpt': 'gpt-6.1-sol@prod', 'opus': 'opus-5.5@prod', 'sonnet': 'sonnet-5.5@prod', 'muse': 'muse-spark-1.3@prod', 'kimi': 'kimi-k2.7-code@prod'}
base = json.load(open(os.path.join(AQUI, '..', 'e2b', 'casamento-in.json')))
g = json.load(open(os.path.join(V3, 'golden.json')))['prs']
lin = lambda s: (s.get('relevantFile'), s.get('relevantLinesStart'))
for k, ch in CH.items():
    W = os.path.join(AQUI, k); os.makedirs(W, exist_ok=True)
    finder, ent, herdados, so_pub = {}, {}, 0, 0
    for f in sorted(glob.glob(f'{DUMPS}/dump-{k}/*.raw.txt')):
        o = json.loads(open(f).read()); c = o['caseId']
        loop = list(o.get('loopFindings') or []); usado = [False] * len(loop)
        pub, fora = {}, []
        for j, s in enumerate(o.get('findings') or [], 1):
            i = next((i for i, x in enumerate(loop) if not usado[i] and lin(x) == lin(s)), None)
            if i is None: so_pub += 1; fora.append(j)
            else: usado[i] = True; herdados += 1; pub[i] = j
        cort = [x for i, x in enumerate(loop) if not usado[i]]
        sug = [{'id': f'C{j}', 'file': s.get('relevantFile'), 'lines': [s.get('relevantLinesStart'), s.get('relevantLinesEnd')], 'texto': s.get('suggestionContent') or ''} for j, s in enumerate(cort, 1)]
        nc, itens = 0, []
        for i, x in enumerate(loop):
            it = {'id': f'L{i + 1}', 'file': x.get('relevantFile'), 'lines': [x.get('relevantLinesStart'), x.get('relevantLinesEnd')]}
            if i in pub: it['publicado'] = f'S{pub[i]}'
            else: nc += 1; it['cortado'] = f'C{nc}'
            itens.append(it)
        itens += [{'id': f'P{j}', 'publicado': f'S{j}'} for j in fora]
        finder[c] = itens
        if sug:
            tps = {r['issueId'] for r in g.get(c, [])}
            issues = [i for i in base[c]['issues'] if i['issueId'] in tps]
            for r in g.get(c, []):
                if r['issueId'] not in {i['issueId'] for i in issues}:
                    issues.append({'issueId': r['issueId'], 'descricao': r.get('commentOpus') or r['comment'], 'textoGolden': None, 'comentarios': []})
            ent[c] = {**{x: base[c][x] for x in ('repo', 'head', 'base')}, 'sugestoes': sug, 'issues': issues}
    json.dump(finder, open(f'{W}/finder.json', 'w'), indent=1)
    json.dump(ent, open(f'{W}/juiz-in.json', 'w'), indent=1)
    print(k, 'PRs', len(finder), '| finder', sum(len(v) for v in finder.values()), '| publicados no loop', herdados, '| publicados fora do loop', so_pub, '| cortados', sum(len(v['sugestoes']) for v in ent.values()), 'em', len(ent), 'PRs')
