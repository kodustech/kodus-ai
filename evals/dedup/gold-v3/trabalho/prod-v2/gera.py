#!/usr/bin/env python3
"""Pagina "Finder no gold v3": producao (V1 e V2) contra o fluxo novo light e heavy, so a etapa do finder.
Aba Geral: placar, cards e tabela de tokens e tempo. Aba Generalista x synthesis rescue: o peso de cada passada no
finder de producao e a experiencia do cliente (finder de producao x novo light), por PR.
  python3 gera.py <saida.html>"""
import json, os, sys, math, html as H
AQUI = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(AQUI, '..', '..'); G2 = os.path.join(V3, '..', 'gold-v2'); INV = os.path.join(V3, '..', '..', 'investigation')
Q1 = json.load(open(f'{AQUI}/../prod-finder/placar-finder-v3.json'))
Q2 = json.load(open(f'{AQUI}/placar.json')) if os.path.exists(f'{AQUI}/placar.json') else {}
sn = json.load(open(f'{V3}/sugestoes.json'))['sugestoes']
cr = {r['issueId']: r['class_reviewed'] for f in ('golden.json', 'fps-conhecidos.json') for l in json.load(open(f'{V3}/{f}'))['prs'].values() for r in l}
TOTAL = sum(1 for v in cr.values() if v == 'TP')
# chave no placar v1, chave da producao V2, nome, via, (modelo, mapa no sugestoes, prefixo light, prefixo heavy)
MODELOS = [('deepseek', 'ds', 'DeepSeek v4.1 Flash', 'via Together', ('deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'gen', 'hv')),
           ('gpt', 'gpt', 'GPT 6.1 Sol', 'via assinatura', ('gpt-6.1-sol', 'gpt-6.1-sol', 'gen', 'hv')),
           ('sonnet-sdk', 'sonnet', 'Sonnet 5.5 via SDK', 'fluxo novo pelo Agent SDK com preset', ('sonnet-5.5', 'sonnet-5.5@cc', 'gensncc', 'hvsncc')),
           ('sonnet-api', 'sonnet', 'Sonnet 5.5 via API', 'fluxo novo pelo loop de produção', ('sonnet-5.5', 'sonnet-5.5@loop', 'gensnloop', 'hvsnloop')),
           ('opus', 'opus', 'Opus 5.5', 'via API', ('opus-5.5', 'opus-5.5@api', 'genopa', 'hvopa')),
           ('muse', 'muse', 'Muse Spark 1.3', 'API da Meta', ('muse-spark-1.3', 'muse-spark-1.3@novo', 'genmuse', 'hvmuse')),
           ('kimi', 'kimi', 'Kimi K2.7 Code', 'OpenRouter, provedor Moonshot AI', ('kimi-k2.7-code', 'kimi-k2.7-code@novo', 'genkimi', 'hvkimi'))]
def pct(v, q):
    v = sorted(v)
    if not v: return None
    k = (len(v) - 1) * q; lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)
PS = (('p50', .5), ('p75', .75), ('p90', .9))
lights = set(json.load(open(f'{INV}/light-30.json')))
tec = lambda pb: 'G' if pb == 'generalist-base' else 'M3' if str(pb).startswith('micro-exp-p3-') else None
def novo(m):
    """Por PR, do fluxo novo light e heavy: tokens e tempo do finder (tokens somados; tempo = a passada mais lenta) e TPs/FPs."""
    model, mapa, gen, hv = m; out = {}
    for modo, P in (('light', gen), ('heavy', hv)):
        s = json.load(open(f'{G2}/{P}_{model}.json')); TECS = ['G'] if modo == 'light' else s.get('tec', 'G,M3').split(',')
        if modo == 'heavy' and TECS == ['G']: TECS = ['G', 'M3']
        pools = dict(zip(s.get('origem', []), s.get('sourcePools', [])))
        uso, pr = {}, {}
        for c in s['prs']:
            pool = pools['09.10.26' if c in lights else 'ho'] if pools else s['sourcePool']
            t = json.load(open(f'{INV}/pools/{pool}/{c}.raw.txt'))['trace']
            ps = [p for p in t.get('recallPasses') or [] if tec(p['label']) in TECS]
            uso[c] = {'input': sum(p.get('inputTokens') or 0 for p in ps), 'cacheRead': sum(p.get('cacheReadTokens') or 0 for p in ps),
                      'output': sum(p.get('outputTokens') or 0 for p in ps), 'ms': max([p.get('ms') or 0 for p in ps] or [0])}
            vistos, tp = set(), 0; itens = s['prs'][c]['suggestions']
            for x in itens:
                i = sn[f'{mapa}|{c}|{x["id"]}']
                if cr[i] == 'TP' and i not in vistos: vistos.add(i); tp += 1
            pr[c] = {'comentarios': len(itens), 'tp': tp, 'fp': len(itens) - tp}
        out[modo] = {'uso': uso, 'porPr': pr}
    return out
NOVO = {m[0]: novo(m[4]) for m in MODELOS}
Q3 = json.load(open(f'{AQUI}/../light-rescue/placar.json')) if os.path.exists(f'{AQUI}/../light-rescue/placar.json') else {}
Q4 = json.load(open(f'{AQUI}/../light-rescue/projecao-heavy.json')) if os.path.exists(f'{AQUI}/../light-rescue/projecao-heavy.json') else {}
Q5 = json.load(open(f'{AQUI}/../light-rescue/x2.json')) if os.path.exists(f'{AQUI}/../light-rescue/x2.json') else {}
def best(m1, m2):
    if not m2: return 'v1'
    return 'v2' if (m2['recall'], m2['f2']) > (m1['recall'], m1['f2']) else 'v1'
esc = H.escape
def d(v, b, inv=False, unit=''):
    x = round(v - b, 1)
    if x == 0: return '<span class="d">±0</span>'
    bom = (x > 0) != inv
    return f'<span class="d {"up" if bom else "dn"}">{"+" if x > 0 else "−"}{abs(x):.1f}{unit}</span>'
def dp(v, b):
    if not b: return ''
    x = round(100 * (v - b) / b)
    if x == 0: return '<span class="d">±0%</span>'
    return f'<span class="d {"dn" if x > 0 else "up"}">{"+" if x > 0 else "−"}{abs(x)}%</span>'
def ktok(v): return '—' if v is None else (f'{v / 1e6:.2f} M' if v >= 1e6 else f'{v / 1e3:.0f} k' if v >= 1e3 else f'{v:.0f}')
def seg(v): return '—' if v is None else f'{v / 1000:.0f} s' if v < 600000 else f'{v / 60000:.1f} min'
def uso_prod(k2):
    q = Q2.get(k2)
    return {c: u['finder'] for c, u in q['uso'].items()} if q else None

# ── Aba Geral: placar ───────────────────────────────────────────────────────
lin = []
for m, k2, nome, via, _ in MODELOS:
    v1 = Q1[f'{m}|producao']; v2 = Q2.get(k2); b = best(v1, v2); base = v2 if b == 'v2' else v1
    rows = [('Produção V1', v1, b == 'v1', False), ('Produção V2', v2, b == 'v2', False), ('Novo light', Q1[f'{m}|light'], False, True)]
    if m != 'sonnet-sdk': rows.append(('Novo light + rescue <span class="tag t12">12</span>', Q3.get(k2), False, True))
    if m in ('deepseek', 'kimi'): rows.append(('Novo light + rescue <span class="tag t20">20</span>', Q3.get(k2 + '20'), False, True))
    rows.append(('Novo heavy', Q1[f'{m}|heavy'], False, True))
    if m != 'sonnet-sdk': rows.append(('Novo heavy + rescue <span class="tag t12">12</span>', Q4.get(k2), False, True))
    if m in ('deepseek', 'kimi'): rows.append(('Novo heavy + rescue <span class="tag t20">20</span>', Q4.get(k2 + '20'), False, True))
    for j, (vn, q, destaque, cmp) in enumerate(rows):
        cls = ' '.join(x for x in ('gtop' if j == 0 else '', 'best' if destaque else '') if x)
        head = f'<th rowspan="{len(rows)}" class="mod">{nome}<span class="via">{via}</span></th>' if j == 0 else ''
        if not q:
            lin.append(f'<tr class="{cls}">{head}<td class="ver">{vn}</td><td colspan="7" class="pend">pendente</td></tr>'); continue
        cel = lambda k: f'<b>{q[k]:.1f}</b>' + (d(q[k], base[k]) if cmp else '')
        lin.append(f'<tr class="{cls}">{head}<td class="ver">{vn}</td><td>{cel("recall")}</td><td>{cel("precisao")}</td><td>{cel("f1")}</td><td>{cel("f2")}</td>'
                   f'<td>{q["tp"]} <span class="frac">/ {q["totalTp"]}</span></td><td>{q["comentarios"]}</td><td>{q["fpNit"]} <span class="frac">/ {q["fpAlucinacao"]}</span></td></tr>')
placar = ''.join(lin)

# ── Aba Geral: tokens e tempo ────────────────────────────────────────────────
MET = (('input', 'Input', ktok), ('cacheRead', 'Cache read', ktok), ('output', 'Output', ktok), ('ms', 'Tempo', seg))
def percs(uso):
    return {k: {p: pct([u[k] for u in uso.values()], q) for p, q in PS} for k, *_ in MET} if uso else None
USO = {}
for m, k2, *_ in MODELOS:
    USO[m] = {'producao': percs(uso_prod(k2)), 'light': percs(NOVO[m]['light']['uso']), 'heavy': percs(NOVO[m]['heavy']['uso']),
              'lr': percs({c: u['finder'] for c, u in Q3[k2]['uso'].items()}) if k2 in Q3 else None}
cards = {}
for p, _ in PS:
    blocos = []
    for m, k2, nome, via, _ in MODELOS:
        u = USO[m]; cs = []
        for k, tit, fmt in MET:
            pv = u['producao'][k][p] if u['producao'] else None
            li = [f'<div class="cl"><span>Produção</span><b>{fmt(pv)}</b></div>']
            for v, vn in (('light', 'Novo light'), ('heavy', 'Novo heavy')):
                x = u[v][k][p]; li.append(f'<div class="cl"><span>{vn}</span><b>{fmt(x)}</b>{dp(x, pv) if pv else ""}</div>')
            cs.append(f'<div class="card"><h4>{tit}</h4>{"".join(li)}</div>')
        blocos.append(f'<div class="crow"><div class="cmod">{nome}</div><div class="cgrid">{"".join(cs)}</div></div>')
    cards[p] = ''.join(blocos)
tl = []
for m, k2, nome, via, _ in MODELOS:
    vs = (('producao', 'Produção V2'), ('light', 'Novo light')) + ((('lr', 'Novo light + rescue'),) if m != 'sonnet-sdk' else ()) + (('heavy', 'Novo heavy'),)
    for j, (v, vn) in enumerate(vs):
        u = USO[m][v]; head = f'<th rowspan="{len(vs)}" class="mod">{nome}</th>' if j == 0 else ''
        if not u: tl.append(f'<tr class="{"gtop" if j == 0 else ""}">{head}<td class="ver">{vn}</td><td colspan="12" class="pend">pendente</td></tr>'); continue
        cel = ''.join(f'<td class="{p} {"sep" if p == "p50" else ""}">{fmt(u[k][p])}</td>' for k, _, fmt in MET for p, _ in PS)
        tl.append(f'<tr class="{"gtop" if j == 0 else ""}">{head}<td class="ver">{vn}</td>{cel}</tr>')
tabtok = ''.join(tl)

# ── Aba Generalista x synthesis rescue ───────────────────────────────────────
ORIG = (('generalist', 'Generalista'), ('synthesis-rescue', 'Synthesis rescue'))
pa = []
for m, k2, nome, via, _ in MODELOS:
    if m == 'sonnet-api': continue
    q = Q2.get(k2); nm = 'Sonnet 5.5' if k2 == 'sonnet' else nome
    if not q: pa.append(f'<tr class="gtop"><th class="mod">{nm}</th><td colspan="9" class="pend">pendente</td></tr>'); continue
    tot = {k: sum(u[o][k] for u in q['uso'].values() for o, _ in ORIG) for k in ('input', 'output', 'ms')}
    for j, (o, on) in enumerate(ORIG + (('finder', 'Finder inteiro'),)):
        r = q['porOrigem'][o] if o != 'finder' else q
        head = f'<th rowspan="3" class="mod">{nm}</th>' if j == 0 else ''
        if o == 'finder':
            share = '<td>100%</td><td>100%</td><td>100%</td>'; tps = f'{q["tp"]} <span class="frac">/ {TOTAL}</span>'; pt = '100%'
        else:
            s = {k: sum(u[o][k] for u in q['uso'].values()) for k in ('input', 'output', 'ms')}
            share = ''.join(f'<td>{round(100 * s[k] / tot[k]) if tot[k] else 0}%</td>' for k in ('input', 'output', 'ms'))
            tps = f'{r["tp"]} <span class="frac">/ {TOTAL}</span>'; pt = f'{round(100 * r["tp"] / q["tp"]) if q["tp"] else 0}%'
        pa.append(f'<tr class="{"gtop" if j == 0 else ""}{" tot" if o == "finder" else ""}">{head}<td class="ver">{on}</td><td>{r["comentarios"]}</td><td>{tps}</td><td><b>{pt}</b></td>'
                  f'<td>{r["recall"]:.1f}</td><td>{r["precisao"]:.1f}</td>{share}</tr>')
tab_orig = ''.join(pa)
ex = []
for m, k2, nome, via, _ in MODELOS:
    if m == 'sonnet-api': continue
    q = Q2.get(k2); nm = 'Sonnet 5.5' if k2 == 'sonnet' else nome
    if not q: ex.append(f'<tr class="gtop"><th class="mod">{nm}</th><td colspan="4" class="pend">pendente</td></tr>'); continue
    ids = {o: set(q['porOrigem'][o]['tpIds']) for o, _ in ORIG}
    for j, (o, on) in enumerate(ORIG):
        outro = ids['synthesis-rescue' if o == 'generalist' else 'generalist']
        so = ids[o] - outro; ach = len(ids[o])
        head = f'<th rowspan="2" class="mod">{nm}</th>' if j == 0 else ''
        ex.append(f'<tr class="{"gtop" if j == 0 else ""}">{head}<td class="ver">{on}</td><td>{ach}</td><td><b>{len(so)}</b></td><td>{round(100 * len(so) / ach) if ach else 0}%</td></tr>')
tab_excl = ''.join(ex)
DG = json.load(open(f'{AQUI}/diag.json')) if os.path.exists(f'{AQUI}/diag.json') else {}
DGN = {'ds': 'DeepSeek v4.1 Flash', 'gpt': 'GPT 6.1 Sol', 'sonnet': 'Sonnet 5.5 via API', 'opus': 'Opus 5.5', 'muse': 'Muse Spark 1.3', 'kimi': 'Kimi K2.7 Code'}
sg = lambda n: f'+{n}' if n > 0 else (f'−{-n}' if n < 0 else '0')
tab_diag = ''.join(f'<tr class="{"foco" if k in ("muse", "kimi") else ""}"><th class="mod">{DGN[k]}</th><td>{d["prodG"]}</td><td>{d["light"]}</td><td><b>{sg(d["enxuta"])}</b></td><td>{d["rescueX"]}</td><td>{d["lentesX"]}</td><td>{d["prod"]}</td><td>{d["heavy"]}</td><td>{d["prodForaHeavy"]} / {d["heavyForaProd"]}</td><td>{d["repete"]}%</td></tr>' for k, d in DG.items())
DIAG = open(f'{AQUI}/diagnostico.html').read() if os.path.exists(f'{AQUI}/diagnostico.html') else ''
# por passada, por percentil
def percs_o(q, o): return {k: {p: pct([u[o][k] for u in q['uso'].values()], qq) for p, qq in PS} for k, *_ in MET}
porp = {}
for p, _ in PS:
    li = []
    for m, k2, nome, via, _ in MODELOS:
        if m == 'sonnet-api': continue
        q = Q2.get(k2); nm = 'Sonnet 5.5 (light via SDK)' if k2 == 'sonnet' else nome
        rows = []
        if q:
            rows += [(on, percs_o(q, o)) for o, on in ORIG] + [('Finder de produção', USO[m]['producao'])]
        rows.append(('Novo light', USO[m]['light']))
        for j, (vn, u) in enumerate(rows):
            head = f'<th rowspan="{len(rows)}" class="mod">{nm}</th>' if j == 0 else ''
            li.append(f'<tr class="{"gtop" if j == 0 else ""}">{head}<td class="ver">{vn}</td>' + ''.join(f'<td class="{p}">{fmt(u[k][p])}</td>' for k, _, fmt in MET) + '</tr>')
    porp[p] = ''.join(li)
# experiencia do cliente
cli = {}
for p, qq in PS:
    li = []
    for m, k2, nome, via, _ in MODELOS:
        q = Q2.get(k2); rows = []
        if q: rows.append(('Finder de produção (V2)', q['porPr']))
        rows.append(('Novo light', NOVO[m]['light']['porPr']))
        for j, (vn, pr) in enumerate(rows):
            tp = pct([x['tp'] for x in pr.values()], qq); fp = pct([x['fp'] for x in pr.values()], qq); c = pct([x['comentarios'] for x in pr.values()], qq)
            sh = round(100 * tp / (tp + fp)) if tp + fp else 0
            head = f'<th rowspan="{len(rows)}" class="mod">{nome}</th>' if j == 0 else ''
            li.append(f'<tr class="{"gtop" if j == 0 else ""}">{head}<td class="ver">{vn}</td><td>{tp:.1f}</td><td>{fp:.1f}</td><td>{c:.1f}</td>'
                      f'<td><div class="bar"><span style="width:{sh}%"></span></div><b>{sh}%</b> <span class="frac">TP</span></td></tr>')
    cli[p] = ''.join(li)

pend = [nome for m, k2, nome, *_ in MODELOS if k2 not in Q2]
OBS = open(f'{AQUI}/observacoes.html').read() if os.path.exists(f'{AQUI}/observacoes.html') else ''
def ptabs(grupo, conteudo, wrap):
    bt = ''.join(f'<button class="pt{" on" if p == "p75" else ""}" data-g="{grupo}" data-p="{p}">{p.upper()}</button>' for p, _ in PS)
    return f'<div class="ptabs">{bt}</div>' + ''.join(f'<div class="pp" data-g="{grupo}" data-p="{p}"{"" if p == "p75" else " hidden"}>{wrap(conteudo[p])}</div>' for p, _ in PS)
HEAD_TOK = '<tr><th rowspan="2">Modelo</th><th rowspan="2">Versão</th>' + ''.join(f'<th colspan="3" class="grp sep">{t}</th>' for _, t, _ in MET) + '</tr><tr>' + ''.join(f'<th class="{p} {"sep" if p == "p50" else ""}">{p.upper()}</th>' for _ in MET for p, _ in PS) + '</tr>'
CSS = open(f'{AQUI}/estilo.css').read()
html = f'''<title>Finder no gold v3</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400&display=swap">
<style>{CSS}</style>
<div class="wrap">
<h1>Finder no gold v3</h1>
<p class="sub">Só a etapa do finder, antes do dedup e do verify · 50 PRs (light 30 + holdout 20) · gold v3 medido pelo <code>class_reviewed</code> · {TOTAL} TPs{(" · pendentes: " + ", ".join(pend)) if pend else ""}</p>
<nav class="tabs" role="tablist"><button class="tab on" data-t="geral" role="tab">Geral</button><button class="tab" data-t="passadas" role="tab">Generalista × synthesis rescue</button><button class="tab" data-t="diag" role="tab">Diagnóstico Muse e Kimi</button></nav>
<section data-t="geral">
<div class="regra">
<div><b>TP</b><p>Problema do gold que o repositório original corrigiu ou descontinuou. Cada TP conta uma vez.</p></div>
<div><b>FP nit</b><p>TP ainda pendente ou que não entrou no original, TP nit, FP do gold, a segunda sugestão sobre o mesmo TP e o comentário que não casou com nenhum problema do gold.</p></div>
<div><b>FP hallucination</b><p>O fato que o comentário alega é falso.</p></div>
</div>
<p class="leg"><span class="sw"></span>Melhor produção de cada modelo: a de maior recall (F2 desempata). As variações do novo light e do novo heavy são contra ela.</p>
<p class="leg"><span class="tag t12">12</span><span>Limite de passos do novo light padrão: no máximo 12 passos por passada, em todo PR, sem exceção.</span></p>
<p class="leg"><span class="tag t20">20</span><span>Mesma regra de passos da produção: 20 passos, mais 0,5 por arquivo alterado acima de 8, até 100.</span></p>
<h2>Resultado do finder</h2>
<div class="scroll"><table class="t1"><thead><tr><th>Modelo</th><th>Versão</th><th>Recall</th><th>Precisão</th><th>F1</th><th>F2</th><th>TPs achados / total</th><th>Comentários</th><th>FP nit / alucinação</th></tr></thead><tbody>
{placar}
</tbody></table></div>
<p class="foot">Produção V1 e V2: o mesmo finder de produção rodado duas vezes. A V1 é o que saiu do verify interno do finder; a V2 é generalista + synthesis rescue antes dele, julgada só contra o gold. Variação em pontos contra a produção destacada. FP nit e FP hallucination somados são todos os FPs. Sonnet via SDK e via API dividem a mesma produção.</p>
<h2>Tokens e tempo do finder</h2>
<p class="nota">Por PR, nos 50 PRs. Produção: generalista seguido do synthesis rescue (rodada V2, medida só no finder). Novo light: a passada generalista. Novo heavy: generalista + as 9 lentes do M3, tokens somados e tempo da passada mais lenta, porque rodam em paralelo. Variação contra a produção; verde é menos.</p>
{ptabs("cards", cards, lambda x: f'<div class="cards">{x}</div>')}
<div class="scroll"><table class="t2"><thead>{HEAD_TOK}</thead><tbody>
{tabtok}
</tbody></table></div>
<p class="foot">Input inclui o cache read. <span class="k p50"></span>P50 <span class="k p75"></span>P75 <span class="k p90"></span>P90.</p>
</section>
<section data-t="passadas" hidden>
<h2>Dentro do finder de produção</h2>
<p class="nota">O finder de produção é o generalista seguido do synthesis rescue, que relê o que o generalista investigou e procura o que faltou. Quanto cada passada trouxe e quanto custou, nos 50 PRs (Produção V2). Um TP achado pelas duas passadas conta nas duas.</p>
<div class="scroll"><table class="t3"><thead><tr><th>Modelo</th><th>Passada</th><th>Comentários</th><th>TPs achados</th><th>% dos TPs do finder</th><th>Recall</th><th>Precisão</th><th>% do input</th><th>% do output</th><th>% do tempo</th></tr></thead><tbody>
{tab_orig}
</tbody></table></div>
<h3>TPs exclusivos de cada passada</h3>
<p class="nota">TPs achados: todos os que a passada achou. Exclusivos: os que só ela achou, sem a outra passada achar também.</p>
<div class="scroll"><table class="t6"><thead><tr><th>Modelo</th><th>Passada</th><th>TPs achados</th><th>TPs exclusivos</th><th>% exclusivos</th></tr></thead><tbody>
{tab_excl}
</tbody></table></div>
<h3>Por passada, por PR</h3>
<p class="nota">Tokens e tempo de cada passada por PR, ao lado do finder inteiro e do novo light, que substitui o finder de produção na experiência do cliente.</p>
{ptabs("porp", porp, lambda x: f'<div class="scroll"><table class="t4"><thead><tr><th>Modelo</th><th>Versão</th><th>Input</th><th>Cache read</th><th>Output</th><th>Tempo</th></tr></thead><tbody>{x}</tbody></table></div>')}
<h2>O que chega ao cliente: finder de produção × novo light</h2>
<p class="nota">Hoje o cliente recebe o finder de produção (generalista + synthesis rescue); com a troca passa a receber o novo light. Por PR, no percentil escolhido: quantos TPs e quantos FPs o finder entrega, e que parte dos comentários é TP.</p>
{ptabs("cli", cli, lambda x: f'<div class="scroll"><table class="t5"><thead><tr><th>Modelo</th><th>Versão</th><th>TPs por PR</th><th>FPs por PR</th><th>Comentários por PR</th><th>TP no que chega</th></tr></thead><tbody>{x}</tbody></table></div>')}
{OBS}
</section>
<section data-t="diag" hidden>
<h2>Por que o light e o heavy perdem da produção na Muse e no Kimi</h2>
<p class="nota">TPs distintos em 50 PRs. Produção = V2 (generalista + rescue, sem verify). Light e heavy = rodadas do novo fluxo.</p>
<div class="scroll"><table class="t7"><thead><tr><th>Modelo</th><th>Generalista de produção</th><th>Light</th><th>Efeito da saída enxuta</th><th>Exclusivos do rescue</th><th>Exclusivos das lentes</th><th>Produção V2</th><th>Heavy</th><th>Só na produção / só no heavy</th><th>TPs que se repetem entre rodadas</th></tr></thead><tbody>
{tab_diag}
</tbody></table></div>
{DIAG}
</section>
</div>
<script>
(function(){{
  var tabs=document.querySelectorAll('.tab'), secs=document.querySelectorAll('section[data-t]');
  function show(t){{tabs.forEach(function(b){{b.classList.toggle('on',b.dataset.t===t);b.setAttribute('aria-selected',b.dataset.t===t)}});secs.forEach(function(s){{s.hidden=s.dataset.t!==t}})}}
  tabs.forEach(function(b){{b.addEventListener('click',function(){{show(b.dataset.t);try{{localStorage.setItem('aba',b.dataset.t)}}catch(e){{}}}})}});
  try{{var a=localStorage.getItem('aba');if(a)show(a)}}catch(e){{}}
  document.querySelectorAll('.pt').forEach(function(b){{b.addEventListener('click',function(){{
    var g=b.dataset.g;document.querySelectorAll('.pt[data-g="'+g+'"]').forEach(function(x){{x.classList.toggle('on',x===b)}});
    document.querySelectorAll('.pp[data-g="'+g+'"]').forEach(function(x){{x.hidden=x.dataset.p!==b.dataset.p}})}})}});
  function fit(){{document.querySelectorAll('.scroll').forEach(function(s){{s.classList.remove('fits');var t=s.querySelector('table');if(t&&t.offsetWidth&&t.offsetWidth<=s.clientWidth)s.classList.add('fits')}})}}
  fit();window.addEventListener('resize',fit);document.addEventListener('click',function(e){{if(e.target.closest('.tab,.pt'))fit()}});
}})();
</script>
'''
open(sys.argv[1], 'w').write(html); print('ok', len(html), 'pendentes', pend)
