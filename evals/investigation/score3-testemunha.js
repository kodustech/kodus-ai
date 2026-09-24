#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * TERCEIRO score: existe uma TESTEMUNHA concreta?
 *
 * A veracidade pergunta se a alegacao e verdadeira. Esta pergunta e mais dura:
 * nomeie o input especifico que faz este codigo produzir o resultado errado.
 *
 * Por que isto separa: 72 dos 91 falsos positivos no ponto de operacao atual
 * sao grupos de um candidato so — um unico agente viu, nenhum outro confirmou.
 * O modo de falha tipico desses nao e mentira, e especulacao: "isto PODE dar
 * problema", sem caminho concreto. Um achado especulativo e verdadeiro no
 * sentido fraco e nao consegue produzir testemunha. Um bug de verdade produz.
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
const OUT = arg('out', path.join(__dirname, 'results', `score3-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('score3-testemunha');

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

const testemunhaTool = tool({
    description: 'Registra a testemunha de cada achado. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        indice: { type: 'number' },
                        verdadeiro: { type: 'number', description: '0-100: quao concreta e a testemunha que voce conseguiu montar.' },
                        ancora: { type: 'string', description: 'A testemunha: input -> resultado errado. Ou por que nao existe.' },
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

const prompt = (itens, diff) => `Below are findings from a review of this pull request. For each one, try to produce a WITNESS: a concrete input or state that makes this code produce a wrong result.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Findings>
${itens
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 450)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}` ,
    )
    .join('\n\n')}
</Findings>

A witness has three parts and all three must be concrete:
  the input — an actual value, request, sequence of calls, or interleaving
  the path — the lines in the diff it runs through
  the wrong result — what the user or the next caller actually gets

Write the witness in the ancora field. Then score how concrete it came out:

  90-100  you wrote a specific input and can name the wrong value it produces
  70-89   the input is specific but the wrong result depends on a caller you
          cannot see; you had to assume it behaves the normal way
  40-69   you can describe the shape of the input but not an actual one, or the
          wrong result is "may be inconsistent" rather than a named value
  15-39   the best you could write is a condition that would have to hold, and
          nothing in the diff says it ever does
  0-14    no witness exists — the finding is a preference, a hardening
          suggestion, a style point, or a worry about input nobody sends

Be strict about the difference between 40-69 and 70-89. "A concurrent request
could interleave here" is not a witness unless you can say which two operations
interleave and what state results. "This value could be null" is not a witness
unless you can say who passes null.

Do not invent a caller that violates the function's contract to force the
failure. If the only way to trigger it is for the caller to do something the
code forbids, that is a 15-39, not a 90.

Score every index exactly once. Call testemunha exactly once.`;

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
                ...tele('score3-testemunha', { caseId: cid }),
                model,
                tools: { testemunha: testemunhaTool },
                toolChoice: { type: 'tool', toolName: 'testemunha' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'testemunha');
            const its = (call?.input ?? call?.args)?.itens || [];
            const porIndice = {};
            for (const it of its) {
                const p = it.indice;
                if (Number.isInteger(p) && p < reps.length) porIndice[reps[p]] = it.verdadeiro;
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
