const fs = require('fs');
const base = __dirname + '/results';
const RUN = process.argv[2] || 'kimi-r02';
const dir = base + '/' + RUN + '/langfuse';

const byPr = {};
for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === '_summary.json') continue;
    const j = require(dir + '/' + f);
    if (!Array.isArray(j.agents) || j.agents.length === 0) continue;
    const a = j.agents.find((x) => /generalist/i.test(x.name)) || j.agents[0];
    if (!a) continue;
    byPr[j.prNumber] = { reasoning: a.reasoning || '', steps: JSON.stringify(a.steps || []), files: (a.filesRead || []).join(' ') };
}
const cand = require(base + '/' + RUN + '/candidates-all.json');
const headToPr = {}; for (const c of cand) headToPr[c.head] = c.prNumber;

function fset(run) { const f = base + '/' + run + '-funnel/match-matrix.json'; if (!fs.existsSync(f)) return new Set(); const m = require(f); const s = new Set(); m.forEach((pr, pi) => (pr || []).forEach((c) => { if (c.match) s.add(pi + ':' + c.gi); })); return s; }
const caught = fset(RUN);

function kws(t) {
    const set = new Set();
    (t.match(/`[^`]+`/g) || []).forEach((x) => set.add(x.replace(/`/g, '')));
    (t.match(/\b[a-z]+[A-Z][a-zA-Z]+\b/g) || []).forEach((x) => set.add(x));
    (t.match(/\b[a-z]+_[a-z_]+\b/g) || []).forEach((x) => set.add(x));
    (t.match(/\b[A-Z][a-zA-Z]{4,}\b/g) || []).forEach((x) => set.add(x));
    return [...set].filter((x) => x.length >= 4).slice(0, 8);
}
const g = require(base + '/' + RUN + '/golden.json');
const cnt = {};
const rows = [];
g.forEach((pr, pi) => {
    (pr.golden_comments || []).forEach((c, gi) => {
        const k = pi + ':' + gi; if (caught.has(k)) return;
        const repo = pr.repo.split('/').pop();
        const t = byPr[headToPr[pr.head]];
        let mode, sig='-';
        if (!t) mode = 'NO-TRACE';
        else { const terms = kws(c.comment); const inR = terms.filter((w) => t.reasoning.includes(w)); const inS = terms.filter((w) => t.steps.includes(w) || t.files.includes(w));
            if (inR.length) { mode = 'analyzed-missed'; sig=inR[0]; } else if (inS.length) { mode = 'read-not-reasoned'; sig=inS[0]; } else mode = 'attention'; }
        cnt[mode] = (cnt[mode] || 0) + 1;
        rows.push({ k, repo, sev: c.severity, mode, sig, txt: c.comment.slice(0, 56) });
    });
});
console.log('RUN=' + RUN + '  goldens perdidos=' + rows.length + '/52\n');
for (const r of rows) console.log('  ' + r.mode.padEnd(18) + '[' + r.sev + ']'.padEnd(9) + r.repo.padEnd(12) + String(r.sig).slice(0,16).padEnd(17) + '| ' + r.txt);
console.log('\nRESUMO:', JSON.stringify(cnt));
