#!/usr/bin/env python3
"""#1821: regra deterministica de veto depois de verify C -> nit protegido, sem
chamada de modelo. Celulas pre-declaradas sobre sinais que as etapas ja devolvem:
  S = grupo de um membro so;  W = lente fraca (generalist-base, text-that-ships,
  test-does-not-verify);  U = passo 1 do verify C deu 'unverified';
  B = passo 1 esgotou o teto (passos >= 10);  N = o nit protegido julgou e disse
  nao-nit com no maximo 2 passos (sinal de pouca investigacao).
Para cada modelo e conjunto (light/holdout), com os rotulos TP/FP, conta o que
cada regra derruba a mais sobre o fluxo base: goldens perdidos (golden unico),
FPs por tipo e precisao. A escolha e por leave-one-model-out no light.

  python3 evals/dedup/gold-v2/regra-veto.py
"""
import json, os, glob
os.chdir(os.path.dirname(os.path.abspath(__file__)))
CORE = {'bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'}
FRACAS = {'generalist-base', 'micro-exp-p3-text-that-ships', 'micro-exp-p3-test-does-not-verify'}
ESPEC = {'micro-exp-p3-' + x for x in ('value-boundary-and-position', 'contract-not-followed', 'says-one-thing-does-another', 'invalid-state-and-concurrency', 'changed-files-disagree')}

# modelo -> conjunto -> (prefixo das sugestoes, passo 1, verify C, nit, pasta dos rotulos)
CFG = {
    'deepseek-v4.1-flash': {'light': ('09.10.26', 'aluc-h1t10', 'aluc-h1t10f', 'nit-v3d-so1b', 'classificacao'),
                            'holdout': ('ho', 'aluc-ho-h1t10', 'aluc-ho-h1t10f', 'ho-nit-v3d-so1', '../holdout-20/classificacao')},
    'gpt-6.1-sol': {'light': ('09.10.26', 'aluc-h1t10', 'aluc-h1t10f', 'nit-v3d-so1b', 'classificacao'),
                    'holdout': ('ho', 'aluc-ho-h1t10', 'aluc-ho-h1t10f', 'ho-nit-v3d-so1', '../holdout-20/classificacao')},
    'sonnet-5.5': {'light': ('09.10.26', 'aluc-h1t10', 'aluc-h1t10f', 'nit-v3d-so1', 'classificacao'),
                   'holdout': ('ho', 'aluc-ho-h1t10', 'aluc-ho-h1t10f', 'ho-nit-v3d-so1', '../holdout-20/classificacao')},
    'muse-spark-1.3': {'light': ('m13l', 'aluc-m13l-h1t10', 'aluc-m13l-h1t10f', 'm13l-nit-v3d-so1', 'classificacao'),
                       'holdout': ('m13h', 'aluc-m13h-h1t10', 'aluc-m13h-h1t10f', 'm13h-nit-v3d-so1', '../holdout-20/classificacao')},
}
REGRAS = {
    'S&W&U&B': lambda g: g['S'] and g['W'] and g['U'] and g['B'],
    'S&W&U': lambda g: g['S'] and g['W'] and g['U'],
    'S&W&B': lambda g: g['S'] and g['W'] and g['B'],
    'S&W&N': lambda g: g['S'] and g['W'] and g['N'],
}


def carrega(m, conj):
    pref, p1, c, nit, rot = CFG[m][conj]
    R = lambda v: json.load(open(f'verify/resultados/{v}/{m}.json'))['prs']
    sug = json.load(open(f'{pref}_{m}.json'))['prs']
    P1, C, NIT = R(p1), R(c), R(nit)
    grupos = []
    for f in glob.glob(f'{rot}/{m}/*.json'):
        d = json.load(open(f)); cid = d['caseId']
        L = {x['id']: x for x in d['itens']}
        S = {s['id']: s for s in sug[cid]['suggestions']}
        p1 = {g['rep']: g for g in P1.get(cid, {}).get('grupos', [])}
        nt = {g['rep']: g for g in NIT.get(cid, {}).get('grupos', [])}
        for g in C.get(cid, {}).get('grupos', []):
            if g.get('nit'):
                continue  # verify C ja derrubou
            mem = g['membros']; rep = g['rep']
            n = nt.get(rep)
            # nit protegido: so derruba se nenhum membro e de lente especializada
            if n and n.get('nit') and not any(S[x]['producedBy'] in ESPEC for x in mem):
                continue
            q = p1.get(rep, {})
            grupos.append({
                'cid': cid, 'rep': rep,
                'S': len(mem) == 1, 'W': S[rep]['producedBy'] in FRACAS,
                'U': q.get('verdict') == 'unverified', 'B': (q.get('passos') or 0) >= 10,
                'N': bool(n) and not n.get('nit') and (n.get('passos') or 99) <= 2,
                'rot': [L[x] for x in mem],
            })
    nucleo = {(f['cid'], x['golden']) for f in grupos for x in f['rot'] if x['classe'] == 'TP' and x.get('goldenCategoria') in CORE}
    return grupos


def placar(grupos, corta=lambda g: False):
    vg = set(); tp = fp = 0; tipos = {}
    for g in grupos:
        if corta(g):
            continue
        core = {(g['cid'], x['golden']) for x in g['rot'] if x['classe'] == 'TP' and x.get('goldenCategoria') in CORE}
        if any(x['classe'] == 'TP' for x in g['rot']) and not core:
            continue
        if core and core - vg:
            tp += 1; vg |= core
        else:
            fp += 1
            t = 'repeticao' if core else g['rot'][0].get('tipoFP')
            tipos[t] = tipos.get(t, 0) + 1
    return len(vg), tp, fp, tipos


def derrubados(grupos, regra):
    out = {}
    for g in grupos:
        if regra(g):
            k = 'TP' if any(x['classe'] == 'TP' for x in g['rot']) else g['rot'][0].get('tipoFP')
            out[k] = out.get(k, 0) + 1
    return out


dados = {(m, c): carrega(m, c) for m in CFG for c in ('light', 'holdout')}
res = {}
for (m, c), gs in dados.items():
    g0, tp0, fp0, _ = placar(gs)
    for nome, r in REGRAS.items():
        g1, tp1, fp1, _ = placar(gs, r)
        res[(m, c, nome)] = {'perde': g0 - g1, 'dprec': 100 * (tp1 / max(1, tp1 + fp1) - tp0 / max(1, tp0 + fp0)), 'caem': derrubados(gs, r)}
    res[(m, c, 'base')] = {'goldens': g0, 'prec': 100 * tp0 / max(1, tp0 + fp0)}

for c in ('light', 'holdout'):
    print(f'\n== {c}: goldens perdidos / ganho de precisao (pts) / o que cai')
    for nome in REGRAS:
        print(f'  {nome:10s} ' + ' | '.join(f"{m.split('-')[0]}: -{res[(m, c, nome)]['perde']} / {res[(m, c, nome)]['dprec']:+.1f} / {res[(m, c, nome)]['caem']}" for m in CFG))

# leave-one-model-out no light: escolhe a regra pelos outros 3 modelos
print('\n== leave-one-model-out (light): regra escolhida pelos outros 3 -> resultado no modelo de fora (light e holdout)')
for fora in CFG:
    treino = [m for m in CFG if m != fora]
    ok = [n for n in REGRAS if all(res[(m, 'light', n)]['perde'] <= 1 and not res[(m, 'light', n)]['caem'].get('bug_real') for m in treino)]
    escolha = max(ok, key=lambda n: min(res[(m, 'light', n)]['dprec'] for m in treino)) if ok else 'nenhuma'
    if escolha == 'nenhuma':
        print(f'  {fora}: nenhuma regra respeita as restricoes nos outros 3'); continue
    a, b = res[(fora, 'light', escolha)], res[(fora, 'holdout', escolha)]
    print(f"  {fora}: {escolha} -> light -{a['perde']} golden, {a['dprec']:+.1f} pts | holdout -{b['perde']} golden, {b['dprec']:+.1f} pts")
