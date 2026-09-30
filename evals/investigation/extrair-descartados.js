#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821 — o que o modelo DESCREVEU no raciocinio e nao reportou.
 *
 * No Sonnet (29/09) extrair do raciocinio os problemas descartados somou +15 a
 * +17 goldens em duas rodadas. No GPT-6 o diagnostico ja dizia que em 6 goldens
 * ele "viu e descartou". Este script le o `reasoning` gravado em cada dump e a
 * lista do que foi submetido, e grava um pool NOVO so com os descartados, para
 * o judge pontuar e para somar ao pool original offline.
 *
 * Nao inventa: cada item precisa citar a frase do raciocinio de onde saiu.
 *
 *   RECALL_MODEL=gpt-6-sol@api node extrair-descartados.js --dump=<pool> --out=<pool novo>
 */
const fs = require('fs');
const path = require('path');
const { buildModel } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const DUMP = arg('dump');
const OUT = arg('out');
const PAR = Number(arg('par', '4'));
const MODEL = process.env.RECALL_MODEL || 'gpt-6-sol@api';

const SCHEMA = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    citacao: { type: 'string', description: 'The sentence of the reasoning this item comes from, verbatim.' },
                    relevantFile: { type: 'string' },
                    relevantLinesStart: { type: 'number' },
                    relevantLinesEnd: { type: 'number' },
                    oneSentenceSummary: { type: 'string' },
                    suggestionContent: { type: 'string' },
                    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                },
                required: ['citacao', 'relevantFile', 'relevantLinesStart', 'relevantLinesEnd', 'oneSentenceSummary', 'suggestionContent', 'severity'],
                additionalProperties: false,
            },
        },
    },
    required: ['itens'],
    additionalProperties: false,
};

const prompt = (reasoning, submetidos, diff) => `A code reviewer went through the pull request below. You have what it wrote while reasoning, and the findings it actually submitted.

While reasoning, reviewers often describe a concrete problem and then decide not to report it — "I cannot establish a production failure", "this is probably intentional", "no confirmed caller breaks", "out of scope for my class". List every concrete defect that the reasoning DESCRIBES and that is NOT among the submitted findings.

Rules:
- Every item must come from the reasoning. Quote, verbatim, the sentence it comes from. Do not add defects of your own.
- Include a problem the reviewer raised and then dropped for lack of proof, because it looked intentional, or because it was outside its assignment.
- Do NOT include a concern the reviewer checked and found to be fine ("I confirmed X is handled", "the guard at line N prevents it").
- Do NOT include anything already covered by a submitted finding (same place, same failure).
- Anchor each item to the file and changed lines the reasoning points at, using the diff.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Reasoning>
${String(reasoning || '').slice(0, 30000)}
</Reasoning>

<SubmittedFindings>
${submetidos.map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'} — ${c.oneSentenceSummary || String(c.suggestionContent || '').slice(0, 140)}`).join('\n') || '(none)'}
</SubmittedFindings>

If the reasoning describes nothing that was left out, return an empty list.`;

(async () => {
    if (!DUMP || !OUT) {
        console.error('uso: node extrair-descartados.js --dump=<pool> --out=<pool novo>');
        process.exit(1);
    }
    const model = buildModel(MODEL);
    const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) diffs[v.caseId] = J(v.changedFilesFull).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`).join('\n\n');
        } catch {}
    }
    fs.mkdirSync(path.join(S, OUT), { recursive: true });
    const arquivos = fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'));
    let falhas = 0;
    const um = async (f) => {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const submetidos = j.trace?.preFilterCandidates || [];
        try {
            const r = await chamadaEstruturada({
                model,
                modelId: MODEL,
                nome: 'descartados',
                schema: SCHEMA,
                prompt: prompt(j.reasoning, submetidos, diffs[j.caseId]),
            });
            const itens = (r.dados?.itens || []).map((it) => ({
                ...it,
                producedBy: 'descartado-do-raciocinio',
                confidence: 5,
            }));
            const novo = { caseId: j.caseId, reasoning: '', findings: [], trace: { preFilterCandidates: itens, recallPasses: [] } };
            fs.writeFileSync(path.join(S, OUT, f), JSON.stringify(novo));
            console.log(`  ${j.caseId.slice(0, 46).padEnd(48)} ${submetidos.length} submetidos -> ${itens.length} descartados`);
        } catch (e) {
            falhas++;
            console.log(`  ${j.caseId.slice(0, 46).padEnd(48)} FALHOU: ${String(e?.message || e).slice(0, 120)}`);
        }
    };
    for (let i = 0; i < arquivos.length; i += PAR) await Promise.all(arquivos.slice(i, i + PAR).map(um));
    if (falhas) {
        console.error(`ABORTADO: ${falhas} PRs falharam — refaca antes de julgar.`);
        process.exit(2);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
