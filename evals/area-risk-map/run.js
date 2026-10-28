#!/usr/bin/env node
// Temporal ranking: earlier PR evidence predicts the direct directories touched
// by later bugfix PRs. No future data enters the map.
const fs = require('node:fs');
const path = require('node:path');
const { registerTs } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

registerTs();
const {
    buildCodeAreaRiskMap,
    rankCodeAreas,
} = require('../../libs/platformData/domain/code-area-risk/build-area-risk-map.ts');

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
        return match ? [match[1], match[2] ?? true] : [arg, true];
    }),
);
const set = args.set || 'holdout-2026';
if (!['development', 'holdout', 'holdout-2026'].includes(set)) {
    console.error(`not measured: unknown set ${set}`);
    process.exit(2);
}
const input = path.join(
    __dirname,
    set === 'holdout-2026'
        ? 'cases-holdout-2026.json'
        : set === 'holdout'
          ? 'cases-holdout.json'
          : 'cases.json',
);
const floor = require('./targets.json').floor;

function directoryOf(file) {
    const slash = file.lastIndexOf('/');
    return slash < 0 ? '.' : file.slice(0, slash);
}

function topAreas(map, basis) {
    return new Set(
        rankCodeAreas(map.directDirectories, basis)
            .slice(0, Math.ceil(map.directDirectories.length * 0.2))
            .map((area) => area.path),
    );
}

function evaluate(data) {
    const maps = new Map();
    const repos = [...new Set(data.targets.map((target) => target.repository))];
    for (const repo of repos) {
        const history = data.history.filter((pr) => pr.repository === repo);
        maps.set(
            repo,
            buildCodeAreaRiskMap({
                source: 'GITHUB',
                windowStart: data.historyWindow[0],
                windowEnd: data.historyWindow[1],
                refreshedAt: data.historyWindow[1],
                discoveredMergedPrs: history.length,
                scanComplete: false,
                pullRequests: history.map((pr) => ({
                    ...pr,
                    url: pr.url,
                    linkedBugIssues: pr.linkedBugIssues || [],
                })),
            }),
        );
    }
    const rows = [];
    for (const target of data.targets) {
        if (
            (set === 'holdout-2026' && !target.linkedBugIssues?.length) ||
            !target.filesComplete ||
            !target.files?.length ||
            Date.parse(target.mergedAt) < Date.parse(data.historyWindow[1])
        )
            continue;
        const map = maps.get(target.repository);
        const parents = new Set(target.files.map(directoryOf));
        const riskTop = topAreas(map, 'bug-evidence');
        const churnTop = topAreas(map, 'churn');
        const hits = [...parents].filter((area) => riskTop.has(area)).length;
        const churnHits = [...parents].filter((area) => churnTop.has(area)).length;
        const known = [...parents].some((area) =>
            map.directDirectories.some((record) => record.path === area),
        );
        rows.push({
            id: target.id,
            checks: 'What share of directories touched by this linked bugfix PR appear in the prior top 20%?',
            hits,
            total: parents.size,
            detail: [
                {
                    what: `bug evidence ${hits}/${parents.size}; churn ${churnHits}/${parents.size}; known area ${known}`,
                    ok: hits > 0,
                },
            ],
            metadata: {
                repository: target.repository,
                churnHits,
                known,
                files: target.files.length,
            },
        });
    }
    return rows;
}

function main() {
    if (!fs.existsSync(input)) {
        console.error('not measured: no frozen temporal corpus');
        return 2;
    }
    const data = JSON.parse(fs.readFileSync(input, 'utf8'));
    const rows = evaluate(data);
    if (rows.length < 200) {
        console.error(
            `not measured: only ${rows.length} fully listed held-out PRs (need 200)`,
        );
        return 2;
    }
    const hits = rows.reduce((sum, row) => sum + row.hits, 0);
    const totalAreas = rows.reduce((sum, row) => sum + row.total, 0);
    const churnHits = rows.reduce((sum, row) => sum + row.metadata.churnHits, 0);
    const known = rows.filter((row) => row.metadata.known).length;
    const result = {
        eval: 'area-risk-map',
        question: evalQuestion('evals/area-risk-map'),
        model: 'none',
        runs: 1,
        metric: {
            name: 'later linked bugfix PR directory recall at top 20%',
            value: hits / totalAreas,
            floor: floor ?? null,
            baseline: churnHits / totalAreas,
        },
        cases: rows,
        tokens: {
            in: 0,
            out: 0,
            cacheRead: 0,
            cacheWrite: 0,
            calls: 0,
            ms: 0,
            callMs: [],
        },
        infra: { errored: 0, total: rows.length },
        temporal: {
            set,
            historyWindow: data.historyWindow,
            targetsStart: data.historyWindow[1],
            knownAreaCases: known,
            source: data.source,
            historySampled: true,
            targetEvidence:
                set === 'holdout-2026'
                    ? 'linked bug-labeled issue'
                    : 'PR bug label',
        },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), {
            recursive: true,
        });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(
        `area-risk-map: ${hits}/${totalAreas} bug evidence; ${churnHits}/${totalAreas} churn; ${known}/${rows.length} targets touch known areas`,
    );
    if (resultProblems(result).length) return 2;
    if (args.gate && floor != null && result.metric.value < floor) return 1;
    return 0;
}

try {
    process.exit(main());
} catch (error) {
    console.error(error);
    process.exit(2);
}
