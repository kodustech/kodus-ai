// Cases: every detector rule in evals/kody-rules/detectors-*.json, run by detector-fp-repro.js over its corpus (the --corpus its __doc names, else the script's default).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'kody-rules');
const MAX = 160;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

// The default corpus as the repro script declares it (`args.corpus || '…'`).
function defaultCorpus() {
    const source = fs.readFileSync(path.join(DIR, 'detector-fp-repro.js'), 'utf8');
    const m = source.match(/args\.corpus\s*\|\|\s*['"]([^'"]+)['"]/);
    if (!m) throw new Error('detector-fp-repro.js: no default --corpus');
    return m[1];
}

// The corpus file: `<name>.json`, or its committed `<name>-with-content.json`
// copy when the harvested file (gitignored) is absent on this checkout.
function corpusStats(name) {
    const file = [`${name}.json`, `${name}-with-content.json`].find((f) => fs.existsSync(path.join(DIR, f)));
    if (!file) return null;
    const cases = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const prs = new Set(cases.map((c) => String(c.caseId || c.source || '').split('::')[0]));
    const files = cases.reduce((n, c) => n + (c.realChangedFiles || c.changedFiles || []).length, 0);
    return { prs: prs.size, files };
}

function catalog() {
    const fallback = defaultCorpus();
    const entries = [];
    for (const file of fs.readdirSync(DIR).filter((f) => /^detectors-.*\.json$/.test(f)).sort()) {
        const seed = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
        const doc = [].concat(seed.__doc || []).join('\n');
        const rules = (Array.isArray(seed) ? seed : seed.detectors || []).filter((r) => r && r.detector);
        const corpus = (doc.match(/--corpus=([\w-]+)/) || [])[1] || fallback;
        const stats = corpusStats(corpus);
        const where = stats ? `${stats.prs} real PRs (${stats.files} files)` : `the ${corpus} corpus`;
        const positiveControl = /positive control/i.test(doc);
        for (const rule of rules) {
            const lang = rule.language;
            const checks = positiveControl
                ? `Still publishes the real hits of the detector "${rule.title}" after judging, across ${where} (positive control)`
                : `Keeps the ${lang ? `${lang}-only ` : ''}detector "${rule.title}" from commenting on ${lang ? `non-${lang}` : 'out-of-scope'} files across ${where}`;
            entries.push({ id: `${file.replace(/\.json$/, '')}:${rule.uuid}`, checks: clip(checks) });
        }
    }
    return entries;
}

module.exports = { catalog };
