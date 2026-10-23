#!/usr/bin/env python3
"""Severity tests page: reads results/<prompt>/*.json, newest test first.
  python3 evals/severity/report.py <out.html>"""
import json, os, sys, html, glob
from collections import Counter

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
    cls = 'ok' if p >= 85 else 'mid' if p >= 75 else 'bad'
    return f'<td class="{cls}">{lv["right"]}/{lv["n"]}<small>{p:.0f}%</small></td>'


# Uma chamada por PR, como em produção: cada voto de uma rodada de 3 é uma chamada independente,
# e cada chamada vira uma linha própria, sem combinar.
def linhas_uma(nome, rows, rotulo):
    k = len(rows[0].get('votes') or [])
    out = []
    for i in range(k):
        pl = por_nivel([{**r, 'got': r['votes'][i]} for r in rows], rotulo)
        tot = sum(pl[l]['right'] for l in NIVEIS)
        n = sum(pl[l]['n'] for l in NIVEIS)
        piso = min(100 * pl[l]['right'] / pl[l]['n'] for l in NIVEIS if pl[l]['n'])
        cls = 'ok' if piso >= 85 else 'mid' if piso >= 75 else 'bad'
        out.append(f'<tr><td>{nome} · chamada {i + 1}</td>' + ''.join(celula(pl[l]) for l in NIVEIS) + f'<td class="sep">{tot}/{n}<small>{100 * tot / n:.0f}%</small></td><td class="{cls}">{piso:.0f}%</td></tr>')
    return ''.join(out)


def tabela(pasta, rotulo='texto', uma=False, so=None):
    linhas = []
    for slug, nome in MODELOS:
        if so and nome not in so: continue
        f = f'{AQUI}/results/{pasta}/{slug}.json'
        sub = f.replace('_api.json', '_sdk.json')  # Claude by subscription when the API was out of quota
        if not os.path.exists(f) and os.path.exists(sub): f = sub
        if not os.path.exists(f) and slug.startswith('kimi'):
            continue
        if not os.path.exists(f):
            linhas.append(f'<tr><td>{nome}</td>' + '<td class="na">—</td>' * 5 + '</tr>')
            continue
        d = json.load(open(f))
        if uma:
            # Rodadas repetidas (<modelo>-run2.json...) entram como mais chamadas do mesmo item.
            votos = {r['issueId']: list(r['votes']) for r in d['rows']}
            for extra in sorted(glob.glob(f.replace('.json', '-run*.json'))):
                for r in json.load(open(extra))['rows']: votos[r['issueId']] += r['votes']
            linhas.append(linhas_uma(nome, [{**r, 'votes': votos[r['issueId']]} for r in d['rows']], rotulo))
            continue
        pl = por_nivel(d['rows'], rotulo)
        d['rows'] = [r for r in d['rows'] if r['issueId'] in ROTULOS[rotulo]]
        tot = sum(pl[l]['right'] for l in NIVEIS)
        n = sum(1 for _ in d['rows'])
        piso = min(100 * pl[l]['right'] / pl[l]['n'] for l in NIVEIS if pl[l]['n'])
        cls = 'ok' if piso >= 85 else 'mid' if piso >= 75 else 'bad'
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


# Aba Erros: por nível atribuído, quantos itens receberam aquele nível sem ser dele (rótulo pelo texto).
# Uma linha por chamada. Aqui critical respondido como high conta como high errado.
def erros_linhas(nome, rows):
    GOLD = ROTULOS['texto']
    k = len(rows[0]['votes'])
    # Só a melhor chamada: a de menos itens com nível errado (estrito).
    i = min(range(k), key=lambda j: sum(r['votes'][j] != GOLD[r['issueId']] for r in rows))
    cel = []
    for l in reversed(NIVEIS):
        dados = [r for r in rows if r['votes'][i] == l]
        errados = [GOLD[r['issueId']] for r in dados if GOLD[r['issueId']] != l]
        if not dados:
            cel.append('<td class="na">—</td>')
            continue
        p = 100 * len(errados) / len(dados)
        # Azul: na faixa amarela, mas todo erro é um nível só abaixo do real (subestima, não infla).
        um_abaixo = errados and all(NIVEIS.index(g) == NIVEIS.index(l) + 1 for g in errados)
        cls = 'ok' if p <= 15 else ('blue' if um_abaixo else 'mid') if p <= 25 else 'bad'
        de = ', '.join(f'{errados.count(g)} {g}' for g in reversed(NIVEIS) if errados.count(g))
        cel.append(f'<td class="{cls}">{len(errados)}/{len(dados)} · {p:.0f}%<small>{de or "nenhum"}</small></td>')
    errs = sum(r['votes'][i] != GOLD[r['issueId']] for r in rows)
    return f'<tr><td>{nome}<small>chamada {i + 1} de {k} · {errs} erros</small></td>{"".join(cel)}</tr>'


# Veredito: por chamada, quantos erros sobem (nível dado acima do real) e quantos descem, e os passos mais comuns.
def veredito(nome, teste, rows):
    GOLD = ROTULOS['texto']
    k = len(rows[0]['votes'])
    sobe, desce = Counter(), Counter()
    for r in rows:
        g = NIVEIS.index(GOLD[r['issueId']])
        for v in r['votes']:
            if v not in NIVEIS: continue
            d = NIVEIS.index(v) - g
            if d > 0: sobe[(GOLD[r['issueId']], v)] += 1
            if d < 0: desce[(GOLD[r['issueId']], v)] += 1
    s, d = sum(sobe.values()) / k, sum(desce.values()) / k
    if d >= 1.5 * s: lado, cls = 'erra mais para baixo', 'baixo'
    elif s >= 1.5 * d: lado, cls = 'erra mais para cima', 'cima'
    else: lado, cls = 'erra para os dois lados', 'meio'
    passos = lambda c: ', '.join(f'{a}→{b} {n / k:.1f}' for (a, b), n in c.most_common(3)) or 'nenhum'
    return f'<tr><td>{E(nome)}</td><td>{E(teste)}</td><td class="sep">{s:.1f}</td><td>{d:.1f}</td><td class="v-{cls}">{lado}</td><td class="mot">sobe: {passos(sobe)}<br>desce: {passos(desce)}</td></tr>'


def tab_erros():
    blocos, vered = [], []
    for t in [x for x in TESTES if x.get('uma')]:
        linhas = []
        for slug, nome in MODELOS:
            if t.get('modelos') and nome not in t['modelos']: continue
            f = f'{AQUI}/results/{t["pasta"]}/{slug}.json'.replace('_api.json', '_sdk.json')
            if not os.path.exists(f): continue
            rows = [r for r in json.load(open(f))['rows'] if r['issueId'] in ROTULOS['texto']]
            votos = {r['issueId']: list(r['votes']) for r in rows}
            for extra in sorted(glob.glob(f.replace('.json', '-run*.json'))):
                for r in json.load(open(extra))['rows']: votos[r['issueId']] += r['votes']
            todas = [{**r, 'votes': votos[r['issueId']]} for r in rows]
            linhas.append(erros_linhas(nome, todas))
            vered.append((nome, t['titulo'].split(' · ')[0], todas))
        blocos.append(f'''<section><h2>{E(t["titulo"])}</h2>
<div class="wrap"><table><thead><tr><th>Modelo</th><th>recebeu critical</th><th>recebeu high</th><th>recebeu medium</th><th>recebeu low</th></tr></thead>
<tbody>{"".join(linhas)}</tbody></table></div></section>''')
    return f'''<p>O avesso da aba Testes: em vez de quanto de cada nível o modelo acertou, quanto do que ele <b>deu</b> a cada nível estava errado. Cada célula: itens que receberam o nível sem ser dele / itens que receberam o nível, o %, e embaixo o nível real dos errados. Aqui é estrito: um critical respondido como high conta como high errado (na aba Testes ele conta como acerto). Uma chamada por PR, como em produção, e só a melhor chamada de cada modelo em cada teste: a que errou menos itens no total. Meta: até 15% errado (85% de acerto) é verde; 16–25% é amarelo, ou azul quando todo erro da célula é um nível só abaixo do real (o modelo subestimou, não inflou); acima de 25% é sempre vermelho.</p>
{"".join(blocos)}
<section><h2>Veredito: para que lado erra</h2>
<p>Erros por chamada, em média de todas as chamadas (não só a melhor): sobe é o nível dado acima do real (infla), desce é abaixo (rebaixa). Um lado ganha quando tem pelo menos 1,5 vez os erros do outro. Ao lado, os três passos mais comuns de cada lado, com a média por chamada. Estrito como as tabelas acima: critical respondido como high conta como descer.</p>
<div class="wrap"><table><thead><tr><th>Modelo</th><th>Teste</th><th class="sep">Sobe</th><th>Desce</th><th>Veredito</th><th>Passos mais comuns</th></tr></thead>
<tbody>{"".join(veredito(n, t, r) for n, t, r in sorted(vered, key=lambda x: ([m for _, m in MODELOS].index(x[0]), x[1])))}</tbody></table></div></section>'''

blocos = []
for t in TESTES:
    blocos.append(f'''<section>
<h2>{E(t["titulo"])}</h2>
{'<p class="hist">Histórico: 158 itens medidos pelo rótulo do gold v3 (o problema), não pelo texto; prompt desalinhado da definição final.</p>' if t.get("rotulo") == "gold" else ''}
<p>{E(t["mudou"])}</p>
<div class="wrap"><table><thead><tr><th>Modelo</th><th>low</th><th>medium</th><th>high</th><th>critical</th><th class="sep">Total</th><th>Pior nível</th></tr></thead>
<tbody>{tabela(t["pasta"], t.get("rotulo", "texto"), t.get("uma", False), t.get("modelos"))}</tbody></table></div>
{f'<p class="leitura">{E(t["leitura"])}</p>' if t.get("leitura") else ''}
</section>''')

page = f'''<title>Severidade em produção</title>
<style>
/* Testes empilhados, o mais novo em cima. */
:root{{--bg:#f6f7f9;--card:#fff;--fg:#1b2330;--mut:#5d6878;--line:#dfe3ea;--ok:#1f7a4d;--okb:#e3f3ea;--mid:#8a5a00;--midb:#fbf0d9;--bad:#b4362c;--badb:#fbe6e3;--acc:#2f5aa8;--blueb:#e3ebf8;
--sans:"IBM Plex Sans",system-ui,sans-serif}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#12161d;--card:#1a2029;--fg:#e4e8ef;--mut:#98a3b3;--line:#2c3542;--ok:#5cc58f;--okb:#183528;--mid:#e0b45a;--midb:#3a2f17;--bad:#f07a6f;--badb:#3d1f1c;--acc:#8fb0ee;--blueb:#1c2a44;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#12161d;--card:#1a2029;--fg:#e4e8ef;--mut:#98a3b3;--line:#2c3542;--ok:#5cc58f;--okb:#183528;--mid:#e0b45a;--midb:#3a2f17;--bad:#f07a6f;--badb:#3d1f1c;--acc:#8fb0ee;--blueb:#1c2a44;color-scheme:dark}}
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
td.ok{{color:var(--ok);background:var(--okb);font-weight:600}}td.mid{{color:var(--mid);background:var(--midb);font-weight:600}}td.bad{{color:var(--bad);background:var(--badb);font-weight:600}}td.blue{{color:var(--acc);background:var(--blueb);font-weight:600}}td.na{{color:var(--mut)}}
.tabs{{display:flex;gap:4px;border-bottom:1px solid var(--line)}}.tabs button{{font:inherit;font-weight:600;background:none;border:0;border-bottom:2px solid transparent;padding:8px 14px;color:var(--mut);cursor:pointer}}.tabs button.on{{color:var(--fg);border-bottom-color:var(--fg)}}.tabs button:focus-visible{{outline:2px solid var(--fg)}}
.aba{{display:grid;gap:26px}}
.lvls{{display:grid;gap:12px}}.lvl{{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:8px;padding:12px 16px;min-width:0}}.lvl h3{{margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em;font-size:.85rem;color:var(--c)}}.lvl p{{color:var(--fg)}}.lvl ul{{margin:10px 0 0;padding-left:18px;color:var(--mut);columns:2 22em;column-gap:28px}}.lvl li{{break-inside:avoid;margin-bottom:4px}}.lvl .ex{{margin-top:10px;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);font-weight:600}}
.lvl-critical{{--c:var(--bad)}}.lvl-high{{--c:var(--mid)}}.lvl-medium{{--c:var(--acc)}}.lvl-low{{--c:var(--mut)}}
.regras{{margin:0;padding-left:20px;display:grid;gap:6px}}
pre.en{{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;font:13px/1.5 ui-monospace,monospace;margin:0;overflow-x:auto}}
td.mot{{white-space:normal;text-align:left;color:var(--mut);font-size:.85rem;min-width:18em}}td.v-cima,td.v-baixo,td.v-meio{{text-align:left;font-weight:600}}td.v-cima{{color:var(--bad)}}td.v-baixo{{color:var(--acc)}}
details summary{{cursor:pointer;font-weight:600;margin-bottom:8px}}table.rev td{{white-space:normal;text-align:left;vertical-align:top}}table.rev td.id{{font:12px ui-monospace,monospace;word-break:break-all;min-width:16em}}table.rev td.mot{{color:var(--mut)}}
.sep{{border-left:1px solid var(--line)}}.hist{{color:var(--mut);font-size:12px;font-style:italic;margin:2px 0}}.leitura{{color:var(--fg)}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap">
<main>
<h1>Severidade: testes de prompt</h1>
<div class="tabs" id="tabs"><button class="on" data-t="testes">Testes</button><button data-t="erros">Erros</button><button data-t="defs">Definições</button></div>
<section id="t-testes" class="aba">
<p>Meta: 85% de acerto em cada nível, separado. Dataset: 205 sugestões rotuladas pelo próprio texto, contra a definição da aba Definições (50 low, 70 medium, 50 high, 35 critical; 31 dos critical são sintéticos, confirmados pelo Astra, porque o gold só tem 4). Errou, errou: um nível ou três dá no mesmo. Única tolerância: critical respondido como high conta como acerto. Verde ≥ 85% (na meta), amarelo 75–84%, vermelho abaixo de 75%. Pior nível: o nível de menor acerto do modelo, que é o que decide a meta.</p>
<p class="leitura"><b>Resultado:</b> com a meta de 85% e uma chamada por PR, como em produção, só o DeepSeek passa em todos os níveis em toda chamada no teste 16 (pior nível 86%). O Opus fica no limite (84–86%), o GPT oscila no high (80–90%), o Kimi fica em 76–77% no medium (sobe medium para high). O Sonnet, que no teste 16 ficava em 58–64% no high, sobe para 74–80% com o 17b, que é o escolhido para ele. O prompt de produção fica em 27–51% no medium e 42–58% no high. Os testes 1 a 15 abaixo são histórico, medidos pelo rótulo do gold.</p>
{''.join(blocos)}
</section>
<section id="t-erros" class="aba" hidden>{tab_erros()}</section>
<section id="t-defs" class="aba" hidden>{tab_defs()}</section>
</main>
<script>
function aba(t){{document.querySelectorAll('#tabs button').forEach(function(b){{b.classList.toggle('on',b.dataset.t===t);}});['testes','erros','defs'].forEach(function(n){{document.getElementById('t-'+n).hidden=n!==t;}});}}
document.getElementById('tabs').addEventListener('click',function(e){{var b=e.target.closest('button');if(b){{aba(b.dataset.t);try{{history.replaceState(null,'','#'+b.dataset.t);}}catch(_){{}}}}}});
if(['defs','erros'].indexOf(location.hash.slice(1))>=0)aba(location.hash.slice(1));
</script>
'''
open(OUT, 'w').write(page)
print(OUT)
