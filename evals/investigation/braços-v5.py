#!/usr/bin/env python3
"""Os 12 bracos de 29.09.26_v5: simulacao fatiada em cenario x persona de dev.

Regra da Martian, aplicada DENTRO de cada braco: por golden vence o candidato de
maior confianca do judge; candidato que nao vence nenhum golden e falso positivo.

  python3 braços-v5.py --run=29.09.26_v5_gpt6_sim_devlevel
"""
import json, os, sys, itertools

AQUI = os.path.dirname(os.path.abspath(__file__))
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}


def arg(n, d=None):
    for a in sys.argv[1:]:
        if a.startswith(f'--{n}='):
            return a[len(n) + 3:]
    if d is None:
        sys.exit(__doc__)
    return d


def pontua(m, incluir):
    """(goldens core vencidos, candidatos, falsos positivos)."""
    venc, cand, fp = set(), 0, 0
    for cid, mm in m.items():
        idx = [j for j, c in enumerate(mm['candidatos']) if incluir(c.get('producedBy') or '')]
        cand += len(idx)
        ganhou = set()
        for i, g in enumerate(mm['goldens']):
            if g.get('category') not in CORE:
                continue
            melhor, nota = None, 0
            for j in idx:
                if mm['conf'][i][j] > nota:
                    melhor, nota = j, mm['conf'][i][j]
            if melhor is not None:
                venc.add((cid, i))
                ganhou.add(melhor)
        fp += len(idx) - len(ganhou)
    return venc, cand, fp


def linha(nome, venc, cand, fp, total):
    r = len(venc) / total if total else 0
    p = len(venc) / cand if cand else 0
    f1 = 2 * p * r / (p + r) if p + r else 0
    f2 = 5 * p * r / (4 * p + r) if p + r else 0
    print(f'{nome:<34} {cand:>4} {len(venc):>4} {fp:>4}  {r*100:>5.1f}%  {p*100:>5.1f}%  {f1:.3f}  {f2:.3f}')


def main():
    run = arg('run')
    m = json.load(open(os.path.join(AQUI, 'results', f'matriz-{run}.json')))
    total = sum(1 for mm in m.values() for g in mm['goldens'] if g.get('category') in CORE)
    nomes = sorted({c.get('producedBy') for mm in m.values() for c in mm['candidatos']})

    print(f'rodada {run} · {len(m)} PRs · {total} goldens core\n')
    print(f'{"braco":<34} {"cand":>4} {"tp":>4} {"fp":>4}  {"recall":>6}  {"prec":>6}  {"F1":>5}  {"F2":>5}')
    for n in nomes:
        linha(n, *pontua(m, lambda p, n=n: p == n), total)

    print()
    grupos = {
        'UNIAO simulacao (3 cenarios, p1g)': lambda p: p.startswith('micro-exp-sim-') and p.endswith('p1g'),
        'UNIAO simulacao (3 cenarios, p3)': lambda p: p.startswith('micro-exp-sim-') and p.endswith('p3'),
        'UNIAO dev-level (3 categorias, p1g)': lambda p: p.startswith('micro-exp-dev-') and p.endswith('p1g'),
        'UNIAO dev-level (3 categorias, p3)': lambda p: p.startswith('micro-exp-dev-') and p.endswith('p3'),
        'UNIAO simulacao (6 bracos)': lambda p: p.startswith('micro-exp-sim-'),
        'UNIAO dev-level (6 bracos)': lambda p: p.startswith('micro-exp-dev-'),
        'UNIAO tudo (12 bracos)': lambda p: True,
    }
    for nome, f in grupos.items():
        linha(nome, *pontua(m, f), total)


main()
