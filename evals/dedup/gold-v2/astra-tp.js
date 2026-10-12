#!/usr/bin/env node
/**
 * Classificacao TP/FP do finder congelado (#1821): segunda opiniao do GPT-6
 * Astra onde a classificacao (classificacao/<modelo>/<caseId>.json) discorda do
 * juiz da Martian. Para cada golden em disputa pergunta so se a sugestao e o
 * golden descrevem o mesmo problema; nao mostra nenhum dos dois vereditos.
 * Codex CLI, assinatura, sem ferramentas. Respostas em classificacao/astra/.
 *
 *   node evals/dedup/gold-v2/astra-tp.js [--models=a,b] [--par=4] [--force]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const PAR = Number(arg('par', '4'));
const MODELS = arg('models', 'gpt-6.1-sol,sonnet-5.5').split(',');
const DIR = path.join(__dirname, 'classificacao');
// Texto completo do golden: a matriz do juiz guarda so os 200 primeiros caracteres.
const GOLDENS = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'benchmark-sets', 'v002', 'goldens.json'), 'utf8')).prs.map((p) => [p.caseId, p.comments]));
const TITULO = {};
for (const f of fs.readdirSync(path.join(__dirname, '..', '..', 'investigation', 'datasets'))) {
    let cs = [];
    try { cs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'investigation', 'datasets', f), 'utf8')); } catch { continue; }
    for (const c of cs) if (c?.vars?.caseId) TITULO[c.vars.caseId] = c.vars.prTitle;
}
const SUG = (m) => JSON.parse(fs.readFileSync(path.join(__dirname, `09.10.26_${m}.json`), 'utf8')).prs;
const MATRIZ = { 'gpt-6.1-sol': '09.10.26_finder-definitivo_gpt', 'sonnet-5.5': '09.10.26_finder-definitivo_sonnet', 'deepseek-v4.1-flash': '09.10.26_finder-definitivo_deepseek', 'muse-spark-1.2': '09.10.26_finder-muse-v1' };

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['sameProblem', 'reason'],
    properties: { sameProblem: { type: 'boolean' }, reason: { type: 'string' } },
};

function prompt(prTitle, golden, s) {
    return `You compare a code review comment with an expected (golden) review comment on the same pull request.

Pull request: ${prTitle}

Golden comment (the issue the reviewer was expected to find):
${golden}

Review comment (${s.relevantFile}:${s.relevantLinesStart}-${s.relevantLinesEnd}):
${s.suggestionContent}

Does the review comment report the same problem as the golden comment? Same problem means a developer who fixes what the review comment describes would also fix the issue the golden comment describes, at the same place in the code. Different wording, extra detail or a broader comment that includes the golden issue still counts as the same problem. A different bug in the same area, or only a related symptom, does not.

Answer with sameProblem (true or false) and a one-sentence reason.`;
}

function run(cmd, args, input, cwd) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { cwd, env: process.env });
        let out = '', err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-800)}`))));
        p.stdin.end(input);
    });
}

async function astra(text) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-tp-'));
    try {
        const schemaFile = path.join(tmp, 'schema.json');
        const outFile = path.join(tmp, 'out.json');
        fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
        await run('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high',
            '--output-schema', schemaFile, '-o', outFile, '-'], text, tmp);
        return JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

(async () => {
    const fila = [];
    for (const m of MODELS) {
        const sug = SUG(m);
        const mat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'investigation', 'results', `matriz-pre-${MATRIZ[m]}.json`), 'utf8'));
        for (const f of fs.readdirSync(path.join(DIR, m))) {
            const c = JSON.parse(fs.readFileSync(path.join(DIR, m, f), 'utf8'));
            const goldens = mat[c.caseId].goldens;
            for (const it of c.itens.filter((x) => x.precisaAstra)) {
                const s = sug[c.caseId].suggestions.find((x) => x.id === it.id);
                // Os goldens em disputa: o do juiz e o da classificacao.
                for (const g of new Set([it.juizMartian?.tp ? it.juizMartian.golden : null, it.classe === 'TP' ? it.golden : null].filter((x) => x != null))) {
                    fila.push({ modelo: m, caseId: c.caseId, id: it.id, golden: g, text: prompt(TITULO[c.caseId] || c.caseId, GOLDENS[c.caseId][g].comment, s) });
                }
            }
        }
    }
    const out = path.join(DIR, 'astra');
    fs.mkdirSync(out, { recursive: true });
    let i = 0, feitos = 0, erros = 0;
    const um = async (q) => {
        const file = path.join(out, `${q.modelo}__${q.caseId}__${q.id}__g${q.golden}.json`);
        if (!process.argv.includes('--force') && fs.existsSync(file)) return;
        for (let t = 1; t <= 3; t++) {
            try {
                const r = await astra(q.text);
                fs.writeFileSync(file, JSON.stringify({ modelo: q.modelo, caseId: q.caseId, id: q.id, golden: q.golden, promptSha: crypto.createHash('sha1').update(q.text).digest('hex'), ...r }, null, 1));
                feitos++;
                return;
            } catch (e) {
                if (t === 3) { erros++; console.error(q.modelo, q.caseId, q.id, String(e.message).slice(0, 200)); }
            }
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    console.log(JSON.stringify({ perguntas: fila.length, feitos, erros }));
    process.exit(erros ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
