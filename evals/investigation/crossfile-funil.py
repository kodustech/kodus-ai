#!/usr/bin/env python3
"""Funil dos goldens CROSS-FILE: quantos existem, quantos a geracao alcanca e
quantos sobrevivem ate o comentario postado.

Tres estagios, porque "nao pegamos" tem duas causas muito diferentes:
  existe   -> esta no gabarito
  alcanca  -> algum candidato do pool cobre o golden (a geracao achou)
  posta    -> o grupo que o cobre passa da cota e do limiar (o reducer manteve)
Um golden perdido no segundo estagio e problema de geracao; no terceiro, de
corte. Misturar os dois esconde qual metade precisa de trabalho.
"""
import json, os, sys
from refit_formula import fit, prob, BASE, CORE, SEVN

R = 'results'
CF = json.load(open(f'{R}/goldens-crossfile.json'))['saida']

def flags(cid, gs):
    """crossFile por indice de golden, casando pelo texto do comentario."""
    arr = CF.get(cid) or []
    por_texto = {str(x.get('comment', ''))[:120]: bool(x.get('crossFile')) for x in arr}
    out, casados = [], 0
    for i, g in enumerate(gs):
        t = str(g.get('comment', ''))[:120]
        if t in por_texto:
            out.append(por_texto[t]); casados += 1
        elif i < len(arr):
            out.append(bool(arr[i].get('crossFile')))
        else:
            out.append(False)
    return out, casados

def funil(nome, pool, matrizes, grupos, veracidades=(), usar_score=False,
          cota=6, lim=0.22):
    MAT = {}
    for m in matrizes:
        MAT.update(json.load(open(f'{R}/{m}')))
    GR = json.load(open(f'{R}/{grupos}'))['saida']
    VER = {}
    for v in veracidades:
        VER.update(json.load(open(f'{R}/{v}'))['saida'])
    # mesmo conjunto de termos da varredura: veracidade e verify-score entram
    # como sinais SEPARADOS, cada um com seu produto contra a nota.
    feats = (['nota', 'ver', 'vscore', 'prod', 'prodsc', 'conf', 'tam', 'sev',
              'nag', 'vies'] if usar_score else BASE)

    dados, meta = {}, {}
    casados_tot = prs = 0
    for cid, v in GR.items():
        if cid not in MAT:
            continue
        j = json.load(open(f'pools/{pool}/{cid}.raw.txt'))
        cands = j['trace'].get('preFilterCandidates') or []
        keep = [i for i, x in enumerate(cands)
                if str(x.get('severity', '')).lower() in SEVN and x.get('reason')]
        gs, conf = MAT[cid]['goldens'], MAT[cid]['conf']
        cf, casados = flags(cid, gs)
        casados_tot += casados; prs += 1
        core = [i for i, g in enumerate(gs) if g.get('category') in CORE]

        # alcancado = algum candidato do POOL INTEIRO cobre o golden
        alcanca = {gi for gi in core
                   if any((conf[gi][c] if c < len(conf[gi]) else 0) > 0
                          for c in range(len(cands)))}
        # dono entre os candidatos que passaram o contrato
        dono = {}
        for gi in core:
            b, q = 0, -1
            for pos, ci in enumerate(keep):
                x = conf[gi][ci] if ci < len(conf[gi]) else 0
                if x > b:
                    b, q = x, pos
            if q >= 0:
                dono[gi] = q

        gr = []
        for g in v.get('grupos', []):
            idx = [i for i in g['indices'] if i < len(keep)]
            if not idx:
                continue
            mem = [cands[keep[i]] for i in idx]
            ags = {m.get('producedBy') for m in mem}
            nota = (g.get('nota') or 0) / 100
            x = VER.get(cid, {}).get(str(g.get('origem')))
            if x is None:
                # seletor antigo guarda so `representante` (indice no pool ja
                # filtrado); a tabela de veracidade e indexada pelo original.
                rep = g.get('representante')
                if isinstance(rep, int) and rep < len(keep):
                    x = VER.get(cid, {}).get(str(keep[rep]))
            ver = (x if x is not None else 50) / 100
            f = {'nota': nota, 'ver': ver, 'prod': nota * ver,
                 'conf': max((m.get('confidence') or 0) for m in mem) / 100,
                 'tam': min(len(idx), 4) / 4,
                 'sev': max(SEVN.get(str(m.get('severity', '')).lower(), .5) for m in mem),
                 'nag': min(len(ags), 3) / 3, 'vies': 1.0}
            if usar_score:
                sc = g.get('score')
                f['vscore'] = (sc if sc is not None else 50) / 100
                f['prodsc'] = nota * f['vscore']
            gr.append({'f': f, 'core': [gi for gi, pos in dono.items() if pos in idx],
                       'cobre': [gi for gi, pos in dono.items() if pos in idx]})
        dados[cid] = {'g': gr}
        meta[cid] = {'core': core, 'cf': cf, 'alcanca': alcanca}

    # leave-one-out por PR
    prs_l = list(dados)
    postados = {}
    for fora in prs_l:
        am = [(g['f'], 1.0 if g['core'] else 0.0)
              for c in prs_l if c != fora for g in dados[c]['g']]
        w = fit(am, feats)
        p = [prob(w, g['f']) for g in dados[fora]['g']]
        ordem = sorted(range(len(p)), key=lambda i: -p[i])[:cota]
        cob = set()
        for i in ordem:
            if p[i] < lim:
                continue
            cob.update(dados[fora]['g'][i]['core'])
        postados[fora] = cob

    lin = {'cf': [0, 0, 0], 'mesmo': [0, 0, 0]}
    for cid in prs_l:
        m = meta[cid]
        for gi in m['core']:
            k = 'cf' if m['cf'][gi] else 'mesmo'
            lin[k][0] += 1
            if gi in m['alcanca']:
                lin[k][1] += 1
            if gi in postados[cid]:
                lin[k][2] += 1
    print(f'\n### {nome}  ({len(prs_l)} PRs, cota {cota}, limiar {lim})')
    print(f'    casamento de texto golden<->classificador: {casados_tot} de '
          f'{sum(len(meta[c]["cf"]) for c in prs_l)}')
    print(f'{"":<14}{"goldens":>9}{"alcancados":>12}{"postados":>10}{"nunca achados":>15}')
    for k, nome_k in [('cf', 'cross-file'), ('mesmo', 'mesmo arquivo')]:
        t, a, p = lin[k]
        print(f'{nome_k:<14}{t:>9}{a:>12}{p:>10}{t-a:>15}'
              f'   ({a*100//max(1,t)}% alcanca, {p*100//max(1,t)}% posta)')
    t = lin['cf'][0] + lin['mesmo'][0]
    a = lin['cf'][1] + lin['mesmo'][1]
    p = lin['cf'][2] + lin['mesmo'][2]
    print(f'{"TOTAL":<14}{t:>9}{a:>12}{p:>10}{t-a:>15}')

if __name__ == '__main__':
    GPT = dict(pool='gpt-30', matrizes=['matriz-fix.json', 'matriz-gpt6.json'],
               veracidades=['fix-score2.json', 'score2-gpt6.json'])
    funil('GPT · veracidade + verify 8 passos', grupos='verify-gpt30-score8.json',
          usar_score=True, cota=5, **GPT)
    funil('GPT · veracidade + verify 5 passos', grupos='verify-gpt30-score.json',
          usar_score=True, cota=6, **GPT)
    funil('GPT · so veracidade', grupos='verify-gpt30-score8.json',
          usar_score=False, cota=6, **GPT)
    funil('DeepSeek · so veracidade', pool='ds-completo',
          matrizes=['matriz-ds-completo.json'], grupos='verify-ds-completo.json',
          veracidades=['score2-ds-completo.json'], usar_score=False, cota=6)
