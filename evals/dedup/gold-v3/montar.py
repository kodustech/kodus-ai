#!/usr/bin/env python3
"""Gabarito v3 (#1821): um problema unico por PR, juntando o que os quatro finders
acharam (DeepSeek, GPT Sol, Sonnet, Muse 1.3) com os goldens da Martian, cada
problema classificado lendo o codigo por Opus e Astra (gpt-6-astra), com ate tres
rodadas de discussao nas divergencias.

Saidas (nesta pasta):
  golden.json            TPs (o gabarito): o que um revisor deveria apontar; subclass "nit" marca os triviais
  fps-conhecidos.json    FPs conhecidos (subclass "hallucination" quando o fato alegado e falso)
  revisao-humana.json    sem consenso depois das tres rodadas; decidir na pagina de revisao
  sugestoes.json         cada sugestao do finder (modelo, PR, id) -> problema

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
meta = {'versao': 'v3', 'prs': len(A), 'modelos': list(ABR.values()), 'classificadores': ['claude-opus-5.5', 'gpt-6-astra'],
        'regua': 'TP = o problema existe no codigo do head e o PR o introduz ou mexe no codigo envolvido; FP = nao ha problema a reportar no PR'}
for nome, dados in [('golden', golden), ('fps-conhecidos', fps), ('revisao-humana', revisao)]:
    json.dump({**meta, 'prs': dados}, open(f'{AQUI}/{nome}.json', 'w'), indent=1, ensure_ascii=False)
json.dump({**meta, 'sugestoes': sugestoes}, open(f'{AQUI}/sugestoes.json', 'w'), indent=1, ensure_ascii=False)
n = lambda d: sum(len(v) for v in d.values())
print('golden', n(golden), '| fps', n(fps), '| revisao', n(revisao), '| sugestoes mapeadas', len(sugestoes))
for k, v in sorted(cont.items(), key=lambda t: str(t[0])): print(' ', k, v)
