const fs = require('fs');
const base = __dirname + '/results';
const dir = base + '/h8b-r01/langfuse';

// prNumber -> generalist trace
const byPr = {};
for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === '_summary.json') continue;
    const j = require(dir + '/' + f);
    if (!Array.isArray(j.agents) || j.agents.length === 0) continue;
    const a = j.agents.find((x) => /generalist/i.test(x.name)) || j.agents[0];
    if (!a) continue;
    byPr[j.prNumber] = {
        f,
        reasoning: a.reasoning || '',
        steps: JSON.stringify(a.steps || []),
        files: (a.filesRead || []).join(' '),
        findings: (a.findings || []).length,
    };
}
// head -> prNumber via candidates-all.json (same PR set)
const cand = require(base + '/h8b-r01/candidates-all.json');
const headToPr = {};
for (const c of cand) headToPr[c.head] = c.prNumber;

const runs = ['ergo-r01', 'hv2-r01', 'hv2-r02', 'h7-r01', 'h7-r02', 'h8-r01', 'h8b-r01'];
function fset(run) {
    const f = base + '/' + run + '-funnel/match-matrix.json';
    if (!fs.existsSync(f)) return new Set();
    const m = require(f);
    const s = new Set();
    m.forEach((pr, pi) => (pr || []).forEach((c) => { if (c.match) s.add(pi + ':' + c.gi); }));
    return s;
}
const ever = new Set();
runs.forEach((r) => fset(r).forEach((x) => ever.add(x)));

function kws(t) {
    const set = new Set();
    (t.match(/`[^`]+`/g) || []).forEach((x) => set.add(x.replace(/`/g, '')));
    (t.match(/\b[a-z]+[A-Z][a-zA-Z]+\b/g) || []).forEach((x) => set.add(x));
    (t.match(/\b[a-z]+_[a-z_]+\b/g) || []).forEach((x) => set.add(x));
    (t.match(/\b[A-Z][a-zA-Z]{4,}\b/g) || []).forEach((x) => set.add(x));
    return [...set].filter((x) => x.length >= 4).slice(0, 8);
}

const g = require(base + '/h8b-r01/golden.json');
const rows = [];
g.forEach((pr, pi) => {
    (pr.golden_comments || []).forEach((c, gi) => {
        const k = pi + ':' + gi;
        if (ever.has(k)) return;
        const repo = pr.repo.split('/').pop();
        const t = byPr[headToPr[pr.head]];
        if (!t) { rows.push({ k, repo, sev: c.severity, mode: 'NO-TRACE', sig: '-', txt: c.comment.slice(0, 52) }); return; }
        const terms = kws(c.comment);
        const inReason = terms.filter((w) => t.reasoning.includes(w));
        const inSteps = terms.filter((w) => t.steps.includes(w) || t.files.includes(w));
        let mode;
        if (inReason.length > 0) mode = 'analyzed';
        else if (inSteps.length > 0) mode = 'read-not-reasoned';
        else mode = 'attention';
        rows.push({ k, repo, sev: c.severity, mode, sig: inReason[0] || inSteps[0] || '-', txt: c.comment.slice(0, 52) });
    });
});

console.log('mode'.padEnd(18) + 'sev'.padEnd(9) + 'repo'.padEnd(13) + 'signal'.padEnd(20) + '| golden');
for (const r of rows) {
    console.log(r.mode.padEnd(18) + r.sev.padEnd(9) + r.repo.padEnd(13) + String(r.sig).slice(0, 18).padEnd(20) + '| ' + r.txt);
}
const cnt = {};
rows.forEach((r) => (cnt[r.mode] = (cnt[r.mode] || 0) + 1));
console.log('\nRESUMO:', JSON.stringify(cnt), 'total=' + rows.length);
