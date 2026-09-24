#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Pontua cada HUNK do diff: qual a chance de um revisor humano ter comentado
 * ali. O modelo NAO ve nenhum achado nosso — so o diff.
 *
 * Por que isto e diferente de tudo que ja testamos: todos os sinais anteriores
 * julgam o ACHADO, e por isso todos acabaram correlacionando com a nota do
 * atribuidor (0,27 a 0,64). Este julga o LOCAL. Nao tem como recair na nota
 * porque nunca ve o que a gente escreveu.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const PARPR = Number(arg('parpr', '5'));
const OUT = arg('out', path.join(__dirname, 'results', 'hunk-sol-teto2.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('hunk-score');

function comEsforco(model, modelId) {
    const effort = process.env.RECALL_REASONING_EFFORT;
    if (!effort) return model;
    const { buildReasoningProviderOptions } = require('../../libs/llm/reasoning-options.ts');
    const provider = /^gpt|^o\d/i.test(modelId) ? 'openai' : 'openai_compatible';
    const inj = buildReasoningProviderOptions(provider, effort, modelId);
    if (!inj || !Object.keys(inj).length) return model;
    const merge = (o) => ({ ...o, providerOptions: { ...(o?.providerOptions || {}), ...inj } });
    return new Proxy(model, { get(t, p, r) {
        if (p === 'doGenerate' || p === 'doStream') return async (o) => t[p](merge(o));
        return Reflect.get(t, p, r); } });
}

/** quebra patchWithLinesStr em hunks com faixa de linhas do lado novo */
function hunks(arquivo, patch) {
    const out = [];
    let atual = null;
    for (const linha of String(patch || '').split('\n')) {
        const m = linha.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (m) {
            if (atual) out.push(atual);
            const ini = Number(m[1]); const len = m[2] ? Number(m[2]) : 1;
            atual = { arquivo, ini, fim: ini + len - 1, corpo: [linha] };
        } else if (atual) atual.corpo.push(linha);
    }
    if (atual) out.push(atual);
    return out;
}

const hunkTool = tool({
    description: 'Registra a nota de cada hunk. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: { type: 'array', items: { type: 'object', properties: {
                indice: { type: 'number' },
                comentado: { type: 'number', description: '0-100: chance de um revisor humano ter deixado comentario neste hunk.' },
                ancora: { type: 'string', description: 'O que neste hunk chama (ou nao) a atencao de um revisor.' },
            }, required: ['indice', 'comentado', 'ancora'], additionalProperties: false } },
        },
        required: ['itens'], additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (hs, titulo) => `This pull request was reviewed by humans when it was opened. Below are the hunks it changed. For each one, give the probability that A REVIEWER LEFT A COMMENT ON IT.

<PullRequest>
${titulo || ''}
</PullRequest>

<Hunks>
${hs.map((h, i) => `[${i}] ${h.arquivo}  lines ${h.ini}-${h.fim}\n${h.corpo.join('\n').slice(0, 2200)}`).join('\n\n')}
</Hunks>

You are not looking for defects. Do not analyse whether the code is correct.
You are predicting where a busy reviewer's attention landed and where they
decided it was worth typing.

Hunks that attract comments:
  new logic with a branch, a loop, a condition someone has to reason about
  anything touching auth, permissions, money, user data, or deletion
  a changed signature, contract or return type that callers depend on
  concurrency, ordering, retries, transactions
  a value that flows somewhere else in the system

Hunks that almost never get a comment, however large:
  generated files, lockfiles, migrations, translation and message bundles
  imports, formatting, renames applied mechanically across many lines
  test fixtures and setup, snapshot updates
  config and constants without logic
  pure deletions, and moves of code that is otherwise unchanged
  a file changed in one trivial place because something else was renamed

Size is not the signal. A 300-line generated diff gets zero comments; a
four-line change to a permission check gets three.

Most hunks in most pull requests receive no comment at all. Be harsh: if the
whole file is mechanical, every hunk in it should be under 10.

Score every index exactly once. Call hunks exactly once.`;

(async () => {
    const model = comEsforco(buildModel(MODEL), String(MODEL).replace(/@sub$/, ''));
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const casos = [];
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (!v?.caseId) continue;
            const hs = J(v.changedFilesFull).flatMap((x) => hunks(x.filename, x.patchWithLinesStr));
            if (hs.length) casos.push({ cid: v.caseId, hs: hs.slice(0, 90), titulo: v.prTitle });
        } catch {}
    }
    const saida = {};
    const um = async ({ cid, hs, titulo }) => {
        try {
            const r = await generateText({
                ...tele('hunk-score', { caseId: cid }), model,
                tools: { hunks: hunkTool }, toolChoice: { type: 'tool', toolName: 'hunks' },
                prompt: prompt(hs, titulo),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'hunks');
            const its = (call?.input ?? call?.args)?.itens || [];
            saida[cid] = its.filter((x) => Number.isInteger(x.indice) && x.indice < hs.length)
                .map((x) => ({ arquivo: hs[x.indice].arquivo, ini: hs[x.indice].ini, fim: hs[x.indice].fim, nota: x.comentado }));
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${hs.length} hunks -> ${saida[cid].length} notas`);
        } catch (e) {
            saida[cid] = [];
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${String(e?.message || e).slice(0, 100)}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) await Promise.all(casos.slice(b, b + PARPR).map(um));
    fs.writeFileSync(OUT, JSON.stringify({ modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
