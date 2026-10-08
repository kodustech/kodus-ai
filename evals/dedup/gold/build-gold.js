#!/usr/bin/env node
/**
 * Builds one unlabeled gold file per model from the finder output (the heavysv
 * pools: G + M3, before dedup). Suggestions are copied as they are, plus a
 * stable id. Re-running keeps every id and any labels already present.
 *
 *   node evals/dedup/gold/build-gold.js [--only=<model>]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INV = path.join(__dirname, '..', '..', 'investigation');
const OUT = __dirname;

const MODELS = [
    { model: 'deepseek-v4.1-flash', route: 'together', pool: '01.10.26_f1_deepseek_together-heavysv' },
    { model: 'kimi-k3', route: 'together', pool: '01.10.26_f1_kimi3_together-heavysv' },
    { model: 'muse-spark-1.2', route: 'meta', pool: '01.10.26_f2_muse-heavysv' },
    { model: 'gpt-6.1-sol', route: 'codex-subscription', pool: '01.10.26_f2_gpt61_sub-heavysv' },
    { model: 'sonnet-5.5', route: 'agent-sdk-subscription', pool: '01.10.26_f2_sonnet55_sdk-heavysv' },
    { model: 'opus-5.5', route: 'claude-code-subscription', pool: '01.10.26_f2_opus55_cc-heavysv' },
    { model: 'glm-5.3', route: 'together', pool: '01.10.26_f2_glm53_together-heavysv' },
];

// Fields the dedup sees. existingCode/improvedCode stay out: the dedup does not use them.
const KEEP = ['producedBy', 'label', 'relevantFile', 'relevantLinesStart', 'relevantLinesEnd', 'oneSentenceSummary', 'suggestionContent'];

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const LABELS = ['isDuplicate', 'duplicateIds', 'groupId', 'needsUnifiedComment', 'partialOverlapWith'];

const cases = JSON.parse(fs.readFileSync(path.join(INV, 'light-30.json'), 'utf8'));
const only = arg('only');

for (const m of MODELS) {
    if (only && only !== m.model) continue;
    const file = path.join(OUT, `${m.model}.json`);
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const gold = { model: m.model, route: m.route, sourcePool: m.pool, labelVersion: 1, prs: {} };
    let total = 0;
    for (const caseId of cases) {
        const raw = fs.readFileSync(path.join(INV, 'pools', m.pool, `${caseId}.raw.txt`), 'utf8');
        const cands = JSON.parse(raw).trace.preFilterCandidates || [];
        const seen = new Set();
        const suggestions = cands.map((c, i) => {
            const id = `s_${sha(`${caseId}|${i}|${c.suggestionContent || ''}`).slice(0, 8)}`;
            if (seen.has(id)) throw new Error(`id collision ${id} in ${m.model}/${caseId}`);
            seen.add(id);
            const s = { id, sourceIndex: i };
            for (const k of KEEP) if (c[k] !== undefined && c[k] !== '') s[k] = c[k];
            if (s.relevantLinesStart !== undefined) s.relevantLinesStart = Number(s.relevantLinesStart);
            if (s.relevantLinesEnd !== undefined) s.relevantLinesEnd = Number(s.relevantLinesEnd);
            const old = prev?.prs?.[caseId]?.suggestions?.find((x) => x.id === id);
            for (const k of LABELS) if (old && old[k] !== undefined) s[k] = old[k];
            return s;
        });
        const old = prev?.prs?.[caseId];
        gold.prs[caseId] = {
            sourceSha: sha(raw),
            suggestions,
            groups: old?.groups || [],
            uniqueConfidence: old?.uniqueConfidence || {},
        };
        total += suggestions.length;
    }
    fs.writeFileSync(file, `${JSON.stringify(gold, null, 2)}\n`);
    console.log(`${m.model}: ${total} suggestions, ${cases.length} PRs -> ${path.relative(process.cwd(), file)}`);
}
process.exit(0);
