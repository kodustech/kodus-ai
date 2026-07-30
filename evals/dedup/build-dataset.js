// Build dedup-eval datasets from a finder-recall result JSON (promptfoo output
// of evals/investigation). Each PR case there already carries the finder's
// findings (response.output) and the PR's goldenComments (vars). We extract
// {prId, findings, goldenComments} per PR so the dedup eval can run without
// re-running the finder. Seed source defaults to the gemini-3-flash NEW-engine
// run; override with argv[2].
//
//   node build-dataset.js [/tmp/recall-new-g3.json]
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/tmp/recall-new-g3.json';
const OUT = path.join(__dirname, 'datasets');

function parseFindings(output) {
    let o = output;
    if (typeof o === 'string') {
        try { o = JSON.parse(o); } catch { return []; }
    }
    if (Array.isArray(o)) return o;
    if (Array.isArray(o?.findings)) return o.findings;
    if (Array.isArray(o?.suggestions)) return o.suggestions;
    return [];
}

function main() {
    const r = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const results = r.results?.results || r.results || [];
    fs.mkdirSync(OUT, { recursive: true });
    let written = 0, totFindings = 0, multi = 0;
    for (const res of results) {
        const vars = res.vars || res.testCase?.vars || {};
        const prId = (vars.caseId || vars.datasetFile || vars.id || '')
            .toString().replace(/\.json$/, '');
        if (!prId) continue;
        // goldenComments is stored as a JSON string in the recall result.
        let goldensRaw = vars.goldenComments;
        if (typeof goldensRaw === 'string') {
            try { goldensRaw = JSON.parse(goldensRaw); } catch { goldensRaw = []; }
        }
        const goldens = (Array.isArray(goldensRaw) ? goldensRaw : []).map((g) =>
            typeof g === 'string' ? g : g.comment,
        );
        const findings = parseFindings(res.response?.output);
        if (!goldens.length) continue; // nothing to score against
        fs.writeFileSync(
            path.join(OUT, prId + '.json'),
            JSON.stringify({ prId, goldenComments: goldens, findings }, null, 2),
        );
        written++; totFindings += findings.length;
        if (findings.length >= 2) multi++;
    }
    console.log(`wrote ${written} PR datasets → ${OUT}`);
    console.log(`  total findings: ${totFindings} · PRs with >=2 findings (dedup-relevant): ${multi}`);
}

main();
