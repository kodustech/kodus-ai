#!/usr/bin/env python3
"""Pode comparar a rodada A com a rodada B? Sai 0 se a configuracao e a mesma
(ou difere so no que foi declarado como o braco do experimento), 2 se nao.

  python3 comparar-config.py <rodadaA> <rodadaB> [--braco=RECALL_DOCS,model]

O --braco lista as chaves que DEVEM diferir (o que esta sendo testado). Qualquer
outra diferenca invalida a comparacao: foi assim que 400k virou 922k de janela
entre duas rodadas de GPT e a queda foi atribuida ao modelo antes de alguem ver.
"""
import json, os, sys


def recusa(msg):
    print(msg)
    sys.exit(2)

AQUI = os.path.dirname(os.path.abspath(__file__))
POOLS = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))


def config(rodada):
    pasta = os.path.join(POOLS, rodada)
    vistas = set()
    for f in sorted(os.listdir(pasta)):
        if f.endswith('.raw.txt'):
            vistas.add(json.dumps(json.load(open(os.path.join(pasta, f))).get('config'), sort_keys=True))
    if len(vistas) != 1:
        recusa(f'{rodada}: {len(vistas)} configuracoes no mesmo pool — nao e uma rodada')
    cfg = json.loads(vistas.pop())
    if cfg is None:
        recusa(f'{rodada}: dumps sem configuracao gravada — nao comparavel')
    plano = {k: v for k, v in cfg.items() if k != 'env'}
    plano.update({f'env.{k}': v for k, v in (cfg.get('env') or {}).items()})
    return plano


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 2:
        sys.exit(__doc__)
    braco = set()
    for a in sys.argv[1:]:
        if a.startswith('--braco='):
            braco = {x.strip() for x in a[8:].split(',') if x.strip()}
    a, b = config(args[0]), config(args[1])
    difs = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    fora = [k for k in difs if k not in braco and k.replace('env.', '') not in braco]
    for k in difs:
        marca = 'braco' if k not in fora else 'NAO DECLARADO'
        print(f'  {k}: {a.get(k)!r} -> {b.get(k)!r}   [{marca}]')
    if fora:
        print(f'\nNAO COMPARAVEL: {len(fora)} diferenca(s) fora do braco declarado.')
        sys.exit(2)
    print('comparavel' + (f' (braco: {", ".join(sorted(braco))})' if braco else ' (configuracao identica)'))


if __name__ == '__main__':
    main()
