#!/usr/bin/env node
/**
 * Warms the call-graph cache for a whole case set, so the eval run itself never
 * pays for a `parse --all` (30s on cal.com, ~6min on keycloak).
 *
 * Usage:
 *   node evals/investigation/prebuild-callgraphs.js [--set=light] [--case=<id>]
 */
const fs = require('fs');
const path = require('path');

const { prepareRepo } = require('./prepare-repo');
const { buildPrCallGraph } = require('./build-pr-callgraph');

const DATASETS = path.join(__dirname, 'datasets');

const args = process.argv.slice(2);
const setName = (args.find((a) => a.startsWith('--set=')) || '--set=light').split('=')[1];
const only = (args.find((a) => a.startsWith('--case=')) || '').split('=')[1];

function caseIdsFor(name) {
    const src = fs.readFileSync(path.join(__dirname, 'recall-tests.js'), 'utf8');
    const key = `${name.toUpperCase()}_CASES`;
    const block = src.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!block) throw new Error(`no ${key} in recall-tests.js`);
    return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

(async () => {
    const wanted = only ? new Set([only]) : caseIdsFor(setName);
    const cases = [];
    for (const file of fs.readdirSync(DATASETS)) {
        if (!file.endsWith('.json')) continue;
        let vars;
        try {
            vars = JSON.parse(fs.readFileSync(path.join(DATASETS, file), 'utf8'))[0].vars;
        } catch {
            continue;
        }
        if (wanted.has(vars.caseId)) cases.push(vars);
    }

    // Cheapest repos first: a failure in the wiring shows up in a minute
    // instead of after the keycloak parses.
    const order = { 'calcom/cal.com': 0, 'discourse/discourse': 1, 'grafana/grafana': 2 };
    cases.sort((a, b) => (order[a.repositoryFullName] ?? 9) - (order[b.repositoryFullName] ?? 9));

    console.log(`prebuilding ${cases.length} cases (set=${setName})`);
    let ok = 0;
    for (const [i, vars] of cases.entries()) {
        const t0 = Date.now();
        const tag = `[${i + 1}/${cases.length}] ${vars.caseId}`;
        let handle = null;
        try {
            handle = await prepareRepo(vars, vars.caseId);
            if (!handle) {
                console.log(`${tag}: SKIP (no worktree)`);
                continue;
            }
            const cg = await buildPrCallGraph(vars, handle.dir, vars.caseId, () => {});
            const secs = ((Date.now() - t0) / 1000).toFixed(0);
            if (!cg) {
                console.log(`${tag}: FAIL (${secs}s)`);
                continue;
            }
            ok++;
            const a = cg.json?.analysis;
            const d1 = a?.blast_radius?.by_depth?.['1']?.length ?? 0;
            console.log(
                `${tag}: OK ${secs}s xml=${cg.xml.length}ch fns=${a?.changed_functions?.length ?? 0} depth1=${d1} blast=${a?.blast_radius?.total_functions ?? 0}/${a?.blast_radius?.total_files ?? 0}f`,
            );
        } catch (err) {
            console.log(`${tag}: ERROR ${String(err).slice(0, 160)}`);
        } finally {
            if (handle) await handle.cleanup().catch(() => {});
        }
    }
    console.log(`done: ${ok}/${cases.length}`);
})();
