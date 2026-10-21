#!/usr/bin/env python3
"""Severity tests page: reads results/<prompt>/*.json, newest test first.
  python3 evals/severity/report.py <out.html>"""
import json, os, sys, html

AQUI = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
MODELOS = [('gpt-6.1-sol_sub', 'GPT Sol'), ('claude-opus-5.5_api', 'Opus'), ('claude-sonnet-5.5_api', 'Sonnet'), ('deepseek-v4.1-flash_together', 'DeepSeek')]
NIVEIS = ['low', 'medium', 'high', 'critical']
# (pasta em results/, título, o que mudou), do mais novo para o mais antigo.
TESTES = json.load(open(f'{AQUI}/tests.json'))
E = html.escape


def celula(lv):
    if not lv or not lv['n']: return '<td class="na">—</td>'
    p = 100 * lv['right'] / lv['n']
    cls = 'ok' if p >= 90 else 'mid' if p >= 80 else 'bad'
    return f'<td class="{cls}">{lv["right"]}/{lv["n"]}<small>{p:.0f}%</small></td>'


def tabela(pasta):
    linhas = []
    for slug, nome in MODELOS:
        f = f'{AQUI}/results/{pasta}/{slug}.json'
        if not os.path.exists(f):
            linhas.append(f'<tr><td>{nome}</td>' + '<td class="na">—</td>' * 5 + '</tr>')
            continue
        d = json.load(open(f))
        pl = d['perLevel']
        tot = sum(pl[l]['right'] for l in NIVEIS)
        n = sum(1 for _ in d['rows'])
        piso = min(100 * pl[l]['right'] / pl[l]['n'] for l in NIVEIS if pl[l]['n'])
        cls = 'ok' if piso >= 90 else 'mid' if piso >= 80 else 'bad'
        linhas.append(f'<tr><td>{nome}</td>' + ''.join(celula(pl[l]) for l in NIVEIS) + f'<td class="sep">{tot}/{n}<small>{100 * tot / n:.0f}%</small></td><td class="{cls}">{piso:.0f}%</td></tr>')
    return ''.join(linhas)


blocos = []
for t in TESTES:
    blocos.append(f'''<section>
<h2>{E(t["titulo"])}</h2>
<p>{E(t["mudou"])}</p>
<div class="wrap"><table><thead><tr><th>Modelo</th><th>low</th><th>medium</th><th>high</th><th>critical</th><th class="sep">Total</th><th>Pior nível</th></tr></thead>
<tbody>{tabela(t["pasta"])}</tbody></table></div>
{f'<p class="leitura">{E(t["leitura"])}</p>' if t.get("leitura") else ''}
</section>''')

page = f'''<title>Severidade em produção</title>
<style>
/* Testes empilhados, o mais novo em cima. */
:root{{--bg:#f6f7f9;--card:#fff;--fg:#1b2330;--mut:#5d6878;--line:#dfe3ea;--ok:#1f7a4d;--okb:#e3f3ea;--mid:#8a5a00;--midb:#fbf0d9;--bad:#b4362c;--badb:#fbe6e3;
--sans:"IBM Plex Sans",system-ui,sans-serif}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#12161d;--card:#1a2029;--fg:#e4e8ef;--mut:#98a3b3;--line:#2c3542;--ok:#5cc58f;--okb:#183528;--mid:#e0b45a;--midb:#3a2f17;--bad:#f07a6f;--badb:#3d1f1c;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#12161d;--card:#1a2029;--fg:#e4e8ef;--mut:#98a3b3;--line:#2c3542;--ok:#5cc58f;--okb:#183528;--mid:#e0b45a;--midb:#3a2f17;--bad:#f07a6f;--badb:#3d1f1c;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans);padding-inline:16px;padding-block:28px}}
main{{max-width:980px;margin:0 auto;display:grid;gap:26px}}
h1{{font-size:1.5rem;margin:0;text-wrap:balance}}h2{{font-size:1.1rem;margin:0 0 4px}}
p{{margin:0;color:var(--mut)}}section{{display:grid;gap:8px}}
.wrap{{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}}
table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}
th,td{{padding:9px 14px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}}
th:first-child,td:first-child{{text-align:left}}
thead th{{font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);font-weight:600}}
tbody tr:last-child td{{border-bottom:0}}
td small{{display:inline-block;min-width:3.2em;margin-left:6px;color:inherit;opacity:.8}}
td.ok{{color:var(--ok);background:var(--okb);font-weight:600}}td.mid{{color:var(--mid);background:var(--midb);font-weight:600}}td.bad{{color:var(--bad);background:var(--badb);font-weight:600}}td.na{{color:var(--mut)}}
.sep{{border-left:1px solid var(--line)}}.leitura{{color:var(--fg)}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap">
<main>
<h1>Severidade: testes de prompt</h1>
<p>Meta: 90% de acerto em cada nível, separado. Dataset: 158 problemas reais do gold v3 (50 low, 50 medium, 50 high, 8 critical). Errou, errou: um nível ou três dá no mesmo. Única tolerância: critical respondido como high conta como acerto. Verde ≥ 90%, amarelo ≥ 80%, vermelho abaixo. Pior nível: o nível de menor acerto do modelo, que é o que decide a meta.</p>
<p class="leitura"><b>Resultado:</b> 90% por nível não foi atingido. O Opus passou de 80% em todos os níveis (teste 9 e refino 2), e o DeepSeek chegou perto (80/88/78/100 no refino 2). O que segura é high, de 74% a 80%, e os erros que sobram são em boa parte os mesmos itens nos quatro modelos: o próprio Astra, segundo anotador do gold, concorda com o rótulo em só 71% dos low e 57% dos medium que deu para conferir. O trecho do código e o label não ajudam; o voto de 3 respostas ajuda 2 a 4 itens em high. Candidato para produção: refino 2 (teste 11), sem código, uma chamada por PR, com ou sem voto.</p>
{''.join(blocos)}
</main>
'''
open(OUT, 'w').write(page)
print(OUT)
