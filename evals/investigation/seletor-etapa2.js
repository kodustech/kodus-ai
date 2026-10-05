#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, etapa 2 (atribuidor + formula + corte): variantes do atribuidor sobre a
 * saida do dedup + v5 (dedup-fusao.js). Uma chamada por PR com todos os itens;
 * a variante "agente" investiga o repositorio com ate 5 passos antes de pontuar.
 *
 *   RECALL_MODEL=<id> node seletor-etapa2.js --fusao=<arq dedup-fusao> --pool=<orig> --variante=base --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada, extraiJson } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const FUSAO = arg('fusao'), POOL = arg('pool'), OUT = arg('out'), VAR = arg('variante', 'base'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);

const COM_SEV = VAR === 'sev';
const SCHEMA = {
    type: 'object',
    properties: {
        notas: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    nota: { type: 'number' },
                    ...(COM_SEV ? { severidade: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } } : {}),
                    porque: { type: 'string' },
                },
                required: ['indice', 'nota', ...(COM_SEV ? ['severidade'] : []), 'porque'],
                additionalProperties: false,
            },
        },
    },
    required: ['notas'],
    additionalProperties: false,
};

const lista = (itens) => itens.map((c, i) => `[${i}] ${c.file}:${c.ini ?? '?'}-${c.fim ?? '?'}\n    ${String(c.texto || '').slice(0, 900)}`).join('\n\n');
const DONOS = `Answer for the developers who OWN this code, not for a careful outsider. They
know the conventions, they know what is intentional, and they know what the
next commit already handles.

Judge the defect, not the prose. Do not reward a confident tone, and do not
punish a terse one. A real defect described badly still scores high.

Be honest with the low end. This pull request does not owe you findings: if
most of these candidates are noise, most of the scores should be below 40.`;

const PERGUNTA = {
    base: `Give each candidate 0-100: how much is it worth posting this, on this pull request,
to the developer who wrote it.

Imagine ten experienced developers who own this codebase and know it well.
They each read this pull request and this comment. How many of the ten would
CHANGE THE CODE because of it, before merging?

Answer with that count times ten: 0, 10, 20 ... 100.

  100  all ten would change the code — the defect is plain and it matters
  70   seven would; three would argue it is fine as is
  40   four would; the rest would merge and maybe open a follow-up
  10   one might; nine would read past it
  0    none would — they know why this is fine, or the claim is wrong

${DONOS}`,
    d20: `Give each candidate 0-100: how much is it worth posting this, on this pull request,
to the developer who wrote it.

Imagine twenty experienced developers who own this codebase and know it well.
They each read this pull request and this comment. How many of the twenty would
CHANGE THE CODE because of it, before merging?

Answer with that count times five: 0, 5, 10 ... 100.

  100  all twenty would change the code — the defect is plain and it matters
  70   fourteen would; six would argue it is fine as is
  40   eight would; the rest would merge and maybe open a follow-up
  10   two might; eighteen would read past it
  0    none would — they know why this is fine, or the claim is wrong

${DONOS}`,
    incidente: `Give each candidate 0-100: if this pull request is merged exactly as it is, how
likely is it that the defect this comment describes really happens to users of
this code — a crash, a wrong result, lost or corrupted data, a security hole,
or a feature that stops working?

  100  it happens on the normal path; anyone using the changed feature hits it
  70   it happens under a condition that real usage will reach
  40   it needs an unusual but possible condition
  10   it needs a contrived condition, or the effect is negligible
  0    it cannot happen: the code prevents it, or the claim is wrong

Judge the code, not the prose: a confident claim is not more likely to happen.
Most review comments are not real incidents: be honest with the low end.`,
};
PERGUNTA.sev = `${PERGUNTA.base}

Also give each candidate the severity YOU judge from the code — not the severity
the comment claims: critical (security hole, data loss or corruption, crash on a
normal path), high (wrong behavior a user will hit), medium (wrong behavior in
a less common path), low (minor or cosmetic).`;
PERGUNTA.agente = PERGUNTA.base;

const prompt = (itens, diff, extra) => `A review of this pull request produced the findings below. Your job is to say how much each one is worth posting.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Candidates>
${lista(itens)}
</Candidates>

${PERGUNTA[VAR]}
${extra || ''}
Call pontuar exactly once, with a score for every candidate index.`;

function ferramentas(cmd) {
    const leitura = { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false };
    return {
        grep: tool({ description: 'Search the repository for a regex pattern.', inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }), execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } } }),
        readFile: tool({ description: 'Read a file, optionally a line range.', inputSchema: jsonSchema(leitura), execute: async ({ path: p, startLine, endLine }) => { try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } } }),
    };
}

async function agente(model, itens, diff, cmd) {
    const TETO = 5;
    let enviado = null;
    const tools = { ...ferramentas(cmd), pontuar: tool({ description: 'Submit the scores. The only way to answer.', inputSchema: jsonSchema(SCHEMA), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model,
        prompt: prompt(itens, diff, `\nYou may read the repository (grep, readFile) to check what the candidates claim before scoring. You have ${TETO} steps; the LAST one must be the pontuar call.\n`),
        tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['pontuar'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'pontuar' } }), messages: [...messages, { role: 'user', content: 'Final step: call pontuar now with a score for every candidate.' }] }
            : undefined,
    });
    if (!enviado) enviado = extraiJson(r.text || '');
    return { dados: enviado, passos: r.steps?.length ?? 0 };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[etapa2] ${descreveModelo(MODELO)} · variante ${VAR}`);
    const F = JSON.parse(fs.readFileSync(FUSAO, 'utf8')).prs;
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: VAR, prs: {} };
    const fila = L30.filter((c) => F[c] && !F[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const itens = F[cid].itens.map((it) => ({ rep: it.rep, file: cs[it.rep].relevantFile, ini: cs[it.rep].relevantLinesStart, fim: cs[it.rep].relevantLinesEnd, texto: it.texto || cs[it.rep].suggestionContent }));
            let dados = { notas: [] }, passos = 0;
            if (itens.length) {
                if (VAR === 'agente') {
                    const { prepareRepo } = require('./prepare-repo');
                    const { LocalRepoCommands } = require('./local-repo-commands');
                    h = await prepareRepo(vars[cid], `${cid}-e2-${process.pid}`);
                    if (!h) throw new Error('sem repo');
                    const r = await retry(() => agente(model, itens, diffs[cid], new LocalRepoCommands(h.dir)));
                    dados = r.dados || {}; passos = r.passos;
                } else {
                    const pt = tool({ description: 'Registra as notas. Chame exatamente uma vez.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });
                    dados = (await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'pontuar', schema: SCHEMA, toolDef: pt, prompt: prompt(itens, diffs[cid]) }))).dados || {};
                }
            }
            const por = Object.fromEntries((dados.notas || []).map((x) => [Number(x.indice), x]));
            const falta = itens.filter((_, j) => !Number.isFinite(Number(por[j]?.nota))).length;
            if (falta) throw new Error(`${falta} itens sem nota`);
            res.prs[cid] = { itens: itens.map((it, j) => ({ rep: it.rep, nota: Number(por[j].nota), ...(COM_SEV ? { severidade: por[j].severidade } : {}), porque: por[j].porque })), passos };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const erros = Object.values(res.prs).filter((p) => p.erro).length;
    console.log(JSON.stringify({ variante: VAR, prs: Object.keys(res.prs).length - erros, erros }));
    process.exit(erros ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
