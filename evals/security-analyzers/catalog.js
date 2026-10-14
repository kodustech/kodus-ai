// Cases: the samples of the dataset llm-vs-analyzers.js reads by default (scripts/security-benchmark/dataset.json), one group per CWE class plus the noise tranche, and the lockfile PRs refutation.js reads.
const fs = require('fs');
const path = require('path');

const MAX = 160;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const source = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

// The dataset path as llm-vs-analyzers.js declares its default.
function datasetPath() {
    const m = source('llm-vs-analyzers.js').match(/args\.dataset\s*\|\|\s*path\.join\(__dirname,\s*['"]([^'"]+)['"]\)/);
    if (!m) throw new Error('llm-vs-analyzers.js: no default --dataset');
    return path.join(__dirname, m[1]);
}

function samplesCatalog() {
    const data = JSON.parse(fs.readFileSync(datasetPath(), 'utf8'));
    const all = Array.isArray(data) ? data : Object.values(data).find(Array.isArray) || [];
    const groups = new Map();
    for (const s of all) {
        const key = s.tranche === 'vuln' ? s.cweLabel || (s.cwes || [])[0] || 'unlabelled' : s.tranche;
        if (!groups.has(key)) groups.set(key, { tranche: s.tranche, samples: [] });
        groups.get(key).samples.push(s);
    }
    return [...groups].map(([key, { tranche, samples }]) => {
        const n = samples.length;
        if (tranche !== 'vuln') {
            return {
                id: tranche,
                group: tranche,
                count: n,
                checks: clip(`Checks that the LLM reviewer and the analyzers stay quiet on ${n} ${tranche} samples: code that only looks dangerous`),
            };
        }
        const published = samples.every((s) => s.source && s.source.advisory);
        const what = published ? `published ${key} advisories` : `synthetic ${key} samples`;
        const langs = [...new Set(samples.map((s) => s.language).filter(Boolean))].join(', ');
        let checks = `Checks whether an analyzer catches any of ${n} ${what} (${langs}) the LLM reviewer misses`;
        if (checks.length > MAX) checks = `Checks whether an analyzer catches any of ${n} ${what} the LLM reviewer misses`;
        return { id: `vuln:${slug(key)}`, group: key, count: n, checks: clip(checks) };
    });
}

// refutation.js: the lockfile PRs of scripts/analyzer-prevalence/result.json,
// filtered and capped exactly as the script does.
function refutationCatalog() {
    const src = source('refutation.js');
    const m = src.match(/require\(['"]([^'"]*analyzer-prevalence\/result\.json)['"]\)/);
    if (!m) return [];
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, m[1]), 'utf8')).rows
        .filter((r) => !r.skipped && !r.fork && !r.archived && (r.fired || []).includes('dependencies'));
    const limit = Number((src.match(/args\.limit\s*\|\|\s*(\d+)/) || [])[1]) || rows.length;
    const n = Math.min(limit, rows.length);
    return [{
        id: 'refutation:lockfile-prs',
        group: 'dependency claims',
        count: n,
        checks: clip(`Checks how many package-advisory claims the LLM reviewer makes on ${n} real lockfile PRs that an OSV lookup refutes`),
    }];
}

function catalog() {
    return [...samplesCatalog(), ...refutationCatalog()];
}

module.exports = { catalog };
