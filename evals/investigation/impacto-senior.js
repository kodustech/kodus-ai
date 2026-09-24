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
const OUT = arg('out', path.join(__dirname, 'results', `impacto-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('impacto-senior');

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

const impactoTool = tool({
    description: 'Registra o impacto de cada comentario. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            itens: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        indice: { type: 'number' },
                        impacto: { type: 'string', enum: ['alto', 'medio', 'baixo'] },
                        verdadeiro: { type: 'number', description: '0-100, onde 100=alto, 50=medio, 10=baixo. Coerente com o campo impacto.' },
                        ancora: { type: 'string', description: 'Uma frase: o que acontece se isto nao for corrigido.' },
                    },
                    required: ['indice', 'impacto', 'verdadeiro', 'ancora'],
                    additionalProperties: false,
                },
            },
        },
        required: ['itens'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, diff) => `You are the senior developer who owns this codebase. An AI reviewed this pull request and decided to post the comments below on it. They are going out to the author as they are.

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

For each one, decide the IMPACT on this codebase. Not whether it is true — assume
it is. Not whether it is well written. What it costs you if it ships as is.

  alto    something breaks for a user, data is wrong or lost, a permission is
          not enforced, the service degrades under normal load. You would hold
          the merge for this.
  medio   it is a genuine defect but bounded — a rare path, a recoverable
          error, a wrong value in a log or a metric, a contract that is
          technically violated but that nothing currently depends on. You would
          merge and open a follow-up.
  baixo   nothing observable changes. A preference, a hardening suggestion, a
          defence against input nobody sends, something that was already like
          that before this pull request, a test that does not exist.

Judge as the owner, not as an auditor. You know the conventions, you know what
is intentional, you know what the next commit already handles.

Be honest with the low end. Most review comments an AI produces are baixo, and
saying so is the useful answer. Do not distribute the three levels evenly.

In ancora, write one sentence: what actually happens if this is not fixed.

Score every index exactly once. Call impacto exactly once.`;

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
                ...tele('impacto-senior', { caseId: cid }),
                model,
                tools: { impacto: impactoTool },
                toolChoice: { type: 'tool', toolName: 'impacto' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'impacto');
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
