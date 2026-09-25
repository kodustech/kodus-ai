#!/usr/bin/env python3
"""Relatorio unico de uma rodada. Responde TODAS as perguntas do protocolo a
partir dos artefatos ja gravados — nenhuma chamada de LLM.

REGRA QUE NAO SE NEGOCIA: o universo sao os 30 PRs do conjunto leve, sempre.
Um PR que nao gerou candidato nenhum entra na conta com 0 achados e os goldens
dele no denominador. Toda tabela de 29 PRs que saiu daqui antes veio de iterar
as chaves de um artefato em vez de iterar o conjunto — o artefato perdia o PR
vazio, o denominador encolhia e o recall subia de graca.

  python3 relatorio.py --run=<nome> [--secao=tempo|tokens|prereducer|agentes|formula]
"""
import json, math, os, sys, statistics as st

AQUI = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(AQUI, 'results')
POOLS = os.environ.get('POOL_ROOT', os.path.join(AQUI, 'pools'))
CORE = {'bug','security','concurrency','data','api','perf','test_gap','doc_defect'}
SEVN = {'low':.25,'medium':.5,'high':.75,'critical':1.0}
CROSS = 'micro-changed-files-disagree'
LIM = float(os.environ.get('REL_LIMIAR', '0.22'))
COTAS = (3,4,5,6,7)
BASE_FEATS = ['nota','ver','prod','conf','tam','sev','nag','vies']

def arg(n, d=None):
    for a in sys.argv[1:]:
        if a.startswith(f'--{n}='): return a[len(n)+3:]
    return d

RUN = arg('run')
if not RUN: sys.exit('uso: relatorio.py --run=<nome>')

OS30 = json.load(open(os.path.join(AQUI,'light-30.json')))
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
    rev, f0, f1 = [], [], []
    faltando = []
    for cid in OS30:
        j = dump(cid)
        if not j: faltando.append(cid); continue
        t = j.get('trace') or {}
        if t.get('reviewWallMs'): rev.append(t['reviewWallMs'])
        ps = t.get('recallPasses') or []
        com_inicio = [p for p in ps if p.get('startMs') is not None and p.get('ms')]
        sim = [p for p in com_inicio if 'simulate' in p['label']]
        mic = [p for p in com_inicio if 'simulate' not in p['label']]
        if mic: f0.append(max(p['startMs']+p['ms'] for p in mic) - min(p['startMs'] for p in mic))
        if sim: f1.append(max(p['startMs']+p['ms'] for p in sim) - min(p['startMs'] for p in sim))
    linhas = [('revisao inteira (parede)', rev),
              ('fase 0 · 13 microagentes', f0),
              ('fase 1 · simulacao', f1)]
    for nome, art in [('atribuidor','seletor'), ('veracidade','score2'), ('verify 8 passos','verify')]:
        j = carregar(art, obrig=False)
        if not j: continue
        if art == 'score2':
            ms = [v for k,v in (j.get('ms') or {}).items() if k in OS30]
        else:
            ms = [v['ms'] for k,v in j['saida'].items() if k in OS30 and v.get('ms')]
        linhas.append((nome, ms))
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
    print('\n== PRE-REDUCER ==  (perfil core; cada candidato conta como comentario postado)')
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
    print('   secao pre-reducer, que conta goldens cobertos.)')
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

# ---------------------------------------------------------------- formula
def fit(am, feats, it=300, lr=.5, reg=.01):
    w = {k:0.0 for k in feats}
    for _ in range(it):
        gr = {k:0.0 for k in feats}
        for f,y in am:
            z = sum(w[k]*f.get(k,0.) for k in feats)
            e = 1/(1+math.exp(-max(-30,min(30,z)))) - y
            for k in feats: gr[k] += e*f.get(k,0.)
        n = len(am) or 1
        for k in feats: w[k] -= lr*(gr[k]/n + reg*w[k])
    return w

def prob(w,f):
    z = sum(w[k]*f.get(k,0.) for k in w)
    return 1/(1+math.exp(-max(-30,min(30,z))))

def montar_grupos(fonte):
    """fonte: 'ver' | 'verify' | 'ambos'."""
    dados = carregar_matriz()
    SEL = carregar('seletor')['saida']
    VER = (carregar('score2', obrig=(fonte in ('ver','ambos'))) or {}).get('saida', {})
    VFY = (carregar('verify', obrig=(fonte in ('verify','ambos'))) or {}).get('saida', {})
    out = {}
    for cid in OS30:
        d = dados[cid]
        cands = d['cands']
        keep = [i for i,c in enumerate(cands)
                if str(c.get('severity','')).lower() in SEVN and c.get('reason')]
        core = [i for i,g in enumerate(d['gs']) if g.get('category') in CORE]
        dono = {}
        for gi in core:
            linha_c = d['conf'][gi] if gi < len(d['conf']) else []
            b,q = 0,-1
            for pos,ci in enumerate(keep):
                x = linha_c[ci] if ci < len(linha_c) else 0
                if x > b: b,q = x,pos
            if q >= 0: dono[gi] = q
        gr = []
        vfy_pr = {g.get('representante'): g.get('score') for g in (VFY.get(cid,{}).get('grupos') or [])}
        for g in (SEL.get(cid,{}).get('grupos') or []):
            idx = [i for i in (g.get('indices') or []) if i < len(keep)]
            if not idx: continue
            mem = [cands[keep[i]] for i in idx]
            ags = {m.get('producedBy') for m in mem}
            rep = g.get('representante', idx[0])
            orig = keep[rep] if rep < len(keep) else rep
            nota = (g.get('nota') or 0)/100
            v_ver = VER.get(cid,{}).get(str(orig))
            v_ver = (v_ver if v_ver is not None else 50)/100
            v_sc = vfy_pr.get(rep)
            v_sc = (v_sc if v_sc is not None else 50)/100
            base = v_sc if fonte == 'verify' else v_ver
            f = {'nota':nota,'ver':base,'prod':nota*base,
                 'conf':max((m.get('confidence') or 0) for m in mem)/100,
                 'tam':min(len(idx),4)/4,
                 'sev':max(SEVN.get(str(m.get('severity','')).lower(),.5) for m in mem),
                 'nag':min(len(ags),3)/3,'vies':1.0}
            if fonte == 'ambos':
                f['vscore'] = v_sc; f['prodsc'] = nota*v_sc
            cobre = [gi for gi,pos in dono.items() if pos in idx]
            gr.append({'f':f,'cobre':cobre,'core':cobre})
        out[cid] = {'g':gr,'core':len(core)}
    return out

def avaliar(dados, feats, pesos=None):
    prs = OS30
    probs = {}
    if pesos:
        for c in prs: probs[c] = [prob(pesos,g['f']) for g in dados[c]['g']]
    else:
        for fora in prs:
            am = [(g['f'], 1.0 if g['core'] else 0.0)
                  for c in prs if c != fora for g in dados[c]['g']]
            w = fit(am, feats)
            probs[fora] = [prob(w,g['f']) for g in dados[fora]['g']]
    linhas = []
    for K in COTAS:
        tp=fp=tot=n=0
        for c in prs:
            tot += dados[c]['core']; cob = set()
            ordem = sorted(range(len(dados[c]['g'])), key=lambda i: -probs[c][i])[:K]
            for i in ordem:
                if probs[c][i] < LIM: continue
                n += 1; g = dados[c]['g'][i]
                if g['core']: cob.update(g['core'])
                elif not g['cobre']: fp += 1
            tp += len(cob)
        r = tp/max(1,tot); p = tp/max(1,tp+fp)
        linhas.append((K,tp,fp,r,p,2*r*p/max(1e-9,r+p),5*r*p/max(1e-9,4*p+r),n/len(prs)))
    return linhas

def tabela(nome, linhas):
    print(f'\n{nome}')
    print(f'{"corte":>6}{"tp":>5}{"fp":>5}{"recall":>9}{"precis":>9}{"F1":>8}{"F2":>8}{"cmt/PR":>8}')
    for K,tp,fp,r,p,f1,f2,cpr in linhas:
        print(f'{K:>6}{tp:>5}{fp:>5}{r:>8.1%}{p:>9.1%}{f1:>8.3f}{f2:>8.3f}{cpr:>8.1f}')

def secao_formula():
    print(f'\n== FORMULA ==  (limiar {LIM}; pesos SEMPRE reajustados leave-one-out por PR —')
    print('   o PR avaliado nunca entra no fit. E o mesmo regime de todas as simulacoes')
    print('   anteriores; os pesos publicados nao entram aqui para nao haver dois numeros.)')
    a = montar_grupos('ver')
    tabela('A) atribuidor + veracidade', avaliar(a, BASE_FEATS))
    b = montar_grupos('ambos')
    tabela('B) atribuidor + veracidade + verify', avaliar(b, BASE_FEATS+['vscore','prodsc']))
    c = montar_grupos('verify')
    tabela('C) atribuidor + verify (sem veracidade)', avaliar(c, BASE_FEATS))

SECOES = {'tempo':secao_tempo,'tokens':secao_tokens,'prereducer':secao_prereducer,
          'agentes':secao_agentes,'formula':secao_formula}
if __name__ == '__main__':
    pedida = arg('secao')
    print(f'rodada: {RUN}   universo: {len(OS30)} PRs / 120 goldens (111 core)')
    for nome, fn in SECOES.items():
        if pedida and pedida != nome: continue
        try: fn()
        except SystemExit as e: print(f'\n[{nome}] {e}')
