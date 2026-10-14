// Cases: THREAD_SCENARIOS in test/integration/agents/__test-utils__/kody-thread-scenarios.ts whose expected offer creates or updates a Kody Rule.
const { threadCatalog } = require('./thread-memory');

function catalog() {
    return threadCatalog(/^KODUS_(CREATE|UPDATE)_KODY_RULE$/);
}

module.exports = { catalog };
