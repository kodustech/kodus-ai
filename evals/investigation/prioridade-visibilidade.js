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
const OUT = arg('out', path.join(__dirname, 'results', `priovis-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('prioridade-visibilidade');

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

const trioTool = tool({
    description: 'Registra prioridade e visibilidade de cada comentario. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        indice: { type: 'number' },
                        prioridade: { type: 'string', enum: ['urgente', 'depois', 'nunca'] },
                        visibilidade: { type: 'string', enum: ['dado-errado', 'cliente-ve', 'interno'] },
                        verdadeiro: { type: 'number', description: 'prioridade em numero: urgente=100, depois=50, nunca=5.' },
                        vis: { type: 'number', description: 'visibilidade em numero: dado-errado=100, cliente-ve=50, interno=5.' },
                        ancora: { type: 'string', description: 'Uma frase: quem percebe, e como.' },
                    },
                    required: ['indice', 'prioridade', 'visibilidade', 'verdadeiro', 'vis', 'ancora'],
                    additionalProperties: false,
                },
            },
        },
        required: ['itens'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, diff) => `You are the senior developer who owns this codebase. You have a full sprint backlog. An AI reviewed this pull request and decided to post the comments below.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Comments the AI decided to post>
${itens
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 450)}` ,
    )
    .join('\n\n')}
</Comments>

Assume every comment is TRUE. Answer two independent questions about each.

FIRST — prioridade. Against your actual backlog, when does this get fixed?
  urgente  it does not ship like this. You fix it in this pull request or you
           block the merge.
  depois   it is a real defect and you would take the ticket, but it goes in
           the backlog behind what you already have. Next sprint, or the one
           after.
  nunca    you would close the ticket. Not because it is false — because it
           will never be worth anyone's afternoon.

SECOND — visibilidade. WHERE does this defect surface? This is not about how
severe it is. A catastrophic crash in a tool only your team runs is "interno".
A wrong label on a button is "cliente-ve".
  dado-errado  a customer's data is written wrong, read wrong, lost, or shown
               to the wrong person. The damage outlives the request.
  cliente-ve   a customer notices something — an error page, a wrong number on
               screen, a slow page, a feature that does not work — but no data
               is corrupted and nothing leaks.
  interno      no customer ever perceives it. An internal log, a metric, a
               developer-facing message, a test, a tool your team runs, a code
               path that only fires in development.

The two answers are independent. A defect can be "nunca" and "dado-errado" at
once (a corruption that needs input nobody sends), or "urgente" and "interno"
(a metric your on-call depends on).

Be honest with the low end on both. Most comments an AI produces are "nunca"
and "interno". Do not spread the three levels evenly.

Score every index exactly once. Call trio exactly once.`;

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
        const POST = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'postados.json'), 'utf8'));
        const reps = (POST[cid] || []).map((x) => x.orig).filter((i) => Number.isInteger(i));
        if (reps.length) casos.push({ cid, reps, itens: reps.map((i) => cands[i]) });
    }
    const saida = {};
    const um = async ({ cid, reps, itens }) => {
        try {
            const r = await generateText({
                ...tele('prioridade-visibilidade', { caseId: cid }),
                model,
                tools: { trio: trioTool },
                toolChoice: { type: 'tool', toolName: 'trio' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'trio');
            const its = (call?.input ?? call?.args)?.itens || [];
            const porIndice = {};
            for (const it of its) {
                const p = it.indice;
                if (Number.isInteger(p) && p < reps.length) porIndice[reps[p]] = { prio: it.verdadeiro, vis: it.vis, pl: it.prioridade, vl: it.visibilidade };
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
