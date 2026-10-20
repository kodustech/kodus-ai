#!/usr/bin/env python3
"""Pagina "Finder no gold v3": so a etapa do finder, producao contra o fluxo novo light e heavy.
  python3 gera-artefato.py <saida.html>"""
import json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
Q = json.load(open(f'{AQUI}/placar-finder-v3.json'))
MODELOS = [('deepseek', 'DeepSeek v4.1 Flash', 'via Together'), ('gpt', 'GPT 6.1 Sol', 'via assinatura'), ('sonnet-sdk', 'Sonnet 5.5 via SDK', 'fluxo novo pelo Agent SDK com preset'),
           ('sonnet-api', 'Sonnet 5.5 via API', 'fluxo novo pelo loop de produção'), ('opus', 'Opus 5.5', 'via API'), ('muse', 'Muse Spark 1.3', 'API da Meta'), ('kimi', 'Kimi K2.7 Code', 'OpenRouter, provedor Moonshot AI')]
VERS = [('producao', 'Produção'), ('light', 'Novo light'), ('heavy', 'Novo heavy')]
TOTAL = Q['deepseek|producao']['totalTp']
def d(v, b):
    x = round(v - b, 1)
    if x == 0: return '<span class="d">±0</span>'
    return f'<span class="d {"up" if x > 0 else "dn"}">{"+" if x > 0 else "−"}{abs(x):.1f}</span>'
lin = []
for m, nome, via in MODELOS:
    base = Q[f'{m}|producao']
    for j, (v, vn) in enumerate(VERS):
        q = Q[f'{m}|{v}']
        cel = lambda k: f'<b>{q[k]:.1f}</b>' + ('' if v == 'producao' else d(q[k], base[k]))
        lin.append(f'<tr class="{"gtop" if j == 0 else ""}">' + (f'<th rowspan="3" class="mod">{nome}<span class="via">{via}</span></th>' if j == 0 else '') +
                   f'<td class="ver">{vn}</td><td>{cel("recall")}</td><td>{cel("precisao")}</td><td>{cel("f1")}</td><td>{cel("f2")}</td>'
                   f'<td>{q["tp"]} <span class="frac">/ {q["totalTp"]}</span></td><td>{q["comentarios"]}</td><td>{q["fpNit"]} <span class="frac">/ {q["fpAlucinacao"]}</span></td></tr>')
html = f'''<title>Finder no gold v3</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400&display=swap">
<style>
/* Layout: uma coluna de leitura; uma tabela larga com rolagem propria no celular. */
:root{{--bg:#f6f7f4;--fg:#1d211c;--mut:#5d655a;--card:#fff;--line:#dfe3da;--acc:#2f6b4f;--up:#2f6b4f;--dn:#a23a2a;--head:#eef1ea;--tag:#e9efe4;
--sans:"IBM Plex Sans",system-ui,-apple-system,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#141713;--fg:#e4e8e0;--mut:#9aa396;--card:#1c201b;--line:#2f352d;--acc:#7fc39d;--up:#7fc39d;--dn:#ee8c79;--head:#232822;--tag:#26301f;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#141713;--fg:#e4e8e0;--mut:#9aa396;--card:#1c201b;--line:#2f352d;--acc:#7fc39d;--up:#7fc39d;--dn:#ee8c79;--head:#232822;--tag:#26301f;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans)}}
.wrap{{max-width:1180px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 48px}}
h1{{font-size:22px;margin:0 0 4px;text-wrap:balance}}h2{{font-size:17px;margin:32px 0 6px;text-wrap:balance}}
.sub,.nota,.foot,.via,.frac{{color:var(--mut)}}.sub{{margin:0 0 12px}}.nota{{max-width:80ch;margin:8px 0}}.foot{{font-size:12px;margin:8px 0 0;max-width:90ch}}
.via{{display:block;font-weight:400;font-size:12px}}.frac{{font-size:12px}}
.scroll{{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-top:12px}}
table{{border-collapse:collapse;width:100%;min-width:860px;font-variant-numeric:tabular-nums}}
th,td{{padding:10px 14px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}}
thead th{{font-weight:600;background:var(--head);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);position:sticky;top:env(safe-area-inset-top,0px)}}
thead th:first-child,thead th:nth-child(2){{text-align:left}}
th.mod{{text-align:left;vertical-align:top;font-weight:600}}td.ver{{text-align:left;color:var(--mut)}}
td{{font-size:15px}}tr.gtop th,tr.gtop td{{border-top:2px solid var(--line)}}
.d{{font-size:12px;margin-left:6px;color:var(--mut)}}.d.up{{color:var(--up)}}.d.dn{{color:var(--dn)}}
.tag{{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--tag);color:var(--mut);margin-left:4px;vertical-align:1px}}
.regra{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:16px 0 4px}}
.regra div{{border-top:2px solid var(--line);padding-top:8px;min-width:0}}.regra b{{font-family:var(--mono);font-weight:400;font-size:13px;color:var(--acc)}}.regra p{{margin:4px 0 0;color:var(--mut);font-size:13px}}
</style>
<div class="wrap">
<h1>Finder no gold v3</h1>
<p class="sub">Só a etapa do finder, antes do dedup e do verify · 50 PRs (light 30 + holdout 20) · gold v3 medido pelo <code>class_reviewed</code> · {TOTAL} TPs</p>
<div class="regra">
<div><b>TP</b><p>Problema do gold que o repositório original corrigiu ou descontinuou. Cada TP conta uma vez.</p></div>
<div><b>FP nit</b><p>TP ainda pendente ou que não entrou no original, TP nit, FP do gold e a segunda sugestão sobre o mesmo TP.</p></div>
<div><b>FP hallucination</b><p>O fato que o comentário alega é falso.</p></div>
</div>
<h2>Resultado do finder</h2>
<div class="scroll"><table><thead><tr><th>Modelo</th><th>Versão</th><th>Recall</th><th>Precisão</th><th>F1</th><th>F2</th><th>TPs achados / total</th><th>Comentários</th><th>FP nit / alucinação</th></tr></thead><tbody>
{"".join(lin)}
</tbody></table></div>
<p class="foot">Variação em pontos contra a produção do mesmo modelo. FP nit e FP hallucination: os dois somados são todos os FPs. Sonnet via SDK e via API dividem a mesma produção (o review de produção rodou pela API); o fluxo novo do Sonnet aparece pelos dois caminhos.</p>
</div>
'''
open(sys.argv[1], 'w').write(html)
print('ok', len(html))
