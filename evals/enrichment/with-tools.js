// The enrichment as an agent loop with the finder's read tools over the PR head,
// the variant evals/enrichment/run.js measures against production's one call
// (libs/code-review/infrastructure/agents/engine/enrich-content.ts enrichOneShot).
// Same task text and the same answer; only the read tools and the done tool differ.
const path = require('path');

const lib = (p) => require(path.join(__dirname, '../../libs', p));
const {
    ENRICH_TASK,
    FIX_STATUSES,
    buildEnrichmentPrompt,
    parseEnrichment,
} = lib('code-review/infrastructure/agents/engine/enrich-content.ts');
const { BudgetPolicy } = lib('agent-harness/infrastructure/policies/budget.policy.ts');
const { ForceFinalizePolicy } = lib('agent-harness/infrastructure/policies/force-finalize.policy.ts');
const { InMemoryToolRegistry } = lib('agent-harness/infrastructure/tools/in-memory-tool-registry.ts');
const { extractLastJsonObjectWith } = lib('llm/structured-output-repair.ts');

const ENRICH_DONE_TOOL = 'submitEnrichment';

const WITH_TOOLS = `

You can read the repository at the pull request head with the read tools. Use them only to confirm the names, signatures and behavior the fix depends on; a few reads are enough. Then call ${ENRICH_DONE_TOOL} with title, fixStatus and improvedCode.`;

const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string' },
        fixStatus: { type: 'string', enum: [...FIX_STATUSES] },
        improvedCode: { type: 'string' },
    },
    required: ['title', 'fixStatus', 'improvedCode'],
};

function buildEnricherAgentSpec({ tools, maxSteps, providerOptions, runName }) {
    return {
        id: 'enricher',
        runName: runName ?? 'code-review-enrich',
        phase: 'enrich',
        systemPrompt: ENRICH_TASK + WITH_TOOLS,
        tools: new InMemoryToolRegistry([
            ...tools.list(),
            {
                name: ENRICH_DONE_TOOL,
                description: 'Submit the title, fixStatus and improvedCode of the finding and end.',
                inputSchema: RESULT_SCHEMA,
                execute: async () => ({ output: 'submitted' }),
            },
        ]),
        policies: [new BudgetPolicy(), new ForceFinalizePolicy({ doneToolName: ENRICH_DONE_TOOL })],
        maxSteps: maxSteps ?? 6,
        resultToolName: ENRICH_DONE_TOOL,
        providerOptions,
    };
}

/** The submitted payload, else the last JSON object in the final text. */
function enrichmentFromRun(state) {
    for (let i = state.artifacts.length - 1; i >= 0; i--) {
        const a = state.artifacts[i];
        if (a.type !== ENRICH_DONE_TOOL) continue;
        const parsed = parseEnrichment(a.payload);
        if (parsed) return parsed;
    }
    const text = state.steps[state.steps.length - 1]?.message.content;
    const json = typeof text === 'string' && text.trim() ? extractLastJsonObjectWith(text, ['fixStatus']) : null;
    return json ? parseEnrichment(json) : null;
}

async function enrichWithTools(input, { runner, tools, ctx, maxSteps, providerOptions }) {
    const spec = buildEnricherAgentSpec({ tools, maxSteps, providerOptions });
    const { user } = buildEnrichmentPrompt(input);
    const state = await runner.run(spec, { prompt: user }, ctx);
    return { result: enrichmentFromRun(state), state };
}

module.exports = { enrichWithTools, buildEnricherAgentSpec, enrichmentFromRun };
