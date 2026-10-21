#!/usr/bin/env python3
"""Analysis page of the enrichment eval: reads dataset/, results/*.judged.json.
  python3 evals/enrichment/report.py <out.html>"""
import json, glob, os, sys, html, collections

AQUI = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
items = {x['issueId']: x for x in json.load(open(f'{AQUI}/dataset/items.json'))['items']}
refs = {r['issueId']: r for f in glob.glob(f'{AQUI}/dataset/references/*.json') for r in json.load(open(f))['items'] if r['issueId'] in items}
ORDEM = ['gpt-6.1-sol@sub', 'claude-opus-5.5@api', 'claude-sonnet-5.5@api', 'deepseek-v4.1-flash@together', 'kimi-k2.7-code@openrouter']
NOME = {'gpt-6.1-sol@sub': 'GPT 6.1 Sol', 'claude-opus-5.5@api': 'Opus 5.5', 'claude-sonnet-5.5@api': 'Sonnet 5.5',
        'deepseek-v4.1-flash@together': 'DeepSeek v4.1 Flash', 'kimi-k2.7-code@openrouter': 'Kimi K2.7 Code'}
VIA = {'gpt-6.1-sol@sub': 'assinatura, effort low', 'claude-opus-5.5@api': 'LLM.run, chave da API', 'claude-sonnet-5.5@api': 'LLM.run, chave da API',
       'deepseek-v4.1-flash@together': 'Together', 'kimi-k2.7-code@openrouter': 'OpenRouter, Moonshot'}
VAR = {'oneshot': 'Chamada única', 'tools': 'Com ferramentas'}
runs = {}
for f in glob.glob(f'{AQUI}/results/*.judged.json'):
    d = json.load(open(f))
    if d['model'] in NOME: runs[(d['model'], d['variant'])] = {r['issueId']: r for r in d['rows']}
ctrl = json.load(open(f'{AQUI}/results/control-noop.judged.json'))['rows']
E = lambda s: html.escape(str(s))
J = lambda r: (r.get('grade') or {}).get('judge') or {}
G = lambda r: r.get('grade') or {}

ok_anchor = lambda i: items[i]['deterministic']['anchorStatus'] == 'ok'
MUST = [i for i, r in refs.items() if ok_anchor(i) and r['fixability'] == 'local' and r['contextSufficient']]
INS = [i for i, r in refs.items() if ok_anchor(i) and r['fixability'] == 'local' and not r['contextSufficient']]
WIDE = [i for i, r in refs.items() if r['fixability'] != 'local']
BROKEN = [i for i in refs if not ok_anchor(i)]

def stats(R):
    rows = list(R.values()); n = len(rows)
    loc = [r for r in rows if r.get('result') and r['result']['fixStatus'] == 'local']
    v = lambda r: J(r).get('fix')
    p = lambda ids: sum(1 for i in ids if v(R[i]) == 'PASS')
    syn = [r for r in loc if G(r).get('syntaxOk') is not None]
    avg = lambda k: sum((r.get('usage') or {}).get(k, 0) for r in rows) / n
    return dict(n=n, att=len(loc), P=sum(1 for r in loc if v(r) == 'PASS'), F=sum(1 for r in loc if v(r) == 'FAIL'),
                U=sum(1 for r in loc if v(r) == 'UNASSESSABLE'), mustP=p(MUST), mustAb=sum(1 for i in MUST if R[i]['result']['fixStatus'] != 'local'),
                insP=p(INS), wideP=p(WIDE), wideAb=sum(1 for i in WIDE if R[i]['result']['fixStatus'] != 'local'),
                synOk=sum(1 for r in syn if G(r)['syntaxOk']), syn=len(syn),
                tj=sum(1 for r in rows if J(r).get('titleNamesProblem')), tf=sum(1 for r in rows if G(r).get('titleFormatOk')),
                st=collections.Counter(r['result']['fixStatus'] if r.get('result') else 'sem resposta' for r in rows),
                empty=sum(1 for r in loc if not r['result']['improvedCode'].strip()),
                inp=avg('input'), cr=avg('cacheRead'), out=avg('output'), s=sum(r.get('ms', 0) for r in rows) / n / 1000)

S = {k: stats(R) for k, R in runs.items()}

# Produção: agregados das 800 sugestões enviadas mais recentes (consulta de 21/10/26); só contagens.
PROD = [('bug', 386, 114, 3), ('kody_rules', 347, 146, 6), ('performance', 34, 9, 1), ('security', 29, 11, 0), ('custom_agent', 4, 3, 0)]
PROD_N = sum(x[1] for x in PROD); PROD_V = sum(x[2] for x in PROD); PROD_P = sum(x[3] for x in PROD)
SEM_KR = [x for x in PROD if x[0] in ('bug', 'performance', 'security')]
SKN, SKV = sum(x[1] for x in SEM_KR), sum(x[2] for x in SEM_KR)
tab_prod = ''.join(f'<tr><td class="ver">{l}</td><td>{n}</td><td>{v}</td><td>{100 * v / n:.1f}%</td><td class="sep">{pr}</td><td>{100 * pr / n:.1f}%</td></tr>' for l, n, v, pr in PROD)
tab_prod += f'<tr class="gtop"><td class="ver"><b>total</b></td><td>{PROD_N}</td><td>{PROD_V}</td><td><b>{100 * PROD_V / PROD_N:.1f}%</b></td><td class="sep">{PROD_P}</td><td>{100 * PROD_P / PROD_N:.1f}%</td></tr>'
# Autojulgamento: cada modelo julga as próprias respostas de chamada única. Testes do mais recente ao mais antigo.
SELF_MODELS = [('gpt-6.1-sol@sub', 'gpt-6.1-sol_sub-oneshot', 'gpt-6.1-sol_sub'), ('claude-opus-5.5@api', 'claude-opus-5.5_api-oneshot', ''),
               ('deepseek-v4.1-flash@together', 'deepseek-v4.1-flash_together-oneshot', 'deepseek-v4.1-flash_together')]
SELF_TESTS = [
    ('selfref-tools', 'Teste 3 · o próprio modelo prepara a referência lendo o repositório e depois julga',
     'Igual ao teste 2, mas quem prepara a referência pode ler o repositório no head do PR (grep, readFile, listDir, findFile, até 12 passos), como o Astra lia. Continua sem gabarito e sem exemplo de correção. O julgamento é igual ao do teste 2.'),
    ('selfref', 'Teste 2 · o próprio modelo prepara a referência e depois julga',
     'Antes de julgar, o próprio modelo escreve a referência de cada item, no papel que era do Astra: o defeito e o que uma correção certa precisa cumprir. Ele faz isso numa chamada, sem ver resposta nenhuma, só com o que o enriquecimento recebe (achado, código citado, 60 linhas em volta, diff); sem repositório, sem gabarito e sem exemplo de correção. Depois julga as respostas contra essa referência.'),
    ('noref', 'Teste 1 · o próprio modelo julga sem referência',
     'O próprio modelo julga as respostas vendo só o achado, o código citado, as 60 linhas em volta e a resposta.'),
]
def nota_producao(suf):
    linhas = PORTAO.get(suf)
    if not linhas: return ''
    tab = ''.join(f'<tr><td class="ver">{E(n)}</td><td>{e}</td><td><b>{ch}</b></td><td>{fa}</td><td>{sc0} → {sc1}</td></tr>' for n, e, ch, fa, sc0, sc1 in linhas)
    return (f'<h3>Comparado com produção hoje</h3><div class="scroll"><table class="t5"><thead><tr><th>Modelo</th><th>Correções erradas que chegam ao cliente hoje</th>'
            f'<th>Com este portão</th><th>Certas perdidas</th><th>Sem código</th></tr></thead><tbody>{tab}</tbody></table></div>'
            f'<p class="nota"><b>Melhor que produção nos três.</b> Produção não tem portão: toda correção errada chega ao cliente (a coluna "hoje" usa a contagem do Opus com referência do Astra, porque produção não mede acerto). '
            f'O portão só tira o improvedCode; o comentário sai igual, então não há perda de recall. O custo: {min(x[3] for x in linhas)} a {max(x[3] for x in linhas)} correção certa sai sem código, e sem código sobe um pouco (em produção é {100 * SKV / SKN:.1f}% nesses labels). '
            f'{LEITURA.get(suf, "")} Dá para publicar e ir melhorando.</p>')
def veredito(r):
    if not r.get('result') or r['result']['fixStatus'] != 'local': return 'N'
    return {'PASS': 'P', 'FAIL': 'F'}.get(J(r).get('fix'), 'U')
PORTAO = {}
LEITURA = {
    'selfref': 'O ganho real é no GPT; no Opus e no DeepSeek a maior parte das erradas ainda passa.',
    'selfref-tools': 'Ler o repositório ajudou o DeepSeek (barra 6 de 20, contra 4 no teste 2) e não mudou o GPT nem o Opus; a maior parte das erradas ainda passa no Opus e no DeepSeek.',
}
def tabela_self(sufixo):
    lin = []
    for m, base, judge in SELF_MODELS:
        tag = '-'.join(x for x in (judge, sufixo) if x)
        f = f'{AQUI}/results/{base}.judged-{tag}.json'
        if not os.path.exists(f): continue
        A = {r['issueId']: veredito(r) for r in json.load(open(f'{AQUI}/results/{base}.judged.json'))['rows']}
        B = {r['issueId']: veredito(r) for r in json.load(open(f))['rows']}
        c = lambda D, x: sum(1 for v in D.values() if v == x)
        pegou = sum(1 for i in A if A[i] == 'F' and B[i] in ('F', 'U')); erradas = c(A, 'F')
        falso = sum(1 for i in A if A[i] == 'P' and B[i] != 'P')
        PORTAO.setdefault(sufixo, []).append((NOME[m], erradas, erradas - pegou, falso, c(A, 'N'), c(B, 'N') + c(B, 'F') + c(B, 'U')))
        for j, (nome, D) in enumerate((('Opus com referência do Astra', A), ('O próprio modelo', B))):
            mod = f'<th class="mod" rowspan="2">{E(NOME[m])}</th>' if j == 0 else ''
            extra = f'<td class="sep" rowspan="2"><b>{pegou} de {erradas}</b></td><td rowspan="2">{falso}</td>' if j == 0 else ''
            cls = ' class="gtop"' if j == 0 else ''
            lin.append(f'<tr{cls}>{mod}<td class="ver">{nome}</td><td>{c(D, "P")}</td><td>{c(D, "F")}</td><td>{c(D, "U")}</td><td>{c(D, "N")}</td>{extra}</tr>')
    return ''.join(lin)
blocos_self = []
for k_, (suf, tit, desc) in enumerate(SELF_TESTS):
    corpo = tabela_self(suf)
    if not corpo: continue
    blocos_self.append(f'''<details class="teste"{' open' if not blocos_self else ''}><summary>{E(tit)}</summary><div class="body"><p class="nota">{E(desc)}</p>
<div class="scroll"><table class="t4"><thead><tr><th>Modelo</th><th>Juiz</th><th>Aprovadas</th><th>Reprovadas</th><th>Juiz não decidiu</th><th>Sem código</th><th class="sep">Correções erradas que o próprio modelo barrou</th><th>Certas que ele barrou à toa</th></tr></thead><tbody>{corpo}</tbody></table></div>{nota_producao(suf) if suf.startswith('selfref') else ''}</div></details>''')
tab_self = ''.join(blocos_self)
semc = sorted(s['n'] - s['att'] for s in S.values()); repr_ = sorted(s['F'] for s in S.values())
bestF = sorted(S[(m, 'tools')]['F'] for m in ('gpt-6.1-sol@sub', 'claude-opus-5.5@api', 'claude-sonnet-5.5@api') if (m, 'tools') in S)
k = lambda v: f'{v / 1000:.1f}k' if v >= 1000 else f'{v:.0f}'

# ── tabela principal ─────────────────────────────────────────────────────────
best = max(S.values(), key=lambda s: s['P'])['P']
lin = []
for m in ORDEM:
    for j, var in enumerate(('oneshot', 'tools')):
        s = S.get((m, var))
        if not s: continue
        cls = ' class="gtop"' if j == 0 else ''
        mod = f'<th class="mod" rowspan="2">{E(NOME[m])}<span class="via">{E(VIA[m])}</span></th>' if j == 0 else ''
        hl = ' class="hi"' if s['P'] == best else ''
        lin.append(f'<tr{cls}>{mod}<td class="ver">{VAR[var]}</td><td{hl}><b>{s["P"]}</b></td><td>{s["F"]}</td><td>{s["U"]}</td><td>{s["n"] - s["att"]}</td></tr>')
tab1 = ''.join(lin)

lin = []
for m in ORDEM:
    for j, var in enumerate(('oneshot', 'tools')):
        s = S.get((m, var))
        if not s: continue
        cls = ' class="gtop"' if j == 0 else ''
        mod = f'<th class="mod" rowspan="2">{E(NOME[m])}</th>' if j == 0 else ''
        lin.append(f'<tr{cls}>{mod}<td class="ver">{VAR[var]}</td><td>{s["tj"]}</td><td class="sep">{k(s["inp"])}</td><td>{k(s["cr"])}</td><td>{k(s["out"])}</td><td>{s["s"]:.1f} s</td></tr>')
tab2 = ''.join(lin)

rc = collections.Counter(r['fixability'] for r in refs.values())
cs = sum(1 for r in refs.values() if r['contextSufficient'])
ac = sum(1 for r in refs.values() if r['anchorCoversDefect'])
nctrl = len(ctrl); cfail = sum(1 for r in ctrl if J(r).get('fix') == 'FAIL')

# ── matriz por item ──────────────────────────────────────────────────────────
COLS = [(m, v) for m in ORDEM for v in ('oneshot', 'tools') if (m, v) in runs]
def chip(r):
    if not r.get('result'): return '<span class="c c-na" title="sem resposta">–</span>'
    st = r['result']['fixStatus']
    if st != 'local':
        ab = {'needs-wider-change': 'W', 'insufficient-context': 'C', 'no-code-fix': 'N'}[st]
        return f'<span class="c c-ab" title="{st}">{ab}</span>'
    v = J(r).get('fix')
    return {'PASS': '<span class="c c-ok" title="PASS">✓</span>', 'FAIL': '<span class="c c-ko" title="FAIL">✗</span>'}.get(v, '<span class="c c-un" title="UNASSESSABLE">?</span>')
def grupo(i):
    if i in BROKEN: return ('quebrada', 'Âncora quebrada')
    if i in MUST: return ('corr', 'Corrigível com o contexto')
    if i in INS: return ('outro', 'Depende de outro arquivo')
    return ('amplo', 'Fora do trecho')
def code(t): return f'<pre>{E(t) if t else "<i>(vazio)</i>"}</pre>'
blocos = []
for i in sorted(items, key=lambda i: (['corr', 'outro', 'amplo', 'quebrada'].index(grupo(i)[0]), items[i]['split'], i)):
    it, ref = items[i], refs[i]
    gk, gn = grupo(i)
    f = it['finding']
    npass = sum(1 for c in COLS if J(runs[c][i]).get('fix') == 'PASS')
    resp = []
    for c in COLS:
        r = runs[c][i]; a = r.get('result') or {}
        resp.append(f'<div class="resp"><h5>{E(NOME[c[0]])} · {VAR[c[1]]} {chip(r)}</h5>'
                    f'<p class="ti"><b>Título:</b> {E(a.get("oneSentenceSummary", ""))}</p>'
                    f'<p class="ti"><b>fixStatus:</b> {E(a.get("fixStatus", "—"))}'
                    + (f' · <b>tools:</b> {E(", ".join(r.get("toolCalls") or []) or "nenhuma")}' if c[1] == 'tools' else '') + '</p>'
                    + (code(a.get('improvedCode', '')) if a.get('fixStatus') == 'local' else '')
                    + (f'<p class="jr"><b>Juiz:</b> {E(J(r).get("fixReason", ""))}</p>' if a.get('fixStatus') == 'local' else '') + '</div>')
    blocos.append(f'''<details class="item" data-g="{gk}"><summary><span class="gid">{E(i)}</span><span class="gp g-{gk}">{gn}</span><span class="sp">{it['split']}</span>
<span class="chips">{''.join(chip(runs[c][i]) for c in COLS)}</span><span class="np">{npass}/{len(COLS)}</span></summary>
<div class="body"><div class="cols"><div>
<p><b>Achado</b> ({E(f.get('label'))}) <code>{E(f.get('relevantFile'))}:{E(f.get('relevantLinesStart'))}-{E(f.get('relevantLinesEnd'))}</code> · origem {E(it['provenance']['run'])} · severidade {E(it['gold']['severity'])}</p>
<p class="txt">{E(f.get('suggestionContent'))}</p>
<p><b>Código citado</b></p>{code(it['deterministic']['existingCode'])}</div><div>
<p><b>Referência (Astra)</b> · fixability <code>{E(ref['fixability'])}</code> · contexto {'suficiente' if ref['contextSufficient'] else 'insuficiente'} · âncora {'cobre' if ref['anchorCoversDefect'] else 'não cobre'}</p>
<p class="txt">{E(ref['defectStatement'])}</p><ul>{''.join(f'<li>{E(o)}</li>' for o in ref['obligations'])}</ul>
<p><b>Exemplo de correção</b></p>{code(ref['exampleFix']) if ref['exampleFix'] is not None else '<p class="mut">(nenhum)</p>'}
<p class="mut">{E(ref['notes'])}</p></div></div>
<div class="resps">{''.join(resp)}</div></div></details>''')

cabec_cols = ''.join(f'<span title="{E(NOME[m])} · {VAR[v]}">{E(NOME[m].split()[0][:4])}{"·T" if v == "tools" else ""}</span>' for m, v in COLS)

page = f'''<title>Enriquecimento do Finder</title>
<style>
/* Layout: uma coluna de leitura; tabelas com cabeçalho fixo; itens em sanfona. */
:root{{--bg:#f6f7f4;--fg:#1d211c;--mut:#5d655a;--card:#fff;--line:#dfe3da;--acc:#2f6b4f;--head:#eef1ea;--hi:#fbe3c7;--hil:#e08a2c;
--ok:#2f6b4f;--okb:#dcefe3;--ko:#a23a2a;--kob:#f6dcd6;--ab:#6a5d1d;--abb:#f3ecc6;--un:#4b3f8a;--unb:#e4e1f2;--na:#5d655a;--nab:#e6e9e1;
--sans:"IBM Plex Sans",system-ui,-apple-system,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#141713;--fg:#e4e8e0;--mut:#9aa396;--card:#1c201b;--line:#2f352d;--acc:#7fc39d;--head:#232822;--hi:#3b2a17;--hil:#e0a25c;
--ok:#7fc39d;--okb:#1d3326;--ko:#ee8c79;--kob:#3d211b;--ab:#e3c654;--abb:#332d14;--un:#c9bff2;--unb:#332d52;--na:#9aa396;--nab:#2a3028;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#141713;--fg:#e4e8e0;--mut:#9aa396;--card:#1c201b;--line:#2f352d;--acc:#7fc39d;--head:#232822;--hi:#3b2a17;--hil:#e0a25c;
--ok:#7fc39d;--okb:#1d3326;--ko:#ee8c79;--kob:#3d211b;--ab:#e3c654;--abb:#332d14;--un:#c9bff2;--unb:#332d52;--na:#9aa396;--nab:#2a3028;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans)}}
.wrap{{max-width:1240px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 48px}}
h1{{font-size:22px;margin:0 0 4px;text-wrap:balance}}h2{{font-size:17px;margin:32px 0 6px;text-wrap:balance}}
.sub,.nota,.mut{{color:var(--mut)}}.nota{{margin:8px 0}}
.regra{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0 4px}}
.regra div{{border-top:2px solid var(--line);padding-top:8px;min-width:0}}.regra b{{font:600 20px var(--mono);color:var(--acc)}}.regra p{{margin:2px 0 0;color:var(--mut);font-size:13px}}
.scroll{{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-top:12px}}
.scroll:not(.fits){{max-height:80vh;overflow:auto}}.scroll.fits{{overflow:visible}}
table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}
th,td{{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}}
thead{{position:sticky;top:env(safe-area-inset-top,0px);z-index:2}}
thead th{{font-weight:600;background:var(--head);font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);white-space:normal;vertical-align:bottom;box-shadow:inset 0 -1px 0 var(--line)}}
thead th:first-child,thead th:nth-child(2){{text-align:left}}
th.mod{{text-align:left;vertical-align:top;font-weight:600}}.via{{display:block;font-weight:400;font-size:12px;color:var(--mut)}}td.ver{{text-align:left;color:var(--mut)}}
tr.gtop th,tr.gtop td{{border-top:2px solid var(--line)}}.sep{{border-left:2px solid var(--line)}}
td.hi{{background:var(--hi);box-shadow:inset 3px 0 0 var(--hil)}}
.t1{{min-width:560px}}.t3{{min-width:560px}}.t5{{min-width:620px}}h3{{font-size:15px;margin:18px 0 4px}}.teste{{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-top:10px}}.teste>summary{{padding:10px 14px;font-weight:600;cursor:pointer}}.teste .scroll{{margin-top:8px}}.t4{{min-width:760px}}.t2{{min-width:620px}}
.tabs{{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 8px;border-bottom:1px solid var(--line)}}\n.tabs button{{font:600 13px var(--sans);border:0;border-bottom:2px solid transparent;background:none;color:var(--mut);padding:8px 12px;cursor:pointer;margin-bottom:-1px}}\n.tabs button.on{{color:var(--fg);border-bottom-color:var(--acc)}}\n.leg{{display:flex;flex-wrap:wrap;gap:6px 16px;margin:12px 0;color:var(--mut);font-size:13px;align-items:center}}
.c{{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;font:600 12px var(--mono)}}
.c-ok{{background:var(--okb);color:var(--ok)}}.c-ko{{background:var(--kob);color:var(--ko)}}.c-ab{{background:var(--abb);color:var(--ab)}}.c-un{{background:var(--unb);color:var(--un)}}.c-na{{background:var(--nab);color:var(--na)}}
.filtros{{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}}
.filtros button{{font:600 12px var(--sans);border:1px solid var(--line);background:var(--card);color:var(--mut);border-radius:999px;padding:5px 12px;cursor:pointer}}
.filtros button.on{{background:var(--head);color:var(--fg);border-color:var(--acc)}}
.mhead{{display:flex;gap:10px;align-items:center;padding:6px 12px;font:600 11px var(--mono);color:var(--mut);position:sticky;top:env(safe-area-inset-top,0px);background:var(--bg);z-index:1;border-bottom:1px solid var(--line)}}
.mhead .cols2{{display:flex;gap:2px;margin-left:auto}}.mhead .cols2 span{{width:20px;text-align:center;font-size:9px;overflow:hidden}}
.item{{background:var(--card);border:1px solid var(--line);border-radius:6px;margin-top:4px}}
.item summary{{display:flex;gap:10px;align-items:center;padding:6px 12px;cursor:pointer;list-style:none;flex-wrap:wrap}}
.item summary::-webkit-details-marker{{display:none}}
.gid{{font:12px var(--mono);min-width:0;overflow-wrap:anywhere;flex:1 1 300px}}
.gp{{font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px;background:var(--head);color:var(--mut)}}
.g-corr{{background:var(--okb);color:var(--ok)}}.g-outro{{background:var(--unb);color:var(--un)}}.g-amplo{{background:var(--abb);color:var(--ab)}}.g-quebrada{{background:var(--kob);color:var(--ko)}}
.sp{{font:11px var(--mono);color:var(--mut)}}.chips{{display:flex;gap:2px}}.np{{font:600 12px var(--mono);min-width:38px;text-align:right}}
.body{{padding:4px 12px 12px;border-top:1px solid var(--line)}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}.cols>div{{min-width:0}}
.resps{{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px;margin-top:12px}}
.resp{{border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-width:0}}
.resp h5{{margin:0 0 4px;font-size:13px;display:flex;gap:8px;align-items:center}}
.ti,.jr{{margin:2px 0;font-size:13px}}.jr{{color:var(--mut)}}.txt{{margin:4px 0}}
pre{{font:12px/1.45 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px;overflow-x:auto;margin:4px 0;white-space:pre}}
code{{font:12px var(--mono)}}.def{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 14px;margin:12px 0}}.def p{{margin:6px 0;font-size:13px}}ul{{margin:4px 0;padding-left:20px}}
@media (max-width:720px){{.cols{{grid-template-columns:1fr}}.resps{{grid-template-columns:1fr}}.mhead .cols2{{display:none}}}}
</style>
<div class="wrap">
<h1>Enriquecimento do Finder</h1>
<p class="sub">Prompt v1 · 100 TPs do gold v3 · juiz Opus 5.5 · 20/10/26</p>
<div class="tabs" id="tabs" role="tablist"><button class="on" data-t="resultado">Resultado dos modelos</button><button data-t="diag">Diagnóstico</button><button data-t="self">Autojulgamento</button><button data-t="itens">Item a item</button><button data-t="dataset">Dataset e validação</button></div>

<section id="t-resultado">
<p class="nota">Cada modelo recebeu os mesmos 100 achados confirmados e, para cada um, escreveu o título e, quando achou que dava, o improvedCode. Todas as contagens são sobre os 100 achados; as quatro colunas somam 100.</p>
<div class="scroll"><table class="t1"><thead><tr><th>Modelo</th><th>Versão</th><th>Aprovadas</th><th>Reprovadas</th><th>Juiz não decidiu</th><th>Sem código</th></tr></thead><tbody>{tab1}</tbody></table></div>
<div class="def">
<p><b>Aprovadas:</b> o improvedCode, posto no lugar das linhas citadas, corrige o problema e não quebra nada, segundo o juiz.</p>
<p><b>Reprovadas:</b> o modelo gerou improvedCode, mas ele não corrige o problema ou quebra outra coisa. É o risco real: um comentário com correção errada.</p>
<p><b>Juiz não decidiu:</b> o modelo gerou improvedCode, mas o juiz não teve material para decidir se está certo.</p>
<p><b>Sem código:</b> o modelo não gerou improvedCode. O comentário sai mesmo assim, só com o problema.</p>
<p><b>Chamada única:</b> o modelo recebe o achado, o código citado, 60 linhas em volta e o diff do arquivo. <b>Com ferramentas:</b> o mesmo, mais grep, readFile, listDir e findFile no repositório, até 6 passos.</p>
</div>

<h2>Título e custo</h2>
<div class="scroll"><table class="t2"><thead><tr><th>Modelo</th><th>Versão</th><th>Título certo /100</th><th class="sep">Input</th><th>Cache read</th><th>Output</th><th>Tempo</th></tr></thead><tbody>{tab2}</tbody></table></div>
<p class="nota">Título certo: nomeia o problema do achado, segundo o juiz. Tokens e tempo são por achado, só do modelo enriquecendo; o juiz não entra.</p>
</section>

<section id="t-diag" hidden>
<p class="nota">O que já acontece hoje em produção com o improvedCode, para saber o que é realidade do fluxo atual e o que o fluxo novo precisa evitar. Base: as {PROD_N} sugestões enviadas mais recentes, consultadas no banco de produção em 21/10/26.</p>
<div class="scroll"><table class="t3"><thead><tr><th>Label</th><th>Enviadas</th><th>Sem improvedCode</th><th>%</th><th class="sep">Instrução em vez de código</th><th>%</th></tr></thead><tbody>{tab_prod}</tbody></table></div>
<p class="nota">Instrução em vez de código: o improvedCode é um comentário dizendo o que fazer, não a correção. Conta revisada à mão; edições legítimas de comentário não entram. performance, security e custom_agent têm poucos casos e oscilam entre amostras (performance deu 45,9% sem código em outra amostra de 800).</p>
<h2>Problema hoje → fluxo novo</h2>
<div class="def">
<p><b>Sem improvedCode: {100 * PROD_V / PROD_N:.1f}% em produção ({100 * SKV / SKN:.1f}% só em bug, performance e security, os labels deste dataset).</b> No fluxo novo, de {semc[0]} a {semc[-1]} em 100 saem sem código. É o mesmo patamar de hoje, e o comentário sai do mesmo jeito, só com o problema.</p>
<p><b>Acerto do improvedCode: produção não mede.</b> Lá só dá para ver que, quando o campo vem preenchido, é código e muda alguma coisa. Aqui o juiz mede: de {repr_[0]} a {repr_[-1]} em 100 saem com correção errada ({bestF[0]} a {bestF[-1]} nos três melhores com ferramentas). Sem um portão antes de publicar, elas chegariam ao cliente, como já devem chegar hoje.</p>
<p><b>Instrução em vez de código: {PROD_P} em {PROD_N} ({100 * PROD_P / PROD_N:.2f}%).</b> No fluxo novo, 1 em 1.000 respostas (as 10 rodadas), e ela parece edição legítima de comentário. Um filtro sem custo pode tirar o improvedCode quando ele é só comentário, e o comentário sai só com o problema.</p>
<p><b>Correção que não muda nada: 0 em {PROD_N}.</b> No fluxo novo também 0 em 1.000. Não é um problema hoje.</p>
<p><b>Fragmento de comentário cortado no meio em arquivos .sh: 4 casos em kody_rules.</b> Parece recorte errado da janela de linhas, não erro do modelo. Fica registrado, fora deste eval.</p>
</div>
</section>

<section id="t-self" hidden>
<p class="nota">Em produção o juiz teria que ser o modelo BYOK do cliente, e não existe a referência do Astra. Aqui cada modelo julga as próprias respostas de chamada única, as mesmas que o Opus já tinha julgado com a referência do Astra. Contagens sobre os 100 achados. Teste mais recente em cima.</p>
{tab_self}
<div class="def">
<p><b>Correções erradas que o próprio modelo barrou:</b> das que o Opus com referência do Astra reprovou, quantas o próprio modelo reprovou ou deixou sem decidir. Num portão de produção, só essas sairiam sem código.</p>
<p><b>Certas que ele barrou à toa:</b> das que o Opus com referência do Astra aprovou, quantas o próprio modelo não aprovou.</p>
<p><b>Sem código</b> não muda: é o próprio modelo que escolheu não escrever improvedCode, antes de qualquer juiz.</p>
</div>
</section>

<section id="t-itens" hidden>
<p class="nota">Cada linha é um achado; as marcas são a resposta de cada rodada. Abra para ver o achado, a referência e as respostas.</p>
<div class="leg"><span class="c c-ok">✓</span>aprovada<span class="c c-ko">✗</span>reprovada<span class="c c-un">?</span>juiz não decidiu<span class="c c-ab">W</span>absteve: fora do trecho<span class="c c-ab">C</span>absteve: contexto<span class="c c-na">–</span>sem resposta</div>
<div class="def">
<p><b>Corrigível com o contexto:</b> a correção cabe nas linhas citadas e dá para escrevê-la só com o que o modelo recebe (achado, código citado, 60 linhas em volta, diff).</p>
<p><b>Depende de outro arquivo:</b> a correção cabe nas linhas citadas, mas usa algo definido em outro arquivo (um método, uma assinatura) que o modelo só vê com ferramentas.</p>
<p><b>Fora do trecho:</b> a âncora aponta o defeito, mas corrigir exige mudar outras linhas ou outros arquivos; trocar só as linhas citadas não resolve.</p>
{'<p><b>Âncora quebrada:</b> o finder mandou o achado sem caminho completo do arquivo ou sem linhas; não há código para recortar.</p>' if BROKEN else ''}
</div>
<div class="filtros" id="f"><button class="on" data-g="">Todos</button><button data-g="corr">Corrigível com o contexto</button><button data-g="outro">Depende de outro arquivo</button><button data-g="amplo">Fora do trecho</button>{'<button data-g="quebrada">Âncora quebrada</button>' if BROKEN else ''}</div>
<div class="mhead"><span>Item</span><span class="cols2">{cabec_cols}</span><span style="min-width:38px;text-align:right">✓</span></div>
<div id="lista">{''.join(blocos)}</div>
</section>

<section id="t-dataset" hidden>
<h2>Como o dataset foi montado</h2>
<p class="nota">100 achados do finder atual (rodadas light + rescue), cada um casado com um TP do gold v3, sorteados por repositório e severidade sem depender do modelo. Só entra achado com âncora válida: arquivo do PR, linha inicial e final.</p>
<h2>Referência de cada item</h2>
<p class="nota">O Astra leu o repositório no head e escreveu, para cada item, o defeito, as obrigações que uma correção precisa cumprir e um exemplo de correção. Ele também classificou cada item pela dificuldade. Essa classificação é a opinião do Astra, não um limite: um modelo pode acertar um item que o Astra achou impossível só com as linhas citadas.</p>
<div class="regra">
<div><b>{len(MUST)}</b><p>a correção cabe nas linhas citadas e dá para escrever só com o que o modelo recebe</p></div>
<div><b>{len(INS)}</b><p>cabe nas linhas citadas, mas usa algo de outro arquivo</p></div>
<div><b>{len(WIDE)}</b><p>exige mudar outras linhas ou outros arquivos</p></div>
</div>
<h2>Como o juiz decide</h2>
<p class="nota">O juiz (Opus 5.5) recebe o achado, a referência, o código citado, as 60 linhas em volta e a resposta. Aprova quando o improvedCode corrige o defeito, cumpre as obrigações e não quebra nada; qualquer implementação que cumpra as obrigações passa, não precisa parecer com o exemplo.</p>
<h2>Teste do próprio juiz</h2>
<p class="nota">Para checar que o juiz não aprova qualquer coisa, cada um dos {nctrl} itens cuja correção cabe nas linhas citadas recebeu uma resposta falsa cujo improvedCode é o próprio código original, sem mudança. O juiz reprovou {cfail} de {nctrl}. Esse teste não envolve nenhum modelo; serve só para validar o juiz.</p>
</section>
</div>
<script>
function fit(){{document.querySelectorAll('.scroll').forEach(function(s){{s.classList.remove('fits');var t=s.querySelector('table');if(t&&t.scrollWidth<=s.clientWidth+1)s.classList.add('fits');}});}}
window.addEventListener('load',fit);
function aba(t){{document.querySelectorAll('#tabs button').forEach(function(x){{x.classList.toggle('on',x.dataset.t===t);}});
['resultado','diag','self','itens','dataset'].forEach(function(n){{document.getElementById('t-'+n).hidden=n!==t;}});fit();}}
document.getElementById('tabs').addEventListener('click',function(e){{var b=e.target.closest('button');if(b){{aba(b.dataset.t);try{{history.replaceState(null,'','#'+b.dataset.t);}}catch(_){{}}}}}});
if(['diag','self','itens','dataset'].indexOf(location.hash.slice(1))>=0)aba(location.hash.slice(1));window.addEventListener('resize',fit);fit();
document.getElementById('f').addEventListener('click',function(e){{var b=e.target.closest('button');if(!b)return;
document.querySelectorAll('#f button').forEach(function(x){{x.classList.toggle('on',x===b);}});var g=b.dataset.g;
document.querySelectorAll('#lista .item').forEach(function(it){{it.hidden=!!g&&it.dataset.g!==g;}});}});
</script>
'''
open(OUT, 'w').write(page)
print(OUT, len(page) // 1024, 'KB')
