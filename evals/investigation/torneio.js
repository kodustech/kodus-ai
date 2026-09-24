#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * TORNEIO DE ELIMINACAO, por PR.
 *
 * Nem pontuar nem escolher: eliminar um de cada vez, sempre o mais fraco do
 * que restou, ate acabar. A ordem de eliminacao e a ordenacao — o ultimo a
 * sair e o melhor.
 *
 * Por que pode diferir do pairwise (que falhou com AUC 0,583): la cada duelo
 * era isolado e o modelo julgava pares fora de contexto. Aqui cada eliminacao
 * acontece com todos os sobreviventes a vista, entao a decisao e sempre
 * relativa ao campo inteiro, que encolhe.
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
const OUT = arg('out', path.join(__dirname, 'results', `torneio-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('torneio');

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

const torneioTool = tool({
    description: 'Registra a ordem de eliminacao. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            eliminacoes: { type: 'array',
                description: 'Na ordem em que voce eliminou: o primeiro do array e o PIOR de todos, o ultimo e o melhor. Inclua TODOS os indices.',
                items: { type: 'object', properties: {
                    indice: { type: 'number' },
                    porque: { type: 'string', description: 'Meia frase: por que este era o mais fraco dos que restavam.' },
                }, required: ['indice', 'porque'], additionalProperties: false } },
        },
        required: ['eliminacoes'], additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, diff) => `An automated review produced the ${itens.length} comments below on this pull request. Run an elimination tournament on them.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Comments>
${itens
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 420)}` ,
    )
    .join('\n\n')}
</Comments>

The rule: look at everything still standing, eliminate the single WEAKEST one,
then look again at what remains and eliminate the weakest of those. Repeat
until one is left.

Do this ${itens.length} times, in order. Each elimination is judged against the
field that is still standing at that moment, not against the original list — a
comment that looked weak among strong ones may be the best of what's left later.

Weakest means: of everything still here, this is the one whose absence from the
review would cost the author the least.

Report them in elimination order: the first entry is the worst comment of all,
the last entry is the one that survived to the end.

Never eliminate two at once, never skip an index, never reorder afterwards to
look consistent. The order is the answer.

Include every index exactly once. Call torneio exactly once.`;

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
                ...tele('torneio', { caseId: cid }),
                model,
                tools: { torneio: torneioTool },
                toolChoice: { type: 'tool', toolName: 'torneio' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'torneio');
            const its = (call?.input ?? call?.args)?.eliminacoes || [];
            const porIndice = {};
            let ordem = 0;
            for (const it of its) {
                const p = it.indice;
                if (Number.isInteger(p) && p < reps.length && porIndice[reps[p]] === undefined) {
                    // eliminado cedo = pior. nota = posicao normalizada.
                    porIndice[reps[p]] = { pos: ordem, v: Math.round((ordem / Math.max(1, its.length - 1)) * 100) };
                    ordem++;
                }
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
