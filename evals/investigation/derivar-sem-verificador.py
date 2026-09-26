#!/usr/bin/env python3
"""A rodada como teria saido SEM o verificador por achado: os achados que ele
derrubou voltam para os candidatos (e para a matriz do judge, com as notas da
matriz-descartados), e o reducer decide sozinho o que vai para o PR.

  python3 derivar-sem-verificador.py --de=<rodada-ou-derivada> --descartes=<rodada-original> --para=<nova>

--de pode ser uma rodada derivada (ex.: o controle -ctl) para somar os descartes
sobre ela; --descartes e a rodada que tem verification.decisions e
matriz-descartados. Candidatos devolvidos ganham producedBy do agente original
(ou 'verificador-descartado' se nao houver) para aparecerem por agente.
"""
import json, os, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
POOLS = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))
R = os.path.join(AQUI, 'results')
EXTRAS = ('-grafo', '-b')


def arg(n):
    for a in sys.argv[1:]:
        if a.startswith(f'--{n}='):
            return a[len(n) + 3:]
    sys.exit(__doc__)


def main():
    de, desc, para = arg('de'), arg('descartes'), arg('para')
    destino = os.path.join(POOLS, para)
    if os.path.exists(destino):
        sys.exit(f'{destino} ja existe')
    os.makedirs(destino)
    m = json.load(open(os.path.join(R, f'matriz-{de}.json')))
    md = json.load(open(os.path.join(R, f'matriz-descartados-{desc}.json')))
    voltaram = 0
    for f in sorted(os.listdir(os.path.join(POOLS, de))):
        if not f.endswith('.raw.txt'):
            continue
        d = json.load(open(os.path.join(POOLS, de, f)))
        o = json.load(open(os.path.join(POOLS, desc, f)))
        cid = d['caseId']
        drops = [x for x in ((o['trace'].get('verification') or {}).get('decisions') or [])
                 if x.get('action') == 'drop' and x.get('droppedFinding')]
        # Braços extras do cross-file ficam de fora, como no controle.
        drops = [x for x in drops if not str(x['droppedFinding'].get('producedBy') or '').endswith(EXTRAS)]
        novos = [{**x['droppedFinding'], 'relevantFile': x['relevantFile'],
                  'producedBy': x['droppedFinding'].get('producedBy') or 'verificador-descartado',
                  'existingCode': '', 'improvedCode': '', 'devolvidoDoVerificador': True}
                 for x in drops]
        d['trace']['preFilterCandidates'] = (d['trace'].get('preFilterCandidates') or []) + novos
        d['config'] = {**(d.get('config') or {}), 'semVerificador': True, 'descartesDe': desc}
        json.dump(d, open(os.path.join(destino, f), 'w'))
        voltaram += len(novos)

        # Matriz: acrescenta as colunas dos devolvidos, na MESMA ordem dos candidatos.
        if cid in m:
            mmd = md.get(cid)
            idx = {}
            if mmd:
                for j, c in enumerate(mmd['candidatos']):
                    idx.setdefault((c.get('relevantFile'), (c.get('oneSentenceSummary') or '')[:200]), j)
            mm = m[cid]
            for n in novos:
                chave = (n.get('relevantFile'), (n.get('oneSentenceSummary') or '')[:200])
                j = idx.get(chave)
                mm['candidatos'].append({'producedBy': n['producedBy'], 'relevantFile': n.get('relevantFile'),
                                         'relevantLinesStart': n.get('relevantLinesStart'),
                                         'severity': n.get('severity'),
                                         'oneSentenceSummary': (n.get('oneSentenceSummary') or '')[:200]})
                for i, linha in enumerate(mm['conf']):
                    linha.append(mmd['conf'][i][j] if (mmd and j is not None) else 0)
    json.dump(m, open(os.path.join(R, f'matriz-{para}.json'), 'w'))
    print(f'{para}: {voltaram} achados devolvidos pelo verificador')


if __name__ == '__main__':
    main()
