#!/usr/bin/env python3
"""Gold de duplicatas v2 (#1821): recall e precisao da regua Martian depois do
dedup de producao rodado (dedup-real/<versao>/<model>.json). Fica o comentario
que o dedup manteve (keep) de cada grupo, depois do guarda de producao, mais as
soltas; usa as matrizes do juiz ja rodadas no finder, sem chamar LLM.

  python3 evals/dedup/gold-v2/placar-dedup-real.py <model> <versao> [<versao> ...]
"""
import json, os, sys
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}
TOTAL = 111
MATRIZ = {'deepseek-v4.1-flash': 'finder-definitivo_deepseek', 'gpt-6.1-sol': 'finder-definitivo_gpt',
          'muse-spark-1.2': 'finder-muse-v1', 'sonnet-5.5': 'finder-definitivo_sonnet'}
tec = lambda pb: pb == 'generalist-base' or str(pb).startswith('micro-exp-p3-')
honra = lambda p: p['lex'] >= 0.3 or (p['cos'] or 0) >= 0.7 or ((p['cos'] or 0) >= 0.4 and p['tb'] is True)

def placar(casos):
    gold = fp = n = 0
    for gs, cols in casos:
        n += len(cols)
        venc = set()
        for gi, g in enumerate(gs):
            if g.get('category') not in CORE:
                continue
            b, q = 0, None
            for k, v in enumerate(cols):
                if v[gi] > b:
                    b, q = v[gi], k
            if q is not None:
                gold += 1
                venc.add(q)
        fp += len(cols) - len(venc)
    return n, gold, gold / TOTAL, gold / (gold + fp)

model, versoes = sys.argv[1], sys.argv[2:]
m = json.load(open(f'investigation/results/matriz-pre-09.10.26_{MATRIZ[model]}.json'))
casos = {}
for c, x in m.items():
    idx = [j for j, cand in enumerate(x['candidatos']) if tec(cand.get('producedBy'))]
    casos[c] = (x['goldens'], {f'S{i + 1}': [x['conf'][gi][j] for gi in range(len(x['goldens']))] for i, j in enumerate(idx)})
n, g, r, p = placar([(gs, list(v.values())) for gs, v in casos.values()])
print(f'| {model} | finder | {n} | {r:.1%} | {p:.1%} |')
for ver in versoes:
    d = json.load(open(f'dedup/gold-v2/dedup-real/{ver}/{model}.json'))['prs']
    sai = []
    for c, (gs, vec) in casos.items():
        fora = set()
        # keep invalido: a producao mantem as duplicatas como independentes.
        for grp in [g for g in d[c]['groups'] if g.get('keep')]:
            for dup in grp['duplicates']:
                par = next((q for q in d[c].get('pares', []) if q.get('dup') == dup and q.get('keep') == grp['keep']), None)
                if dup != grp['keep'] and (par is None or honra(par)):
                    fora.add(dup)
        sai.append((gs, [v for s, v in vec.items() if s not in fora]))
    n, g, r, p = placar(sai)
    print(f'| {model} | dedup {ver} | {n} | {r:.1%} | {p:.1%} |')
