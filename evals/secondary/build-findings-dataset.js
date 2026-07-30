// Build shared secondary-pass datasets from a finder-recall result JSON
// (promptfoo output of evals/investigation). Each PR case carries findings +
// goldenComments. Output shape is shared by dedup / severity / format evals:
//
//   { prId, goldenComments: string[], findings: object[] }
//
//   node evals/secondary/build-findings-dataset.js [/tmp/recall-new-g3.json]
//   node evals/secondary/build-findings-dataset.js --out=evals/dedup/datasets ...
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : ['_src', a];
    }),
);

const SRC = args._src || '/tmp/recall-new-g3.json';
const OUT = path.resolve(
    args.out || path.join(__dirname, 'datasets'),
);

function parseFindings(output) {
    let o = output;
    if (typeof o === 'string') {
        try {
            o = JSON.parse(o);
        } catch {
            return [];
        }
    }
    if (Array.isArray(o)) return o;
    if (Array.isArray(o?.findings)) return o.findings;
    if (Array.isArray(o?.suggestions)) return o.suggestions;
    return [];
}

function main() {
    if (!fs.existsSync(SRC)) {
        console.error(`source missing: ${SRC}`);
        process.exit(2);
    }
    const r = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const results = r.results?.results || r.results || [];
    fs.mkdirSync(OUT, { recursive: true });
    let written = 0;
    let totFindings = 0;
    let multi = 0;
    for (const res of results) {
        const vars = res.vars || res.testCase?.vars || {};
        const prId = (vars.caseId || vars.datasetFile || vars.id || '')
            .toString()
            .replace(/\.json$/, '');
        if (!prId) continue;
        let goldensRaw = vars.goldenComments;
        if (typeof goldensRaw === 'string') {
            try {
                goldensRaw = JSON.parse(goldensRaw);
            } catch {
                goldensRaw = [];
            }
        }
        const goldens = (Array.isArray(goldensRaw) ? goldensRaw : []).map((g) =>
            typeof g === 'string' ? g : g.comment,
        );
        const findings = parseFindings(res.response?.output);
        if (!goldens.length && !findings.length) continue;
        fs.writeFileSync(
            path.join(OUT, prId + '.json'),
            JSON.stringify({ prId, goldenComments: goldens, findings }, null, 2),
        );
        written++;
        totFindings += findings.length;
        if (findings.length >= 2) multi++;
    }
    console.log(`wrote ${written} PR datasets → ${OUT}`);
    console.log(
        `  total findings: ${totFindings} · PRs with >=2 findings: ${multi}`,
    );
}

main();
