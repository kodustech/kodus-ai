#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * EDITOR por PR: escolhe QUAIS achados virariam comentario, vendo todos os
 * concorrentes de uma vez.
 *
 * Por que isto e diferente dos outros segundos escores: veracidade, orcamento
 * e "revisor humano" pontuam um achado por vez, cegos aos demais. O oraculo
 * mostra que, com 4 comentarios por PR, da para chegar a 59,3%/57,7% — ou
 * seja, o problema que sobrou nao e "este achado e bom?" e sim "este achado e
 * melhor que os outros 11 deste PR?". Essa e uma escolha comparativa, e
 * nenhuma nota absoluta a captura: ranquear exige ver os rivais.
 *
 * A saida e uma ORDEM, nao uma nota. A posicao entra na formula como 1/(pos+1).
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
const OUT = arg('out', path.join(__dirname, 'results', `editor-${DUMP}.json`));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('editor-por-pr');

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

const editorTool = tool({
    description: 'Registra a ordem de postagem escolhida. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            ordem: {
                type: 'array',
                description: 'Indices, do que voce postaria primeiro ao que postaria por ultimo. Inclua TODOS os indices.',
                items: { type: 'number' },
            },
            quantos: {
                type: 'number',
                description: 'Quantos dos primeiros voce de fato postaria neste PR.',
            },
        },
        required: ['ordem', 'quantos'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (itens, diff) => `You are the reviewer who has to decide what to actually post on this pull request. Below is everything an automated pass flagged. Duplicates are already merged.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Candidates>
${itens
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 450)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}` ,
    )
    .join('\n\n')}
</Candidates>

Rank ALL of them, best first, then say how many you would really post.

Rank them AGAINST EACH OTHER, not against a standard. The question is never
"is this worth posting" on its own — it is "would I post this one before that
one". So compare directly: if two findings sit on the same line, one of them is
the better-argued version and the other is noise. If one says the code loses
data and another says a loop could be a Set, the second loses no matter how well
written it is. Ties are not allowed; break them.

What wins a higher position:
  the failure is concrete — you can name the input and the wrong result
  it is caused BY THIS DIFF, not inherited from code the diff merely touched
  the reasoning ends in a failure, not in a worry
  a reader of this PR could act on it without asking you a question first

What loses position, however true:
  performance that is not pathological, hardening against input nobody sends
  a second finding on a line another candidate already covers better
  "consider", "might want to", "could be clearer"
  anything whose whole argument is that a test does not exist

For "quantos": real reviewers post few comments. Two or three is normal on a
change this size, five is a lot, and a PR where nothing is worth saying gets
zero. Do not spend the number just because there are many candidates — the
count should reflect how many genuinely clear the bar, and most of these do not.

Include every index in ordem exactly once. Call editor exactly once.`;

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
                ...tele('editor-por-pr', { caseId: cid }),
                model,
                tools: { editor: editorTool },
                toolChoice: { type: 'tool', toolName: 'editor' },
                prompt: prompt(itens, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'editor');
            const inp = call?.input ?? call?.args ?? {};
            const ordem = Array.isArray(inp.ordem) ? inp.ordem : [];
            const porIndice = {};
            let pos = 0;
            for (const p of ordem) {
                if (Number.isInteger(p) && p < reps.length && porIndice[reps[p]] === undefined) {
                    porIndice[reps[p]] = { pos, dentro: pos < (inp.quantos ?? 0) };
                    pos++;
                }
            }
            saida[cid] = { itens: porIndice, quantos: inp.quantos ?? 0 };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${reps.length} itens -> ordena ${pos}, postaria ${inp.quantos ?? 0}`);
        } catch (e) {
            saida[cid] = { itens: {}, quantos: 0 };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${String(e?.message || e).slice(0, 110)}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) await Promise.all(casos.slice(b, b + PARPR).map(um));
    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
