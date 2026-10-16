// Cases: the samples run-stage.js runs (scripts/security-benchmark/dataset.json),
// one group per CWE class of the vuln tranche, the planted secrets, and the
// noise tranche.
const MAX = 160;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function catalog() {
    const { samples } = require('../../scripts/security-benchmark/dataset.json');
    const groups = new Map();
    for (const s of samples) {
        const key = s.tranche === 'noise' ? 'noise' : s.id.startsWith('secret-') ? 'planted secrets' : s.cweLabel || (s.cwes || [])[0] || 'unlabelled';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
    }
    return [...groups].map(([key, list]) => {
        const n = list.length;
        if (key === 'noise') return { id: 'noise', group: 'noise', count: n, checks: clip(`Stays quiet on ${n} samples that only look like secrets or vulnerabilities`) };
        if (key === 'planted secrets') return { id: 'vuln:planted-secrets', group: key, count: n, checks: clip(`Flags each of ${n} synthetic credentials committed in a diff`) };
        const langs = [...new Set(list.map((s) => s.language).filter(Boolean))].join(', ');
        return { id: `vuln:${slug(key)}`, group: key, count: n, checks: clip(`Flags the vulnerable lines of ${n} published ${key} advisories (${langs}) with the analyzers production ships`) };
    });
}

module.exports = { catalog };
