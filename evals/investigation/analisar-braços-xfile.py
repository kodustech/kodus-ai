#!/usr/bin/env python3
"""Fase 1 do #1821, dentro de UMA rodada (variancia entre rodadas zero):

  1. o agente cross-file com grafo acha mais que o mesmo agente sem grafo?
  2. uma segunda amostra do cross-file soma recall?
  3. o verificador descarta bug bom, e quanto tempo ele custa?

  python3 analisar-braços-xfile.py --run=<rodada>

Criterio fixado ANTES da rodada: so e efeito uma diferenca de 3+ goldens core,
no mesmo sentido nos dois modelos. 1-2 goldens e sorte de amostra.
"""
import json, os, sys, statistics as st

AQUI = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(AQUI, 'results')
POOLS = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}
XF = 'micro-changed-files-disagree'
GRAFO, AMOSTRA_B = XF + '-grafo', XF + '-b'
EXTRAS = {GRAFO, AMOSTRA_B}


def arg(n):
    for a in sys.argv[1:]:
        if a.startswith(f'--{n}='):
            return a[len(n) + 3:]
    sys.exit(__doc__)


def cobertura(m, incluir):
    """Goldens core cobertos pelos candidatos cujo agente passa em `incluir`."""
    s = set()
    for cid, mm in m.items():
        for j, c in enumerate(mm['candidatos']):
            if not incluir(c.get('producedBy') or ''):
                continue
            for i, g in enumerate(mm['goldens']):
                if g.get('category') in CORE and mm['conf'][i][j] > 0:
                    s.add((cid, i))
    return s


def main():
    run = arg('run')
    m = json.load(open(os.path.join(R, f'matriz-{run}.json')))
    total = sum(1 for mm in m.values() for g in mm['goldens'] if g.get('category') in CORE)
    so = lambda nome: (lambda p: p == nome)
    controle = cobertura(m, lambda p: p not in EXTRAS)
    base, grafo, b = cobertura(m, so(XF)), cobertura(m, so(GRAFO)), cobertura(m, so(AMOSTRA_B))
    n_cand = lambda nome: sum(1 for mm in m.values() for c in mm['candidatos'] if c.get('producedBy') == nome)

    print(f'rodada {run} · {total} goldens core')
    print(f'controle (13 agentes + simulacao, sem os braços): {len(controle)} ({len(controle) / total * 100:.1f}%)')
    print('\n1) GRAFO no agente cross-file')
    print(f'   sem grafo: {len(base)} goldens em {n_cand(XF)} candidatos · com grafo: {len(grafo)} em {n_cand(GRAFO)}')
    print(f'   so o com-grafo acha: {len(grafo - base)} · so o sem-grafo acha: {len(base - grafo)}')
    print(f'   trocar pelo com-grafo mudaria a rodada em {len((controle - base) | grafo) - len(controle):+d} goldens')
    print('\n2) SEGUNDA AMOSTRA do cross-file')
    print(f'   amostra A: {len(base)} · amostra B: {len(b)} · uniao: {len(base | b)}')
    print(f'   somar a B a rodada: {len(controle | b) - len(controle):+d} goldens · custo: {n_cand(AMOSTRA_B)} candidatos a mais')

    p = os.path.join(R, f'matriz-descartados-{run}.json')
    ms, walls, n_desc = [], [], 0
    pasta = os.path.join(POOLS, run)
    for f in os.listdir(pasta):
        if f.endswith('.raw.txt'):
            t = json.load(open(os.path.join(pasta, f)))['trace']
            v = t.get('verification') or {}
            if v.get('verifyMs') is not None:
                ms.append(v['verifyMs'] / 60000)
                walls.append((t.get('reviewWallMs') or 0) / 60000)
            n_desc += v.get('droppedByVerifier', 0)
    print('\n3) VERIFICADOR')
    if ms:
        print(f'   tempo: mediana {st.median(ms):.1f} min de {st.median(walls):.1f} min por PR · pior {max(ms):.1f} min')
    if os.path.exists(p):
        md = json.load(open(p))
        casados = [(cid, mm['candidatos'][j]['oneSentenceSummary'], mm['goldens'][i]['comment'])
                   for cid, mm in md.items() for i, linha in enumerate(mm['conf'])
                   for j, x in enumerate(linha) if x > 0 and mm['goldens'][i].get('category') in CORE]
        desc_total = sum(len(mm['candidatos']) for mm in md.values())
        novos = {(cid, g) for cid, _, g in casados}
        print(f'   descartou {desc_total} achados; {len(novos)} batem com golden core')
        for cid, s, g in casados:
            print(f'     - {cid[:40]}: "{s[:110]}"  ~ golden: "{g[:110]}"')
    else:
        print(f'   {n_desc} descartados, ainda sem matriz de descartados')


if __name__ == '__main__':
    main()
