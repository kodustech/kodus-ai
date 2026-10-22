#!/usr/bin/env node
/**
 * Severity labels from the suggestion text (#1821): Astra (gpt-6-astra on the
 * Codex subscription) reads each dataset item exactly as the tested models do
 * (file, lines, suggestionContent; no code) plus definitions.md, and gives the
 * level that text supports. It never sees the gold comment, the current label,
 * the category or any model answer. Items go in batches under neutral keys.
 *
 *   node evals/severity/astra-label.js [--batch=20] [--par=4] [--items=items.json] [--out=astra-labels.json]
 *     -> evals/severity/dataset/<out> {issueId: {severity, reason}}
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const BATCH = Number(arg('batch', 20));
const PAR = Number(arg('par', 4));
const OUT = path.join(__dirname, 'dataset', arg('out', 'astra-labels.json'));
const DEFS = fs.readFileSync(path.join(__dirname, 'definitions.md'), 'utf8').replace(' Internally refuted findings need validity review.', '').trim();
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset', arg('items', 'items.json')), 'utf8')).items;
const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['key', 'severity', 'reason'],
                properties: {
                    key: { type: 'string' },
                    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                    reason: { type: 'string' },
                },
            },
        },
    },
};

const prompt = (batch) => `You label the severity of code review comments for an evaluation dataset. Each comment below is the whole input: rate the consequence the comment itself states and supports, using only the definitions. Assume what the comment claims is true; do not decide whether it is correct. Do not look at any repository. Give one level per key and a one-sentence reason naming the consequence and the definition clause it falls under.

<Definitions>
${DEFS}
</Definitions>

${batch.map(({ key, it }) => `### ${key}\nFile: ${it.finding.relevantFile}${it.finding.relevantLinesStart ? `, lines ${it.finding.relevantLinesStart}-${it.finding.relevantLinesEnd ?? it.finding.relevantLinesStart}` : ''}\nComment: ${it.finding.suggestionContent.trim()}`).join('\n\n')}
`;

function run(batch) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-astra-'));
    fs.writeFileSync(path.join(tmp, 'schema.json'), JSON.stringify(SCHEMA));
    fs.writeFileSync(path.join(tmp, 'prompt.txt'), prompt(batch));
    return new Promise((resolve) => {
        const p = spawn('bash', ['-c', `codex exec --skip-git-repo-check --sandbox read-only -m gpt-6-astra -c model_reasoning_effort=high -C "${tmp}" --output-schema "${tmp}/schema.json" -o "${tmp}/out.json" - < "${tmp}/prompt.txt" > "${tmp}/log.txt" 2>&1`]);
        p.on('close', () => {
            let n = 0;
            try {
                const byKey = new Map(batch.map((b) => [b.key, b.it.issueId]));
                for (const x of JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8')).items) {
                    if (!byKey.has(x.key)) continue;
                    done[byKey.get(x.key)] = { severity: x.severity, reason: x.reason };
                    n++;
                }
                fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
            } catch {}
            console.log(`${n === batch.length ? 'ok  ' : 'FAIL'} ${batch[0].key}.. ${n}/${batch.length}`);
            fs.rmSync(tmp, { recursive: true, force: true });
            resolve(n === batch.length);
        });
    });
}

(async () => {
    // Shuffled by a fixed hash so a batch mixes PRs and levels; keys say nothing about either.
    const todo = items.filter((it) => !done[it.issueId]).map((it) => ({ it, h: require('crypto').createHash('sha256').update(it.issueId).digest('hex') })).sort((a, b) => (a.h < b.h ? -1 : 1)).map(({ it }, i) => ({ key: `c${String(i).padStart(3, '0')}`, it }));
    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    console.log(`items to label: ${todo.length}, batches: ${batches.length}`);
    let i = 0, fail = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < batches.length) if (!(await run(batches[i++]))) fail++;
    }));
    console.log(`done, labelled: ${Object.keys(done).length}/${items.length}, failed batches: ${fail}`);
    process.exit(fail ? 1 : 0);
})();
