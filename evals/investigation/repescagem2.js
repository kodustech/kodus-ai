#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * REPESCAGEM por lacuna, nao por reordenacao.
 *
 * Reordenar o descarte e aritmeticamente identico a baixar a cota — a nossa
 * probabilidade ja tem AUC 0,610 la dentro. Este parte de outro lugar: olha o
 * DIFF e o que ja foi comentado, pergunta o que FICOU FALTANDO, e so entao
 * procura entre os descartados quem cobre a lacuna. O ponto de partida e o
 * codigo, nao a nossa lista.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DUMP = arg('dump', 'sol-teto2');
const PARPR = Number(arg('parpr', '5'));
const OUT = arg('out', path.join(__dirname, 'results', 'repesca2-sol-teto2.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('repescagem');

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

const repescaTool = tool({
    description: 'Registra as lacunas e quais descartados as cobrem. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            lacunas: { type: 'array', description: 'O que um revisor teria comentado e nao foi comentado. Vazio se nada ficou faltando.',
                items: { type: 'object', properties: {
                    oque: { type: 'string', description: 'A lacuna, em uma frase.' },
                    onde: { type: 'string', description: 'arquivo:linha' },
                    cobre: { type: 'array', description: 'Indices da lista Discarded que cobrem esta lacuna. Vazio se nenhum cobre.', items: { type: 'number' } },
                    forca: { type: 'number', description: '0-100: quanto voce aposta que um revisor humano comentou isto.' },
                }, required: ['oque', 'onde', 'cobre', 'forca'], additionalProperties: false } },
        },
        required: ['lacunas'], additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (diff, postados, descartados) => `An automated review of this pull request already posted the comments under <Posted>. The comments under <Dropped> were produced by the same review and then dropped as not worth posting.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Posted>
${postados.length ? postados.map((c, i) => `[P${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}\n    ${c.oneSentenceSummary || ''}`).join('\n\n') : '(nothing was posted)'}
</Posted>

<Dropped>
${descartados.length ? descartados.map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}\n    ${c.oneSentenceSummary || ''}\n    ${String(c.suggestionContent || '').slice(0, 340)}` ).join('\n\n') : '(empty)'}
</Dropped>

The dropping was probably right. Your job is to catch the rare case where it was not.

Name any dropped comment that a reviewer of this pull request would clearly have
raised — something whose absence from <Posted> leaves a real defect unmentioned.

**Returning an empty list is the expected answer.** Most of the time the drops
were correct, and recovering a weak comment costs more than leaving it out. Do
not recover something to be helpful. Do not recover the best of a bad set — if
the best one still is not worth the author's attention, recover nothing.

Recover one only if you can state, in one sentence, the concrete thing that goes
wrong and that no posted comment already covers.

Never recover:
  something a posted comment already says, even in different words
  a true observation about code this diff did not introduce
  a hardening suggestion, a preference, a missing test
  anything you would describe with "consider" or "it may be worth"

For each one you recover, put its index in cobre and say in oque what goes
wrong. In forca, how strongly you would bet a human reviewer raised it.

Call repesca exactly once, with lacunas empty if nothing deserves recovery.`;

(async () => {
    const model = comEsforco(buildModel(MODEL), String(MODEL).replace(/@sub$/, ''));
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'base-editor.json'), 'utf8'));
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) diffs[v.caseId] = J(v.changedFilesFull).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`).join('\n\n');
        } catch {}
    }
    const casos = [];
    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId; const b = BASE[cid];
        if (!b) continue;
        const cands = j.trace?.preFilterCandidates || [];
        const P = b.postados.map((x) => cands[x.orig]).filter(Boolean);
        const D = b.descartados.map((x) => ({ ...cands[x.orig], __orig: x.orig })).filter((x) => x.relevantFile);
        if (D.length) casos.push({ cid, P, D });
    }
    const saida = {};
    const um = async ({ cid, P, D }) => {
        try {
            const r = await generateText({
                ...tele('repescagem', { caseId: cid }), model,
                tools: { repesca: repescaTool }, toolChoice: { type: 'tool', toolName: 'repesca' },
                prompt: prompt(diffs[cid], P, D),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'repesca');
            const ls = (call?.input ?? call?.args)?.lacunas || [];
            saida[cid] = ls.map((l) => ({ oque: l.oque, onde: l.onde, forca: l.forca,
                origs: (l.cobre || []).filter((i) => Number.isInteger(i) && i < D.length).map((i) => D[i].__orig) }));
            const n = saida[cid].reduce((a, l) => a + l.origs.length, 0);
            console.log(`  ${cid.slice(0, 44).padEnd(46)} ${D.length} descartados -> ${ls.length} lacunas, ${n} repescados`);
        } catch (e) {
            saida[cid] = [];
            console.log(`  ${cid.slice(0, 44).padEnd(46)} FALHOU: ${String(e?.message || e).slice(0, 90)}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) await Promise.all(casos.slice(b, b + PARPR).map(um));
    fs.writeFileSync(OUT, JSON.stringify({ modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
