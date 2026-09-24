/** HTML for the PR debugger. Kept apart from the data-gathering so a change to
 *  the checks never means touching markup, and vice-versa. */

const CSS = `
.agg{margin:1.2rem 0;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:10px;background:var(--surface-2,transparent)}
.agg h3{margin:0 0 .6rem}

  :root{
    --paper:#f5f7f6;--card:#fff;--line:#dde4e1;--line-soft:#eef2f0;
    --ink:#131e1b;--ink-soft:#54625d;--ink-mute:#8b9792;
    --ok:#1f6f5c;--ok-bg:#e8f2ee;--bad:#a6452f;--bad-bg:#f8eae5;--unk:#8a7a3f;--unk-bg:#f5efdd;
    --serif:"IBM Plex Serif",Georgia,serif;--sans:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --paper:#0f1513;--card:#171f1c;--line:#293430;--line-soft:#202a27;
    --ink:#e7eeeb;--ink-soft:#9caca6;--ink-mute:#6c7b76;
    --ok:#5cbfa1;--ok-bg:#15302a;--bad:#e08468;--bad-bg:#31211b;--unk:#d7bd6a;--unk-bg:#2d2718;}}
  :root[data-theme="dark"]{
    --paper:#0f1513;--card:#171f1c;--line:#293430;--line-soft:#202a27;
    --ink:#e7eeeb;--ink-soft:#9caca6;--ink-mute:#6c7b76;
    --ok:#5cbfa1;--ok-bg:#15302a;--bad:#e08468;--bad-bg:#31211b;--unk:#d7bd6a;--unk-bg:#2d2718;}

  *{box-sizing:border-box}
  body{margin:0;padding-block:2.25rem 4rem;padding-left:1.1rem;padding-right:1.1rem;
    background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;
    display:flex;justify-content:center}
  .page{width:100%;max-width:1000px;display:flex;flex-direction:column;gap:1.6rem}

  .eyebrow{font-family:var(--mono);font-size:.67rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute);margin:0}
  h1{font-family:var(--serif);font-size:1.7rem;margin:.35rem 0 .3rem;font-weight:600}
  .lede{margin:0;color:var(--ink-soft);max-width:66ch;font-size:.92rem}

  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:.6rem}
  .st{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.7rem .8rem;display:flex;flex-direction:column;gap:.12rem}
  .st .n{font-family:var(--mono);font-size:1.45rem;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}
  .st .k{font-size:.74rem;color:var(--ink-soft)}
  .st.bad .n{color:var(--bad)} .st.unk .n{color:var(--unk)} .st.ok .n{color:var(--ok)}

  .filters{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
  .filters button{font-family:var(--mono);font-size:.72rem;padding:.32rem .7rem;border-radius:5px;
    border:1px solid var(--line);background:var(--card);color:var(--ink-soft);cursor:pointer}
  .filters button[aria-pressed="true"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
  .filters button:focus-visible{outline:2px solid var(--ok);outline-offset:2px}

  details.pr{background:var(--card);border:1px solid var(--line);border-radius:7px}
  details.pr[open]{border-color:var(--ink-mute)}
  /* O grid vive num <div> dentro do <summary>, nunca no <summary>: o WebKit
     trata o summary como caixa especial e um display:grid nele embaralha a
     linha inteira — foi o que quebrava os PRs vizinhos ao expandir um. */
  details.pr summary{padding:0;cursor:pointer;display:block;list-style:none}
  details.pr summary::-webkit-details-marker{display:none}
  details.pr summary::marker{content:""}
  .s-row{padding:.75rem .9rem;display:grid;grid-template-columns:auto 1fr auto auto;
    gap:.7rem;align-items:center}
  summary:focus-visible{outline:2px solid var(--ok);outline-offset:-2px}
  .caret{font-family:var(--mono);color:var(--ink-mute);font-size:.8rem;transition:transform .15s}
  details[open] .caret{transform:rotate(90deg)}
  .s-title{min-width:0}
  .s-title b{display:block;font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-title span{font-family:var(--mono);font-size:.67rem;color:var(--ink-mute)}
  .pill{font-family:var(--mono);font-size:.66rem;padding:.16rem .45rem;border-radius:4px;white-space:nowrap}
  .pill.ok{background:var(--ok-bg);color:var(--ok)} .pill.bad{background:var(--bad-bg);color:var(--bad)}
  .pill.unk{background:var(--unk-bg);color:var(--unk)} .pill.mute{background:var(--line-soft);color:var(--ink-soft)}

  .body{border-top:1px solid var(--line);padding:.95rem}
  .body h3{margin:0 0 .55rem;font-family:var(--mono);font-size:.68rem;letter-spacing:.1em;
    text-transform:uppercase;color:var(--ink-mute);font-weight:500}
  .body section+section{margin-top:1.15rem}

  .steps{display:flex;flex-direction:column;gap:.3rem}
  .step{display:grid;grid-template-columns:3.3rem 1fr;gap:.6rem;padding:.4rem .5rem;border-radius:5px;background:var(--paper)}
  .step .mark{font-family:var(--mono);font-size:.64rem;font-weight:600;letter-spacing:.05em;padding-top:.08rem}
  .step.ok .mark{color:var(--ok)} .step.bad{background:var(--bad-bg)} .step.bad .mark{color:var(--bad)}
  .step.unk .mark{color:var(--unk)}
  .step .what{font-size:.85rem}
  .step .why{font-size:.76rem;color:var(--ink-soft);font-family:var(--mono);overflow-wrap:anywhere}

  .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.5rem}
  .kv div{background:var(--paper);border-radius:5px;padding:.45rem .55rem}
  .kv .k{font-size:.68rem;color:var(--ink-mute);font-family:var(--mono)}
  .kv .v{font-family:var(--mono);font-size:.84rem;font-variant-numeric:tabular-nums}

  table{border-collapse:collapse;width:100%;font-size:.8rem}
  th,td{text-align:left;padding:.33rem .5rem;border-bottom:1px solid var(--line-soft)}
  th{font-family:var(--mono);font-size:.63rem;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-mute);font-weight:500}
  td.n{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums}
  tbody tr:last-child td{border-bottom:0}
  .wrap{overflow-x:auto}

  ul.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.35rem}
  ul.list li{font-size:.82rem;color:var(--ink-soft);display:flex;gap:.45rem;align-items:baseline;flex-wrap:wrap}
  code{font-family:var(--mono);font-size:.92em;color:var(--ink)}

  a.lf{font-family:var(--mono);font-size:.72rem;color:var(--ok);text-decoration:none;border-bottom:1px solid currentColor}
  a.lf:hover{opacity:.75}
  .traces{display:flex;flex-direction:column;gap:.22rem;margin:.5rem 0 0}
  .traces a{font-family:var(--mono);font-size:.7rem;color:var(--ink-soft);text-decoration:none;
    display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
  .traces a:hover{color:var(--ok)}
  .traces .t-id{color:var(--ink-mute)}

  footer{font-family:var(--mono);font-size:.71rem;color:var(--ink-mute);line-height:1.75;border-top:1px solid var(--line);padding-top:.9rem}
  .hidden{display:none!important}
  @media (max-width:620px){
    .s-row{grid-template-columns:auto 1fr;gap:.4rem}
    .step{grid-template-columns:1fr;gap:.1rem}
  }
`;

function render(d) {
    const { cases, when, totalChecks, failed, unknown, prsWithFail, esc, short, num, DUMP } = d;
    const path = require('path');

    const prs = cases
        .map((c) => {
            const bad = c.checks.filter((x) => x.ok === false).length;
            const unk = c.checks.filter((x) => x.ok === null).length;
            const state = bad ? 'bad' : unk ? 'unk' : 'ok';
            const m = c.metrics || {};

            const steps = c.checks
                .map((x) => {
                    const cls = x.ok === true ? 'ok' : x.ok === false ? 'bad' : 'unk';
                    const mark = x.ok === true ? 'OK' : x.ok === false ? 'NÃO OK' : '?';
                    return `<div class="step ${cls}"><span class="mark">${mark}</span><span><span class="what">${esc(x.label)}</span><br><span class="why">${esc(x.detail)}</span></span></div>`;
                })
                .join('');

            const p = c.pipeline || {};
            const u = c.usage || {};

            const tr = c.langfuseTraces || [];
            const hhmmss = (t) => String(t || '').slice(11, 19);
            const lf = c.langfuse
                ? `<p style="margin:.6rem 0 0"><a class="lf" href="${esc(c.langfuse)}" target="_blank" rel="noreferrer">abrir a primeira execução no Langfuse${c.env ? ` (env: ${esc(c.env)})` : ''} ↗</a></p>
                   ${c.langfuseList ? `<p style="margin:.3rem 0 0"><a class="lf" href="${esc(c.langfuseList)}" target="_blank" rel="noreferrer">ver a lista filtrada por <code>${esc(c.runName)}</code> ↗</a></p>` : ''}
                   <div class="traces">${tr
                       .slice(0, 14)
                       .map(
                           (t, i) =>
                               `<a href="${esc(t.url)}" target="_blank" rel="noreferrer"><span class="t-id">${String(i + 1).padStart(2, '0')}</span> <span>${esc(hhmmss(t.ts))}</span> <span>${esc(t.name)}</span> <span class="t-id">${esc(String(t.id).slice(0, 12))}</span></a>`,
                       )
                       .join('')}</div>
                   ${tr.length > 14 ? `<p class="why" style="margin:.3rem 0 0">+${tr.length - 14} trace(s) além dos listados</p>` : ''}`
                : `<p class="why" style="margin:.6rem 0 0">${esc(c.langfuseNote || 'sem rastro no Langfuse para este run')}</p>`;
            const kv = `
              <div><div class="k">arquivos no prompt</div><div class="v">${num(p.filesInPrompt)}${c.git ? ` / ${num(c.git.reviewable)}` : ''}</div></div>
              <div><div class="k">prompt</div><div class="v">${num(Math.round(((p.systemPromptChars || 0) + (p.userPromptChars || 0)) / 1000))}k chars</div></div>
              <div><div class="k">janela</div><div class="v">${p.contextWindowTokens ? num(p.contextWindowTokens) : '—'}</div></div>
              <div><div class="k">tokens (total)</div><div class="v">${num(u.totalTokens)}</div></div>
              <div><div class="k">input</div><div class="v">${num(u.inputTokens)}</div></div>
              <div><div class="k">cache read</div><div class="v">${num(u.cacheReadTokens)}${u.inputTokens ? ` <span class="why">(${Math.round((100 * (u.cacheReadTokens || 0)) / u.inputTokens)}%)</span>` : ''}</div></div>
              <div><div class="k">output</div><div class="v">${num(u.outputTokens)}${u.reasoningTokens ? ` <span class="why">(${num(u.reasoningTokens)} reasoning)</span>` : ''}</div></div>
              <div><div class="k">tempo</div><div class="v">${c.durationMs ? (c.durationMs / 1000).toFixed(0) + 's' : '—'}</div></div>
              <div><div class="k">recall</div><div class="v">${m.tp != null ? `${m.tp}/${(m.tp || 0) + (m.fn || 0)}` : '—'}</div></div>`;

            // FUNIL: quantos entram e quantos deles eram acerto, etapa a etapa.
            // A queda de `n` e volume; a queda de `tp` e o que custa caro.
            const funil = (c.funil || []).length
                ? `<div class="wrap"><table><thead><tr><th>etapa</th><th>achados</th><th>acertos</th><th>falsos positivos</th><th>precisão</th><th>perdeu acerto</th></tr></thead><tbody>${c.funil
                      .map((e, i) => {
                          const ant = i > 0 ? c.funil[i - 1] : null;
                          const fp = e.tp == null ? null : e.n - e.tp;
                          const perdeu =
                              ant && ant.tp != null && e.tp != null
                                  ? ant.tp - e.tp
                                  : null;
                          return `<tr><td>${esc(e.nome)}</td><td class="n">${num(e.n)}${ant ? ` <span class="why">(−${num(ant.n - e.n)})</span>` : ''}</td><td class="n">${e.tp == null ? '—' : e.tp}</td><td class="n">${fp == null ? '—' : fp}</td><td class="n">${e.tp == null || !e.n ? '—' : Math.round((100 * e.tp) / e.n) + '%'}</td><td class="n">${perdeu == null ? '—' : perdeu > 0 ? `<span class="pill bad">−${perdeu}</span>` : '0'}</td></tr>`;
                      })
                      .join('')}</tbody></table></div>`
                : '<p class="why">sem funil registrado</p>';

            // Quem produziu o quê, e quanto sobreviveu. Responde "vale a pena
            // manter este agente?" por PR, em vez de só no agregado.
            const porAgente = (() => {
                const m2 = new Map();
                for (const x of c.candidates || []) {
                    const k = String(x.producedBy || '?').replace('micro-', '');
                    m2.set(k, (m2.get(k) || 0) + 1);
                }
                const postadoPor = new Map();
                for (const f of c.findings || []) {
                    const k = String(f.producedBy || '?').replace('micro-', '');
                    const cur = postadoPor.get(k) || { n: 0, hit: 0 };
                    cur.n++;
                    if (f.hit) cur.hit++;
                    postadoPor.set(k, cur);
                }
                if (!m2.size) return '<p class="why">sem candidatos</p>';
                const linhas = [...m2.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => {
                        const p2 = postadoPor.get(k) || { n: 0, hit: 0 };
                        return `<tr><td><code>${esc(k)}</code></td><td class="n">${n}</td><td class="n">${p2.n}</td><td class="n">${p2.hit > 0 ? `<span class="pill ok">${p2.hit}</span>` : '0'}</td></tr>`;
                    })
                    .join('');
                return `<div class="wrap"><table><thead><tr><th>agente</th><th>gerou</th><th>postou</th><th>acertos</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
            })();

            // Cobertura: arquivo que nenhuma ferramenta abriu. Separa "o
            // agente olhou e descreveu diferente" de "ninguem olhou o arquivo
            // onde estava o bug" — sao problemas opostos e o recall sozinho
            // nao distingue.
            const cov = (() => {
                const v = c.coverage;
                if (!v || v.totalTargets == null) return '<p class="why">sem registro de cobertura</p>';
                const pend = v.pendingFiles || [];
                const pct = v.totalTargets ? Math.round((100 * (v.touchedTargets || 0)) / v.totalTargets) : 0;
                return `<div class="kv">
                    <div><div class="k">alvos tocados</div><div class="v">${num(v.touchedTargets)} / ${num(v.totalTargets)} <span class="why">(${pct}%)</span></div></div>
                    <div><div class="k">não tocados</div><div class="v">${num(v.pendingTargets)}</div></div>
                  </div>
                  ${pend.length ? `<ul class="list">${pend.slice(0, 12).map((f) => `<li><span class="pill bad">não lido</span><code>${esc(f)}</code></li>`).join('')}</ul>${pend.length > 12 ? `<p class="why">+${pend.length - 12} arquivo(s)</p>` : ''}` : '<p class="why">todos os alvos foram abertos por alguma ferramenta</p>'}`;
            })();

            const passes = (c.passes || []).length
                ? `<div class="wrap"><table><thead><tr><th>passada</th><th>achados</th><th>tempo</th><th>steps</th><th>tools</th><th>input</th></tr></thead><tbody>${c.passes
                      .map(
                          (x) =>
                              `<tr><td><code>${esc(x.label)}</code></td><td class="n">${x.added > 0 ? '+' + x.added : '—'}</td><td class="n">${x.ms != null ? (x.ms / 1000).toFixed(1) + 's' : '—'}</td><td class="n">${x.steps}</td><td class="n">${x.toolCalls}</td><td class="n">${num(x.inputTokens)}</td></tr>`,
                      )
                      .join('')}</tbody></table></div>`
                : '<p class="why">nenhuma passada registrada</p>';

            const cands = (c.candidates || []).length
                ? `<div class="wrap"><table><thead><tr><th>origem</th><th>arquivo</th><th>sev</th><th>conf</th><th>resumo</th></tr></thead><tbody>${c.candidates
                      .map(
                          (x) =>
                              `<tr><td><code>${esc(String(x.producedBy || '?').replace('micro-', ''))}</code></td><td><code>${esc(short(x.relevantFile))}:${esc(x.relevantLinesStart)}</code></td><td>${esc(x.severity)}</td><td class="n">${esc(x.confidence)}</td><td>${esc(String(x.oneSentenceSummary || '').slice(0, 110))}</td></tr>`,
                      )
                      .join('')}</tbody></table></div>`
                : '<p class="why">nenhum candidato produzido</p>';

            const finals = (c.findings || []).length
                ? `<ul class="list">${c.findings
                      .map(
                          (f) =>
                              `<li><span class="pill ${f.hit ? 'ok' : 'bad'}">${f.hit ? 'acerto' : 'falso positivo'}</span><code>${esc(short(f.relevantFile))}:${esc(f.relevantLinesStart)}</code> ${esc(String(f.oneSentenceSummary || '').slice(0, 130))}</li>`,
                      )
                      .join('')}</ul>`
                : '<p class="why">nada postado</p>';

            const golds = (c.goldens || []).length
                ? `<ul class="list">${c.goldens
                      .map(
                          (g) =>
                              `<li><span class="pill ${g.found ? 'ok' : 'bad'}">${g.found ? 'achou' : 'perdeu'}</span><span class="why">${esc(g.sev)}</span>${esc(String(g.text).replace(/\s+/g, ' ').slice(0, 165))}</li>`,
                      )
                      .join('')}</ul>`
                : '<p class="why">sem goldens</p>';

            return `
  <details class="pr" data-state="${state}">
    <summary>
      <div class="s-row">
        <span class="caret">▸</span>
        <span class="s-title"><b>${esc(c.title)}</b><span>${esc(c.repo)} · ${esc(c.id)}</span></span>
        <span class="pill mute">${num(p.filesInPrompt)} arq</span>
        <span class="pill ${state}">${bad ? `${bad} NÃO OK` : unk ? `${unk} não verificável` : 'tudo OK'}</span>
      </div>
    </summary>
    <div class="body">
      <section>
        <h3>Passo a passo da execução</h3>
        <div class="steps">${steps}</div>
      </section>
      <section>
        <h3>Números</h3>
        <div class="kv">${kv}</div>
        ${lf}
        ${c.url ? `<p style="margin:.3rem 0 0"><a class="lf" href="${esc(c.url)}" target="_blank" rel="noreferrer">abrir o PR original ↗</a></p>` : ''}
      </section>
      <section><h3>Funil: onde os achados são perdidos</h3>${funil}</section>
      <section><h3>Cobertura do diff</h3>${cov}</section>
      <section><h3>Passadas</h3>${passes}</section>
      <section><h3>Por agente: gerou, postou, acertou</h3>${porAgente}</section>
      <section><h3>Candidatos antes do reducer</h3>${cands}</section>
      <section><h3>Postado ao final</h3>${finals}</section>
      <section><h3>Golden comments do PR</h3>${golds}</section>
    </div>
  </details>`;
        })
        .join('\n');

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debugger de PR</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@600&display=swap">
<style>${CSS}</style>
</head>
<body>

<div class="page">
  <header>
    <p class="eyebrow">Kodus · execução de ${esc(when)} · ${esc(path.basename(DUMP))}</p>
    <h1>Debugger de PR</h1>
    <p class="lede">Cada verificação é computada a partir do rastro da execução e do repositório clonado — a contagem de arquivos é conferida contra <code>git diff --name-only</code>, o formato do diff é inspecionado no prompt que foi enviado, e a chamada ao modelo é lida no transporte.</p>
  </header>

  ${(() => {
      // Agregado das mesmas etapas. O numero por PR diz onde doeu naquele caso;
      // este diz se dói sempre.
      const etapas = [];
      for (const c of cases) {
          (c.funil || []).forEach((e, i) => {
              etapas[i] ||= { nome: e.nome, n: 0, tp: 0, semRotulo: false };
              etapas[i].n += e.n;
              if (e.tp == null) etapas[i].semRotulo = true;
              else etapas[i].tp += e.tp;
          });
      }
      const u = cases.reduce(
          (a, c) => {
              const x = c.usage || {};
              a.total += x.totalTokens || 0;
              a.input += x.inputTokens || 0;
              a.cache += x.cacheReadTokens || 0;
              a.output += x.outputTokens || 0;
              return a;
          },
          { total: 0, input: 0, cache: 0, output: 0 },
      );
      if (!etapas.length) return '';
      return `<section class="agg">
    <h3>Funil do run inteiro</h3>
    <div class="wrap"><table><thead><tr><th>etapa</th><th>achados</th><th>acertos</th><th>falsos positivos</th><th>precisão</th><th>perdeu acerto</th></tr></thead><tbody>${etapas
        .map((e, i) => {
            const ant = i > 0 ? etapas[i - 1] : null;
            const tp = e.semRotulo ? null : e.tp;
            const fp = tp == null ? null : e.n - tp;
            const perdeu =
                ant && !ant.semRotulo && tp != null ? ant.tp - tp : null;
            return `<tr><td>${esc(e.nome)}</td><td class="n">${num(e.n)}${ant ? ` <span class="why">(−${num(ant.n - e.n)})</span>` : ''}</td><td class="n">${tp == null ? '—' : tp}</td><td class="n">${fp == null ? '—' : fp}</td><td class="n">${tp == null || !e.n ? '—' : Math.round((100 * tp) / e.n) + '%'}</td><td class="n">${perdeu == null ? '—' : perdeu > 0 ? `<span class="pill bad">−${perdeu}</span>` : '0'}</td></tr>`;
        })
        .join('')}</tbody></table></div>
    <div class="kv" style="margin-top:.8rem">
      <div><div class="k">tokens (total)</div><div class="v">${num(u.total)}</div></div>
      <div><div class="k">input</div><div class="v">${num(u.input)}</div></div>
      <div><div class="k">cache read</div><div class="v">${num(u.cache)}${u.input ? ` <span class="why">(${Math.round((100 * u.cache) / u.input)}%)</span>` : ''}</div></div>
      <div><div class="k">output</div><div class="v">${num(u.output)}</div></div>
      <div><div class="k">por PR</div><div class="v">${num(Math.round(u.total / Math.max(cases.length, 1)))}</div></div>
      ${(() => {
          // Relogio, nao soma de tokens: a fase sequencial da simulacao nao
          // muda o custo em token e quase dobra o tempo de parede, entao um
          // painel que so mostra token nao enxerga o que ela cobra.
          const ts = cases.map((c) => c.durationMs || 0).filter(Boolean);
          if (!ts.length) return '';
          const soma = ts.reduce((a, b) => a + b, 0);
          const pior = cases
              .filter((c) => c.durationMs)
              .sort((a, b) => b.durationMs - a.durationMs)[0];
          const seg = (ms) => Math.round(ms / 1000) + 's';
          return `<div><div class="k">tempo somado</div><div class="v">${Math.round(soma / 60000)} min</div></div>
      <div><div class="k">média por PR</div><div class="v">${seg(soma / ts.length)}</div></div>
      <div><div class="k">PR mais lento</div><div class="v">${seg(pior.durationMs)} <span class="why">${esc(String(pior.id).slice(0, 28))}</span></div></div>`;
      })()}
    </div>
  </section>`;
  })()}

  <div class="summary">
    <div class="st"><span class="n">${cases.length}</span><span class="k">PRs revisados</span></div>
    <div class="st ok"><span class="n">${totalChecks - failed - unknown}</span><span class="k">verificações OK</span></div>
    <div class="st bad"><span class="n">${failed}</span><span class="k">NÃO OK</span></div>
    <div class="st unk"><span class="n">${unknown}</span><span class="k">não verificáveis</span></div>
    <div class="st ${prsWithFail ? 'bad' : 'ok'}"><span class="n">${prsWithFail}</span><span class="k">PRs com falha</span></div>
  </div>

  <div class="filters">
    <button type="button" data-f="all" aria-pressed="true">todos</button>
    <button type="button" data-f="bad" aria-pressed="false">só com NÃO OK</button>
    <button type="button" data-f="unk" aria-pressed="false">só não verificáveis</button>
    <button type="button" id="expand" aria-pressed="false">expandir todos</button>
  </div>

${prs}

  <footer>
    dump: ${esc(DUMP)}<br>
    verificações computadas: contagem de arquivos contra o git do clone · formato do diff no prompt enviado · chamadas do modelo no transporte · ferramentas atendidas · reducer<br>
    "não verificável" = execução anterior à instrumentação do bloco <code>pipeline</code>, não uma verificação que passou
  </footer>
</div>

<script>
  const btns = [...document.querySelectorAll('.filters button[data-f]')];
  const prs = [...document.querySelectorAll('details.pr')];
  btns.forEach((b) => b.addEventListener('click', () => {
    btns.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    const f = b.dataset.f;
    prs.forEach((p) => {
      const s = p.dataset.state;
      p.classList.toggle('hidden', f !== 'all' && s !== f);
    });
  }));
  const ex = document.getElementById('expand');
  ex.addEventListener('click', () => {
    const open = ex.getAttribute('aria-pressed') !== 'true';
    ex.setAttribute('aria-pressed', String(open));
    ex.textContent = open ? 'recolher todos' : 'expandir todos';
    prs.forEach((p) => { if (!p.classList.contains('hidden')) p.open = open; });
  });
</script>
</body>
</html>`;
}

module.exports = { render };
