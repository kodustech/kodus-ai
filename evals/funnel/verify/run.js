#!/usr/bin/env node
// funnel/verify: what each agent loop's verify step got in the snapshot's
// review (snapshot.js) — the candidates and the files the finder investigated —
// through production's verify again (verifyFindings, finder.agent.ts: each
// candidate judged, then the evidence gate's full re-verify of a finding on a
// file the finder never read). The review runs as production runs it up to each
// agent loop; in place of the loop, verify runs with the loop's own runner,
// tools and provider options (finderRunEnvironment, core-agent-loop.adapter.ts)
// over the PR's checkout. A known bug is lost when every candidate that matches
// it is dropped.
const { main } = require('../stage-run');

const lib = (p) => require(`../../../libs/${p}`);

// What a loop returns when nothing came of it: the stage carries on with no
// finding from this agent.
function nothingFound(params) {
    const { DiffCoverageLedger } = lib('code-review/infrastructure/agents/adapters/diff-coverage-ledger.adapter.ts');
    const { buildAgentAnomalies } = lib('code-review/infrastructure/agents/core/agent-anomalies.ts');
    const coverage = new DiffCoverageLedger({ changedFiles: params.changedFiles, fileTiers: params.fileTiers }).coverageSummary();
    const zero = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    return {
        findings: { reasoning: '', suggestions: [] },
        text: '',
        steps: 0,
        toolCalls: [],
        finishReason: 'completed',
        source: 'empty',
        usage: { ...zero, totalTokens: 0 },
        discardedBySeverity: [],
        droppedByVerify: [],
        coverage,
        verification: null,
        verificationUsage: zero,
        anomalies: buildAgentAnomalies({ steps: 0, toolCalls: [], coverage }),
        warnings: [],
    };
}

const flat = (frozen) => frozen.loops.flatMap((l) => l.candidates);

main({
    id: 'verify',
    usesModel: true,
    inputOf: flat,
    // A control is judged by whichever agent loop the review runs first, as if
    // its finder had read the file the findings are on.
    controlInput: (candidates) => ({ loops: [{ loop: '*', investigated: ['src/cart.ts'], candidates }] }),
    apply: async (env, frozen) => {
        const { reviewPullRequest, loopKey } = require('../../shared/review-stage');
        const { finderRunEnvironment } = lib('code-review/infrastructure/agents/core/core-agent-loop.adapter.ts');
        const { verifyFindings } = lib('code-review/infrastructure/agents/core/finder.agent.ts');
        const { createAgentRunContext } = lib('llm/agent-run-context.ts');
        const offsets = [];
        frozen.loops.reduce((n, l) => (offsets.push(n), n + l.candidates.length), 0);
        const pending = new Map(frozen.loops.map((l, i) => [l.loop, i]));
        const kept = new Set();
        await reviewPullRequest({
            ...env,
            agentLoop: async (params, secrets) => {
                const key = pending.has(loopKey(params)) ? loopKey(params) : pending.has('*') ? '*' : null;
                if (key === null) return nothingFound(params);
                const i = pending.get(key);
                pending.delete(key);
                const loop = frozen.loops[i];
                const candidates = loop.candidates.map((x) => ({ ...x.finding }));
                const { verifyParams } = finderRunEnvironment(params, secrets);
                const { ctx, cleanup } = createAgentRunContext({ runId: `funnel-verify:${params.agentName}`, parentSignal: params.parentSignal });
                try {
                    const r = await verifyFindings(verifyParams, candidates, new Set(loop.investigated), ctx);
                    for (const f of r.kept) kept.add(offsets[i] + candidates.indexOf(f));
                } finally {
                    cleanup();
                }
                return nothingFound(params);
            },
        });
        // A loop of the snapshot the review no longer runs: its candidates
        // were never judged, which is not a loss of the verifier's.
        if (pending.size) throw new Error(`the review no longer runs ${pending.size} agent loop(s) of the snapshot (${[...pending.keys()][0].split('|')[0]}, …)`);
        return kept;
    },
});
