#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * DELECAO FORCADA, por PR.
 *
 * Todas as dez perguntas anteriores pediam para ESCOLHER ou PONTUAR, e todas
 * acabaram reproduzindo a nota do atribuidor. Esta pede o contrario: o modelo
 * e obrigado a APAGAR metade, e tem que justificar cada remocao. Rejeitar e
 * uma tarefa diferente de aprovar — quem escolhe procura virtude, quem apaga
 * procura defeito, e sao listas diferentes.
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
const OUT = arg('out', path.join(__dirname, 'results', `delecao-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('delecao-forcada');

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

const deletarTool = tool({
    description: 'Registra o que voce apaga. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: { type: 'array', items: { type: 'object', properties: {
                indice: { type: 'number' },
                apagar: { type: 'boolean' },
                verdadeiro: { type: 'number', description: '0-100: quanto voce resiste a apagar este. 0 = apaga primeiro, 100 = apaga por ultimo.' },
                ancora: { type: 'string', description: 'Meia frase: por que apaga, ou por que resiste.' },
            }, required: ['indice', 'apagar', 'verdadeiro', 'ancora'], additionalProperties: false } },
        },
        required: ['itens'], additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, diff) => `An automated review produced the ${itens.length} comments below on this pull request. Posting all of them is not an option — the author would stop reading.

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

**You must delete AT LEAST HALF of them.** That is ${Math.max(1, Math.floor(itens.length / 2))} of ${itens.length}, minimum. Deleting more is allowed and often right.

Do not choose which to keep. Go through them looking for the reason to DELETE
each one, and only spare the ones where you cannot find one.

Reasons to delete, in the order you will meet them:
  it is true but nothing changes if it ships
  it is about code the diff did not introduce
  another comment on this list already says it, better
  it asks for a defence against input that does not arrive
  it is a preference dressed as a defect
  the author plainly already knows — it is their own code and their own change
  you cannot state, in one sentence, what goes wrong if it is ignored

Spare a comment only when you can name the concrete failure it prevents.

The author's attention is the scarce thing here, not correctness. A true
comment that costs attention and returns nothing is worse than no comment.

In verdadeiro, say how hard you resisted deleting it: 0 means it was the first
to go, 100 means you would defend it. Use the full range — do not cluster.

Answer every index exactly once. Call deletar exactly once.`;

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
                ...tele('delecao-forcada', { caseId: cid }),
                model,
                tools: { deletar: deletarTool },
                toolChoice: { type: 'tool', toolName: 'deletar' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'deletar');
            const its = (call?.input ?? call?.args)?.itens || [];
            const porIndice = {};
            for (const it of its) {
                const p = it.indice;
                if (Number.isInteger(p) && p < reps.length) porIndice[reps[p]] = { v: it.verdadeiro, apagar: !!it.apagar };
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
