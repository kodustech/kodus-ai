// The review stages and the eval that covers each one (#2114).
//
// One row per stage reaches BigQuery `quality.signals` as `evals.stage.<id>`
// (evals/stage-signals.js), so the quality panel lists every stage with its
// eval, or `none`. Order follows the review: code-review-pipeline.strategy.ts
// and, inside the agent stage, the finder and its passes.
//
//   id       — signal suffix
//   label    — what the stage does, for the panel
//   eval     — the eval's folder, or null when nothing covers the stage
//   model    — how the eval reaches the stage on a schedule:
//                real     a real model measures it (the value is a quality number)
//                scripted the scripted model drives it: proves the eval still
//                         reaches the engine, measures nothing
//                mocked   no model: a deterministic stand-in
//                on-demand an eval exists but nothing runs it on a schedule
//                none     no eval
//   wiring   — evals/wiring-smoke.js steps that run it (scripted or mocked)
//   nightly  — true when the nightly measures it with a real model; its row then
//              comes only from the nightly, never from the wiring smoke
//   note     — shown by the panel next to the status
const STAGES = [
    {
        id: 'business-logic',
        label: 'Business-logic validation against the linked task',
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'analyzers',
        label: 'Static analyzers run before the agents',
        eval: 'evals/security-analyzers',
        model: 'on-demand',
        wiring: [],
        note: 'on demand only, not scheduled',
    },
    {
        id: 'finder',
        label: 'Finder: the agent that looks for bugs (verify included)',
        eval: 'evals/investigation',
        model: 'real',
        wiring: ['finder-recall'],
        nightly: true,
        note: 'recall on the nightly light set against its floor; tools answered from a recording',
    },
    {
        id: 'verify',
        label: 'Verify: keeps or drops each finder candidate',
        eval: 'evals/verifier-verdict',
        model: 'mocked',
        wiring: ['verifier-verdict'],
        note: 'checks a verdict reaches the gate; its effect on recall is inside the finder row',
    },
    {
        id: 'kody-rules',
        label: 'Kody Rules agent',
        eval: 'evals/kody-rules',
        model: 'scripted',
        wiring: ['kody-rules'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'parse',
        label: 'Output recovery: every LLM call parses its answer',
        eval: 'evals/review-chain',
        model: 'mocked',
        wiring: ['review-chain', 'shape-invariance'],
        note: 'deterministic: every call site wired to the shared recovery, every wire shape normalized',
    },
    {
        id: 'dedup',
        label: 'Dedup of findings',
        eval: 'evals/dedup',
        model: 'scripted',
        wiring: ['dedup', 'dedup-engine'],
        note: 'mocked and scripted only on a schedule; real-model runs are on demand',
    },
    {
        id: 'severity',
        label: 'Severity of each finding',
        eval: 'evals/severity',
        model: 'mocked',
        wiring: ['severity'],
        note: 'heuristic mock only on a schedule',
    },
    {
        id: 'format',
        label: 'Formatting of each suggestion',
        eval: 'evals/format',
        model: 'mocked',
        wiring: ['format'],
        note: 'mock only on a schedule',
    },
    {
        id: 'anchoring',
        label: 'Anchoring findings to diff lines',
        eval: 'evals/anchoring',
        model: 'scripted',
        wiring: ['anchoring'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'posting',
        label: 'Validation and posting of comments on the PR',
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'pr-summary',
        label: 'PR summary',
        eval: 'evals/pr-summary',
        model: 'scripted',
        wiring: ['pr-summary'],
        note: 'scripted model nightly; every tier-0 model on Friday (evals.tier0.*)',
    },
    {
        id: 'review-rounds',
        label: 'Later review rounds: no reposts, nothing lost',
        eval: 'evals/review-rounds',
        model: 'scripted',
        wiring: ['review-rounds', 'review-lifecycle'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'reply-addressing',
        label: 'Replies to Kody in PR threads',
        eval: 'evals/reply-addressing',
        model: 'scripted',
        wiring: ['reply-addressing'],
        note: 'scripted model only on a schedule',
    },
];

module.exports = { STAGES };
