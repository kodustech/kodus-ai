// The review stages and the eval that covers each one (#2114).
//
// A stage is a step that can change what Kody posts on the PR: it adds, drops,
// rewrites or places a comment. Each one reaches BigQuery `quality.signals` as
// `evals.stage.<id>` (evals/stage-signals.js), so the quality panel lists every
// stage with its eval, or `none`. Order follows the review; the passes inside
// the agent stage run together and are grouped, not strictly ordered.
//
// Every stage of the review pipeline (code-review-pipeline.strategy.ts) is here
// or in PLUMBING: evals/stage-signals.spec.ts fails on one that is in neither,
// so adding a pipeline stage means saying how it is tested.
//
//   id       — signal suffix
//   label    — what the stage does, for the panel
//   pipeline — the pipeline stage class(es) it lives in; null outside the review
//              pipeline (the PR conversation)
//   eval     — the eval's folder, or null when nothing covers the stage
//   model    — how the eval reaches the stage on a schedule:
//                real      a real model measures it (the value is a quality number)
//                scripted  the scripted model drives it: proves the eval still
//                          reaches the engine, measures nothing
//                mocked    no model: a deterministic stand-in
//                on-demand an eval exists but nothing runs it on a schedule
//                none      no eval
//   wiring   — evals/wiring-smoke.js steps that run it (scripted or mocked)
//   nightly  — true when the nightly measures it with a real model; its row then
//              comes only from the nightly, never from the wiring smoke
//   friday   — true when the Friday check (evals/tier0-smoke.js) runs it on
//              every tier-0 model: proves it still runs there, measures nothing
//   history  — an older signal carrying the same number, for the panel's chart
//              until this stage's own rows have a history
//   note     — shown by the panel next to the status
const STAGES = [
    {
        id: 'business-logic',
        label: 'Business-logic validation against the linked task',
        pipeline: ['BusinessLogicValidationStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'analyzers',
        label: 'Static analyzers run before the agents',
        pipeline: ['RunAnalyzersStage'],
        eval: 'evals/security-analyzers',
        model: 'on-demand',
        wiring: [],
        note: 'on demand only, not scheduled',
    },
    {
        id: 'finder',
        label: 'Finder: the agent that looks for bugs (verify included)',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/investigation',
        model: 'real',
        wiring: ['finder-recall'],
        nightly: true,
        friday: true,
        history: 'evals.nightly.recall',
        note: 'recall on the nightly light set against its floor; tools answered from a recording',
    },
    {
        id: 'kody-rules',
        label: 'Kody Rules agent',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/kody-rules',
        model: 'scripted',
        wiring: ['kody-rules'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'verify',
        label: 'Verify: keeps or drops each finder candidate',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/verifier-verdict',
        model: 'mocked',
        wiring: ['verifier-verdict'],
        note: 'checks a verdict reaches the gate; its effect on recall is inside the finder row',
    },
    {
        id: 'parse',
        label: 'Output recovery: every LLM call parses its answer',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/review-chain',
        model: 'mocked',
        wiring: ['review-chain', 'shape-invariance'],
        note: 'deterministic: every call site wired to the shared recovery, every wire shape normalized',
    },
    {
        id: 'severity',
        label: 'Severity of each finding',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/severity',
        model: 'mocked',
        wiring: ['severity'],
        note: 'heuristic mock only on a schedule',
    },
    {
        id: 'dedup',
        label: 'Dedup of findings',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/dedup',
        model: 'scripted',
        wiring: ['dedup', 'dedup-engine'],
        note: 'mocked and scripted only on a schedule; real-model runs are on demand',
    },
    {
        id: 'format',
        label: 'Formatting of each suggestion',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/format',
        model: 'mocked',
        wiring: ['format'],
        note: 'mock only on a schedule',
    },
    {
        id: 'anchoring',
        label: 'Anchoring findings to diff lines',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/anchoring',
        model: 'scripted',
        wiring: ['anchoring'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'review-rounds',
        label: 'Later review rounds: no reposts, nothing lost',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/review-rounds',
        model: 'scripted',
        wiring: ['review-rounds', 'review-lifecycle'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'pr-comments',
        label: 'PR-level comments (findings without a diff line)',
        pipeline: ['CreatePrLevelCommentsStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'posting',
        label: 'Validation and posting of comments on the PR',
        pipeline: ['ValidateSuggestionsStage', 'CreateFileCommentsStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'pr-summary',
        label: 'PR summary',
        pipeline: ['UpdateCommentsAndGenerateSummaryStage'],
        eval: 'evals/pr-summary',
        model: 'scripted',
        wiring: ['pr-summary'],
        friday: true,
        note: 'scripted model nightly; every tier-0 model on Friday',
    },
    {
        id: 'approval',
        label: 'Approve or request changes on the PR',
        pipeline: ['RequestChangesOrApproveStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'reply-addressing',
        label: 'Replies to Kody in PR threads',
        pipeline: null,
        eval: 'evals/reply-addressing',
        model: 'scripted',
        wiring: ['reply-addressing'],
        note: 'scripted model only on a schedule',
    },
];

// Pipeline stages that do not change what Kody posts: they gate, configure,
// fetch, or report. Unit and E2E tests cover them; the panel does not list them.
const PLUMBING = {
    ValidatePrerequisitesStage: 'decides whether the review runs',
    ValidateNewCommitsStage: 'decides whether the review runs',
    ResolveConfigStage: 'loads the configuration',
    ValidateConfigStage: 'checks the configuration',
    FetchChangedFilesStage: "feeds the agent the PR's files",
    ILoadExternalContextStage: 'feeds the agent external context',
    LoadCiEvidenceStage: 'feeds the agent CI evidence',
    CreateSandboxStage: "gives the agent the repository's tools",
    InitialCommentStage: 'posts the "review started" comment',
    AggregateResultsStage: 'counts what was posted',
};

module.exports = { STAGES, PLUMBING };
