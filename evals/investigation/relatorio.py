#!/usr/bin/env python3
"""Relatorio unico de uma rodada. Responde TODAS as perguntas do protocolo a
partir dos artefatos ja gravados — nenhuma chamada de LLM.

REGRA QUE NAO SE NEGOCIA: o universo sao os 30 PRs do conjunto leve, sempre.
Um PR que nao gerou candidato nenhum entra na conta com 0 achados e os goldens
dele no denominador. Toda tabela de 29 PRs que saiu daqui antes veio de iterar
as chaves de um artefato em vez de iterar o conjunto — o artefato perdia o PR
vazio, o denominador encolhia e o recall subia de graca.

  python3 relatorio.py --run=<nome> [--secao=tempo|tokens|prereducer|agentes]
"""
import json, os, sys, statistics as st

AQUI = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(AQUI, 'results')
POOLS = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))
CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
CROSS = 'micro-changed-files-disagree'

def arg(n, d=None):
    for a in sys.argv[1:]:
        if a.startswith(f'--{n}='): return a[len(n)+3:]
    return d

RUN = arg('run')
if not RUN: sys.exit('uso: relatorio.py --run=<nome>')

OS30 = json.load(open(os.path.join(AQUI,'light-30.json')))
# REL_SO=arquivo.json (lista de caseIds): mede so esses PRs — para comparar com
# uma rodada incompleta nos MESMOS PRs (ex.: GPT cortado pela cota em 27/09).
if os.environ.get('REL_SO'):
    _so = set(json.load(open(os.environ['REL_SO'])))
    OS30 = [c for c in OS30 if c in _so]
GOLD = {p['caseId']: p.get('comments') or []
        for p in json.load(open(os.path.join(AQUI,'../benchmark-sets/v002/goldens.json')))['prs']}

def carregar(nome, obrig=True):
    p = os.path.join(R, f'{nome}-{RUN}.json')
    if not os.path.exists(p):
        if obrig: sys.exit(f'falta {p}')
        return None
    return json.load(open(p))

def dump(cid):
    p = os.path.join(POOLS, RUN, f'{cid}.raw.txt')
    return json.load(open(p)) if os.path.exists(p) else None

def resumo(vals, div=1.0, suf=''):
    if not vals: return 'sem dado'
    v = sorted(x/div for x in vals)
    return (f'menor {v[0]:,.1f}{suf} · mediana {st.median(v):,.1f}{suf} · '
            f'media {st.mean(v):,.1f}{suf} · maior {v[-1]:,.1f}{suf}')

# ---------------------------------------------------------------- tempo
def secao_tempo():
    print('\n== TEMPO ==  (30 PRs; PR ausente aparece como faltando)')
    rev, fin = [], []
    faltando = []
    for cid in OS30:
        j = dump(cid)
        if not j: faltando.append(cid); continue
        t = j.get('trace') or {}
        if t.get('reviewWallMs'): rev.append(t['reviewWallMs'])
        ps = [p for p in (t.get('recallPasses') or []) if p.get('startMs') is not None and p.get('ms')]
        if ps: fin.append(max(p['startMs']+p['ms'] for p in ps) - min(p['startMs'] for p in ps))
    linhas = [('revisao inteira (parede)', rev),
              ('passadas do finder', fin)]
    print(f'{"fase":<28}{"n":>4}  distribuicao (minutos)')
    for nome, vals in linhas:
        print(f'{nome:<28}{len(vals):>4}  {resumo(vals, 60000, " min")}')
    if faltando: print(f'\n  ! sem dump: {len(faltando)} PRs -> {", ".join(x[:34] for x in faltando)}')

# ---------------------------------------------------------------- tokens
def secao_tokens():
    print('\n== TOKENS POR PR ==  (30 PRs)')
    fresco, cache, out, tot = [], [], [], []
    for cid in OS30:
        j = dump(cid)
        if not j: continue
        u = (j.get('trace') or {}).get('usage') or {}
        i, c, o = u.get('inputTokens',0), u.get('cacheReadTokens',0), u.get('outputTokens',0)
        fresco.append(i-c); cache.append(c); out.append(o); tot.append(i+o)
    for nome, v in [('input fresco (pago)',fresco), ('cache read',cache),
                    ('output',out), ('total (input+output)',tot)]:
        print(f'{nome:<24}{resumo(v)}')
    if fresco:
        print(f'\nsoma da rodada: fresco {sum(fresco):,} · cache {sum(cache):,} · output {sum(out):,}')

# ------------------------------------------------- matriz e regra da metrica
def carregar_matriz():
    M = carregar('matriz')
    dados = {}
    for cid in OS30:
        m = M.get(cid)
        j = dump(cid)
        cands = ((j.get('trace') or {}).get('preFilterCandidates') or []) if j else []
        gs = m['goldens'] if m else [{'comment':g.get('comment'),'category':g.get('category'),
                                      'severity':g.get('severity')} for g in GOLD.get(cid,[])]
        conf = m['conf'] if m else [[] for _ in gs]
        dados[cid] = {'gs':gs,'conf':conf,'cands':cands}
    return dados

def metricas(dados, excluir=()):
    """Regra da metrica: por golden vence o candidato de maior confianca;
       candidato que nao vence nenhum golden e falso positivo."""
    tp=fp=tot=post=0
    for cid in OS30:
        d = dados[cid]
        ok = [k for k,c in enumerate(d['cands']) if (c.get('producedBy') or '') not in excluir]
        post += len(ok)
        core = [i for i,g in enumerate(d['gs']) if g.get('category') in CORE]
        tot += len(core)
        cobre = {k: False for k in ok}
        for gi in range(len(d['gs'])):
            linha = d['conf'][gi] if gi < len(d['conf']) else []
            b,q = 0,-1
            for k in ok:
                x = linha[k] if k < len(linha) else 0
                if x > b: b,q = x,k
            if q >= 0:
                cobre[q] = True
                if gi in core: tp += 1
        fp += sum(1 for k in ok if not cobre[k])
    r = tp/max(1,tot); p = tp/max(1,tp+fp)
    return dict(prs=len(OS30), goldens=tot, cand=post, tp=tp, fp=fp, recall=r, precisao=p,
                f1=2*r*p/max(1e-9,r+p), f2=5*r*p/max(1e-9,4*p+r))

def linha(rot, m):
    print(f'{rot:<38}{m["prs"]:>4}{m["goldens"]:>9}{m["cand"]:>7}{m["tp"]:>5}{m["fp"]:>5}'
          f'{m["recall"]:>8.1%}{m["precisao"]:>9.1%}{m["f1"]:>8.3f}{m["f2"]:>8.3f}')

def secao_prereducer():
    dados = carregar_matriz()
    print('\n== PRE-DEDUP ==  (pos-verify; perfil core; cada candidato conta como comentario postado)')
    print(f'{"":<38}{"PRs":>4}{"goldens":>9}{"cand":>7}{"tp":>5}{"fp":>5}{"recall":>8}{"precis":>9}{"F1":>8}{"F2":>8}')
    linha('com o agente cross-file', metricas(dados))
    linha('SEM o agente cross-file', metricas(dados, excluir={CROSS}))

# ---------------------------------------------------------------- agentes
def secao_agentes():
    dados = carregar_matriz()
    tot_tp, tot_fp, unic_tp, unic_fp = {}, {}, {}, {}
    for cid in OS30:
        d = dados[cid]
        core = {i for i,g in enumerate(d['gs']) if g.get('category') in CORE}
        ganhou, alcanca = {}, {}
        for gi in range(len(d['gs'])):
            linha_c = d['conf'][gi] if gi < len(d['conf']) else []
            b,q = 0,-1
            for k in range(len(d['cands'])):
                x = linha_c[k] if k < len(linha_c) else 0
                if x > 0: alcanca.setdefault(gi,set()).add(d['cands'][k].get('producedBy') or '?')
                if x > b: b,q = x,k
            if q >= 0 and gi in core: ganhou.setdefault(q,set()).add(gi)
        for k,c in enumerate(d['cands']):
            a = c.get('producedBy') or '?'
            if k in ganhou:
                tot_tp[a] = tot_tp.get(a,0)+1
                for gi in ganhou[k]:
                    if alcanca.get(gi) == {a}: unic_tp[a] = unic_tp.get(a,0)+1
            else:
                tot_fp[a] = tot_fp.get(a,0)+1
                # FP unico: nenhum outro agente produziu candidato no mesmo arquivo
                viz = {d['cands'][o].get('producedBy') for o in range(len(d['cands']))
                       if o != k and d['cands'][o].get('relevantFile') == c.get('relevantFile')}
                if not (viz - {a}): unic_fp[a] = unic_fp.get(a,0)+1
    print('\n== POR AGENTE ==  (conta CANDIDATOS, nao goldens: um candidato pode')
    print('   vencer mais de um golden, entao a soma de TP aqui e menor que o tp da')
    print('   secao pre-dedup, que conta goldens cobertos.)')
    print(f'{"agente":<34}{"TP":>5}{"FP":>5}{"prec":>7}{"TP unico":>10}{"FP unico":>10}')
    ags = sorted(set(tot_tp)|set(tot_fp), key=lambda a: -tot_tp.get(a,0))
    for a in ags:
        tp,fp = tot_tp.get(a,0), tot_fp.get(a,0)
        print(f'{a.replace("micro-",""):<34}{tp:>5}{fp:>5}{tp/max(1,tp+fp):>7.0%}'
              f'{unic_tp.get(a,0):>10}{unic_fp.get(a,0):>10}')
    print(f'{"TOTAL":<34}{sum(tot_tp.values()):>5}{sum(tot_fp.values()):>5}'
          f'{sum(tot_tp.values())/max(1,sum(tot_tp.values())+sum(tot_fp.values())):>7.0%}'
          f'{sum(unic_tp.values()):>10}{sum(unic_fp.values()):>10}')
    print('  TP unico = golden que SO este agente alcanca (confianca > 0)')
    print('  FP unico = candidato sem golden e sem nenhum outro agente no mesmo arquivo')

SECOES = {'tempo':secao_tempo,'tokens':secao_tokens,'prereducer':secao_prereducer,
          'agentes':secao_agentes}
def configuracao():
    """A configuracao que produziu a rodada. Um pool com dumps de configuracoes
    diferentes nao descreve configuracao nenhuma (foi assim que o gpt-30, 24 PRs
    de uma rodada e 6 de outra, passou por baseline) — o relatorio para."""
    vistas = {}
    for cid in OS30:
        d = dump(cid)
        if not d: continue
        chave = json.dumps(d.get('config'), sort_keys=True)
        vistas.setdefault(chave, []).append(cid)
    if len(vistas) > 1:
        print('\nABORTADO: esta rodada mistura configuracoes diferentes.')
        for chave, cids in vistas.items():
            print(f'  {len(cids)} PRs com {chave[:300]}')
        sys.exit(2)
    cfg = json.loads(next(iter(vistas))) if vistas else None
    if cfg is None:
        print('config: (dumps anteriores a gravacao de configuracao — nao comparavel com rodadas novas)')
    else:
        print('config: ' + json.dumps({k: v for k, v in cfg.items() if k != 'env'}, sort_keys=True))
    return cfg

if __name__ == '__main__':
    pedida = arg('secao')
    print(f'rodada: {RUN}   universo: {len(OS30)} PRs / 120 goldens (111 core)')
    configuracao()
    for nome, fn in SECOES.items():
        if pedida and pedida != nome: continue
        try: fn()
        except SystemExit as e: print(f'\n[{nome}] {e}')
