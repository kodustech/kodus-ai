const fs = require('fs');
const base = __dirname + '/results';

function load(f) { return fs.existsSync(f) ? require(f) : null; }
function goldsCaught(mm) {
    const s = new Set();
    mm.forEach((pr, pi) => (pr || []).forEach((c) => { if (c.match) s.add(pi + ':' + c.gi); }));
    return s;
}
// count distinct candidates per matrix (by pr+ci)
function candCount(mm) {
    let n = 0;
    mm.forEach((pr) => { const s = new Set(); (pr || []).forEach((c) => s.add(c.ci)); n += s.size; });
    return n;
}

for (const run of ['stance-r01', 'stance-r02', 'stance2-r01']) {
    const funnel = load(`${base}/${run}-funnel/match-matrix.json`);
    const sent = load(`${base}/${run}/match-matrix.json`);
    const cand = load(`${base}/${run}/candidates-all.json`);
    if (!funnel || !sent) { console.log(run, 'missing'); continue; }

    const gFunnel = goldsCaught(funnel);
    const gSent = goldsCaught(sent);
    const leaked = [...gFunnel].filter((k) => !gSent.has(k));

    // safeguard kill stats from candidates-all (post-verify pool)
    const iss = (cand || []).flatMap((pr) => pr.issues || []);
    const sg = iss.filter((i) => i.killedBy === 'safeguard-llm').length;

    console.log(`\n=== ${run} ===`);
    console.log(`  candidatos: funnel-pool=${candCount(funnel)}  sent-pool=${candCount(sent)}  candidates-all=${iss.length} (safeguard-killed=${sg})`);
    console.log(`  finder-goldens=${gFunnel.size}  delivered-goldens=${gSent.size}  VAZARAM=${leaked.length}`);

    // attribute each leaked golden: matching candidate in funnel; is it in sent pool?
    for (const k of leaked) {
        const [pi, gi] = k.split(':').map(Number);
        // find candidate index that matched this golden in funnel
        const cis = (funnel[pi] || []).filter((c) => c.gi === gi && c.match).map((c) => c.ci);
        // was any of those ci present (matched or not) in the sent matrix for this PR?
        const sentCis = new Set((sent[pi] || []).map((c) => c.ci));
        const survivedToSent = cis.some((ci) => sentCis.has(ci));
        const g = load(`${base}/${run}/golden.json`);
        const txt = ((g[pi].golden_comments || [])[gi] || {}).comment || '';
        const sev = ((g[pi].golden_comments || [])[gi] || {}).severity || '?';
        // heuristic: if the matched candidate count in sent pool for this PR < funnel, it died pre-sent.
        console.log(`    leak ${k} [${sev}] ${g[pi].repo.split('/').pop()}: ${txt.slice(0, 55)}`);
    }
}
