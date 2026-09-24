#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Bateria de perguntas por achado — um agente que RESPONDE, sem decidir nada.
 *
 * O que muda em relacao a tudo que foi testado hoje. Redutor, verify, PFA e
 * painel pedem ao modelo um veredicto, e medido em quatro formatos ele nao
 * contradiz as proprias alegacoes: 89 confirmados contra 25 refutados no
 * feasibility, 2 em 85 no PFA, 13 em 56 no painel (e essas 13 vieram todas de
 * UMA pergunta). Aqui ele nao decide: coleta fatos, e a formula e ajustada
 * depois, nos rotulos, por nos.
 *
 * O desenho das perguntas segue o que os dados mostraram:
 *
 *  - Pergunta de OPINIAO sobre a alegacao nao discrimina. `simbolo_confere`
 *    deu 0,609 para acerto e 0,552 para falso positivo; `introduzido_aqui`
 *    0,822 e 0,801. A resposta e "sim" nos dois casos.
 *  - Pergunta que exige IR BUSCAR discrimina. A unica checagem que produziu
 *    refutacao em todo o dia foi a que obrigava a nomear um chamador concreto.
 *  - Por isso as factuais aqui sao CONTAGENS, nao booleanos: booleano ele
 *    responde de reflexo, contagem ele precisa grepar.
 *  - E as subjetivas ficam, porque a pergunta mais vaga ("um revisor senior
 *    postaria isto?") foi o melhor sinal isolado em cinco rodadas do Jev
 *    (AUC 0,682, acima de todas as factuais). Nao se sabe qual combinacao
 *    serve; por isso coleta-se as duas familias.
 *
 * Nenhuma pergunta de manter/descartar, de proposito.
 *
 * Usage:
 *   node evals/investigation/question-battery.js [--limit=N] [--parpr=3] [--par=4]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, comTrace, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { rotular } = require('./label-candidates');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(arg('limit', '0'));
const PARPR = Number(arg('parpr', '3'));
const PAR = Number(arg('par', '4'));
// 8 passos nao chegam: o prompt manda ler chamadores, guards e a definicao do
// que o achado cita, e a medicao deu ~12 chamadas por achado. Quem estourava o
// teto nao registrava score nenhum e sumia da analise em silencio — 2 de 3 no
// primeiro smoke, ou seja, a bateria media o subconjunto que coube no orcamento.
const MAXSTEPS = Number(arg('maxsteps', '24'));
const DUMPS = arg('dumps', 'ds16b').split(',');
const OUT = arg('out', path.join(__dirname, 'results', 'question-battery.json'));
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('question-battery');

const numero = (desc) => ({ type: 'number', description: desc });
const enumStr = (vals, desc) => ({ type: 'string', enum: vals, description: desc });

/**
 * Bateria em ESCALA, nao em compromisso.
 *
 * A bateria anterior media onze perguntas — contagens, binarias e categoricas —
 * e nenhuma separou: a melhor ficou a 0,079 do aleatorio, `urgencia` deu
 * exatamente 0,500. Mas o Jev, perguntando coisas parecidas em PROBABILIDADE,
 * deu 0,64-0,68. A diferenca nao esta no que se pergunta: quando o modelo tem
 * que cravar sim ou nao, ele responde igual para acerto e falso positivo;
 * quando pode dar 0,73, aparece gradiente.
 *
 * Dai tudo aqui ser 0-100. Duas defesas no prompt contra o que ja estragou
 * medicao antes: a escala e ancorada com exemplos (sem isso 0-100 vira 70-90
 * para tudo, que foi o que aconteceu com o `confidence` do proprio agente —
 * 159 de 165 achados em 9 ou 10), e o 50 tem significado declarado ("nao faco
 * ideia") para nao virar o valor de fuga.
 *
 * `aposta` usa enquadramento de aposta de proposito: tratar o numero como
 * dinheiro em risco e tecnica conhecida de calibracao, e sai de graca junto.
 */
const respostasTool = tool({
    description: 'Registra os scores do achado. Chame exatamente uma vez, no fim.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            respostas: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'number' },
                        confiabilidade: { type: 'number', description: '0-100: confianca de que e um bug real, dado o diff, os chamadores e as chamadas que voce leu.' },
                        urgencia: { type: 'number', description: '0-100: urgencia de corrigir. 0 = nunca precisa, 100 = nao pode ir para producao assim.' },
                        quanto_confirmei: { type: 'number', description: '0-100: que fracao do caminho da falha voce CONFIRMOU lendo codigo, versus inferiu.' },
                        autor_rejeitaria: { type: 'number', description: '0-100: chance de o autor responder que e intencional, que ja era assim, ou que o caso nao ocorre.' },
                        especificidade: { type: 'number', description: '0-100: o achado nomeia entrada e estado concretos (100) ou fala de forma generica (0).' },
                        aposta: { type: 'number', description: '0-100: quanto do seu proprio dinheiro voce apostaria que este bug e real.' },
                        evidencia: { type: 'string', description: 'Os file:line que voce leu.' },
                    },
                    required: ['index', 'confiabilidade', 'urgencia', 'quanto_confirmei', 'autor_rejeitaria', 'especificidade', 'aposta', 'evidencia'],
                    additionalProperties: false,
                },
            },
        },
        required: ['respostas'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

function readTools(cmd) {
    return {
        grep: tool({
            description: 'Procura um padrao regex no repositorio.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p }) => {
                try { return String(await cmd.grep(pattern, p)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message).slice(0, 90)}`; }
            },
        }),
        readFile: tool({
            description: 'Le um arquivo, opcionalmente um intervalo de linhas.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => {
                try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message).slice(0, 90)}`; }
            },
        }),
    };
}

const prompt = (file, diff, c) => `<Diff>
--- ${file} ---
${diff}
</Diff>

<Role>
  Other reviewers raised the finding below. You are NOT deciding whether to keep
  or drop it — you are scoring it, and someone else decides later.
</Role>

<Finding>
  ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
  ${c.oneSentenceSummary || ''}
  ${String(c.suggestionContent || '').slice(0, 700)}${c.existingCode ? `\n  code: ${String(c.existingCode).slice(0, 250)}` : ''}${c.reason ? `\n  walk the reviewer recorded: ${String(c.reason).slice(0, 700)}` : ''}
</Finding>

<Task>
  You have grep and readFile over the repository at this commit. Read the code
  before scoring — the callers, the guards on the path, the definition of what
  it cites.

  Then call the "respostas" tool exactly once, with one entry, index 0. Every
  score is an integer from 0 to 100.

  confiabilidade — how sure are you this is a real defect, given what you read?
      0   the code you read contradicts it
     25   plausible but nothing you read supports it
     50   you genuinely cannot tell
     75   the code you read supports it, with a gap
    100   you traced it end to end and it holds

  urgencia — how badly does this need fixing?
      0   never needs fixing
     50   worth a follow-up ticket
    100   must not ship like this

  quanto_confirmei — what fraction of the failure path did you CONFIRM by
    reading code, as opposed to inferring? 0 = read nothing relevant,
    100 = read every step of it.

  autor_rejeitaria — chance the author replies that it is intentional, that it
    was already like that, or that the case cannot happen.
      0   they would accept it immediately
    100   they would certainly push back

  especificidade — does the finding name a concrete input and state?
      0   speaks generally about what could go wrong
    100   names the exact value, record or interleaving that triggers it

  aposta — if you had to bet your own money that this defect is real, at even
    odds, how much of 100 would you stake?

  Two rules about the numbers:
  - 50 means "I have no idea". Use it when that is true, and do not use it as a
    resting place when you do have a view.
  - Giving every finding the same score is worse than not answering. If your
    scores do not move between findings, they carry nothing.

  Nothing else you write is read. Put everything in the tool call.
</Task>`;

(async () => {
    const pool = {}, vars = {}, goldens = {};
    // O pool e o PRE-reducer. Antes era `j.findings`, o que sai depois do
    // reducer, com o rotulo vindo de `metadata.findingHit` — um array alinhado
    // aquele indice. Media-se entao a capacidade de filtrar um conjunto ja
    // filtrado, que nao e a pergunta: queremos saber se a bateria separa o pool
    // inteiro. O rotulo do pool inteiro nao existe pronto, entao vem do
    // `label-candidates`, que julga uma vez e guarda.
    const labels = await rotular(DUMPS, { force: process.argv.includes('--relabel') });
    for (const d of DUMPS) {
        const dir = path.join(S, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const h = labels[j.caseId] || [];
            (j.trace?.preFilterCandidates || []).forEach((x, i) => {
                (pool[j.caseId] ||= []).push({ ...x, acerto: !!h[i] });
            });
        }
    }
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) { vars[v.caseId] = v; goldens[v.caseId] = J(v.goldenComments); }
        } catch {}
    }

    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const ids = Object.keys(pool).filter((c) => vars[c]).filter((c) => !SO.length || SO.includes(c)).slice(0, LIMIT || undefined);
    const diag = { arquivos: 0, semTool: 0, segundaChance: 0, parciais: 0, erro: 0, toolCalls: 0, motivos: [] };
    const out = [];

    const rodarPR = async (cid, i) => {
        const cands = pool[cid];
        let handle = null, rt = null;
        try {
            handle = await prepareRepo(vars[cid], cid);
            if (handle) rt = readTools(new LocalRepoCommands(handle.dir));
            else diag.motivos.push(`prepareRepo null: ${cid}`);
        } catch (e) { diag.motivos.push(`prepareRepo: ${String(e?.message || e).slice(0, 120)}`); }
        const diffs = Object.fromEntries(J(vars[cid].changedFilesFull).map((f) => [f.filename, f.patchWithLinesStr || '']));

        // Uma chamada por sugestao, com orcamento proprio. Por arquivo, 8
        // achados dividiriam os mesmos passos e as contagens — que exigem um
        // grep cada — nao caberiam: e a falha medida no redutor com ferramenta,
        // que com 30 passos para 13 alegacoes verificou as primeiras e julgou o
        // resto no olho. O custo empata: ~90 arquivos x 14 passos da o mesmo
        // que 165 achados x 8.
        //
        // O <Diff> abre o prompt de proposito: os achados do mesmo arquivo
        // mandam o mesmo bloco, e cache de prefixo so casa a partir do inicio
        // da mensagem.
        for (let b = 0; b < cands.length; b += PAR) {
            await Promise.all(cands.slice(b, b + PAR).map(async (c) => {
                diag.arquivos++;
                const file = c.relevantFile || '?';
                const diff = String(diffs[file] || '(diff indisponivel)').slice(0, 9000);
                try {
                    const r = await generateText({
                        ...tele('question-battery', { caseId: cid, file }),
                        model,
                        tools: { ...(rt || {}), respostas: respostasTool },
                        prompt: prompt(file, diff, c),
                        stopWhen: (x) =>
                            (x.steps?.length ?? 0) >= MAXSTEPS ||
                            (x.steps || []).some((st) => (st.toolCalls || []).some((t) => (t.toolName ?? t.name) === 'respostas')),
                    });
                    for (const st of r.steps || []) diag.toolCalls += (st.toolCalls || []).length;
                    let call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'respostas');
                    // Segunda chance COM o historico: o turno acima ja leu o
                    // codigo, e um `prompt` novo jogaria essa leitura fora e
                    // faria o modelo pontuar no escuro.
                    if (!call) {
                        diag.segundaChance++;
                        try {
                            const r2 = await generateText({
                                ...tele('question-battery-forcado', { caseId: cid, file }),
                                model,
                                tools: { respostas: respostasTool },
                                toolChoice: { type: 'tool', toolName: 'respostas' },
                                messages: [
                                    ...(r.response?.messages || []),
                                    { role: 'user', content: 'Record the scores now, from the reading you just did above.' },
                                ],
                            });
                            call = (r2.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'respostas');
                        } catch (e2) {
                            diag.motivos.push(`segunda-chance: ${String(e2?.message || e2).slice(0, 140)}`);
                        }
                    }
                    const resp = ((call?.input ?? call?.args)?.respostas || [])[0];
                    if (!resp) { diag.semTool++; return; }
                    out.push({
                        caseId: cid, file, acerto: c.acerto,
                        resumo: c.oneSentenceSummary,
                        severidadeOriginal: c.severity, confiancaOriginal: c.confidence,
                        producedBy: c.producedBy,
                        ...resp,
                    });
                } catch (e) {
                    diag.erro++;
                    diag.motivos.push(`${file.split('/').pop()}: ${String(e?.message || e).slice(0, 140)}`);
                }
            }));
        }
        try { await handle?.cleanup?.(); } catch {}
        console.log(`[${i + 1}/${ids.length}] ${cid.slice(0, 42).padEnd(44)} ${cands.length} achados → ${out.filter((o) => o.caseId === cid).length} respondidos`);
    };

    for (let b = 0; b < ids.length; b += PARPR) {
        await Promise.all(ids.slice(b, b + PARPR).map((cid, k) =>
            comTrace({ traceName: 'question-battery', sessionId: cid, metadata: { caseId: cid }, tags: ['investigation', 'battery'] },
                () => rodarPR(cid, b + k))));
    }
    await flush();

    fs.writeFileSync(OUT, JSON.stringify({ modelo: MODEL, diagnostico: diag, respostas: out }, null, 2));
    console.log(`\nDIAGNOSTICO`);
    console.log(`  chamadas: ${diag.arquivos} · sem tool: ${diag.semTool} · segunda chance: ${diag.segundaChance} · parciais: ${diag.parciais} · erro: ${diag.erro} · tool calls: ${diag.toolCalls}`);
    if (diag.motivos.length) for (const m of diag.motivos.slice(0, 10)) console.log(`    ${m}`);
    console.log(`\n${out.length} achados respondidos (${out.filter((x) => x.acerto).length} acertos, ${out.filter((x) => !x.acerto).length} falsos positivos)`);
    console.log(`-> ${OUT}`);
})();
