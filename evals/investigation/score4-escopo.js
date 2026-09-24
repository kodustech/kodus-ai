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
const OUT = arg('out', path.join(__dirname, 'results', `score4-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('score4-escopo');

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
                        verdadeiro: { type: 'number', description: '0-100: quanto este diff causou o defeito.' },
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

const prompt = (itens, diff) => `Below are findings a review produced on this pull request. Duplicates are already merged. For each one, decide whether THIS DIFF CAUSED IT.

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

Answer ONLY this: DID THIS DIFF CAUSE IT?

Ignore whether the finding is true. Ignore whether it matters. A real,
serious, correctly-described bug that was already there before this change
scores 0 here.

  100  the defect did not exist before this diff — the added or changed lines
       create it, and reverting them removes it
  75   the diff makes an existing weakness reachable, or widens it: the code
       path, the input, or the caller is new even if the flawed line is not
  50   you cannot tell from the diff whether the surrounding code already
       behaved this way
  25   the flaw is in code the diff merely touched — moved, renamed,
       reindented, or called from one more place
  0    the defect is entirely pre-existing, or is about code the diff does not
       change at all; also 0 when the finding asks for something the diff never
       claimed to do

The removed lines in the diff are your evidence. If the removed lines had the
same flaw as the added lines, this is 0 or 25, not 100. If there are no removed
lines and the code is new, it is 100.

Two traps. A finding phrased as "this function does not validate X" is usually
about code that never validated X — check whether the diff introduced the
function or just edited it. And a finding about a NEW call to an OLD function is
75, not 0: the diff created that reachability.

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
    const um = async ({ cid, reps, itens }) => {
        try {
            const r = await generateText({
                ...tele('score4-escopo', { caseId: cid }),
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
