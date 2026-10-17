// The review stages, and the Kody features that feed the review, with the eval
// that covers each one (#2114).
//
// A stage is a step that can change what Kody posts on the PR: it adds, drops,
// rewrites or places a comment. Each one reaches BigQuery `quality.signals` as
// `evals.stage.<id>` (evals/stage-signals.js), so the quality panel lists every
// stage with its eval, or `none`. Order is the order a review runs them: the
// pipeline's stages (code-review-pipeline.strategy.ts), and inside the agent
// stage (agent-review.stage.ts) the two agents side by side (the finder and
// the Kody Rules agent, review-orchestrator.service.ts Promise.allSettled), each
// run's output parsed and then verified, and after the agents the line anchor,
// the repeat drop, dedup, severity and the formatter, in that order. Where Kody
// Rules and memories come from is not a review step: those stages come after
// the review's.
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
//   set      — what the model reviews to produce it. The panel reads it after
//              "<model> reviews <cases>", so it starts with a plural noun
//   caveat   — what a green number does not prove
//   friday   — when the Friday check (evals/tier0-smoke.js) runs it on every
//              tier-0 model: the key of its outcome in that check's
//              `evals.tier0.<model>` meta. Proves it still runs there, measures
//              nothing. Every stage the nightly measures has one, so Friday
//              covers the same stages on every model
//   history  — an older signal carrying the same number, for the panel's chart
//              until this stage's own rows have a history
//   note     — shown by the panel next to the status
// The panel's groups, in order: parts of the review, and the features that feed
// it. Every stage names one, and a group's stages are adjacent.
const GROUPS = ['Before the agents', 'The agents, side by side', 'After the agents', 'On the PR', 'Where rules and memories come from', 'Conversation with Kody'];

const STAGES = [
    {
        id: 'business-logic',
        name: 'Business logic',
        group: 'Before the agents',
        label: 'Business-logic validation against the linked task',
        pipeline: ['BusinessLogicValidationStage'],
        eval: 'evals/business-logic',
        model: 'real',
        wiring: ['business-logic'],
        nightly: 'shared',
        friday: 'business_logic',
        metric: 'of PRs the stage answered right',
        set: 'three PRs that close a Jira ticket: one leaves a requirement out, one does it all, one links a ticket that cannot be read',
        caveat: 'Three cases: a green night says the stage still reads the ticket and the diff and tells a gap from a pass, not how good its gap analysis is.',
        note: "production's stage over its MCP adapter: the Kodus MCP server is production's, the mcp-manager answer and the Atlassian MCP are the eval's data",
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
        note: "on demand: node evals/security-analyzers/run-stage.js --gate runs production's RunAnalyzersStage (the secret scan on a sandbox checkout of each sample) against per-tranche floors; needs the betterleaks version docker/Dockerfile pins",
    },
    {
        id: 'finder',
        name: 'Finder',
        group: 'The agents, side by side',
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
        note: "recall of what the review ships, on the nightly light set, against its floor; production's sandbox over the repository at each PR's head",
    },
    {
        id: 'memories',
        name: 'Following memories',
        group: 'The agents, side by side',
        label: "Follows the team's memories: quiet where one says the code is intended, a finding where one says it is wrong",
        pipeline: ['AgentReviewStage'],
        eval: 'evals/memories',
        model: 'real',
        wiring: ['memories'],
        nightly: 'shared',
        friday: 'memories',
        metric: 'of memory cases the review got right',
        set: 'small invented pull requests, one per kind of memory production teams keep, each paired with a bug the memory must not silence',
        note: 'every PR against the scripted model; nightly on the real model when the finder or its cases change',
    },
    {
        id: 'parse',
        name: 'Output parsing',
        group: 'The agents, side by side',
        label: "Parse: the end of each finder run becomes findings",
        pipeline: ['AgentReviewStage'],
        eval: 'evals/parse',
        model: 'real',
        wiring: ['parse', 'review-chain', 'shape-invariance'],
        nightly: 'shared',
        friday: 'parse',
        metric: 'of written findings handled right by the parse',
        set: 'recorded finder outputs from nine production models on public PRs, with the shapes production lost (#2112)',
        caveat: 'Replays recorded model output: a model that changes how it writes its findings shows here once its runs are recorded again (evals/parse/capture.js).',
        byHand: ['evals/structured-outputs'],
        note: 'every PR against the scripted model (the deterministic part); nightly on the real model when the parse or its payloads change',
    },
    {
        id: 'verify',
        name: 'Verify',
        group: 'The agents, side by side',
        label: 'Verify: keeps or drops each finder candidate',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/funnel/verify',
        model: 'real',
        wiring: ['verifier-verdict', 'funnel-verify'],
        note: "nightly on a production review's frozen candidates, evidence gate included, ungated; verifier-verdict checks a verdict reaches the gate on each PR",
        nightly: 'shared',
        friday: 'funnel_verify',
        metric: 'of known bugs reaching verify kept, and of its control checks right',
        set: "PRs whose known bugs reach the step in a production review (evals/funnel/snapshot), and the step's control pair",
        caveat: 'Ungated until the relabeled dataset lands (#2114): reported, never alerted.',
    },
    {
        id: 'detectors',
        name: 'Detectors',
        group: 'The agents, side by side',
        label: 'Turns a mechanical rule into a pattern match whose hits the AI confirms',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/kody-rules/polyglot-cases.json',
        model: 'on-demand',
        wiring: [],
        byHand: ['evals/kody-rules'],
        note: "on demand: node evals/kody-rules/real-agent.js --dataset=polyglot-cases runs production's review (compile, sandbox, stage) with a Ruby-only rule over polyglot PRs; the kody-rules nightly also reaches the detector route, its rules carrying examples",
        caveat: 'A negative control: it counts comments on files the rule must not touch, not violations found.',
    },
    {
        id: 'kody-rules',
        name: 'Finding violations',
        group: 'The agents, side by side',
        label: 'Kody Rules agent: flags every place a PR breaks a rule',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/kody-rules',
        model: 'real',
        wiring: ['kody-rules'],
        nightly: 'kody-rules',
        friday: 'kody_rules',
        metric: 'of known rule violations flagged',
        set: 'real PRs where we know every line that breaks a rule',
        caveat: 'The set holds mechanical rules only (no console, no any, no process.env, no generic Error): a green night says the rule machinery works, not that Kody is good at harder rules.',
        note: 'occurrence recall and clean-file specificity on github-cases against their floors, when its files changed',
    },
    {
        id: 'anchoring',
        name: 'Anchoring',
        group: 'After the agents',
        label: 'Anchoring findings to diff lines',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/funnel/anchoring',
        model: 'real',
        wiring: ['funnel-anchoring'],
        // evals/anchoring is retired: it ran its own finder loop over recorded
        // tools, and funnel/anchoring runs the same path check and line snap,
        // production's, on the findings a production review gave them.
        byHand: [],
        note: "nightly on a production review's frozen findings, ungated; near misses printed",
        nightly: 'shared',
        friday: 'funnel_anchoring',
        metric: 'of known bugs reaching anchoring kept, and of its control checks right',
        set: "PRs whose known bugs reach the step in a production review (evals/funnel/snapshot), and the step's control pair",
        caveat: 'Ungated until the relabeled dataset lands (#2114): reported, never alerted.',
    },
    {
        id: 'review-rounds',
        name: 'Later rounds',
        group: 'After the agents',
        label: 'Later review rounds: no reposts, nothing lost',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/review-rounds',
        model: 'real',
        wiring: ['review-rounds', 'review-lifecycle'],
        nightly: 'shared',
        friday: 'review_rounds',
        metric: 'of claims handled right',
        set: 'later rounds of a PR: reposts that must stay off it, new problems and revisions that must post',
        caveat: 'The nightly runs one model on a subset (evals/nightly-evals.js, targets.json sets.nightly); the full set, the lifecycle chains and other models run by hand.',
        note: 'targets.json sets.nightly in the nightly (evals/nightly-evals.js); the full set runs by hand',
    },
    {
        id: 'dedup',
        name: 'Dedup',
        group: 'After the agents',
        label: 'Dedup of findings',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/funnel/dedup',
        model: 'real',
        wiring: ['funnel-dedup'],
        note: "nightly on a production review's frozen findings, ungated",
        nightly: 'shared',
        friday: 'funnel_dedup',
        metric: 'of known bugs reaching dedup kept, and of its control checks right',
        set: "PRs whose known bugs reach the step in a production review (evals/funnel/snapshot), and the step's control pair",
        caveat: 'Ungated until the relabeled dataset lands (#2114): reported, never alerted.',
    },
    {
        id: 'severity',
        name: 'Severity',
        group: 'After the agents',
        label: 'Severity of each finding',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/funnel/severity',
        model: 'real',
        wiring: ['funnel-severity'],
        note: "nightly on a production review's frozen findings at the default threshold (medium), ungated",
        nightly: 'shared',
        friday: 'funnel_severity',
        metric: 'of known bugs reaching severity kept, and of its control checks right',
        set: "PRs whose known bugs reach the step in a production review (evals/funnel/snapshot), and the step's control pair",
        caveat: 'Ungated until the relabeled dataset lands (#2114): reported, never alerted.',
    },
    {
        id: 'format',
        name: 'Formatting',
        group: 'After the agents',
        label: 'Formatting of each suggestion',
        pipeline: ['AgentReviewStage'],
        eval: 'evals/format',
        model: 'real',
        wiring: ['format'],
        nightly: 'shared',
        friday: 'format',
        metric: 'of findings formatted right',
        set: 'batches of findings: each of 31 real reviews under four team languages and a writing guideline',
        caveat: 'Checks the text a reviewer sees, not whether the claim stayed the same.',
        note: 'every PR against the scripted model (the local fallback); nightly on the real model when the formatter or its cases change',
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
        model: 'real',
        wiring: ['pr-summary'],
        nightly: 'shared',
        friday: 'pr_summary',
        metric: 'of PR-summary checks passed',
        set: 'summary cases: pull requests under each behaviour for an existing description and a new commit, three with a title that says nothing',
        caveat: 'Whether the summary speaks of the diff is read from its words, not judged.',
        note: 'every PR against the scripted model (the contract); nightly on the real model when the summary path or its cases change',
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
        id: 'rules-learned',
        name: 'Learned from reviews',
        group: 'Where rules and memories come from',
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
        group: 'Where rules and memories come from',
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
        group: 'Where rules and memories come from',
        label: 'Offers to create a Kody Rule or narrow one a PR thread shows is too broad; does it when asked',
        pipeline: null,
        eval: 'evals/thread-actions',
        model: 'real',
        wiring: ['thread-rule'],
        nightly: 'shared',
        friday: 'thread_rule',
        metric: 'of write checks right',
        set: 'invented PR threads that do or do not call for a Kody Rule, in English and Portuguese',
        caveat: "Counts the writes: the rule or memory lands when the developer asks and nothing is written unasked, read from the org's stores behind production's MCP server. Whether the reply offers the action is reported beside the number (reported), not gated: production's MCP client drops the tools' proactiveHint (MCP SDK 1.29.0 ToolAnnotationsSchema, read in libs/mcp-server/mcp-adapter/client.ts listTools), so the prompt never carries the offers block.",
        note: 'run.js --kind=rule; every PR against the scripted model, nightly on the real model when the agent or its cases change. The offer contract with a scripted model stays in the unit suite (test/integration/agents/kody-proactive-actions.integration.spec.ts)',
    },
    {
        id: 'thread-memory',
        name: 'Memory from a thread',
        group: 'Where rules and memories come from',
        label: 'Offers to save a memory when a PR thread shows a team convention; saves it when asked',
        pipeline: null,
        eval: 'evals/thread-actions',
        model: 'real',
        wiring: ['thread-memory'],
        nightly: 'shared',
        friday: 'thread_memory',
        metric: 'of write checks right',
        set: 'invented PR threads that do or do not call for a memory, in English and Portuguese',
        caveat: "Counts the writes: the rule or memory lands when the developer asks and nothing is written unasked, read from the org's stores behind production's MCP server. Whether the reply offers the action is reported beside the number (reported), not gated: production's MCP client drops the tools' proactiveHint (MCP SDK 1.29.0 ToolAnnotationsSchema, read in libs/mcp-server/mcp-adapter/client.ts listTools), so the prompt never carries the offers block.",
        note: 'run.js --kind=memory; every PR against the scripted model, nightly on the real model when the agent or its cases change. The offer contract with a scripted model stays in the unit suite (test/integration/agents/kody-proactive-actions.integration.spec.ts)',
    },
    {
        id: 'reply-addressing',
        name: 'Thread replies',
        group: 'Conversation with Kody',
        label: 'Replies to Kody in PR threads',
        pipeline: null,
        eval: 'evals/reply-addressing',
        model: 'real',
        wiring: ['reply-addressing'],
        nightly: 'shared',
        friday: 'reply_addressing',
        metric: 'of replies handled right',
        set: 'conversations where someone replies in a Kody thread without @kody',
        note: 'cases.json in the nightly (evals/nightly-evals.js); the real replies of repo-cases.json run by hand',
    },
    {
        id: 'conversation',
        name: 'Conversation replies',
        group: 'Conversation with Kody',
        label: 'Answers a developer in a PR thread from the code: a claimed fix, a decline, a question',
        pipeline: null,
        eval: 'evals/conversation',
        model: 'real',
        wiring: ['conversation'],
        nightly: 'shared',
        friday: 'conversation',
        metric: 'of reply checks right',
        set: 'invented threads where the developer is right or wrong about the code, in English and Portuguese',
        caveat: 'A judge reads whether the reply asserts what the code shows (assertsClaim); offering or taking actions is evals/thread-actions.',
        note: 'every PR against the scripted model; nightly on the real model when the agent or its cases change',
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
