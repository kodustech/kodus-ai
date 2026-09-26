#!/usr/bin/env python3
"""Deriva, de uma rodada completa, a rodada que um NIVEL (light/balanced) teria
produzido: mesmos dumps, so com os candidatos dos agentes do nivel. A matriz do
judge e filtrada pelas mesmas colunas, entao nao custa chamada nenhuma; depois
basta rodar atribuidor + veracidade + relatorio sobre a rodada derivada.

  python3 derivar-nivel.py --de=<rodada> --para=<nova> --agentes=a,b,c

Aproximacao declarada: a simulacao da rodada original viu o <AlreadyRaised> de
TODOS os agentes. Num nivel de verdade ela veria so os do nivel. Confirmar o
nivel escolhido numa rodada real antes de levar para producao.
"""
import json, os, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
POOLS = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))
R = os.path.join(AQUI, 'results')


def arg(n):
    for a in sys.argv[1:]:
        if a.startswith(f'--{n}='):
            return a[len(n) + 3:]
    sys.exit(__doc__)


def main():
    de, para = arg('de'), arg('para')
    agentes = {x.strip() if x.strip().startswith('micro-') else f'micro-{x.strip()}'
               for x in arg('agentes').split(',') if x.strip()}
    origem, destino = os.path.join(POOLS, de), os.path.join(POOLS, para)
    if os.path.exists(destino):
        sys.exit(f'{destino} ja existe')
    os.makedirs(destino)
    manteve = total = 0
    for f in sorted(os.listdir(origem)):
        if not f.endswith('.raw.txt'):
            continue
        d = json.load(open(os.path.join(origem, f)))
        cands = d['trace'].get('preFilterCandidates') or []
        total += len(cands)
        d['trace']['preFilterCandidates'] = [c for c in cands if c.get('producedBy') in agentes]
        manteve += len(d['trace']['preFilterCandidates'])
        # A configuracao do nivel e a da origem MAIS a lista de agentes: duas
        # derivacoes diferentes da mesma rodada nao podem passar por iguais.
        d['config'] = {**(d.get('config') or {}), 'derivadoDe': de, 'agentes': sorted(agentes)}
        json.dump(d, open(os.path.join(destino, f), 'w'))

    m = json.load(open(os.path.join(R, f'matriz-{de}.json')))
    for cid, mm in m.items():
        cols = [j for j, c in enumerate(mm['candidatos']) if c.get('producedBy') in agentes]
        mm['candidatos'] = [mm['candidatos'][j] for j in cols]
        mm['conf'] = [[linha[j] for j in cols] for linha in mm['conf']]
    json.dump(m, open(os.path.join(R, f'matriz-{para}.json'), 'w'))
    print(f'{para}: {manteve}/{total} candidatos de {len(agentes)} agentes')


if __name__ == '__main__':
    main()
