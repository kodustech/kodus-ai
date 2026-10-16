#!/usr/bin/env node
// The snapshot observes a production review (evals/shared/review-stage.js
// observeTheReview); observing must not change it. Reviews the wiring smoke's
// written repository twice on the scripted model, unobserved and observed, and
// fails unless both ship the same and every step after the agents was recorded.
// Run by finder-parity.spec.ts in plain node: the wrappers patch the modules'
// exports, which the spec runner's own transform makes read-only.
//
// Exit: 0 same review, 1 the observation changed it or missed a step, 2 did not run.
const path = require('path');
const { startFakeLlmServer } = require('../shared/fake-llm-server');

const STEPS = ['anchorSuggestionsToDiff', 'dedupSuggestionStreams', 'mapper', 'reclassifyAndFilterSeverity', 'verify'];

async function main() {
    const server = await startFakeLlmServer();
    try {
        Object.assign(process.env, { EVAL_FAKE_LLM_URL: server.url, EVAL_FAKE_LLM_KEY: 'fake', RECALL_MODEL: 'eval-fake' });
        if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
        const { internals } = require('../investigation/agent-provider');
        const { reviewPullRequest } = require('../shared/review-stage');
        const { vars } = require(path.join(__dirname, '../investigation/wiring-case.json'));
        const route = internals.resolveRoute({ provider: 'tier0', model: 'eval-fake' });
        const run = (observeSteps) =>
            reviewPullRequest({ pr: internals.prOf(vars), team: internals.teamOf(vars), route, permissionService: internals.evalPermissionService(route.storedConfig), observeSteps });
        const plain = await run(false);
        const observed = await run(true);
        const recorded = Object.keys(observed.steps || {}).sort();
        console.log(JSON.stringify({ shippedPlain: plain.shipped.length, shippedObserved: observed.shipped.length, recorded }));
        return plain.shipped.length > 0 && observed.shipped.length === plain.shipped.length && JSON.stringify(recorded) === JSON.stringify(STEPS) ? 0 : 1;
    } finally {
        await server.close();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
