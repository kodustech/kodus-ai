#!/usr/bin/env node
// Records, for each case whose rule is long enough to be decomposed, the atoms
// production generates for it (KodyRuleSummaryService.generateAtoms: one
// decomposition call, then the detector compile of each atom), so every review
// of the case judges the same atoms. Production stores them on the rule once
// and reuses them on every review until the rule text or its examples change;
// left to the review, each run would decompose the rule again, and a
// comparison of two versions of the code would also compare two decompositions.
//
//   node evals/kody-rules/freeze-atoms.js --dataset=reference-cases [--model=<tier-0 id>] [--force]
//
// Rewrites the dataset in place. A rule whose recorded atoms still match its
// text and examples is left alone unless --force is given.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const file = path.join(__dirname, `${args.dataset || 'reference-cases'}.json`);
const MODELKEY = args.model || 'deepseek-v4-flash@fireworks';

async function main() {
    const ROUTE = require('../shared/model-route').orgRouteOrExit(MODELKEY);
    const review = require('./production-review');
    const lib = (p) => require(path.join(__dirname, '../../libs', p));
    const { KodyRuleSummaryService } = lib('kodyRules/infrastructure/adapters/services/kody-rule-summary.service.ts');

    const permission = review.permissionService(ROUTE.storedConfig);
    const summary = new KodyRuleSummaryService(permission, null, review.observabilityService());
    const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
    let failed = 0;
    for (const c of cases) {
        const rule = c.rule;
        if (!rule || !summary.isLong(rule.rule)) continue;
        if (!args.force && rule.atoms?.sourceHash === summary.atomsHashOf(rule)) {
            console.log(`${c.caseId}: atoms current (${rule.atoms.items.length}), kept`);
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const atoms = await summary.generateAtoms(rule, review.EVAL_ORG);
        if (!atoms) {
            console.error(`${c.caseId}: no atoms generated`);
            failed++;
            continue;
        }
        rule.atoms = atoms;
        console.log(`${c.caseId}: ${atoms.items.length} atom(s) by ${atoms.model}, ${atoms.items.filter((a) => a.detector).length} with a detector`);
    }
    fs.writeFileSync(file, `${JSON.stringify(cases, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
    return failed ? 1 : 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(err);
        process.exit(1);
    },
);
