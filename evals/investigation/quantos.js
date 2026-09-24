#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * QUANTOS: uma leitura do diff que devolve so um numero — quantos comentarios
 * um revisor humano deixaria neste PR. NAO ve nenhum achado nosso.
 *
 * Por que so o numero: no teste do editor, a ORDEM que ele produziu era ruim
 * (AUC 0,718, abaixo da nossa formula) e o NUMERO era bom (+11pp de precisao).
 * O modelo e ruim em dizer quais e bom em dizer quantos. Aqui ele so faz a
 * parte que sabe fazer, e sem ver a nossa lista, para o numero ser uma leitura
 * do PR e nao uma reacao ao que a gente produziu.
 *
 * Quem ordena continua sendo a formula.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const PARPR = Number(arg('parpr', '6'));
const OUT = arg('out', path.join(__dirname, 'results', 'quantos-sol-teto2.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('quantos');

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

const quantosTool = tool({
    description: 'Registra quantos comentarios este PR merece. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            quantos: { type: 'number', description: 'Quantos comentarios de revisao este PR recebeu de humanos. 0 a 10.' },
            onde: { type: 'string', description: 'Os arquivos ou funcoes onde esses comentarios cairiam, em uma linha.' },
            porque: { type: 'string', description: 'Uma frase: o que neste diff justifica esse numero.' },
        },
        required: ['quantos', 'onde', 'porque'], additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (diff, titulo, nArq, nLin) => `This pull request was reviewed by humans when it was opened. Estimate HOW MANY review comments they left on it.

<PullRequest>
${titulo || ''}
files changed: ${nArq} · diff lines: ${nLin}
</PullRequest>

<Diff>
${String(diff || '').slice(0, 45000)}
</Diff>

You are not reviewing this code. Do not look for defects and do not describe
any. Read it the way you would skim a colleague's pull request and ask one
question: how much did this change give people to talk about?

What raises the count:
  new logic with branches someone has to reason about
  auth, permissions, money, user data, deletion, migrations
  a changed signature or contract that callers depend on
  concurrency, ordering, retries, transactions
  a change that looks rushed, or one that touches many things at once

What keeps it near zero, however large the diff:
  generated files, lockfiles, translations, formatting, mechanical renames
  a config or constant change
  a straightforward addition that follows an existing pattern in the file
  pure deletions and moves

Size is a weak signal. A 2000-line translation update gets zero comments; a
30-line change to a permission check gets four.

Calibration, and take it seriously: most pull requests get **two or three**
comments. Five is a busy review. Zero is common and is a real answer. Above six
is rare enough that you should only say it when the change is genuinely
dangerous in several independent places.

Answer with a single number. Call quantos exactly once.`;

(async () => {
    const model = comEsforco(buildModel(MODEL), String(MODEL).replace(/@sub$/, ''));
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const casos = [];
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (!v?.caseId) continue;
            const cf = J(v.changedFilesFull);
            const diff = cf.map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`).join('\n\n');
            casos.push({ cid: v.caseId, diff, titulo: v.prTitle, nArq: cf.length, nLin: diff.split('\n').length });
        } catch {}
    }
    const saida = {};
    const um = async ({ cid, diff, titulo, nArq, nLin }) => {
        try {
            const r = await generateText({
                ...tele('quantos', { caseId: cid }), model,
                tools: { quantos: quantosTool }, toolChoice: { type: 'tool', toolName: 'quantos' },
                prompt: prompt(diff, titulo, nArq, nLin),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'quantos');
            const i = call?.input ?? call?.args ?? {};
            saida[cid] = { quantos: i.quantos, onde: i.onde, porque: i.porque };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${nArq} arq -> ${i.quantos}`);
        } catch (e) {
            saida[cid] = { quantos: null };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${String(e?.message || e).slice(0, 90)}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) await Promise.all(casos.slice(b, b + PARPR).map(um));
    fs.writeFileSync(OUT, JSON.stringify({ modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
