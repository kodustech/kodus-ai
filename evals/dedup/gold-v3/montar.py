#!/usr/bin/env python3
"""Gabarito v3 (#1821): um problema unico por PR, juntando o que os quatro finders
acharam (DeepSeek, GPT Sol, Sonnet, Muse 1.3) com os goldens da Martian, cada
problema classificado lendo o codigo por Opus e Astra (gpt-6-astra), com ate tres
rodadas de discussao nas divergencias.

Saidas (nesta pasta):
  golden.json            TPs (o gabarito): o que um revisor deveria apontar; subclass "nit" marca os triviais
  fps-conhecidos.json    FPs conhecidos (subclass "hallucination" quando o fato alegado e falso)
  revisao-humana.json    sem consenso depois das tres rodadas e ainda sem decisao humana
                         (as decisoes de Junior e Gabriel ficam em trabalho/revisao-humana-decisoes.json)
  sugestoes.json         cada sugestao do finder (modelo, PR, id) -> problema

Cada problema guarda a classificacao original (class, subclass) e a classe com que o gold e medido,
class_reviewed: "TP" (TP confirmado ou descontinuado no repositorio original, verificacao-upstream.json),
"FP nit" (TP pendente ou que nao entrou no original, TP nit, FP) ou "FP hallucination" (o fato alegado e falso).
Cada TP conta uma vez; a segunda sugestao sobre o mesmo TP conta como FP nit.

  python3 evals/dedup/gold-v3/montar.py [<dir de trabalho>]   (padrao: trabalho/, os insumos desta rodada)
"""
import json, os, sys, collections
AQUI = os.path.dirname(os.path.abspath(__file__))
W = sys.argv[1] if len(sys.argv) > 1 else os.path.join(AQUI, 'trabalho')
N = {'low': 0, 'medium': 1, 'high': 2, 'critical': 3}
ABR = {'ds': 'deepseek-v4.1-flash', 'gpt': 'gpt-6.1-sol', 'son': 'sonnet-5.5', 'muse': 'muse-spark-1.3'}
P = json.load(open(f'{W}/inventario.json'))
A = json.load(open(f'{W}/agrupamento.json'))
O = json.load(open(f'{W}/opus.json'))
AS = json.load(open(f'{W}/astra_all.json'))
D = json.load(open(f'{W}/debate/estado.json'))
HUM = json.load(open(f'{W}/revisao-humana-decisoes.json')) if os.path.exists(f'{W}/revisao-humana-decisoes.json') else {}
G = {(c, g['gid']): g for c, p in P.items() for g in p['grupos']}
# Goldens anexados ao PR errado no gabarito da Martian: descrevem codigo que o PR nao toca.
GOLDEN_DE_OUTRO_PR = {'optimize-spans-buffer-insertion-with-eviction-during-insert-sentry'}

sub = lambda s: None if s in (None, 'none') else s
golden, fps, revisao, sugestoes = {}, {}, {}, {}
cont = collections.Counter()
for cid, L in A.items():
    for iss in L:
        k = iss['issueId']; o = O[k]; a = AS[k]
        reg = {'issueId': k}
        # decisao final
        if k in D:
            d = D[k]; h = d['hist']
            ou = next(x for x in reversed(h) if x['who'] == 'opus'); au = next(x for x in reversed(h) if x['who'] == 'astra')
            debate = [{'quem': x['who'], 'class': x['class'], 'subclass': sub(x['subclass']), 'severity': sub(x['severity']), 'texto': x['text']} for x in h]
            if d.get('fechado'):
                cls, sc, status = ou['class'], sub(ou['subclass']), 'agreed_after_debate'
                sevo, seva = sub(ou['severity']), sub(au['severity'])
            elif k in HUM:
                # Sem consenso entre os modelos; decidido por Junior e Gabriel.
                cls, sc, status = HUM[k]['class'], HUM[k]['subclass'], 'human_decided'
                sevo, seva = sub(ou['severity']), sub(au['severity'])
                reg['humanos'] = {p: HUM[k].get(p) for p in ('junior', 'gabriel')}
                if HUM[k].get('nota'): reg['humanos']['nota'] = HUM[k]['nota']
            else:
                cls, sc, status = None, None, 'human_review'
                sevo, seva = sub(ou['severity']), sub(au['severity'])
            reg['debate'] = debate
        else:
            cls, sc, status = o['class'], sub(o.get('subclass')), 'agreed'
            sevo, seva = o.get('severity'), sub(a['severity'])
        # severidade: unanime nas sugestoes; senao Opus (diferenca de 1 nivel fica com o Opus; 2+ foi discutido)
        sev = iss['severity'] if iss['sevStatus'] == 'unanime' else (sevo or seva)
        gold_txt = [P[cid]['goldens'][i] for i in iss['goldens']]
        found = collections.defaultdict(list)
        for gid in iss['gids']:
            ab = gid.split(':')[0]; found[ABR[ab]] += G[(cid, gid)]['membros']
        reg.update({
            'caseId': cid,
            'comment': gold_txt[0]['comment'] if gold_txt else o.get('comment'),
            'commentOpus': o.get('comment'),
            'class': cls, 'subclass': sc, 'status': status,
            'severity': sev,
            'category': (gold_txt[0]['category'] if gold_txt else o.get('category')) if cls == 'TP' else None,
            'source': 'martian' if gold_txt else 'kodus',
            'martianRef': [{'caseId': cid, 'index': i, 'severity': P[cid]['goldens'][i]['severity'], 'category': P[cid]['goldens'][i]['category']} for i in iss['goldens']],
            'foundBy': dict(found),
            'reason_opus': o['reason'], 'reason_astra': a['reason'],
            'class_opus_inicial': o['class'], 'subclass_opus_inicial': sub(o.get('subclass')),
            'class_astra_inicial': a['class'], 'subclass_astra_inicial': sub(a['subclass']),
        })
        if gold_txt and cid in GOLDEN_DE_OUTRO_PR and not iss['gids']:
            # Erro do gabarito de origem, nao alucinacao de modelo: FP sem subclasse.
            reg.update(goldenDeOutroPr=True, subclass=None)
        for m, ids in found.items():
            for sid in ids: sugestoes[f'{m}|{cid}|{sid}'] = k
        alvo = revisao if status == 'human_review' else golden if cls == 'TP' else fps
        alvo.setdefault(cid, []).append(reg)
        cont[(status, cls, sc)] += 1
# Rodadas de finder posteriores (ex.: GPT com o sandbox E2B): cada sugestao nova casada por Opus
# e Astra (cegos, debate no desacordo) com um problema que ja existe herda o problema; so o que
# nenhum dos dois casou vira problema novo, classificado do mesmo jeito.
RODADAS = {'e2b': 'gpt-6.1-sol@e2b'}
for pasta, chave in RODADAS.items():
    R = f'{W}/{pasta}'
    if not os.path.exists(f'{R}/opus-classif.json'):
        continue
    import glob
    op = {}
    for f in glob.glob(f'{R}/opus-out*.json'): op.update(json.load(open(f)))
    ast = {json.load(open(f))['caseId']: {x['id']: x for x in json.load(open(f))['items']} for f in glob.glob(f'{R}/astra/*.json')}
    deb = json.load(open(f'{R}/debate-casamento.json'))
    oc = json.load(open(f'{R}/opus-classif.json'))
    ac = {x['issueId']: x for f in glob.glob(f'{R}/astra-classif/*.json') for x in json.load(open(f))['items']}
    dsev = json.load(open(f'{R}/debate-severidade.json'))
    novos = json.load(open(f'{R}/classif-in.json'))
    porId = {r['issueId']: r for d in (golden, fps, revisao) for l in d.values() for r in l}
    for cid, L in op.items():
        for x in L:
            a = ast[cid][x['id']]
            fim = x['match'] if x['match'] == a['match'] else deb[cid][x['id']]['final']
            if fim != 'new':
                sugestoes[f'{chave}|{cid}|{x["id"]}'] = fim
                porId[fim].setdefault('foundBy', {}).setdefault(chave, []).append(x['id'])
    for cid, p in novos.items():
        for it in p['issues']:
            k = it['issueId']; o = oc[k]; a = ac[k]
            assert (o['class'], o['subclass']) == (a['class'], sub(a['subclass'])), f'{k}: classe sem consenso'
            N = {'low': 0, 'medium': 1, 'high': 2, 'critical': 3}
            reg = {'issueId': k, 'caseId': cid, 'comment': o['comment'], 'commentOpus': o['comment'],
                   'class': o['class'], 'subclass': o['subclass'], 'status': 'agreed',
                   'severity': o['severity'], 'category': o['category'] if o['class'] == 'TP' else None, 'source': 'kodus', 'martianRef': [],
                   'foundBy': {chave: [c['gid'].split(':')[1] for c in it['comentarios']]},
                   'reason_opus': o['reason'], 'reason_astra': a['reason'],
                   'class_opus_inicial': o['class'], 'subclass_opus_inicial': o['subclass'],
                   'class_astra_inicial': a['class'], 'subclass_astra_inicial': sub(a['subclass']), 'rodada': pasta}
            # severidade: 1 nivel de diferenca fica com o Opus; 2+ discutido, e sem consenso vai para revisao humana
            if abs(N[o['severity']] - N[a['severity']]) >= 2 and k in dsev:
                if dsev[k].get('humano'):
                    reg.update(severity=dsev[k]['humano'], severidadeHumana={'opus': o['severity'], 'astra': a['severity'], 'nota': dsev[k].get('nota')})
                else:
                    reg['severidadeEmRevisao'] = {'opus': o['severity'], 'astra': a['severity']}
            for c in it['comentarios']:
                sugestoes[f'{chave}|{cid}|{c["gid"].split(":")[1]}'] = k
            (golden if o['class'] == 'TP' else fps).setdefault(cid, []).append(reg)
            cont[(f'{pasta}:agreed', o['class'], o['subclass'])] += 1

# Rodadas pontuadas pelo juiz Opus contra os TPs do gold v3 (o padrao desde 17/10/26): a sugestao
# que o juiz casou com um TP herda o TP; o que ele marcou como novo foi agrupado por problema e
# classificado por Opus e Astra as cegas, com debate (trabalho/<pasta>/debate/estado.json).
RODADAS_JUIZ = {'sncc': 'sonnet-5.5@cc', 'opa': 'opus-5.5@api', 'oph': 'opus-5.5@api'}
for pasta, chave in RODADAS_JUIZ.items():
    R = f'{W}/{pasta}'
    if not os.path.exists(f'{R}/debate/estado.json'):
        continue
    import glob
    op, oc = {}, {}
    for f in glob.glob(f'{R}/opus-out*.json'): op.update(json.load(open(f)))
    for f in glob.glob(f'{R}/opus-classif*.json'): oc.update(json.load(open(f)))
    ac = {x['issueId']: x for f in glob.glob(f'{R}/astra-classif/*.json') for x in json.load(open(f))['items']}
    D2 = json.load(open(f'{R}/debate/estado.json'))
    novos = json.load(open(f'{R}/classif-in.json'))
    porId = {r['issueId']: r for d in (golden, fps, revisao) for l in d.values() for r in l}
    for cid, L in op.items():
        for x in L:
            if x['match'] != 'new':
                sugestoes[f'{chave}|{cid}|{x["id"]}'] = x['match']
                porId[x['match']].setdefault('foundBy', {}).setdefault(chave, []).append(x['id'])
    for cid, p in novos.items():
        for it in p['issues']:
            k = it['issueId']; o = oc[k]; a = ac[k]
            reg = {'issueId': k, 'caseId': cid, 'comment': o['comment'], 'commentOpus': o['comment'], 'source': 'kodus', 'martianRef': [],
                   'foundBy': {chave: [c['gid'].split(':')[1] for c in it['comentarios']]},
                   'reason_opus': o['reason'], 'reason_astra': a['reason'],
                   'class_opus_inicial': o['class'], 'subclass_opus_inicial': o['subclass'],
                   'class_astra_inicial': a['class'], 'subclass_astra_inicial': sub(a['subclass']), 'rodada': pasta}
            if k in D2:
                d = D2[k]
                assert d.get('fechado'), f'{k}: debate em aberto'
                fo = next(h for h in reversed(d['hist']) if h['who'] == 'opus')
                cls, sc, sev, status = fo['class'], sub(fo['subclass']), fo['severity'], 'agreed_after_debate'
                reg['debate'] = [{'quem': h['who'], 'class': h['class'], 'subclass': sub(h['subclass']), 'severity': sub(h['severity']), 'texto': h['text']} for h in d['hist']]
            else:
                assert (o['class'], o['subclass']) == (a['class'], sub(a['subclass'])), f'{k}: classe sem consenso'
                cls, sc, sev, status = o['class'], o['subclass'], o['severity'], 'agreed'
            reg.update({'class': cls, 'subclass': sc, 'status': status, 'severity': sev, 'category': o['category'] if cls == 'TP' else None})
            for c in it['comentarios']:
                sugestoes[f'{chave}|{cid}|{c["gid"].split(":")[1]}'] = k
            (golden if cls == 'TP' else fps).setdefault(cid, []).append(reg)
            cont[(f'{pasta}:{status}', cls, sc)] += 1

# Baseline de producao (main 1a7041085, light), 4 modelos, juiz Opus conferido pelo Astra
# (trabalho/prod/<modelo>): o que casou com TP herda o TP; o resto passou contra os FPs
# conhecidos do PR (prod/<modelo>/fp); o que seguiu novo foi agrupado entre os modelos e
# classificado por Opus e Astra as cegas, com debate (trabalho/prod/pool). Em divergencia
# de casamento vale o Opus.
RODADAS_PROD = {'ds': 'deepseek-v4.1-flash@prod', 'gpt': 'gpt-6.1-sol@prod', 'opus': 'opus-5.5@prod', 'sonnet': 'sonnet-5.5@prod'}
if os.path.exists(f'{W}/prod/pool/debate/estado.json'):
    import glob
    porId = {r['issueId']: r for d in (golden, fps, revisao) for l in d.values() for r in l}
    for k, chave in RODADAS_PROD.items():
        for cid, m in json.load(open(f'{W}/prod/{k}/casamento-tp.json'))['tp'].items():
            for sid, iss in m.items():
                sugestoes[f'{chave}|{cid}|{sid}'] = iss
                porId[iss].setdefault('foundBy', {}).setdefault(chave, []).append(sid)
        for cid, L in json.load(open(f'{W}/prod/{k}/fp/opus-out0.json')).items():
            for x in L:
                if x['match'] != 'new':
                    sugestoes[f'{chave}|{cid}|{x["id"]}'] = x['match']
                    porId[x['match']].setdefault('foundBy', {}).setdefault(chave, []).append(x['id'])
    R = f'{W}/prod/pool'
    oc = {}
    for f in glob.glob(f'{R}/opus-classif*.json'): oc.update(json.load(open(f)))
    ac = {x['issueId']: x for f in glob.glob(f'{R}/astra-classif/*.json') for x in json.load(open(f))['items']}
    D2 = json.load(open(f'{R}/debate/estado.json'))
    for cid, p in json.load(open(f'{R}/classif-in.json')).items():
        for it in p['issues']:
            k = it['issueId']; o = oc[k]; a = ac[k]
            fb = collections.defaultdict(list)
            for c in it['comentarios']:
                mk, sid = c['gid'].split('-', 1)[1].split(':')
                fb[RODADAS_PROD[mk]].append(sid)
                sugestoes[f'{RODADAS_PROD[mk]}|{cid}|{sid}'] = k
            reg = {'issueId': k, 'caseId': cid, 'comment': o['comment'], 'commentOpus': o['comment'], 'source': 'kodus', 'martianRef': [],
                   'foundBy': dict(fb), 'reason_opus': o['reason'], 'reason_astra': a['reason'],
                   'class_opus_inicial': o['class'], 'subclass_opus_inicial': o['subclass'],
                   'class_astra_inicial': a['class'], 'subclass_astra_inicial': sub(a['subclass']), 'rodada': 'prod'}
            if k in D2:
                d = D2[k]
                assert d.get('fechado'), f'{k}: debate em aberto'
                fo = next(h for h in reversed(d['hist']) if h['who'] == 'opus')
                cls, sc, sev = fo['class'], sub(fo['subclass']), fo['severity']
                status = 'human_decision' if d['fechado'] == 'humano' else 'agreed_after_debate'
                if d.get('decisaoHumana'): reg['decisaoHumana'] = d['decisaoHumana']
                reg['debate'] = [{'quem': h['who'], 'class': h['class'], 'subclass': sub(h['subclass']), 'severity': sub(h['severity']), 'texto': h['text']} for h in d['hist']]
            else:
                assert (o['class'], o['subclass']) == (a['class'], sub(a['subclass'])), f'{k}: classe sem consenso'
                cls, sc, sev, status = o['class'], o['subclass'], o['severity'], 'agreed'
            reg.update({'class': cls, 'subclass': sc, 'status': status, 'severity': sev, 'category': (o['category'] or 'bug') if cls == 'TP' else None})
            (golden if cls == 'TP' else fps).setdefault(cid, []).append(reg)
            cont[(f'prod:{status}', cls, sc)] += 1

# Rodadas novas de um modelo so, no processo do baseline de producao: juiz Opus conferido pelo
# Astra (o Opus decide), segunda passada contra os FPs conhecidos (<pasta>/fp), e o que seguiu
# novo classificado por Opus e Astra as cegas, com debate (<pasta>/debate).
RODADAS_FP = {'snapi': 'sonnet-5.5@sdkapi', 'snloop': 'sonnet-5.5@loop', 'prod/muse': 'muse-spark-1.3@prod', 'muse13': 'muse-spark-1.3@novo', 'kimi': 'kimi-k2.7-code@novo', 'prod/kimi': 'kimi-k2.7-code@prod'}
for pasta, chave in RODADAS_FP.items():
    R = f'{W}/{pasta}'
    if not os.path.exists(f'{R}/debate/estado.json'):
        continue
    import glob
    porId = {r['issueId']: r for d in (golden, fps, revisao) for l in d.values() for r in l}
    casados = dict(json.load(open(f'{R}/casamento-tp.json'))['tp'])
    for cid, L in json.load(open(f'{R}/fp/opus-out0.json')).items():
        for x in L:
            if x['match'] != 'new': casados.setdefault(cid, {})[x['id']] = x['match']
    for cid, m in casados.items():
        for sid, iss in m.items():
            sugestoes[f'{chave}|{cid}|{sid}'] = iss
            porId[iss].setdefault('foundBy', {}).setdefault(chave, []).append(sid)
    oc = {}
    for f in glob.glob(f'{R}/opus-classif*.json'): oc.update(json.load(open(f)))
    ac = {x['issueId']: x for f in glob.glob(f'{R}/astra-classif/*.json') for x in json.load(open(f))['items']}
    D2 = json.load(open(f'{R}/debate/estado.json'))
    for cid, p in json.load(open(f'{R}/classif-in.json')).items():
        for it in p['issues']:
            k = it['issueId']; o = oc[k]; a = ac[k]
            reg = {'issueId': k, 'caseId': cid, 'comment': o['comment'], 'commentOpus': o['comment'], 'source': 'kodus', 'martianRef': [],
                   'foundBy': {chave: [c['gid'].split(':')[1] for c in it['comentarios']]},
                   'reason_opus': o['reason'], 'reason_astra': a['reason'],
                   'class_opus_inicial': o['class'], 'subclass_opus_inicial': o['subclass'],
                   'class_astra_inicial': a['class'], 'subclass_astra_inicial': sub(a['subclass']), 'rodada': pasta}
            if k in D2:
                d = D2[k]
                assert d.get('fechado'), f'{k}: debate em aberto'
                fo = next(h for h in reversed(d['hist']) if h['who'] == 'opus')
                cls, sc, sev = fo['class'], sub(fo['subclass']), fo['severity']
                status = 'human_decision' if d['fechado'] == 'humano' else 'agreed_after_debate'
                if d.get('decisaoHumana'): reg['decisaoHumana'] = d['decisaoHumana']
                reg['debate'] = [{'quem': h['who'], 'class': h['class'], 'subclass': sub(h['subclass']), 'severity': sub(h['severity']), 'texto': h['text']} for h in d['hist']]
            else:
                assert (o['class'], o['subclass']) == (a['class'], sub(a['subclass'])), f'{k}: classe sem consenso'
                cls, sc, sev, status = o['class'], o['subclass'], o['severity'], 'agreed'
            reg.update({'class': cls, 'subclass': sc, 'status': status, 'severity': sev, 'category': (o['category'] or 'bug') if cls == 'TP' else None})
            for c in it['comentarios']:
                sugestoes[f'{chave}|{cid}|{c["gid"].split(":")[1]}'] = k
            (golden if cls == 'TP' else fps).setdefault(cid, []).append(reg)
            cont[(f'{pasta}:{status}', cls, sc)] += 1

# Finder da producao (main 1a7041085, light): o loopFindings de cada PR, antes do dedup, do verify e do corte por
# severidade (trabalho/prod-finder/<modelo>/finder.json, chave L<i> na ordem do loop). O que a producao publicou herda
# o problema da sugestao publicada (@prod); o que ela cortou passou pelo juiz Opus contra os TPs e TP nits (opus-out*),
# depois contra os FPs conhecidos (fp-out.json), e o que seguiu novo foi classificado por Opus e Astra as cegas, com debate.
RODADAS_FINDER = {'ds': 'deepseek-v4.1-flash', 'gpt': 'gpt-6.1-sol', 'opus': 'opus-5.5', 'sonnet': 'sonnet-5.5', 'muse': 'muse-spark-1.3', 'kimi': 'kimi-k2.7-code'}
R = f'{W}/prod-finder'
if os.path.exists(f'{R}/debate/estado.json'):
    import glob
    porId = {r['issueId']: r for d in (golden, fps, revisao) for l in d.values() for r in l}
    fin = {k: json.load(open(f'{R}/{k}/finder.json')) for k in RODADAS_FINDER}
    deC = {(k, cid, it['cortado']): it['id'] for k, p in fin.items() for cid, l in p.items() for it in l if 'cortado' in it}
    oc = json.load(open(f'{R}/opus-classif.json'))
    ac = {x['issueId']: x for f in glob.glob(f'{R}/astra-classif/*.json') for x in json.load(open(f))['items']}
    D2 = json.load(open(f'{R}/debate/estado.json'))
    for cid, p in json.load(open(f'{R}/classif-in.json')).items():
        for it in p['issues']:
            k = it['issueId']; o = oc[k]; a = ac[k]
            mk, cn = it['comentarios'][0]['gid'].split(':'); mk = mk.split('-', 1)[1]
            reg = {'issueId': k, 'caseId': cid, 'comment': o['comment'], 'commentOpus': o['comment'], 'source': 'kodus', 'martianRef': [],
                   'foundBy': {f'{RODADAS_FINDER[mk]}@prod-finder': [deC[(mk, cid, cn)]]},
                   'reason_opus': o['reason'], 'reason_astra': a['reason'],
                   'class_opus_inicial': o['class'], 'subclass_opus_inicial': o['subclass'],
                   'class_astra_inicial': a['class'], 'subclass_astra_inicial': sub(a['subclass']), 'rodada': 'prod-finder'}
            if k in D2:
                d = D2[k]
                assert d.get('fechado'), f'{k}: debate em aberto'
                fo = next(h for h in reversed(d['hist']) if h['who'] == 'opus')
                cls, sc, sev = fo['class'], sub(fo['subclass']), fo['severity']
                status = 'human_decision' if d['fechado'] == 'humano' else 'agreed_after_debate'
                if d.get('decisaoHumana'): reg['decisaoHumana'] = d['decisaoHumana']
                reg['debate'] = [{'quem': h['who'], 'class': h['class'], 'subclass': sub(h['subclass']), 'severity': sub(h['severity']), 'texto': h['text']} for h in d['hist']]
            else:
                assert (o['class'], o['subclass']) == (a['class'], sub(a['subclass'])), f'{k}: classe sem consenso'
                cls, sc, sev, status = o['class'], o['subclass'], o['severity'], 'agreed'
            reg.update({'class': cls, 'subclass': sc, 'status': status, 'severity': sev, 'category': (o['category'] or 'bug') if cls == 'TP' else None})
            (golden if cls == 'TP' else fps).setdefault(cid, []).append(reg)
            porId[k] = reg
            cont[(f'prod-finder:{status}', cls, sc)] += 1
    op = {}
    for f in sorted(glob.glob(f'{R}/opus-out*.json')): op.update(json.load(open(f)))
    fpo = json.load(open(f'{R}/fp-out.json'))
    for mk, model in RODADAS_FINDER.items():
        chave = f'{model}@prod-finder'
        for cid, itens in fin[mk].items():
            for it in itens:
                if 'publicado' in it:
                    iss = sugestoes[f'{model}@prod|{cid}|{it["publicado"]}']
                else:
                    cn, key = it['cortado'], f'{mk}|{cid}'
                    iss = next(x['match'] for x in op[key] if x['id'] == cn)
                    if iss == 'new': iss = next(x['match'] for x in fpo[key] if x['id'] == cn)
                    if iss == 'new': iss = f'{cid}#pf-{mk}-{cn}'
                    if chave not in porId[iss].get('foundBy', {}) or it['id'] not in porId[iss]['foundBy'][chave]:
                        porId[iss].setdefault('foundBy', {}).setdefault(chave, []).append(it['id'])
                sugestoes[f'{chave}|{cid}|{it["id"]}'] = iss

# class_reviewed: a classe com que o gold e medido (regra oficial desde 18/10/26). class e subclass ficam como a
# classificacao original. TP = TP confirmado ou descontinuado no repositorio original (verificacao-upstream.json);
# FP nit = TP pendente ou que nao entrou no original, TP nit e FP; FP hallucination = FP com subclass hallucination.
# Um TP ainda sem conferencia no original fica com class_reviewed null.
UP = {k: t['status'] for p in json.load(open(f'{AQUI}/verificacao-upstream.json'))['prs'].values() for k, t in p['tps'].items()} if os.path.exists(f'{AQUI}/verificacao-upstream.json') else {}
def revisada(r):
    if r['class'] == 'TP' and not r['subclass']:
        return {'confirmado': 'TP', 'descontinuado': 'TP', 'pendente': 'FP nit', 'nao_entrou_no_original': 'FP nit'}.get(UP.get(r['issueId']))
    if r['class'] == 'FP' and r['subclass'] == 'hallucination':
        return 'FP hallucination'
    return 'FP nit' if r['class'] in ('TP', 'FP') else None
for d in (golden, fps, revisao):
    for l in d.values():
        for r in l: r['class_reviewed'] = revisada(r)

meta = {'versao': 'v3', 'prs': len(A), 'modelos': list(ABR.values()) + list(RODADAS.values()) + list(RODADAS_JUIZ.values()) + list(RODADAS_PROD.values()) + list(RODADAS_FP.values()) + [f'{m}@prod-finder' for m in RODADAS_FINDER.values()], 'classificadores': ['claude-opus-5.5', 'gpt-6-astra'],
        'regua': 'TP = o problema existe no codigo do head e o PR o introduz ou mexe no codigo envolvido; FP = nao ha problema a reportar no PR',
        'regua_class_reviewed': 'Medir pelo class_reviewed. TP = TP confirmado ou descontinuado no repositorio original; FP nit = TP pendente ou que nao entrou no original, TP nit e FP; FP hallucination = o fato alegado e falso. Cada TP conta uma vez: a segunda sugestao sobre o mesmo TP conta como FP nit.'}
for nome, dados in [('golden', golden), ('fps-conhecidos', fps), ('revisao-humana', revisao)]:
    json.dump({**meta, 'prs': dados}, open(f'{AQUI}/{nome}.json', 'w'), indent=1, ensure_ascii=False)
json.dump({**meta, 'sugestoes': sugestoes}, open(f'{AQUI}/sugestoes.json', 'w'), indent=1, ensure_ascii=False)
n = lambda d: sum(len(v) for v in d.values())
print('golden', n(golden), '| fps', n(fps), '| revisao', n(revisao), '| sugestoes mapeadas', len(sugestoes))
print('class_reviewed', dict(collections.Counter(r['class_reviewed'] for d in (golden, fps) for l in d.values() for r in l)))
for k, v in sorted(cont.items(), key=lambda t: str(t[0])): print(' ', k, v)
