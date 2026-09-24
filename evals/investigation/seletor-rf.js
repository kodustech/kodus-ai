#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * UMA passada sobre todos os candidatos pre-reducer de um PR, no lugar do
 * reducer E do gate.
 *
 * Por que uma so: medimos hoje que todo filtro POR CANDIDATO perde — painel,
 * PFA, walk, bateria de scores, Jev, self-consistency. O unico estagio que
 * sempre ganhou foi o reducer, que e uma decisao sobre o CONJUNTO. Duas
 * chamadas de LLM em sequencia (reducer, depois gate) custam o dobro em tempo
 * e uma delas esta fazendo trabalho que a outra ja podia fazer: agrupar
 * duplicata e escolher o que vale postar sao a mesma decisao vista de dois
 * angulos.
 *
 * E o mais importante do desenho: a passada NAO corta. Ela agrupa duplicata e
 * devolve, para cada grupo, uma nota de 0 a 100 de "vale postar isto". O corte
 * — quantos comentarios por PR — fica como parametro OFFLINE. Assim uma unica
 * execucao produz a curva inteira de orcamento, em vez de uma chamada por
 * ponto testado. O numero que motiva: as ferramentas no topo do benchmark da
 * Martian postam 3,0 a 3,6 comentarios por PR; o nosso harness posta 7,1.
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
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const PARPR = Number(arg('parpr', '4'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const OUT = arg('out', path.join(__dirname, 'results', `seletor-rf-${DUMP}.json`));
registerTracing('seletor-reasoning-first');

const selecionarTool = tool({
    description: 'Registra os grupos e as notas. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            grupos: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        indices: {
                            type: 'array',
                            items: { type: 'number' },
                            description: 'Indices dos candidatos que descrevem O MESMO defeito. Um candidato sozinho vira um grupo de um.',
                        },
                        representante: { type: 'number', description: 'Qual dos indices e a melhor redacao do defeito.' },
                        // REASONING-FIRST: a justificativa sai ANTES da nota, entao
                        // o modelo gera o raciocinio e so depois crava o numero.
                        // O BitsAI-CR mediu o inverso (Conclusion-First) como melhor;
                        // este arquivo existe para checar se isso vale aqui.
                        porque: { type: 'string', description: 'Uma frase, citando file:line, justificando a nota que voce vai dar em seguida.' },
                        nota: { type: 'number', description: '0-100: o quanto vale postar ISTO neste PR.' },
                    },
                    required: ['indices', 'representante', 'porque', 'nota'],
                    additionalProperties: false,
                },
            },
        },
        required: ['grupos'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (cands, diff) => `A review of this pull request produced the candidate findings below. Several of them describe the same defect in different words. Your job is to group them and to say how much each group is worth posting.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Candidates>
${cands
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 500)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}`,
    )
    .join('\n\n')}
</Candidates>

STEP 1 — GROUP.
Put every candidate that describes the SAME defect into one group, even when
the wording, the file or the line differ — the same mistake repeated across
call sites is ONE defect. A candidate nobody duplicates is a group of one.
Every index must appear in exactly one group. Pick the clearest wording as the
representative.

STEP 2 — SCORE.
Give each group 0-100: how much is it worth posting this, on this pull request,
to the developer who wrote it.

  90-100  something is definitely wrong and it matters: a wrong value reaching
          a caller, a crash, data lost, a permission not enforced, a credential
          exposed. You can point at the line and say what breaks.
  70-89   very likely wrong and worth a comment, but one step of the path is
          inferred rather than read.
  40-69   might be wrong, or is right but minor — the author would probably
          not act on it before merging.
  10-39   a preference about how the code is written, a defence nobody
          violates, or a problem that predates this change.
  0-9     the claim does not hold against the code above.

Judge the defect, not the prose. Do not reward a confident tone, and do not
punish a terse one. A real defect described badly still scores high.

Be honest with the low end. This pull request does not owe you findings: if
most of these candidates are noise, most of the scores should be below 40.

For each group, write the one-sentence justification FIRST and only then the score, so the number follows the reasoning.

Call selecionar exactly once, with every candidate index accounted for.`;

(async () => {
    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
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
        if (SO.length && !SO.includes(j.caseId)) continue;
        const cands = j.trace?.preFilterCandidates || [];
        if (cands.length) casos.push({ cid: j.caseId, cands });
    }

    const saida = {};
    const um = async ({ cid, cands }) => {
        try {
            const r = await generateText({
                ...tele('seletor-unico', { caseId: cid }),
                model,
                tools: { selecionar: selecionarTool },
                toolChoice: { type: 'tool', toolName: 'selecionar' },
                prompt: prompt(cands, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'selecionar');
            const grupos = (call?.input ?? call?.args)?.grupos || [];
            saida[cid] = { grupos, candidatos: cands.length };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${cands.length} cand -> ${grupos.length} grupos`);
        } catch (e) {
            saida[cid] = { erro: String(e?.message || e).slice(0, 200), candidatos: cands.length };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${saida[cid].erro}`);
        }
    };
    for (let b = 0; b < casos.length; b += PARPR) {
        await Promise.all(casos.slice(b, b + PARPR).map(um));
    }
    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, modelo: MODEL, saida }, null, 2));
    console.log(`\n-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
