#!/usr/bin/env node
/**
 * Translates the review page's suggestions to pt-BR (summary + full text), one
 * call per (model, PR), cached in translations/. Code, identifiers and paths
 * stay as they are. Adds summaryPt/contentPt to the review data file.
 *
 *   node evals/dedup/gold/review/translate.js --scope=pilot [--par=4]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const SCOPE = arg('scope', 'pilot');
const PAR = Number(arg('par', '4'));
const dataFile = path.join(__dirname, `${SCOPE}.json`);
const cacheDir = path.join(__dirname, 'translations');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'summaryPt', 'contentPt'], properties: { id: { type: 'string' }, summaryPt: { type: 'string' }, contentPt: { type: 'string' } } } } },
};

function claude(prompt) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) delete env[k];
        const p = spawn('claude', ['-p', '--model', 'claude-sonnet-5-5', '--effort', 'low', '--tools', '', '--output-format', 'json',
            '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--setting-sources', '',
            '--system-prompt', 'You translate code review comments from English to Brazilian Portuguese. Answer only with the requested JSON.'], { env, cwd: os.tmpdir() });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => {
            if (code !== 0) return reject(new Error(`claude exit ${code}: ${(err || out).slice(-400)}`));
            try {
                const r = JSON.parse(out);
                if (r.is_error) return reject(new Error(String(r.result).slice(0, 400)));
                resolve(r.structured_output ?? JSON.parse(r.result));
            } catch (e) {
                reject(e);
            }
        });
        p.stdin.end(prompt);
    });
}

async function translateUnit(u) {
    const file = path.join(cacheDir, `${u.key}.json`);
    const cached = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const todo = u.suggestions.filter((s) => !cached[s.id]);
    if (!todo.length) return cached;
    const payload = todo.map((s) => ({ id: s.id, summary: s.summary, content: s.content }));
    const prompt = `Translate each item's "summary" and "content" to Brazilian Portuguese (pt-BR). Keep code, code blocks, identifiers, file paths, function names, API names and technical terms usually kept in English (e.g. race condition, null check, cache) exactly as they are. Keep the structure, line breaks and markdown. Keep labels like WHAT/WHY/FIX translated as O QUÊ/POR QUÊ/CORREÇÃO. An empty summary stays empty. Return one item per id.\n\n${JSON.stringify(payload, null, 1)}`;
    let errs = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await claude(prompt + (errs.length ? `\n\nPrevious answer was missing ids: ${errs.join(', ')}` : ''));
        for (const it of r.items || []) if (todo.some((s) => s.id === it.id)) cached[it.id] = { summaryPt: it.summaryPt, contentPt: it.contentPt };
        errs = todo.filter((s) => !cached[s.id]).map((s) => s.id);
        if (!errs.length) break;
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cached, null, 1));
    if (errs.length) throw new Error(`missing translations: ${errs.join(', ')}`);
    return cached;
}

(async () => {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    let i = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < data.units.length) {
            const u = data.units[i++];
            try {
                const tr = await translateUnit(u);
                for (const s of u.suggestions) Object.assign(s, tr[s.id] || {});
                console.log(`${u.key}: ok`);
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
