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
    cls = 'ok' if p >= 80 else 'mid' if p >= 70 else 'bad'
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
        cls = 'ok' if piso >= 80 else 'mid' if piso >= 70 else 'bad'
        linhas.append(f'<tr><td>{nome}</td>' + ''.join(celula(pl[l]) for l in NIVEIS) + f'<td class="sep">{tot}/{n}<small>{100 * tot / n:.0f}%</small></td><td class="{cls}">{piso:.0f}%</td></tr>')
    return ''.join(linhas)



# Aba Definições: a definição de cada nível, escrita por Astra e Opus a partir do gold v3.
REV = json.load(open(f'{AQUI}/../dedup/gold-v3/trabalho/revisao-severidade.json'))['itens']
DEF_EN = open(f'{AQUI}/definitions.md').read()
NO_DATASET = sum(1 for x in json.load(open(f'{AQUI}/dataset/items.json'))['items'] if x.get('severityBefore'))
import collections as _c
MUDANCAS = _c.Counter((v['de'], v['para']) for v in REV.values())
NIVEIS_PT = [
    ('critical', 'Um caminho concreto para burlar um fator de autenticação, administração não autorizada ampla, execução controlada pelo atacante no navegador ou no servidor, ou perda destrutiva sistêmica de uma fila inteira ou de um fluxo contínuo de trabalho.',
     ['SQL injection ou command injection com entrada comum de usuário.', 'XSS armazenado: conteúdo de um usuário roda como script para outros usuários ou para o admin.', 'Execução remota de código (deserialização insegura, template avaliado com entrada do usuário).', 'Login aceito sem senha ou sem o segundo fator.', 'Usuário só de leitura consegue se dar permissão de administrador.', 'Worker reiniciado descarta a fila inteira de jobs sem processar.', 'Migração apaga ou sobrescreve dados de produção de todos os clientes.']),
    ('high', 'Um caminho operacional suportado fica inutilizável para entradas válidas (inclusive um caminho de interface identificado); um efeito durável essencial falha; uma entidade principal fica sem o identificador obrigatório; dados operacionais são apagados indevidamente; ou um controle de segurança ou de admissão é burlado. Inclui queda em produção comprovada e build ou deploy bloqueado.',
     ['Crash (500) no fluxo principal para usuário comum, como quem ainda não tem um registro opcional.', 'Usuário acessa ou altera dado de outro usuário ou de outro tenant (IDOR, checagem de permissão errada).', 'Race condition que deixa passar do limite de vagas, de dispositivos ou de licenças.', 'Reserva aceita fora da janela de agendamento ou para convidado bloqueado.', 'Cancelar ou remarcar não atualiza o evento no calendário integrado.', 'Registro apagado ou sobrescrito indevidamente.', 'Credencial salva corrompida quebra a integração daí em diante.', 'Migração ou build quebra o deploy.', 'Mudança de contrato que quebra quem já chama a API.']),
    ('medium', 'Defeito real, mas limitado: erro em saída secundária ou de diagnóstico, feedback enganoso, falha de uma requisição isolada, tratamento comum de entrada inválida, trabalho extra significativo, fraqueza de segurança ou privacidade limitada. Falta de teste para comportamento relevante que o PR adiciona é medium. Teste que passa sem verificar o que diz verificar é medium.',
     ['Race condition cujo efeito é só um registro duplicado.', 'Comparação de segredo sem tempo constante (timing attack sem exploit demonstrado).', 'Lentidão relevante: N+1 em coleção grande, trabalho síncrono pesado, falta de paginação.', 'Erro errado para entrada inválida, como 500 no lugar de 400.', 'Log, métrica ou mensagem enganosa para quem opera ou usa.', 'Contador ou badge desatualizado até recarregar a página.', 'E-mail ou anexo enviado com dado errado, sem afetar o registro principal.', 'await faltando: o trabalho roda, mas o erro é engolido.', 'Comportamento novo do PR sem teste, ou teste que passa sem verificar o que diz verificar.']),
    ('low', 'Manutenção, inconsistência cosmética, pouco trabalho redundante, falta de teste em código não alterado ou trivial, fixture de teste imprecisa sem teste que passe falsamente, vazamento de recurso só em teste. N+1 em laço pequeno e limitado é low; N+1 sozinho não prova carga significativa.',
     ['Nome de função ou variável enganoso.', 'Comentário ou docstring desatualizado.', 'Texto na interface sem tradução.', 'Código morto ou import não usado.', 'Trabalho redundante pequeno: a mesma consulta repetida num laço curto.', 'Script de desenvolvimento que só roda no macOS.', 'Falta de teste em código que o PR não alterou.', 'Desalinhamento visual leve, sem perder função.']),
]
REGRAS_PT = [
    'Avaliar só a consequência que o comentário e o gatilho declarado sustentam. Não inventar escala, sucesso de exploit, rota alternativa, recuperação, nem se o comportamento é novo. Achado que o próprio texto refuta vai para revisão de validade, não para severidade.',
    'Usar a consequência mais alta que o texto sustenta. Tamanho do grupo afetado, feature flag, raridade do gatilho e concorrência não rebaixam.',
    'Controle de admissão (high): limites de vagas, dispositivos ou licenças; janelas de agendamento permitidas, inclusive overrides de data e horário de trabalho; listas de bloqueio de participantes; elegibilidade pelo ciclo de vida da reserva. Exige aceitar de fato uma reserva, um convidado ou um dispositivo inelegível; exibir ou descrever errado a restrição não conta.',
    'Efeito durável essencial: os registros principais do sistema e as integrações de calendário. Erro só em anexos ou e-mails para destinatários é saída secundária (medium), salvo consequência maior.',
    'Duplicação limitada é medium, salvo se viola um controle de admissão ou quebra uma atualização operacional essencial. Erro cosmético ou de métrica persistente continua limitado.',
    'Campo faltando, await faltando ou crescimento de recurso, sozinhos, não provam queda. Testes se julgam pelo dano à verificação, não pela gravidade do bug que poderiam deixar passar.',
]
def tab_defs():
    cards = ''.join(f'<div class="lvl lvl-{n}"><h3>{n}</h3><p>{E(t)}</p><div class="ex">Exemplos</div><ul>{"".join(f"<li>{E(x)}</li>" for x in ex)}</ul></div>' for n, t, ex in NIVEIS_PT)
    regras = ''.join(f'<li>{E(r)}</li>' for r in REGRAS_PT)
    mud = ''.join(f'<tr><td>{de}</td><td>{para}</td><td>{n}</td></tr>' for (de, para), n in MUDANCAS.most_common())
    lista = ''.join(f'<tr><td class="id">{E(k)}</td><td>{v["de"]} → {v["para"]}</td><td class="mot">{E(v["motivo"])}</td></tr>' for k, v in sorted(REV.items()))
    return f"""<p>O Astra leu os 431 problemas reais do gold v3 com a severidade de cada um e escreveu a definição de cada nível a partir dos rótulos. O Opus revisou cada versão (4 rodadas do Astra, 2 do Opus), e os rótulos inconsistentes foram corrigidos no gold quando os dois concordaram. Os testes da outra aba foram medidos com os rótulos de antes dessa correção.</p>
<div class="lvls">{cards}</div>
<h2>Regras de fronteira</h2><ul class="regras">{regras}</ul>
<h2>Texto para o prompt</h2><p>A mesma definição, em inglês, como vai no prompt de severidade (evals/severity/definitions.md).</p>
<pre class="en">{E(DEF_EN)}</pre>
"""

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
:root{{--bg:#f6f7f9;--card:#fff;--fg:#1b2330;--mut:#5d6878;--line:#dfe3ea;--ok:#1f7a4d;--okb:#e3f3ea;--mid:#8a5a00;--midb:#fbf0d9;--bad:#b4362c;--badb:#fbe6e3;--acc:#2f5aa8;
--sans:"IBM Plex Sans",system-ui,sans-serif}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#12161d;--card:#1a2029;--fg:#e4e8ef;--mut:#98a3b3;--line:#2c3542;--ok:#5cc58f;--okb:#183528;--mid:#e0b45a;--midb:#3a2f17;--bad:#f07a6f;--badb:#3d1f1c;--acc:#8fb0ee;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#12161d;--card:#1a2029;--fg:#e4e8ef;--mut:#98a3b3;--line:#2c3542;--ok:#5cc58f;--okb:#183528;--mid:#e0b45a;--midb:#3a2f17;--bad:#f07a6f;--badb:#3d1f1c;--acc:#8fb0ee;color-scheme:dark}}
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
.tabs{{display:flex;gap:4px;border-bottom:1px solid var(--line)}}.tabs button{{font:inherit;font-weight:600;background:none;border:0;border-bottom:2px solid transparent;padding:8px 14px;color:var(--mut);cursor:pointer}}.tabs button.on{{color:var(--fg);border-bottom-color:var(--fg)}}.tabs button:focus-visible{{outline:2px solid var(--fg)}}
.aba{{display:grid;gap:26px}}
.lvls{{display:grid;gap:12px}}.lvl{{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:8px;padding:12px 16px;min-width:0}}.lvl h3{{margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em;font-size:.85rem;color:var(--c)}}.lvl p{{color:var(--fg)}}.lvl ul{{margin:10px 0 0;padding-left:18px;color:var(--mut);columns:2 22em;column-gap:28px}}.lvl li{{break-inside:avoid;margin-bottom:4px}}.lvl .ex{{margin-top:10px;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);font-weight:600}}
.lvl-critical{{--c:var(--bad)}}.lvl-high{{--c:var(--mid)}}.lvl-medium{{--c:var(--acc)}}.lvl-low{{--c:var(--mut)}}
.regras{{margin:0;padding-left:20px;display:grid;gap:6px}}
pre.en{{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;font:13px/1.5 ui-monospace,monospace;margin:0;overflow-x:auto}}
details summary{{cursor:pointer;font-weight:600;margin-bottom:8px}}table.rev td{{white-space:normal;text-align:left;vertical-align:top}}table.rev td.id{{font:12px ui-monospace,monospace;word-break:break-all;min-width:16em}}table.rev td.mot{{color:var(--mut)}}
.sep{{border-left:1px solid var(--line)}}.leitura{{color:var(--fg)}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap">
<main>
<h1>Severidade: testes de prompt</h1>
<div class="tabs" id="tabs"><button class="on" data-t="testes">Testes</button><button data-t="defs">Definições</button></div>
<section id="t-testes" class="aba">
<p>Meta: 80% de acerto em cada nível, separado. Dataset: 158 problemas reais do gold v3, medidos com os rótulos de antes da revisão das definições (50 low, 50 medium, 50 high, 8 critical). Errou, errou: um nível ou três dá no mesmo. Única tolerância: critical respondido como high conta como acerto. Verde ≥ 80% (na meta), amarelo 70–79%, vermelho abaixo de 70%. Pior nível: o nível de menor acerto do modelo, que é o que decide a meta.</p>
<p class="leitura"><b>Resultado:</b> o Opus bate a meta de 80% em todos os níveis (teste 9 e refino 2); o DeepSeek fica a um item dela em high (80/88/78/100 no refino 2) e o GPT a um item em medium e high (80/78/78/100 no refino 4). O Sonnet não chega: rebaixa high em todos os testes. O que segura é high, de 74% a 80%, e os erros que sobram são em boa parte os mesmos itens nos quatro modelos: o próprio Astra, segundo anotador do gold, concorda com o rótulo em só 71% dos low e 57% dos medium que deu para conferir. O trecho do código e o label não ajudam; o voto de 3 respostas ajuda 2 a 4 itens em high. Candidato para produção: refino 2 (teste 11), sem código, uma chamada por PR, com ou sem voto.</p>
{''.join(blocos)}
</section>
<section id="t-defs" class="aba" hidden>{tab_defs()}</section>
</main>
<script>
function aba(t){{document.querySelectorAll('#tabs button').forEach(function(b){{b.classList.toggle('on',b.dataset.t===t);}});['testes','defs'].forEach(function(n){{document.getElementById('t-'+n).hidden=n!==t;}});}}
document.getElementById('tabs').addEventListener('click',function(e){{var b=e.target.closest('button');if(b){{aba(b.dataset.t);try{{history.replaceState(null,'','#'+b.dataset.t);}}catch(_){{}}}}}});
if(location.hash.slice(1)==='defs')aba('defs');
</script>
'''
open(OUT, 'w').write(page)
print(OUT)
