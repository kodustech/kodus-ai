#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: etapa "classify" sobre a saida do dedup de producao (sem o revisor).
 * Agent loop por sugestao, teto de 5 passos (grep/readFile no worktree do PR),
 * diff do PR no prompt, no modelo do cenario. Devolve severidade, categoria
 * (nitpick / speculative / defensive / defect) e lowValue (true para as tres
 * primeiras). O que tiver lowValue=true e descartado.
 *
 *   RECALL_MODEL=<id> node classify-etapa.js --dedup=<arq> --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const DEDUP = arg('dedup'), POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const TETO = 5;

const SUBMIT = {
    type: 'object',
    properties: {
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        category: { type: 'string', enum: ['nitpick', 'speculative', 'defensive', 'defect'] },
        lowValue: { type: 'boolean' },
        reason: { type: 'string', description: 'One sentence citing file:line.' },
    },
    required: ['severity', 'category', 'lowValue', 'reason'],
};

const SYSTEM = `You classify ONE code review finding on a pull request. Read the code with grep and readFile before deciding.

category — exactly one:
- nitpick: style, naming, comments, documentation, log wording, formatting, readability, harmless dead code. Nothing behaves wrong.
- speculative: the failure depends on hypothetical usage, configuration, scale, input or a future change that nothing in this pull request or its code indicates will happen.
- defensive: asks for a null check, validation, try/catch, guard or fallback, but there is no concrete path in this code where the missing guard produces a wrong result.
- defect: a concrete wrong behavior this code produces — a crash, wrong value, lost or corrupted data, security exposure, broken feature, or a test that passes while the code is wrong — reachable through a path you can see in the code.

lowValue — true when the category is nitpick, speculative or defensive; false when it is defect.
severity — low, medium, high or critical, as YOU judge it from the code, not as the finding claims.

Judge the code, not the prose. When the finding describes a concrete reachable failure, it is a defect even if it also suggests a guard. If you cannot tell within your steps, answer defect.`;

const prompt = (c, diff) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

File: ${c.relevantFile}
Lines: ${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? c.relevantLinesStart ?? '?'}
Finding: ${c.suggestionContent}

You have up to ${TETO} steps. The LAST one is your answer — submitting is itself a step — so you have up to ${TETO - 1} to read code with.
Submit with submitClassification: {"severity": "...", "category": "...", "lowValue": true|false, "reason": "..."}.`;

function ferramentas(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
}

async function sessao(model, cmd, c, diff) {
    let enviado = null;
    const tools = { ...ferramentas(cmd), submitClassification: tool({ description: 'Submit the classification. The only way to answer.', inputSchema: jsonSchema(SUBMIT), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM, prompt: prompt(c, diff), tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitClassification'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitClassification' } }),
                messages: [...messages, { role: 'user', content: 'Final step: submit your classification now. If you could not tell, answer defect.' }] }
            : undefined,
    });
    if (!enviado) enviado = extraiJson(r.text || '');
    if (!enviado || typeof enviado.lowValue !== 'boolean' || !enviado.category) throw new Error('sem classificacao');
    // A flag segue a categoria: o modelo as vezes diverge das duas.
    const low = ['nitpick', 'speculative', 'defensive'].includes(enviado.category);
    return { severity: enviado.severity, category: enviado.category, lowValue: low, flagDoModelo: enviado.lowValue, reason: String(enviado.reason || '').slice(0, 300), passos: r.steps?.length ?? 0 };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[classify] ${descreveModelo(MODELO)} · agent loop, teto ${TETO}`);
    const R = JSON.parse(fs.readFileSync(DEDUP, 'utf8')).prs;
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); }
        } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = L30.filter((c) => (!SO.length || SO.includes(c)) && R[c] && !R[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const kept = R[cid].kept || [];
            const itens = [];
            if (kept.length) {
                h = await prepareRepo(vars[cid], `${cid}-cl-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                let j = 0;
                const saida = {};
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < kept.length) {
                        const k = kept[j++];
                        saida[k] = await retry(() => sessao(model, cmd, { ...cs[k], existingCode: undefined }, diffs[cid]));
                    }
                }));
                for (const k of kept) itens.push({ k, ...saida[k] });
            }
            res.prs[cid] = { itens };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const its = ok.flatMap((p) => p.itens);
    const cat = {}; for (const x of its) cat[x.category] = (cat[x.category] || 0) + 1;
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, itens: its.length, lowValue: its.filter((x) => x.lowValue).length, cat }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
