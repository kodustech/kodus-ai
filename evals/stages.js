// The review stages, and the Kody features that feed the review, with the eval
// that covers each one (#2114).
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
//   name     — short name, one line in the panel's step list
//   group    — the panel group it is listed under (GROUPS)
//   label    — what the stage does, for the panel
//   pipeline — the pipeline stage class(es) it lives in; null outside the review
//              pipeline (the PR conversation)
//   eval     — the eval's folder, or null when nothing covers the stage
//   model    — how the eval reaches the stage on a schedule:
//                real      a real model measures it (the value is a quality number)
//                scripted  the scripted model drives it: proves the eval still
//                          reaches the engine, measures nothing
//                mocked    no model: a deterministic stand-in
//                e2e       an E2E scenario on the test matrix runs it on a real
//                          stack: proves it works end to end, measures nothing
//                on-demand an eval exists but nothing runs it on a schedule
//                none      no eval
//   wiring   — evals/wiring-smoke.js steps that run it (scripted or mocked);
//              empty for an eval that runs elsewhere (unit suite, E2E matrix):
//              its row is then `skipped` and `model` says how it is checked
//   byHand   — evals that can measure it on a real model, but only when someone
//              runs them by hand: what it takes to start measuring the stage
//   nightly  — the result the nightly measures it with on a real model
//              (stage-signals.js READERS); its row then comes only from the
//              nightly, never from the wiring smoke
//   metric   — what the measured number counts, shown under it
//   set      — what the model reviews to produce it
//   caveat   — what a green number does not prove
//   friday   — when the Friday check (evals/tier0-smoke.js) runs it on every
//              tier-0 model: the key of its outcome in that check's
//              `evals.tier0.<model>` meta. Proves it still runs there, measures
//              nothing
//   history  — an older signal carrying the same number, for the panel's chart
//              until this stage's own rows have a history
//   note     — shown by the panel next to the status
// The panel's groups, in order: parts of the review, and the features that feed
// it. Every stage names one, and a group's stages are adjacent.
const GROUPS = ['Before the agents', 'Finding issues', 'Kody Rules', 'On the PR', 'Conversation with Kody'];

const STAGES = [
    {
        id: 'business-logic',
        name: 'Business logic',
        group: 'Before the agents',
        label: 'Business-logic validation against the linked task',
        pipeline: ['BusinessLogicValidationStage'],
        eval: 'test/evals/business-rules-validation',
        model: 'mocked',
        wiring: [],
        byHand: ['libs/agents/skills/business-rules-validation/evals'],
        note: 'recorded cases in the unit test suite; a real-model run is by hand (RUN_BR_EVAL=1)',
    },
    {
        id: 'analyzers',
        name: 'Static analyzers',
        group: 'Before the agents',
        label: 'Static analyzers run before the agents',
        pipeline: ['RunAnalyzersStage'],
        eval: 'evals/security-analyzers',
        model: 'on-demand',
        wiring: [],
        note: 'on demand only, not scheduled',
    },
    {
        id: 'finder',
        name: 'Finder',
        group: 'Finding issues',
        label: 'Finder: the agent that looks for bugs (verify included)',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/investigation',
        model: 'real',
        wiring: ['finder-recall'],
        nightly: 'finder-recall',
        metric: 'of known bugs found',
        set: 'real PRs whose bugs we know',
        friday: 'review',
        history: 'evals.nightly.recall',
        byHand: ['evals/trace-context'],
        note: 'recall on the nightly light set against its floor; tools answered from a recording',
    },
    {
        id: 'verify',
        name: 'Verify',
        group: 'Finding issues',
        label: 'Verify: keeps or drops each finder candidate',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/verifier-verdict',
        model: 'mocked',
        wiring: ['verifier-verdict'],
        byHand: ['evals/promotion'],
        note: 'checks a verdict reaches the gate; its effect on recall is inside the finder row',
    },
    {
        id: 'parse',
        name: 'Output parsing',
        group: 'Finding issues',
        label: 'Output recovery: every LLM call parses its answer',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/review-chain',
        model: 'mocked',
        wiring: ['review-chain', 'shape-invariance'],
        byHand: ['evals/parser', 'evals/structured-outputs'],
        note: 'deterministic: every call site wired to the shared recovery, every wire shape normalized',
    },
    {
        id: 'severity',
        name: 'Severity',
        group: 'Finding issues',
        label: 'Severity of each finding',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/severity',
        model: 'mocked',
        wiring: ['severity'],
        byHand: ['evals/severity'],
        note: 'heuristic mock only on a schedule',
    },
    {
        id: 'dedup',
        name: 'Dedup',
        group: 'Finding issues',
        label: 'Dedup of findings',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/dedup',
        model: 'scripted',
        wiring: ['dedup', 'dedup-engine'],
        byHand: ['evals/dedup'],
        note: 'mocked and scripted only on a schedule; real-model runs are on demand',
    },
    {
        id: 'format',
        name: 'Formatting',
        group: 'Finding issues',
        label: 'Formatting of each suggestion',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/format',
        model: 'mocked',
        wiring: ['format'],
        byHand: ['evals/format'],
        note: 'mock only on a schedule',
    },
    {
        id: 'anchoring',
        name: 'Anchoring',
        group: 'Finding issues',
        label: 'Anchoring findings to diff lines',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/anchoring',
        model: 'scripted',
        wiring: ['anchoring'],
        byHand: ['evals/anchoring'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'review-rounds',
        name: 'Later rounds',
        group: 'Finding issues',
        label: 'Later review rounds: no reposts, nothing lost',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/review-rounds',
        model: 'scripted',
        wiring: ['review-rounds', 'review-lifecycle'],
        byHand: ['evals/review-rounds'],
        note: 'scripted model only on a schedule; real-model runs are on demand',
    },
    {
        id: 'rules-learned',
        name: 'Learned from reviews',
        group: 'Kody Rules',
        label: "Writes rules from what the team's reviewers said on past PRs",
        pipeline: null,
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval: unit tests cover which comments it reads, nothing checks the rules it writes',
    },
    {
        id: 'rules-from-files',
        name: 'From repo files',
        group: 'Kody Rules',
        label: 'Imports rules from files in the repository (.kody/rules, AGENTS.md, IDE rule files) and keeps them in sync',
        pipeline: null,
        eval: 'tests/e2e/scenarios/kody-rules-file-sync.ts',
        model: 'e2e',
        wiring: [],
        note: 'E2E on the test matrix: file sync, lifecycle and rule-file detection scenarios',
    },
    {
        id: 'thread-rule',
        name: 'From a thread',
        group: 'Kody Rules',
        label: 'Offers to narrow a Kody Rule a PR thread shows is too broad; creates one when asked',
        pipeline: null,
        eval: 'test/integration/agents/kody-proactive-actions.integration.spec.ts',
        model: 'mocked',
        wiring: [],
        note: 'no AI, in the unit test suite: covers changing a rule; no case creates one',
    },
    {
        id: 'thread-memory',
        name: 'Memory from a thread',
        group: 'Kody Rules',
        label: 'Offers to save a memory when a PR thread shows a team convention or a false positive',
        pipeline: null,
        eval: 'test/integration/agents/kody-proactive-actions.integration.spec.ts',
        model: 'mocked',
        wiring: [],
        note: 'no AI, in the unit test suite: the agent is offered the memory action in those threads',
    },
    {
        id: 'detectors',
        name: 'Detectors',
        group: 'Kody Rules',
        label: 'Turns a mechanical rule into a pattern match whose hits the AI confirms',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/kody-rules/detector-fp-repro.js',
        model: 'on-demand',
        wiring: [],
        note: 'on demand only; unit tests cover the compiler',
    },
    {
        id: 'kody-rules',
        name: 'Finding violations',
        group: 'Kody Rules',
        label: 'Kody Rules agent: flags every place a PR breaks a rule',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/kody-rules',
        model: 'real',
        wiring: ['kody-rules'],
        nightly: 'kody-rules',
        metric: 'of known rule violations flagged',
        set: 'real PRs where we know every line that breaks a rule',
        caveat: 'The set holds mechanical rules only (no console, no any, no process.env, no generic Error): a green night says the rule machinery works, not that Kody is good at harder rules.',
        note: 'occurrence recall and clean-file specificity on github-cases against their floors, when its files changed',
    },
    {
        id: 'pr-comments',
        name: 'PR-level comments',
        group: 'On the PR',
        label: 'PR-level comments (findings without a diff line)',
        pipeline: ['CreatePrLevelCommentsStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'posting',
        name: 'Posting',
        group: 'On the PR',
        label: 'Validation and posting of comments on the PR',
        pipeline: ['ValidateSuggestionsStage', 'CreateFileCommentsStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'pr-summary',
        name: 'PR summary',
        group: 'On the PR',
        label: 'PR summary',
        pipeline: ['UpdateCommentsAndGenerateSummaryStage'],
        eval: 'evals/pr-summary',
        model: 'scripted',
        wiring: ['pr-summary'],
        friday: 'pr_summary',
        byHand: ['evals/pr-summary'],
        note: 'scripted model nightly; every tier-0 model on Friday',
    },
    {
        id: 'approval',
        name: 'Approval',
        group: 'On the PR',
        label: 'Approve or request changes on the PR',
        pipeline: ['RequestChangesOrApproveStage'],
        eval: null,
        model: 'none',
        wiring: [],
        note: 'no eval for this stage',
    },
    {
        id: 'reply-addressing',
        name: 'Thread replies',
        group: 'Conversation with Kody',
        label: 'Replies to Kody in PR threads',
        pipeline: null,
        eval: 'evals/reply-addressing',
        model: 'scripted',
        wiring: ['reply-addressing'],
        byHand: ['evals/reply-addressing'],
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

module.exports = { STAGES, GROUPS, PLUMBING };
