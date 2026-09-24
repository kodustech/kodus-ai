#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * IMPACTO: o dev senior dono do codigo olha o que a IA decidiu postar e diz
 * qual o impacto de cada comentario.
 *
 * Diferente de tudo que ja foi testado. Veracidade pergunta se e verdade — e
 * quase tudo e verdade. Este pergunta se IMPORTA, e pergunta sobre o conjunto
 * que de fato seria postado, nao sobre o pool inteiro. Se impacto separar
 * vencedor de falso positivo, temos um filtro; se nao separar, esta provado
 * que os falsos positivos sao indistinguiveis tambem por importancia, e nao
 * so por veracidade.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const GRUPOS = arg('grupos');
const PARPR = Number(arg('parpr', '4'));
const OUT = arg('out', path.join(__dirname, 'results', `cego-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('cego-sem-diff');

function comEsforco(model, modelId) {
    const effort = process.env.RECALL_REASONING_EFFORT;
    if (!effort) return model;
    const { buildReasoningProviderOptions } = require('../../libs/llm/reasoning-options.ts');
    const provider = /^gpt|^o\d/i.test(modelId) ? 'openai' : 'openai_compatible';
    const inj = buildReasoningProviderOptions(provider, effort, modelId);
    if (!inj || !Object.keys(inj).length) return model;
    const merge = (o) => ({ ...o, providerOptions: { ...(o?.providerOptions || {}), ...inj } });
    return new Proxy(model, {
        get(t, p, r) {
            if (p === 'doGenerate' || p === 'doStream') return async (o) => t[p](merge(o));
            return Reflect.get(t, p, r);
        },
    });
}

const cegoTool = tool({
    description: 'Marca quais comentarios sao ruido. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        indice: { type: 'number' },
                        ruido: { type: 'boolean', description: 'true se voce apostaria que ninguem escreveria este comentario numa revisao real.' },
                        verdadeiro: { type: 'number', description: '0-100: chance de um revisor humano ter escrito este comentario. 0 = com certeza ruido.' },
                        ancora: { type: 'string', description: 'A palavra ou frase do comentario que te fez decidir.' },
                    },
                    required: ['indice', 'ruido', 'verdadeiro', 'ancora'],
                    additionalProperties: false,
                },
            },
        },
        required: ['itens'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, _diff) => `Below are comments an AI produced while reviewing a pull request. You do NOT get the code. That is deliberate.

<Comments>
${itens
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 500)}` ,
    )
    .join('\n\n')}
</Comments>

You cannot check whether any of these is true, and you must not try. Judge them
as comments. You have read thousands of real code reviews; you know what people
actually write and what they do not.

Give each one the probability that A HUMAN REVIEWER WROTE IT.

What real review comments look like:
  they name one concrete thing and stop
  they assume the reader knows the codebase
  they are often short, sometimes blunt, sometimes a question
  they point at a consequence the author has not seen

What generated noise looks like, even when it is true:
  it explains the codebase back to the person who wrote it
  it hedges — "consider", "it may be worth", "to be safe"
  it asks for a defence against something nobody sends
  it restates a convention as if it were a finding
  it is complete, balanced and thorough in a way a busy person is not
  the file path alone tells you nobody comments there — a test fixture, a
  generated file, a migration, a translation file

Trust the tell in the prose. The strongest signal you have is whether it sounds
like someone typing into a review box at 4pm or like a machine filling a form.

In ancora, quote the word or phrase that decided it for you.

Be harsh. Most of these are noise. Score every index exactly once. Call cego exactly once.`;

(async () => {
    const model = comEsforco(buildModel(MODEL), String(MODEL).replace(/@sub$/, ''));
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const GR = JSON.parse(fs.readFileSync(GRUPOS, 'utf8')).saida;
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId)
                diffs[v.caseId] = J(v.changedFilesFull)
                    .map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`)
                    .join('\n\n');
        } catch {}
    }
    const casos = [];
    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        const g = GR[cid];
        if (!g) continue;
        const cands = j.trace?.preFilterCandidates || [];
        // mesmo filtro de contrato que o atribuidor aplicou, para os indices baterem
        const orig = cands
            .map((c, i) => [c, i])
            .filter(([c]) => ESCALA.has(String(c?.severity || '').toLowerCase()) && !!c?.reason)
            .map(([, i]) => i);
        const reps = (g.grupos || [])
            .map((x) => x.representante)
            .filter((p) => Number.isInteger(p) && p < orig.length)
            .map((p) => orig[p]);
        if (reps.length) casos.push({ cid, reps, itens: reps.map((i) => cands[i]) });
    }
    const saida = {};
    const um = async ({ cid, reps, itens }) => {
        try {
            const r = await generateText({
                ...tele('cego-sem-diff', { caseId: cid }),
                model,
                tools: { cego: cegoTool },
                toolChoice: { type: 'tool', toolName: 'cego' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'cego');
            const its = (call?.input ?? call?.args)?.itens || [];
            const porIndice = {};
            for (const it of its) {
                const p = it.indice;
                if (Number.isInteger(p) && p < reps.length) porIndice[reps[p]] = { v: it.verdadeiro, ruido: it.ruido, ancora: it.ancora };
            }
            saida[cid] = porIndice;
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${reps.length} itens -> ${Object.keys(porIndice).length} notas`);
        } catch (e) {
            saida[cid] = {};
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${String(e?.message || e).slice(0, 110)}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) await Promise.all(casos.slice(b, b + PARPR).map(um));
    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
