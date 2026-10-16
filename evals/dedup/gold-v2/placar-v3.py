#!/usr/bin/env python3
"""#1821: o fluxo de producao medido no gold v3 (evals/dedup/gold-v3).

Acerto = TP sem subclasse; cada TP conta uma vez (golden unico). TP nit, FP,
FP alucinacao e a segunda sugestao sobre o mesmo TP (FP duplicata) contam como FP.
Recall = TPs distintos acertados / todos os TPs do gold dos PRs da rodada.
F2 = 5PR / (4P + R).

Etapas: finder (todas as sugestoes), dedup (o keep de cada grupo do dedup real,
depois do guarda de producao; o que o conversor, o parse e o anchoring tiram
antes do dedup tambem sai aqui), verify C, nit protegido.

Tambem: o dedup contra o gabarito de dedup (09.10.26_<model>.final.json, light-30) e tokens/tempo por PR de cada etapa (media, p75, p90).

  python3 evals/dedup/gold-v2/placar-v3.py <model> --prefixo=<p> [--saida=<json>]
      [--dedup=<p>-dedup] [--aluc=aluc-<p>-h1t10] [--nit=<p>-nit-v3d-so1]
"""
import json, os, sys, collections, math
AQUI = os.path.dirname(os.path.abspath(__file__))
os.chdir(AQUI)
V3 = os.path.join(AQUI, '..', 'gold-v3')
INV = os.path.join(AQUI, '..', '..', 'investigation')
ESPECIALISTAS = {'micro-exp-p3-' + x for x in ('value-boundary-and-position', 'contract-not-followed',
                 'says-one-thing-does-another', 'invalid-state-and-concurrency', 'changed-files-disagree')}

a = [x for x in sys.argv[1:] if not x.startswith('--')]
o = dict(x[2:].split('=', 1) for x in sys.argv[1:] if x.startswith('--'))
MODEL, P = a[0], o['prefixo']
DEDUP, ALUC, NIT = o.get('dedup', f'{P}-dedup'), o.get('aluc', f'aluc-{P}-h1t10'), o.get('nit', f'{P}-nit-v3d-so1')
ler = lambda p: json.load(open(p))
sug = ler(f'{P}_{MODEL}.json')
fin = ler(f'{P}_{MODEL}.final.json')
assert str(fin.get('fonte', '')).startswith('dedup-real/'), 'grupos precisam vir do dedup real'
fin, real = fin['prs'], ler(f'dedup-real/{DEDUP}/{MODEL}.json')['prs']
h1 = ler(f'verify/resultados/{ALUC}/{MODEL}.json')['prs']
h1f = ler(f'verify/resultados/{ALUC}f/{MODEL}.json')['prs']
nit = ler(f'verify/resultados/{NIT}/{MODEL}.json')['prs']
mapa = ler(f'{V3}/sugestoes.json')['sugestoes']
classe = {}
for f in ('golden.json', 'fps-conhecidos.json'):
    for l in ler(f'{V3}/{f}')['prs'].values():
        for i in l:
            classe[i['issueId']] = (i['class'], i['subclass'])
tps = collections.Counter(i['caseId'] for l in ler(f'{V3}/golden.json')['prs'].values() for i in l if i['class'] == 'TP' and not i['subclass'])
PRS = list(sug['prs'])
TOTAL_TP = sum(tps[c] for c in PRS)

def grupos(cid):
    """[(keep, membros)] como o verify recebe (grupos-producao.js)."""
    S = sug['prs'][cid]['suggestions']
    chegou = set(real[cid].get('idsEntradaDedup') or [])
    por, out = {}, []
    for s in S:
        if s['id'] not in chegou:
            continue
        k = fin[cid].get(s['id'], {}).get('grupo')
        if k:
            por.setdefault(k, []).append(s['id'])
        else:
            out.append((s['id'], [s['id']]))
    out += [(k, m) for k, m in por.items()]
    return out

caiu_verify = {(c, g['rep']) for c, p in h1f.items() for g in p.get('grupos', []) if g.get('nit')}
caiu_nit = set()
for c, p in nit.items():
    pb = {s['id']: s['producedBy'] for s in sug['prs'][c]['suggestions']}
    for g in p.get('grupos', []):
        if g.get('nit') and not any(pb[x] in ESPECIALISTAS for x in g['membros']):
            caiu_nit.add((c, g['rep']))

def placar(comentarios):
    """comentarios: [(cid, sid)] -> numeros da regua."""
    vistos, n = set(), collections.Counter()
    for cid, sid in comentarios:
        iss = mapa[f'{MODEL}|{cid}|{sid}']
        cl, sub = classe[iss]
        if cl == 'TP' and not sub:
            if iss in vistos:
                n['fp_duplicata'] += 1
            else:
                vistos.add(iss); n['tp'] += 1
        elif cl == 'TP':
            n['tp_nit'] += 1
        elif sub == 'hallucination':
            n['fp_alucinacao'] += 1
        else:
            n['fp'] += 1
    tot = len(comentarios)
    R = n['tp'] / TOTAL_TP if TOTAL_TP else 0
    Pr = n['tp'] / tot if tot else 0
    f = lambda b: (1 + b * b) * Pr * R / (b * b * Pr + R) if Pr + R else 0
    return {'comentarios': tot, 'tp': n['tp'], 'totalTp': TOTAL_TP, 'recall': round(100 * R, 1), 'precisao': round(100 * Pr, 1),
            'f1': round(100 * f(1), 1), 'f2': round(100 * f(2), 1),
            **{k: n[k] for k in ('tp_nit', 'fp_alucinacao', 'fp', 'fp_duplicata')}}

finder = [(c, s['id']) for c in PRS for s in sug['prs'][c]['suggestions']]
dedup = [(c, k) for c in PRS for k, _ in grupos(c)]
verify = [x for x in dedup if x not in caiu_verify]
final = [x for x in verify if x not in caiu_nit]
etapas = {'finder': placar(finder), 'dedup': placar(dedup), 'verify C': placar(verify), 'nit protegido': placar(final)}

# Dedup contra o gabarito de dedup (09.10.26, revisado a mao; so o light-30), restrito ao que
# chegou ao dedup nesta rodada. O gold v3 nao serve aqui: partiu dos grupos do dedup de cada
# modelo e no holdout herdou a saida do dedup real.
def particao(ids, grupo_de):
    por = collections.defaultdict(set)
    for i in ids:
        por[grupo_de(i) or ('so', i)].add(i)
    return [frozenset(v) for v in por.values()]
pares = lambda part: {frozenset((x, y)) for g in part for x in g for y in g if x < y}
GAB = ler(f'09.10.26_{MODEL}.final.json')
assert not str(GAB.get('fonte', '')).startswith('dedup-real/'), 'o gabarito de dedup foi sobrescrito'
GAB = GAB['prs']
c = collections.Counter()
for cid in PRS:
    if cid not in GAB:
        continue
    ids = real[cid].get('idsEntradaDedup') or []
    pg = particao(ids, lambda i: GAB[cid].get(i, {}).get('grupo'))
    pd = particao(ids, lambda i: fin[cid].get(i, {}).get('grupo'))
    c['prs'] += 1; c['prsIguais'] += set(pg) == set(pd)
    c['sugestoes'] += len(ids)
    onde_g = {i: g for g in pg for i in g}; onde_d = {i: g for g in pd for i in g}
    c['sugestoesNoGrupoCerto'] += sum(onde_g[i] == onde_d[i] for i in ids)
    gg, gd = [g for g in pg if len(g) > 1], [g for g in pd if len(g) > 1]
    c['gruposGabarito'] += len(gg); c['gruposDedup'] += len(gd)
    c['gruposDedupCertos'] += sum(g in set(pg) for g in gd)
    ag, ad = pares(pg), pares(pd)
    c['paresGabarito'] += len(ag); c['paresDedup'] += len(ad); c['paresCertos'] += len(ag & ad)
    # sobras: comentarios que seguem alem de um por problema / problemas fundidos num comentario so
    c['comentariosDepoisDoDedup'] += len(pd); c['problemasNoGabarito'] += len(pg)
    c['gruposMisturandoProblemas'] += sum(1 for g in pd if len({onde_g[i] for i in g}) > 1)
    c['problemasPartidos'] += sum(1 for g in pg if len({onde_d[i] for i in g}) > 1)
gab_dedup = dict(c)

# Tokens e tempo por PR (todos os PRs da rodada; etapa sem chamada no PR conta zero).
def pct(v, q):
    v = sorted(v)
    if not v:
        return 0
    k = (len(v) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)
CAMPOS = ('input', 'cacheRead', 'output', 'reasoning', 'ms', 'chamadas')
def resumo(porPr):
    out = {}
    for k in CAMPOS:
        v = [porPr.get(c, {}).get(k, 0) or 0 for c in PRS]
        out[k] = {'media': round(sum(v) / len(v)), 'p75': round(pct(v, .75)), 'p90': round(pct(v, .90))}
    # input sem cache
    v = [(porPr.get(c, {}).get('input', 0) or 0) - (porPr.get(c, {}).get('cacheRead', 0) or 0) for c in PRS]
    out['inputSemCache'] = {'media': round(sum(v) / len(v)), 'p75': round(pct(v, .75)), 'p90': round(pct(v, .90))}
    out['prsComChamada'] = sum(1 for c in PRS if (porPr.get(c, {}).get('chamadas') or 0) > 0)
    return out
tec = lambda pb: 'G' if pb == 'generalist-base' else 'M3' if str(pb).startswith('micro-exp-p3-') else None
TECS = sug.get('tec', 'G,M3').split(',')
pools = dict(zip(sug.get('origem', []), sug.get('sourcePools', [])))
lights = set(ler(f'{INV}/light-30.json'))
uso = {}
finder_uso = {T: {} for T in TECS}
for c in PRS:
    pool = pools['09.10.26' if c in lights else 'ho'] if pools else sug['sourcePool']
    t = ler(f'{INV}/pools/{pool}/{c}.raw.txt')['trace']
    for T in TECS:
        ps = [p for p in t.get('recallPasses') or [] if tec(p['label']) == T]
        finder_uso[T][c] = {'chamadas': sum(p.get('steps') or 0 for p in ps), 'input': sum(p.get('inputTokens') or 0 for p in ps),
                            'cacheRead': sum(p.get('cacheReadTokens') or 0 for p in ps), 'output': sum(p.get('outputTokens') or 0 for p in ps),
                            'reasoning': sum(p.get('reasoningTokens') or 0 for p in ps), 'ms': max([p.get('ms') or 0 for p in ps] or [0])}
for T in TECS:
    uso[f'finder {"generalista" if T == "G" else "M3"}'] = finder_uso[T]
uso['dedup'] = {c: p.get('uso') or {} for c, p in real.items()}
uso['verify C passo 1'] = {c: p.get('uso') or {} for c, p in h1.items()}
uso['verify C passo 2'] = {c: p.get('uso') or {} for c, p in h1f.items()}
uso['nit protegido'] = {c: p.get('uso') or {} for c, p in nit.items()}
# Fluxo inteiro por PR: tokens somam; tempo = finder (passadas em paralelo, a mais lenta) + etapas em sequencia.
tot = {}
for c in PRS:
    x = {k: 0 for k in CAMPOS}
    for nome, d in uso.items():
        for k in CAMPOS:
            if k != 'ms':
                x[k] += d.get(c, {}).get(k, 0) or 0
    x['ms'] = max(finder_uso[T][c]['ms'] for T in TECS) + sum((uso[n].get(c, {}).get('ms', 0) or 0) for n in ('dedup', 'verify C passo 1', 'verify C passo 2', 'nit protegido'))
    tot[c] = x
uso['fluxo inteiro'] = tot
custo = {k: resumo(v) for k, v in uso.items()}

out = {'model': MODEL, 'prefixo': P, 'tec': TECS, 'prs': len(PRS), 'etapas': etapas, 'dedupVsGabarito': gab_dedup, 'uso': custo,
       'erros': {'dedup': sum(1 for p in real.values() if p.get('erro')), 'verify1': sum(1 for p in h1.values() if p.get('erro')),
                 'verify2': sum(1 for p in h1f.values() for g in p.get('grupos', []) if (g.get('etapa2') or {}).get('erro')),
                 'nit': sum(1 for p in nit.values() if p.get('erro'))}}
if 'saida' in o:
    json.dump(out, open(o['saida'], 'w'), indent=1)
print(f"{MODEL} · {P} · {len(PRS)} PRs · {TOTAL_TP} TPs no gold")
print('| Etapa | Coment. | TP | Recall | Precisao | F1 | F2 | TP nit | FP aluc. | FP | FP dup |')
for k, e in etapas.items():
    print(f"| {k} | {e['comentarios']} | {e['tp']} | {e['recall']} | {e['precisao']} | {e['f1']} | {e['f2']} | {e['tp_nit']} | {e['fp_alucinacao']} | {e['fp']} | {e['fp_duplicata']} |")
print('dedup vs gabarito:', gab_dedup)
print('erros:', out['erros'])
