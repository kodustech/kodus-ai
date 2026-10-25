#!/usr/bin/env node
/**
 * The Business Logic live specs on one model, routed as production routes an
 * org's (evals/business-logic/live-setup.js), so the numbers in a PR can be
 * reproduced:
 *
 *   node evals/business-logic/live.js --model=<tier-0 id> [--only=gap-check]
 *
 * Runs requirement-accuracy, analyzer-verdict and gap-check
 * (evals/business-logic/*.live.spec.ts) and criteria-location
 * (test/evals/business-rules-validation). Each writes its report to
 * evals/business-logic/results/.
 *
 * EXIT CODES: 0 = every case passed, 1 = a case failed, 2 = not measured
 * (no model, or one production can't route).
 */
const path = require('path');
const { spawnSync } = require('child_process');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
if (!args.model) {
    console.error('usage: live.js --model=<tier-0 id> [--only=<spec name,…>]');
    process.exit(2);
}

const root = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const { orgRouteOrExit } = require('../shared/model-route');
orgRouteOrExit(String(args.model));

const SPECS = {
    'requirement-accuracy':
        'evals/business-logic/requirement-accuracy.live.spec.ts',
    'analyzer-verdict': 'evals/business-logic/analyzer-verdict.live.spec.ts',
    'gap-check': 'evals/business-logic/gap-check.live.spec.ts',
    'criteria-location':
        'test/evals/business-rules-validation/criteria-location/criteria-location.live.spec.ts',
};
const only = args.only ? String(args.only).split(',') : Object.keys(SPECS);
const specs = only.map((name) => SPECS[name]).filter(Boolean);

// The spec paths go before --setupFilesAfterEnv, which would take them as its own.
const result = spawnSync(
    'npx',
    [
        'jest',
        '--no-coverage',
        ...specs,
        '--setupFilesAfterEnv',
        path.join(__dirname, 'live-setup.js'),
    ],
    {
        cwd: root,
        stdio: 'inherit',
        env: {
            ...process.env,
            RUN_BR_EVAL: '1',
            API_NODE_ENV: 'test',
            EVAL_MODEL: String(args.model),
        },
    },
);
process.exit(result.status === 0 ? 0 : 1);
