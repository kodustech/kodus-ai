#!/usr/bin/env python3
"""Severity tests page: reads results/<prompt>/*.json, newest test first.
  python3 evals/severity/report.py <out.html>"""
import json, os, sys, html

AQUI = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
MODELOS = [('gpt-6.1-sol_sub', 'GPT Sol'), ('claude-opus-5.5_api', 'Opus'), ('claude-sonnet-5.5_api', 'Sonnet'), ('deepseek-v4.1-flash_together', 'DeepSeek'), ('kimi-k2.7-code_openrouter', 'Kimi')]
NIVEIS = ['low', 'medium', 'high', 'critical']
# (pasta em results/, título, o que mudou), do mais novo para o mais antigo.
TESTES = json.load(open(f'{AQUI}/tests.json'))
E = html.escape
# Scored against the current dataset labels (gold v3 after the 68 relabels), not the gold stored in each run.
_ITENS = json.load(open(f'{AQUI}/dataset/items.json'))['items']
# Testes 16 em diante: rótulo pelo texto da sugestão. Antes: o rótulo do gold v3 (severityGold), com o qual rodaram.
ROTULOS = {'texto': {x['issueId']: x['severity'] for x in _ITENS}, 'gold': {x['issueId']: x['severityGold'] for x in _ITENS if x.get('severityGold')}}


def por_nivel(rows, rotulo='texto'):
    GOLD = ROTULOS[rotulo]
    rows = [r for r in rows if r['issueId'] in GOLD]
    certo = lambda g, x: x in ('high', 'critical') if g == 'critical' else x == g
    feitos = [r for r in rows if r.get('got')]
    return {l: {'n': sum(GOLD[r['issueId']] == l for r in feitos), 'right': sum(GOLD[r['issueId']] == l and certo(l, r['got']) for r in feitos)} for l in NIVEIS}


def celula(lv):
    if not lv or not lv['n']: return '<td class="na">—</td>'
    p = 100 * lv['right'] / lv['n']
    cls = 'ok' if p >= 80 else 'mid' if p >= 70 else 'bad'
    return f'<td class="{cls}">{lv["right"]}/{lv["n"]}<small>{p:.0f}%</small></td>'


def tabela(pasta, rotulo='texto'):
    linhas = []
    for slug, nome in MODELOS:
        f = f'{AQUI}/results/{pasta}/{slug}.json'
        sub = f.replace('_api.json', '_sdk.json')  # Claude by subscription when the API was out of quota
        if not os.path.exists(f) and os.path.exists(sub): f = sub
        if not os.path.exists(f) and slug.startswith('kimi'):
            continue
        if not os.path.exists(f):
            linhas.append(f'<tr><td>{nome}</td>' + '<td class="na">—</td>' * 5 + '</tr>')
            continue
        d = json.load(open(f))
        pl = por_nivel(d['rows'], rotulo)
        d['rows'] = [r for r in d['rows'] if r['issueId'] in ROTULOS[rotulo]]
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
    ('critical', 'Um caminho concreto para burlar um fator de autenticação por quem não tem nenhum fator válido, administração não autorizada ampla, execução controlada pelo atacante no navegador ou no servidor, ou perda destrutiva sistêmica de uma fila inteira ou de um fluxo contínuo de trabalho.',
     ['SQL injection ou command injection com entrada comum de usuário.', 'XSS armazenado: conteúdo de um usuário roda como script para outros usuários ou para o admin.', 'Execução remota de código (deserialização insegura, template avaliado com entrada do usuário).', 'Login aceito sem senha ou sem o segundo fator, por quem não tem nenhum fator válido.', 'Usuário só de leitura consegue se dar permissão de administrador.', 'Worker reiniciado marca a fila inteira de jobs como concluída sem processar.', 'Migração apaga ou sobrescreve dados de produção de todos os clientes.']),
    ('high', 'Um caminho operacional suportado fica inutilizável para entradas válidas (inclusive um caminho de interface identificado); um efeito durável essencial falha; uma entidade principal fica sem o identificador obrigatório; dados operacionais são apagados indevidamente; ou um controle de segurança ou de admissão é burlado. Inclui queda em produção comprovada e build ou deploy de produção bloqueado.',
     ['Crash (500) no fluxo principal para usuário comum, como quem ainda não tem um registro opcional.', 'Usuário acessa ou altera dado de outro usuário ou de outro tenant (IDOR, checagem de permissão errada).', 'Race condition que deixa passar do limite de vagas, de dispositivos ou de licenças.', 'Reserva aceita fora da janela de agendamento ou para convidado bloqueado.', 'Cancelar ou remarcar não atualiza o evento no calendário integrado.', 'Registro apagado ou sobrescrito indevidamente.', 'Credencial salva corrompida quebra a integração daí em diante.', 'Código de recuperação substituído continua aceito no login (exige ter o código antigo).', 'Migração ou build quebra o deploy de produção.', 'Mudança de contrato que quebra quem já chama a API.']),
    ('medium', 'Defeito real, mas limitado: métrica, alerta ou outra saída secundária errada; mensagem ou feedback enganoso para o usuário; falha de uma requisição isolada; falha confinada a um registro ou embed, mesmo que se repita para ele; tratamento comum de entrada inválida; trabalho extra significativo; fraqueza de segurança ou privacidade limitada. Lint ou CI quebrado que só trava o desenvolvimento é medium. Problema que nenhum caminho atual alcança (só um chamador futuro, uma extensão customizada ou uma configuração que ninguém usa) é medium no máximo. Falta de teste para comportamento relevante que o PR adiciona é medium. Teste que passa sem verificar o que diz verificar é medium.',
     ['Race condition cujo efeito é só um registro duplicado.', 'Comparação de segredo sem tempo constante, mesmo quando o comentário afirma que dá para recuperar o segredo, sem mostrar como.', 'Lentidão relevante: N+1 em coleção grande, trabalho síncrono pesado, falta de paginação.', 'Erro errado para entrada inválida, como 500 no lugar de 400.', 'Métrica ou alerta errado, ou mensagem enganosa para o usuário.', 'Jobs reprocessados em duplicidade depois de um desligamento, sem perda.', 'Lint quebrando o CI.', 'Contador ou badge desatualizado até recarregar a página.', 'E-mail ou anexo enviado com dado errado, sem afetar o registro principal.', 'await faltando: o trabalho roda, mas o erro é engolido.', 'Comportamento novo do PR sem teste, ou teste que passa sem verificar o que diz verificar.']),
    ('low', 'Manutenção, inconsistência cosmética, pouco trabalho redundante, conteúdo de log (linha, campo ou contexto de log faltando, errado ou enganoso), falta de teste em código não alterado ou trivial, fixture de teste imprecisa sem teste que passe falsamente, vazamento de recurso só em teste. N+1 em laço pequeno e limitado é low; N+1 sozinho não prova carga significativa.',
     ['Nome de função ou variável enganoso.', 'Log sem os campos da requisição ou com o tipo errado na mensagem.', 'Comentário ou docstring desatualizado.', 'Texto na interface sem tradução.', 'Código morto ou import não usado.', 'Trabalho redundante pequeno: a mesma consulta repetida num laço curto.', 'Falta de teste em código que o PR não alterou.', 'Desalinhamento visual leve, sem perder função.']),
]
REGRAS_PT = [
    'Avaliar só a consequência que o comentário e o gatilho declarado sustentam. Não inventar escala, sucesso de exploit, rota alternativa, recuperação, nem se o comportamento é novo. Os fatos sobre o código valem como verdade; o sucesso de um ataque que o comentário só afirma, sem o caminho concreto, não: vale a fraqueza (medium). Achado que o próprio texto refuta vai para revisão de validade, não para severidade.',
    'Usar a consequência mais alta que o texto sustenta. Tamanho do grupo afetado, feature flag, raridade do gatilho e concorrência não rebaixam.',
    'Controle de admissão (high): limites de vagas, dispositivos ou licenças; janelas de agendamento permitidas, inclusive overrides de data e horário de trabalho; listas de bloqueio de participantes; elegibilidade pelo ciclo de vida da reserva. Exige aceitar de fato uma reserva, um convidado ou um dispositivo inelegível; exibir ou descrever errado a restrição não conta. Negar por engano um acesso legítimo não é burla: é medium, salvo se inutiliza um caminho suportado.',
    'Efeito durável essencial: os registros principais do sistema e as integrações de calendário. Erro só em anexos ou e-mails para destinatários é saída secundária (medium), salvo consequência maior.',
    'Critical de perda exige trabalho marcado como feito sem ser processado; trabalho reprocessado ou duplicado, sem perda, é medium. Duplicação limitada é medium, salvo se viola um controle de admissão ou quebra uma atualização operacional essencial. Erro cosmético ou de métrica persistente continua limitado.',
    'Campo faltando, await faltando ou crescimento de recurso, sozinhos, não provam queda. Testes se julgam pelo dano à verificação, não pela gravidade do bug que poderiam deixar passar.',
]
def tab_defs():
    cards = ''.join(f'<div class="lvl lvl-{n}"><h3>{n}</h3><p>{E(t)}</p><div class="ex">Exemplos</div><ul>{"".join(f"<li>{E(x)}</li>" for x in ex)}</ul></div>' for n, t, ex in NIVEIS_PT)
    regras = ''.join(f'<li>{E(r)}</li>' for r in REGRAS_PT)
    mud = ''.join(f'<tr><td>{de}</td><td>{para}</td><td>{n}</td></tr>' for (de, para), n in MUDANCAS.most_common())
    lista = ''.join(f'<tr><td class="id">{E(k)}</td><td>{v["de"]} → {v["para"]}</td><td class="mot">{E(v["motivo"])}</td></tr>' for k, v in sorted(REV.items()))
    return f"""<p>O Astra leu os 431 problemas reais do gold v3 com a severidade de cada um e escreveu a definição de cada nível a partir dos rótulos. O Opus revisou cada versão (4 rodadas do Astra, 2 do Opus), e os rótulos inconsistentes foram corrigidos no gold quando os dois concordaram.</p>
<div class="lvls">{cards}</div>
<h2>Regras de fronteira</h2><ul class="regras">{regras}</ul>
<h2>Texto para o prompt</h2><p>A mesma definição, em inglês, como vai no prompt de severidade (evals/severity/definitions.md).</p>
<pre class="en">{E(DEF_EN)}</pre>
"""

blocos = []
for t in TESTES:
    blocos.append(f'''<section>
<h2>{E(t["titulo"])}</h2>
{'<p class="hist">Histórico: 158 itens medidos pelo rótulo do gold v3 (o problema), não pelo texto; prompt desalinhado da definição final.</p>' if t.get("rotulo") == "gold" else ''}
<p>{E(t["mudou"])}</p>
<div class="wrap"><table><thead><tr><th>Modelo</th><th>low</th><th>medium</th><th>high</th><th>critical</th><th class="sep">Total</th><th>Pior nível</th></tr></thead>
<tbody>{tabela(t["pasta"], t.get("rotulo", "texto"))}</tbody></table></div>
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
.sep{{border-left:1px solid var(--line)}}.hist{{color:var(--mut);font-size:12px;font-style:italic;margin:2px 0}}.leitura{{color:var(--fg)}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap">
<main>
<h1>Severidade: testes de prompt</h1>
<div class="tabs" id="tabs"><button class="on" data-t="testes">Testes</button><button data-t="defs">Definições</button></div>
<section id="t-testes" class="aba">
<p>Meta: 80% de acerto em cada nível, separado. Dataset: 205 sugestões rotuladas pelo próprio texto, contra a definição da aba Definições (50 low, 70 medium, 50 high, 35 critical; 31 dos critical são sintéticos, confirmados pelo Astra, porque o gold só tem 4). Errou, errou: um nível ou três dá no mesmo. Única tolerância: critical respondido como high conta como acerto. Verde ≥ 80% (na meta), amarelo 70–79%, vermelho abaixo de 70%. Pior nível: o nível de menor acerto do modelo, que é o que decide a meta.</p>
<p class="leitura"><b>Resultado:</b> o teste 16 (definição final, voto de 3) bate a meta de 80% em todos os níveis no Opus (86/93/84/100), no DeepSeek (90/89/88/100) e no GPT (86/93/80/100). O Kimi fica a 3 itens em medium (76%, sobe medium para high) e o Sonnet em high (62%, rebaixa high para medium). O prompt de produção, nos mesmos itens, fica em 27–51% no medium e 42–58% no high. Os testes 1 a 15 abaixo são histórico, medidos pelo rótulo do gold.</p>
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
