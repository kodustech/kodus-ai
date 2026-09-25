#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * SEGUNDO score, sobre o conjunto JA AGRUPADO: a probabilidade de a alegacao
 * ser VERDADEIRA sobre o codigo.
 *
 * Por que um segundo: a nota do atribuidor pergunta "quantos devs mudariam o
 * codigo", que mistura duas coisas — se o achado e verdadeiro e se ele importa.
 * Um achado falso e um achado verdadeiro porem irrelevante recebem nota
 * parecida por motivos opostos, e um ranqueador nao consegue separar o que a
 * pergunta ja fundiu. Medindo as duas em separado, P(verdadeiro) x P(importa)
 * multiplica dois sinais que erram de formas diferentes.
 *
 * Esta pergunta e deliberadamente CEGA a importancia: um erro de digitacao num
 * comentario pode ser 100 aqui e 5 na outra. E o que torna os dois sinais
 * independentes — se ele reproduzir o julgamento da primeira, nao acrescenta
 * nada, e o teste dira isso.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const GRUPOS = arg('grupos');
const PARPR = Number(arg('parpr', '4'));
const OUT = arg('out', path.join(__dirname, 'results', `score2-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('score2-veracidade');

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

const veracidadeTool = tool({
    description: 'Registra a veracidade de cada achado. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        indice: { type: 'number' },
                        verdadeiro: { type: 'number', description: '0-100: probabilidade de a alegacao ser verdadeira sobre este codigo.' },
                        ancora: { type: 'string', description: 'O file:line que voce usou para decidir.' },
                    },
                    required: ['indice', 'verdadeiro', 'ancora'],
                    additionalProperties: false,
                },
            },
        },
        required: ['itens'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, diff) => `Below are findings a review produced on this pull request. Duplicates are already merged. For each one, give the probability that THE CLAIM IS TRUE OF THIS CODE.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Findings>
${itens
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 450)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}${c.existingCode ? `\n    code: ${String(c.existingCode).slice(0, 220)}` : ''}` ,
    )
    .join('\n\n')}
</Findings>

Answer ONLY the factual question. Ignore whether the defect matters, whether it
is worth a comment, whether the author would care, whether it is major or
trivial. A typo in a log message can be 100 here. A catastrophic data-loss bug
that the code does not actually have is 0.

  100  the diff above shows exactly what the claim describes; you can point at
       the line and read it off
  75   the claim follows from the code, but one step of it rests on a file or
       caller that is not in the diff and you had to assume it behaves normally
  50   you genuinely cannot tell from what is above — the deciding code is not
       here
  25   the code above works against the claim: a guard, a default, an earlier
       return, or a type makes the described state unlikely
  0    the diff contradicts the claim outright, or the symbol, call or condition
       it names does not appear at all

Two traps to avoid. First, a confident, well-written claim is not more likely to
be true — judge the code, not the prose. Second, when a claim says something is
MISSING (no validation, no guard, no check), look for it in the diff before
believing it is absent; claims of absence are the ones most often wrong.

Score every index exactly once. Call veracidade exactly once.`;

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
    const ms = {};
    const um = async ({ cid, reps, itens }) => {
        const t0 = Date.now();
        try {
            const r = await generateText({
                ...tele('score2-veracidade', { caseId: cid }),
                model,
                tools: { veracidade: veracidadeTool },
                toolChoice: { type: 'tool', toolName: 'veracidade' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'veracidade');
            const its = (call?.input ?? call?.args)?.itens || [];
            const porIndice = {};
            for (const it of its) {
                const p = it.indice;
                if (Number.isInteger(p) && p < reps.length) porIndice[reps[p]] = it.verdadeiro;
            }
            saida[cid] = porIndice;
            ms[cid] = Date.now() - t0;
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${reps.length} itens -> ${Object.keys(porIndice).length} notas`);
        } catch (e) {
            saida[cid] = {};
            ms[cid] = Date.now() - t0;
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${String(e?.message || e).slice(0, 110)}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) await Promise.all(casos.slice(b, b + PARPR).map(um));
    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida, ms }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
