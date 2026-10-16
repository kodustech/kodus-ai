// Production's severity pass on a list of findings:
// AgentReviewStage.reclassifyAndFilterSeverity (agent-review.stage.ts) — the
// severity classifier on the routed model, then the team's threshold — on a
// stage built as the review builds it, over the team's default config with the
// model routed as an org's (evals/shared/review-stage.js teamContext). The
// labels are what the pass left on every finding, kept or filtered; whether
// the classifier's answer parsed is read off its parser, not changed.
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { normalizeSeverity } = require('./severity-eval');

// The model a cloud org without BYOK reviews with (the managed default).
const DEFAULT_MODEL = 'deepseek-v4-flash@fireworks';

const parses = new AsyncLocalStorage();
let parserObserved = false;
function observeTheParser() {
    if (parserObserved) return;
    const prompt = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/engine/severity-prompt.ts'));
    const parse = prompt.parseSeverityResponse;
    prompt.parseSeverityResponse = (...args) => {
        const out = parse(...args);
        parses.getStore()?.push(out.parseOk);
        return out;
    };
    parserObserved = true;
}

/**
 * @param {Array} findings
 * @param {string} modelKey   tier0-models id
 * @returns {Promise<{ labels: string[], parseOk: boolean, defaultedAll: boolean, kept: number[] }>}
 */
async function runSeverity(findings, modelKey = DEFAULT_MODEL) {
    if (!findings.length) {
        return { labels: [], parseOk: true, defaultedAll: false, kept: [] };
    }
    process.env.RECALL_MODEL = modelKey;
    const { internals } = require('../investigation/agent-provider');
    const { teamContext, buildAgentReviewStage } = require('../shared/review-stage');
    observeTheParser();
    const route = internals.resolveRoute({ provider: 'tier0', model: modelKey });
    const permissionService = internals.evalPermissionService(route.storedConfig);
    const { context, codeManagement } = await teamContext({ route, permissionService });
    const stage = buildAgentReviewStage({ permissionService, codeManagement });
    // `evalIndex` maps what comes out back to what went in.
    const input = findings.map((f, k) => ({ ...f, evalIndex: k }));
    const parsed = [];
    const kept = await parses.run(parsed, () => stage.reclassifyAndFilterSeverity(input, context, []));
    // A failed call or an answer that did not parse leaves every finding at
    // medium, in production too.
    const parseOk = parsed.length > 0 && parsed.every(Boolean);
    return {
        labels: input.map((s) => normalizeSeverity(s.severity)),
        parseOk,
        defaultedAll: !parseOk,
        kept: kept.map((s) => s.evalIndex),
    };
}

module.exports = { runSeverity, DEFAULT_MODEL };
