#!/usr/bin/env node
/**
 * Second check for every suggestion the gold marks as unique: GPT-6 Astra
 * compares it against every other suggestion of the same (model, PR) and
 * names any possible duplicate, with the reason in pt-BR. Cached in
 * second-check/; adds `secondCheck` to each unique in the review data file.
 *
 *   node evals/dedup/gold/review/second-check.js --scope=pilot [--par=4]
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
const SCOPE = arg('scope', 'pilot');
const PAR = Number(arg('par', '4'));
const dataFile = path.join(__dirname, `${SCOPE}.json`);
const cacheDir = path.join(__dirname, 'second-check');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['checks'],
    properties: { checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'candidates'], properties: {
        id: { type: 'string' },
        candidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'likelihood', 'reasonPt'], properties: {
            id: { type: 'string' },
            likelihood: { type: 'string', enum: ['likely_duplicate', 'borderline'] },
            reasonPt: { type: 'string' },
        } } },
    } } } },
};

function codex(prompt) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'second-check-'));
    const schemaFile = path.join(tmp, 'schema.json');
    const outFile = path.join(tmp, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    return new Promise((resolve, reject) => {
        const p = spawn('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high',
            '--output-schema', schemaFile, '-o', outFile, '-'], { cwd: tmp });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.stdout.on('data', () => {});
        p.on('close', (code) => {
            try {
                if (code !== 0) throw new Error(`codex exit ${code}: ${err.slice(-400)}`);
                resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
            } catch (e) {
                reject(e);
            } finally {
                fs.rmSync(tmp, { recursive: true, force: true });
            }
        });
        p.stdin.end(prompt);
    });
}

const RULES = fs.readFileSync(path.join(__dirname, '..', 'judge-prompt.md'), 'utf8').split('# Confidence')[0];

async function checkUnit(u) {
    const uniques = u.unique.map((x) => x.id);
    const key = crypto.createHash('sha1').update(u.suggestions.map((s) => s.id).join('|') + '#' + uniques.join('|')).digest('hex').slice(0, 10);
    const file = path.join(cacheDir, `${u.key}.json`);
    const cached = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (cached?.key === key) return cached.checks;
    if (!uniques.length) return {};
    const list = u.suggestions.map((s) => `### ${s.id}\nFile: ${s.file} (lines ${s.start}-${s.end})\n${s.summary ? `Summary: ${s.summary}\n` : ''}${s.content}`).join('\n\n');
    const prompt = `${RULES}
# Your task

A previous labeling pass marked some suggestions of this PR as unique (no duplicate). Double-check each of them: compare it against EVERY other suggestion below, one by one, and list any that could describe the same defect under the rules above.

- likely_duplicate: you believe it is the same defect.
- borderline: a reasonable reviewer could call it the same defect.
- Do not list suggestions that are clearly different defects.
- reasonPt: one or two sentences in Brazilian Portuguese explaining the overlap (keep code identifiers as they are).

Return one entry per suggestion to check, with an empty candidates list when nothing overlaps.

Suggestions to check: ${uniques.join(', ')}

# All suggestions of this PR (${u.suggestions.length})

${list}
`;
    const ids = new Set(u.suggestions.map((s) => s.id));
    let r;
    for (let attempt = 1; attempt <= 3; attempt++) {
        r = await codex(prompt);
        const got = new Set(r.checks.map((c) => c.id));
        if (uniques.every((id) => got.has(id)) && r.checks.every((c) => c.candidates.every((x) => ids.has(x.id) && x.id !== c.id))) break;
        if (attempt === 3) throw new Error('invalid answer after 3 attempts');
    }
    const checks = Object.fromEntries(r.checks.filter((c) => uniques.includes(c.id)).map((c) => [c.id, c.candidates]));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key, checks }, null, 1));
    return checks;
}

(async () => {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    let i = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < data.units.length) {
            const u = data.units[i++];
            try {
                const checks = await checkUnit(u);
                for (const x of u.unique) x.secondCheck = checks[x.id] || [];
                const n = u.unique.filter((x) => x.secondCheck.length).length;
                console.log(`${u.key}: ${u.unique.length} unique, ${n} with possible duplicates`);
            } catch (e) {
                failed++;
                console.log(`${u.key}: FAILED ${e.message}`);
            }
        }
    }));
    fs.writeFileSync(dataFile, JSON.stringify(data));
    console.log(`done, ${failed} failed`);
    process.exit(failed ? 2 : 0);
})();
