#!/usr/bin/env node
// funnel/anchoring: each agent's verified findings in the snapshot's review
// (snapshot.js) through anchoring again, as production runs it: the agent
// provider's path check (mapAgentFindings, finding-mapper.ts: a finding on a
// file the PR does not change is dropped), then
// AgentReviewStage.anchorSuggestionsToDiff on the PR's changed files as
// FetchChangedFilesStage renders them (snapped to a changed hunk, or dropped
// when its lines touch none). A known bug is lost when every finding that
// matches it is dropped. A drop within two lines of a hunk is printed as a
// near miss. No model call.
const { main } = require('../stage-run');

const lib = (p) => require(`../../../libs/${p}`);
const NEAR = 2;

function nearMisses(dropped, changedFiles) {
    const { extractValidDiffLines } = lib('code-review/pipeline/stages/agent-review.stage.ts');
    for (const s of dropped) {
        const file = changedFiles.find((f) => f.filename === s.relevantFile);
        if (!file) continue;
        const start = Number(s.relevantLinesStart);
        const end = Number(s.relevantLinesEnd ?? start);
        const gap = Math.min(...extractValidDiffLines(file.patch).map(([a, b]) => (end < a ? a - end : start > b ? start - b : 0)));
        if (gap <= NEAR) console.log(`  near miss: ${s.relevantFile}:${start}-${end} is ${gap} line(s) from a hunk — "${String(s.oneSentenceSummary || '').slice(0, 80)}"`);
    }
}

main({
    id: 'anchoring',
    inputOf: (frozen) => frozen.agents.flatMap((a) => a.candidates),
    // A control comes from the generalist agent, with the params its provider
    // gives the mapper.
    controlInput: (candidates) => {
        const { GeneralistAgentProvider } = lib('code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
        const agent = new GeneralistAgentProvider(undefined, {}, undefined, undefined);
        const params = {
            kodyRules: [],
            prNumber: 1,
            isKodyRules: false,
            identityName: agent.getIdentity().name,
            labelPolicy: { categoryLabel: agent.getCategoryLabel(), allowedLabels: agent.getAllowedSuggestionLabels({}), supportsMixed: agent.supportsMixedLabels() },
        };
        return { kodyRules: [], agents: [{ params, candidates }] };
    },
    apply: async (env, frozen) => {
        const { prepareReview, buildAgentReviewStage } = require('../../shared/review-stage');
        const { mapAgentFindings } = lib('code-review/infrastructure/agents/collaborators/finding-mapper.ts');
        const { context, codeManagement, cleanup } = await prepareReview(env);
        try {
            const stage = buildAgentReviewStage({ permissionService: env.permissionService, codeManagement });
            const mapped = [];
            let offset = 0;
            for (const agent of frozen.agents) {
                // The mapper filters and maps each finding on its own, so mapping
                // one at a time returns the same suggestions and keeps which
                // finding each came from, even when two share a description.
                agent.candidates.forEach((x, i) => {
                    const { suggestions } = mapAgentFindings({ findings: { reasoning: '', suggestions: [{ ...x.finding }] } }, { ...agent.params, changedFiles: context.changedFiles });
                    for (const s of suggestions) mapped.push({ ...s, evalIndex: offset + i });
                });
                offset += agent.candidates.length;
            }
            const out = stage.anchorSuggestionsToDiff(mapped, context.changedFiles, frozen.kodyRules || [], []);
            const kept = new Set(out.map((s) => s.evalIndex));
            nearMisses(mapped.filter((s) => !kept.has(s.evalIndex)), context.changedFiles);
            return kept;
        } finally {
            await cleanup();
        }
    },
});
