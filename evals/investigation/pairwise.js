#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * PAIRWISE na zona de fronteira, agregado com Bradley-Terry.
 *
 * Pontual e listwise ja foram testados aqui e nenhum bateu a nota do
 * atribuidor. Pairwise nao. A diferenca que importa: comparar dois itens e uma
 * tarefa mais facil que pontuar um, e o resultado e uma ORDEM — imune a deriva
 * de calibracao entre execucoes, que foi o que derrubou o limiar global.
 *
 * So a faixa 3-9 entra, que e onde a cota de fato decide. Cada par vai nos dois
 * sentidos, com ids embaralhados, para cancelar vies de posicao.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DUMP = arg('dump', 'sol-teto2');
const PARPR = Number(arg('parpr', '5'));
const OUT = arg('out', path.join(__dirname, 'results', 'pairwise-sol-teto2.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
registerTracing('pairwise');

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

const duelosTool = tool({
    description: 'Registra o vencedor de cada duelo. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            duelos: { type: 'array', items: { type: 'object', properties: {
                duelo: { type: 'number' },
                vencedor: { type: 'string', description: 'A ou B — qual dos dois merece mais virar comentario.' },
                porque: { type: 'string', description: 'Meia frase.' },
            }, required: ['duelo', 'vencedor', 'porque'], additionalProperties: false } },
        },
        required: ['duelos'], additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const txt = (c) => `${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
      ${c.oneSentenceSummary || ''}
      ${String(c.suggestionContent || '').slice(0, 380)}`;

const prompt = (duelos, diff) => `Below are pairs of findings from a review of this pull request. For each pair, say which one deserves to become a comment more than the other.

<Diff>
${String(diff || '').slice(0, 30000)}
</Diff>

<Duels>
${duelos.map((x) => `### duelo ${x.duelo}

  A: ${txt(x.a)}

  B: ${txt(x.b)}`).join('\n\n')}
</Duels>

Every pair needs a winner. Ties are not allowed — if they feel equal, find the
thing that separates them and pick.

You are not scoring them. You are choosing between these two, and only these
two. The same finding may appear in several duels; judge each duel on its own
and do not try to be consistent across duels — that is handled afterwards.

What wins a duel:
  the failure is concrete — you can name the input and the wrong result
  it is caused BY THIS DIFF, not inherited from code the diff merely touched
  a reader of this pull request could act on it without asking a question first
  the reasoning ends in something going wrong, not in a worry

What loses:
  performance that is not pathological, hardening against input nobody sends
  a defect in code that was already like that before this change
  "consider", "might want to", "could be clearer"
  anything whose whole argument is that a test does not exist

Judge the defect, not the prose. A real defect described badly beats a
well-written non-issue.

Answer every duelo exactly once. Call duelos exactly once.`;

(async () => {
    const model = comEsforco(buildModel(MODEL), String(MODEL).replace(/@sub$/, ''));
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const FR = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'fronteira.json'), 'utf8'));
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
        const cid = j.caseId; const itens = FR[cid];
        if (!itens || itens.length < 2) continue;
        const cands = j.trace?.preFilterCandidates || [];
        const obj = itens.map((x) => ({ ...x, c: cands[x.orig] })).filter((x) => x.c);
        const duelos = [];
        let id = 1;
        for (let i = 0; i < obj.length; i++) for (let k = i + 1; k < obj.length; k++) {
            duelos.push({ duelo: id++, a: obj[i].c, b: obj[k].c, oa: obj[i].orig, ob: obj[k].orig });
            duelos.push({ duelo: id++, a: obj[k].c, b: obj[i].c, oa: obj[k].orig, ob: obj[i].orig });
        }
        // embaralha para o modelo nao ver o par espelhado adjacente
        for (let i = duelos.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [duelos[i], duelos[k]] = [duelos[k], duelos[i]]; }
        casos.push({ cid, duelos });
    }
    const saida = {};
    const um = async ({ cid, duelos }) => {
        try {
            const r = await generateText({
                ...tele('pairwise', { caseId: cid }), model,
                tools: { duelos: duelosTool }, toolChoice: { type: 'tool', toolName: 'duelos' },
                prompt: prompt(duelos, diffs[cid]),
            });
            const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'duelos');
            const ds = (call?.input ?? call?.args)?.duelos || [];
            const porId = Object.fromEntries(duelos.map((x) => [x.duelo, x]));
            saida[cid] = ds.filter((x) => porId[x.duelo]).map((x) => {
                const p = porId[x.duelo];
                const venceu = String(x.vencedor || '').trim().toUpperCase().startsWith('B') ? p.ob : p.oa;
                return { ganhou: venceu, perdeu: venceu === p.oa ? p.ob : p.oa };
            });
            console.log(`  ${cid.slice(0, 44).padEnd(46)} ${duelos.length} duelos -> ${saida[cid].length} veredictos`);
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
