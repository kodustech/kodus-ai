// Cases: THREAD_SCENARIOS (and CONFIRMATION_TURN) in test/integration/agents/__test-utils__/kody-thread-scenarios.ts, run by kody-proactive-actions.integration.spec.ts; this stage keeps the memory offers.
const { requireTs } = require('../shared/eval-result');

const SCENARIOS = 'test/integration/agents/__test-utils__/kody-thread-scenarios.ts';
const MAX = 160;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

// KODUS_CREATE_MEMORY -> "to create a memory"; KODUS_UPDATE_KODY_RULE -> "to update the Kody Rule".
function offerPhrase(tool) {
    const [, verb = '', ...rest] = String(tool).split('_');
    const kody = rest.includes('KODY');
    const object = rest.map((w) => (kody ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
    return `to ${verb.toLowerCase()} ${verb === 'CREATE' ? 'a' : 'the'} ${object}`;
}

const when = (signal) => (/^developer\b/i.test(signal) ? `when the ${signal}` : `when the thread reveals: ${signal}`);

// One entry per scenario whose expected offer matches `offerPattern`, plus the
// confirmation turn when it continues one of them.
function threadCatalog(offerPattern) {
    const { THREAD_SCENARIOS, CONFIRMATION_TURN } = requireTs(SCENARIOS);
    const picked = THREAD_SCENARIOS.filter((s) => s.expectedOffer && offerPattern.test(s.expectedOffer));
    const entries = picked.map((s) => ({
        id: s.id,
        checks: clip(`Offers ${offerPhrase(s.expectedOffer)} (${s.expectedOffer}) ${when(s.signal)}`),
    }));
    const confirmed = CONFIRMATION_TURN && picked.find((s) => s.id === CONFIRMATION_TURN.scenarioId);
    if (confirmed) {
        const reply = String(CONFIRMATION_TURN.userMessage).replace(/^@kody\s*/i, '');
        entries.push({
            id: `${confirmed.id}:confirmation`,
            checks: clip(`Replays Kody's earlier offer ${offerPhrase(confirmed.expectedOffer)} into the next turn so the developer's "${reply}" can confirm it`),
        });
    }
    return entries;
}

function catalog() {
    return threadCatalog(/MEMORY/);
}

module.exports = { catalog, threadCatalog };
