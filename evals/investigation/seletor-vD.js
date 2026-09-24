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
const OUT = arg('out', path.join(__dirname, 'results', `seletor-vD-${DUMP}.json`));
registerTracing('seletor-vD');

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
                        nota: { type: 'number', description: '0-100: o quanto vale postar ISTO neste PR.' },
                        porque: { type: 'string', description: 'Uma frase, citando file:line.' },
                    },
                    required: ['indices', 'representante', 'nota', 'porque'],
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

Score the IMPACT, 0 to 100: what happens if this is NOT fixed before merging,
against what is gained by fixing it.

  90-100  production consequence that is hard to undo: data corrupted or lost,
          a credential exposed, a permission not enforced, money or bookings
          wrong. Someone gets paged, or a user is harmed.
  70-89   a user-visible failure: a crash on a real path, a wrong value shown
          or stored, a feature that silently does not work.
  40-69   contained: it degrades something, or fails on an edge case, or makes
          the next change harder. Nobody is paged, but someone pays later.
  10-39   cosmetic or internal: a name, a comment, a log line, a test that is
          weaker than it looks. Nothing changes for anyone running the code.
  0-9     no impact, because nothing is actually wrong.

Judge the consequence, not the effort. A one-line fix that prevents data loss
scores high; a large refactor that changes nothing observable scores low. If
the blast radius depends on how the code is called, use what the diff and the
candidates tell you about the callers, and do not assume the worst.

Judge the defect, not the prose. Do not reward a confident tone, and do not
punish a terse one. A real defect described badly still scores high.

Be honest with the low end. This pull request does not owe you findings: if
most of these candidates are noise, most of the scores should be below 40.

Call selecionar exactly once, with every candidate index accounted for.`;

/** `buildModel` nao aplica RECALL_REASONING_EFFORT — isso vive no
 *  agent-provider, que este script nao usa. Sem o wrapper, o atribuidor roda
 *  no default do fornecedor, que e um regime NAO DECLARADO: comparar duas
 *  variantes de prompt sob defaults diferentes compara configuracao, nao
 *  prompt. */
function comEsforco(model, modelId) {
    const effort = process.env.RECALL_REASONING_EFFORT;
    if (!effort) return model;
    const { buildReasoningProviderOptions } = require('../../libs/llm/reasoning-options.ts');
    const provider = /^gemini/i.test(modelId) ? 'google_gemini'
        : /^claude/i.test(modelId) ? 'anthropic'
        : /^gpt|^o\d/i.test(modelId) ? 'openai' : 'openai_compatible';
    const inj = buildReasoningProviderOptions(provider, effort, modelId);
    if (!inj || !Object.keys(inj).length) return model;
    console.log(`[reasoning] ${modelId} effort=${effort} -> ${JSON.stringify(inj)}`);
    const merge = (o) => ({ ...o, providerOptions: { ...(o?.providerOptions || {}), ...inj } });
    return new Proxy(model, {
        get(t, p, r) {
            if (p === 'doGenerate' || p === 'doStream') return async (o) => t[p](merge(o));
            return Reflect.get(t, p, r);
        },
    });
}

(async () => {
    const model = comEsforco(buildModel(MODEL), String(MODEL).replace(/@sub$/, ''));
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
        let cands = j.trace?.preFilterCandidates || [];
        // FILTRO DE CONTRATO, antes do atribuidor. Um achado marcado com
        // severidade fora da escala declarada (`info`, `error`) ou sem o
        // percurso obrigatorio nao e um defeito proposto — e anotacao de
        // verificacao ocupando o campo errado. Medido: 33 de 278 candidatos
        // numa rodada, zero deles casando com golden. Tem de sair ANTES do
        // agrupamento: se entrar, o atribuidor agrupa e pontua em cima deles.
        // Ligado por padrao. Medido: filtrar ANTES do agrupamento da F1 0.471
        // contra 0.452 filtrando depois e 0.464 sem filtrar — a diferenca esta
        // em o atribuidor nao agrupar anotacao junto com defeito. Desliga com
        // RECALL_FILTRO_CONTRATO=0, para poder medir o contrafactual.
        if (process.env.RECALL_FILTRO_CONTRATO !== '0') {
            const ESCALA = new Set(['low', 'medium', 'high', 'critical']);
            cands = cands.filter(
                (c) => ESCALA.has(String(c?.severity || '').toLowerCase()) && !!c?.reason,
            );
        }
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
