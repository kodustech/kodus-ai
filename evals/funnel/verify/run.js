#!/usr/bin/env node
// funnel/verify: every frozen candidate the verifier judged (snapshot.js)
// through the production verifier again — `LlmVerifier` in a
// `runVerificationPass`, built as `runAgentLoopViaCore`
// (core-agent-loop.adapter.ts) builds it: the same runner, the finder's tool
// registry over the PR's recorded tools, the same provider options. A known bug
// is lost when every candidate that matches it is dropped.
//
// Not covered: the evidence gate, which re-verifies a kept finding the finder
// never read, because it needs the finder's own run.
const { main } = require('../stage-run');
const { datasetFor } = require('../known-bugs');
const { withCallErrors } = require('../../shared/eval-kit');

main({
    id: 'verify',
    usesModel: true,
    reaches: () => true,
    apply: async (input, caseId) => {
        const { AiSdkAgentRunner } = require('../../../libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
        const { buildFinderToolRegistry } = require('../../../libs/code-review/infrastructure/agents/adapters/finder-tools.adapter.ts');
        const { buildProviderOptions } = require('../../../libs/llm/reasoning-options.ts');
        const { createAgentRunContext } = require('../../../libs/llm/agent-run-context.ts');
        const { runVerificationPass } = require('../../../libs/agent-harness/infrastructure/orchestration/verification-pass.ts');
        const { LlmVerifier } = require('../../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');
        const { ReplayRemoteCommands } = require('../../investigation/agent-provider');
        const vars = datasetFor(caseId);
        const replay = typeof vars.toolReplay === 'string' ? JSON.parse(vars.toolReplay) : vars.toolReplay || {};

        const runner = new AiSdkAgentRunner(undefined, { organizationId: 'funnel-eval' });
        const { registry: tools } = buildFinderToolRegistry({ remoteCommands: new ReplayRemoteCommands(replay), repositoryFullName: vars.repositoryFullName });
        const providerOptions = buildProviderOptions('funnel-verify', undefined, {});
        const verifier = new LlmVerifier(runner, { modelId: 'resolved', tools, providerOptions, agentName: 'funnel-verify' });
        const candidates = input.map((c) => ({ ...c.finding }));
        const { ctx, cleanup } = createAgentRunContext({ runId: `funnel-verify:${caseId}` });
        try {
            const { classifyLLMError, LlmErrorCategory } = require('../../../libs/llm/error-classifier.ts');
            const { result: pass, errors } = await withCallErrors(() => runVerificationPass({ candidates, verifier, concurrency: 4 }, ctx));
            // A verifier call that fails keeps its candidate (fail-open), which
            // would read as nothing lost; a refusal leaves the PR unmeasured.
            const refused = errors.find((e) => ['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED'].map((c) => LlmErrorCategory[c]).includes(classifyLLMError(e).category));
            if (refused) throw new Error(`verifier call refused: ${String(refused.message || refused).slice(0, 160)}`);
            const index = new Map(candidates.map((f, k) => [f, k]));
            return pass.kept.map((f) => index.get(f)).filter((k) => k !== undefined);
        } finally {
            cleanup();
        }
    },
});
