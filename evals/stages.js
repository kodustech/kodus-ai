// The steps of the code review, and the Kody features that feed it, each with
// the tests and the eval that cover it (#2114). The quality panel's stages page
// lists them in this order, from the rows evals/stage-signals.js writes.
//
// A step is something that can change what Kody posts on the PR: it adds,
// drops, rewrites or places a comment. Order is the order a review runs them:
// the pipeline's stages (code-review-pipeline.strategy.ts), and inside the
// agent stage (agent-review.stage.ts) the two agents side by side (the finder
// and the Kody Rules agent), each run's output parsed and verified, then the
// line anchor, the repeat drop, dedup, severity and the formatter. Where Kody
// Rules and memories come from is not a review step: those come after.
//
// Every stage of the review pipeline is here or in PLUMBING:
// evals/stage-signals.spec.ts fails on one that is in neither, so adding a
// pipeline stage means saying how it is tested.
//
// What covers a step (evals/README.md, "When it runs"):
//   tests — pass or fail, the same on every run.
//     { kind: 'unit', name, specs: [<spec file>] }
//         jest, run on main every night (evals/stage-tests.js)
//     { kind: 'contract', name, wiring: [<step>] }
//         evals/wiring-smoke.js steps: the step's production code driven end to
//         end by a scripted model, on every PR and every night
//     { kind: 'contract', name, weekly: <command> }
//         the same contract on every tier-0 model, every week (evals/weekly.js)
//     { kind: 'e2e', name, scenario, signal }
//         an E2E scenario on the test matrix, which reports as `signal`
//     { kind: 'contract', name, spec, signal }
//         a contract test another workflow runs against the real provider,
//         which reports as `signal` (contract-tests.yml: contract.api)
//   eval — how good the step is, measured by a real model against a floor; null
//     when nothing measures it yet:
//     { path, metric, sets: { controlled, full }, nightly, caveat, catalog }
//         path      the eval's folder (its README says what it answers)
//         catalog   what lists its cases, when not the folder's catalog.js
//         metric    what the number counts, shown under it
//         sets      what the model reviews. `controlled`: the nightly, on one
//                   model, and every tier-0 model's weekly run. `full`:
//                   on demand; null when the controlled set is all
//                   there is. Each reads after "<model> reviews"
//         nightly   how evals/stage-signals.js reads its result (READERS)
//         caveat    what a green number does not prove
//   short — what it does in a few words, for the panel's overview (`does` says it in full)
//   note — shown beside the step when something about it needs saying
const GROUPS = ['Before the agents', 'The agents, side by side', 'After the agents', 'On the PR', 'Where rules and memories come from', 'Conversation with Kody'];

// The funnel's evals read a production review's frozen output (evals/funnel/snapshot).
const FUNNEL_SETS = {
    controlled: "the controlled PRs' findings from a production review (evals/funnel/snapshot) that reach this step, and the step's control pair",
    full: "the findings of every snapshot PR (30) that reach this step, and the step's control pair",
};

const STAGES = [
    {
        id: 'business-logic',
        name: 'Business logic',
        short: 'Checks the PR against its linked task',
        group: 'Before the agents',
        does: 'Before the agents run, reads the task the PR links (a Jira ticket, say) and the diff, and comments on what the PR leaves out of the task.',
        pipeline: ['BusinessLogicValidationStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The stage and its verifier',
                specs: [
                    'libs/code-review/pipeline/stages/business-logic-validation.stage.spec.ts',
                    'test/unit/code-review/pipeline/stages/business-logic-validation.stage.spec.ts',
                    'libs/agents/infrastructure/services/agents/business-rules-validation/business-rules-verifier.spec.ts',
                ],
            },
            { kind: 'contract', name: 'The stage, its MCP adapter and the Kodus MCP server, end to end', wiring: ['business-logic'] },
        ],
        eval: {
            path: 'evals/business-logic',
            metric: 'of PRs the stage answered right',
            sets: {
                controlled: 'three PRs that close a Jira ticket: one leaves a requirement out, one does it all, one links a ticket that cannot be read',
                full: null,
            },
            nightly: 'shared',
            caveat: 'Three cases: a green number says the stage still reads the ticket and the diff and tells a gap from a pass, not how good its gap analysis is.',
        },
    },
    {
        id: 'analyzers',
        name: 'Static analyzers',
        short: 'Static scanners on the changed lines',
        group: 'Before the agents',
        does: 'Before the agents run, scans the changed lines with static tools (a secret scanner, a dependency CVE scanner) and hands what they flag to the review. Beta, and off unless a repository turns it on.',
        pipeline: ['RunAnalyzersStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The stage, its router and its tools',
                specs: [
                    'libs/code-review/pipeline/stages/run-analyzers.stage.spec.ts',
                    'libs/code-review/pipeline/analyzer-tool-registry.spec.ts',
                    'libs/code-review/infrastructure/analyzers/analyzer-tool.router.spec.ts',
                    'libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions.spec.ts',
                    'libs/code-review/infrastructure/analyzers/revert-patch.spec.ts',
                    'libs/code-review/infrastructure/analyzers/tools/secret-scan.tool.spec.ts',
                    'libs/code-review/infrastructure/analyzers/tools/dependency-scan.tool.spec.ts',
                ],
            },
        ],
        eval: null,
        note: 'No model decides anything here. What the scanners catch is a benchmark run by hand (scripts/security-benchmark/stage), not an eval.',
    },
    {
        id: 'finder',
        name: 'Finder',
        short: 'Finds the bugs in the PR',
        group: 'The agents, side by side',
        does: 'The agent that looks for bugs. It reads the PR and the repository with tools (opening files, searching, running commands in a sandbox) and writes down each problem it finds, with its lines and a fix. Verify then checks each one.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The agent, its loop and its prompt',
                specs: [
                    'libs/code-review/infrastructure/agents/core/finder.agent.spec.ts',
                    'libs/code-review/infrastructure/agents/core/finder.agent.revision-field.spec.ts',
                    'libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.spec.ts',
                    'libs/code-review/infrastructure/agents/prompts/prompt-builder.spec.ts',
                    'libs/code-review/infrastructure/agents/prompts/prompt-builder.snapshot.spec.ts',
                ],
            },
            { kind: 'contract', name: "A scripted model's review of a PR reaches scoring with its finding", wiring: ['finder-recall'] },
            { kind: 'unit', name: "An org with no model of its own: the default model is built on Kodus's key", specs: ['libs/llm/byok-to-vercel.env-default.spec.ts'] },
            { kind: 'contract', name: "An org with no model of its own: the review runs end to end on Kodus's default model", wiring: ['managed-route'] },
            { kind: 'contract', name: "Kodus's default model is a real model the provider answers", signal: 'contract.api', spec: 'libs/llm/trial-model-availability.contract.spec.ts' },
        ],
        eval: {
            path: 'evals/investigation',
            metric: 'of known bugs found',
            sets: {
                controlled: '15 real PRs whose bugs we know, three per repository',
                full: 'all 50 real PRs whose bugs we know',
            },
            nightly: 'finder-recall',
            caveat: "Counts the known bugs the review ships. A real bug outside the dataset's list counts against precision, not for recall.",
        },
    },
    {
        id: 'memories',
        name: 'Following memories',
        short: "Follows the team's memories",
        group: 'The agents, side by side',
        does: "Inside the finder: follows the team's memories (conventions the team saved). Stays quiet on code a memory says is intended, flags code a memory says is wrong.",
        pipeline: ['AgentReviewStage'],
        tests: [
            { kind: 'unit', name: 'Memories reach the prompt', specs: ['test/unit/shared/utils/prompts/memories-injection.spec.ts'] },
            { kind: 'contract', name: "A scripted model's review of each memory case runs end to end", wiring: ['memories'] },
        ],
        eval: {
            path: 'evals/memories',
            metric: 'of memory cases the review got right',
            sets: {
                controlled: 'small invented pull requests, one per kind of memory production teams keep, each paired with a bug the memory must not silence',
                full: null,
            },
            nightly: 'shared',
        },
    },
    {
        id: 'repo-instructions',
        name: 'Agent instructions',
        short: "Checks the repo's coding-agent instructions",
        group: 'The agents, side by side',
        does: "Inside the finder, when the team turns it on: lists the CLAUDE.md, AGENTS.md, .cursor/rules and Copilot instructions that govern the changed files, reads them from the target branch, and reports a change that breaks one, quoting it.",
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'Which files govern the change, the read tool, the quote check',
                specs: [
                    'libs/code-review/infrastructure/agents/collaborators/repo-instructions.spec.ts',
                    'libs/code-review/infrastructure/agents/adapters/repo-instruction-tool.spec.ts',
                    'libs/code-review/infrastructure/agents/core/finder-with-verify.spec.ts',
                ],
            },
            { kind: 'contract', name: "A scripted model reads the CLAUDE.md through the tool and the verifier gets it", wiring: ['repo-instructions'] },
        ],
        eval: {
            path: 'evals/repo-instructions',
            metric: 'of violation lines the review posts',
            sets: {
                controlled: 'real merged PRs, one per repository and convention, each with a CLAUDE.md on its target branch stating the convention it breaks beside a decoy',
                full: 'every such PR (14)',
            },
            nightly: 'shared',
            caveat: "Counts what the review posts under the team's default severity and quantity filters, which drop most of these findings (the finder rates them low); what the finder reported before the filters is shown beside it.",
        },
    },
    {
        id: 'parse',
        name: 'Output parsing',
        short: "Turns the finder's output into findings",
        group: 'The agents, side by side',
        does: "Turns what the finder writes at the end of each run into findings, and recovers the ones a model wrote as prose instead of the schema.",
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The findings schema and the JSON extraction',
                specs: [
                    'libs/code-review/infrastructure/agents/core/findings-schema.spec.ts',
                    'test/unit/code-review/agents/findings-schema-sanitize.spec.ts',
                    'test/unit/common/prompt-parser-extract-json.spec.ts',
                ],
            },
            { kind: 'contract', name: 'Recorded outputs of nine production models go through the parse; a finding written twice in two shapes parses the same', wiring: ['parse', 'review-chain', 'shape-invariance'] },
        ],
        eval: null,
        note: 'Tests only for now: they replay recorded model output through production\'s parse. An eval of this step comes later.',
    },
    {
        id: 'verify',
        name: 'Verify',
        short: 'Drops findings the code does not confirm',
        group: 'The agents, side by side',
        does: 'Checks each bug the finder proposes against the code, with its own tools, and drops the ones the code does not confirm: claims the code contradicts, hallucinations, nits. What it keeps moves on toward the PR.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The verifier, its verdict and the verification pass',
                specs: [
                    'libs/code-review/infrastructure/agents/core/verifier.agent.contract.spec.ts',
                    'libs/code-review/infrastructure/agents/core/verifier.agent.previous-decisions-path.spec.ts',
                    'libs/code-review/infrastructure/agents/core/verifier.agent.telemetry.spec.ts',
                    'libs/agent-harness/infrastructure/orchestration/verification-pass.spec.ts',
                    'libs/agent-harness/infrastructure/verify/llm-verdict.spec.ts',
                ],
            },
            { kind: 'contract', name: "A scripted verdict reaches the evidence gate, and verify keeps a confirmed finding and drops a refuted one", wiring: ['verifier-verdict', 'funnel-verify'] },
        ],
        eval: {
            path: 'evals/funnel/verify',
            metric: 'of known bugs reaching verify kept, and of its control checks right',
            sets: FUNNEL_SETS,
            nightly: 'shared',
            caveat: 'Counts the known bugs verify keeps, and one false claim it must drop. The other wrong findings it drops do not count yet: the dataset only marks known bugs.',
        },
    },
    {
        id: 'kody-rules',
        name: 'Finding violations',
        short: "Flags every break of the team's rules",
        group: 'The agents, side by side',
        does: "The Kody Rules agent, beside the finder: checks the PR against each of the team's rules and flags every place the code breaks one. A mechanical rule becomes a pattern search whose hits the AI confirms.",
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The agent, its path match and the rule compiler',
                specs: [
                    'libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.spec.ts',
                    'test/unit/code-review/agents/kody-rules-agent-path-match.spec.ts',
                    'libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler.spec.ts',
                    'libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler.prompt.spec.ts',
                ],
            },
            { kind: 'contract', name: "Production's review of a merged PR compiles a rule and runs the stage", wiring: ['kody-rules'] },
        ],
        eval: {
            path: 'evals/kody-rules',
            metric: 'of known rule violations flagged',
            sets: { controlled: 'real PRs where we know every line that breaks a rule', full: null },
            nightly: 'kody-rules',
            caveat: 'The set holds mechanical rules only (no console, no any, no process.env, no generic Error): a green number says the rule machinery works, not that Kody is good at harder rules. A Ruby-only rule over polyglot PRs runs by hand (--dataset=polyglot-cases).',
        },
    },
    {
        id: 'custom-agents',
        name: 'Custom agents',
        short: "Runs the team's own reviewers in their lane",
        group: 'The agents, side by side',
        does: 'Beside the finder: each custom agent the team set up reviews only the files its globs match (an ignored file too, when a glob names it), reports only what its instructions ask for, and its findings go through verify, its own severity floor and comment limit, then dedup. A disabled agent does not run.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'Scope, dispatch, lane, quote gate, floor and cap, directory cascade',
                specs: [
                    'libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope.spec.ts',
                    'libs/code-review/infrastructure/agents/review-orchestrator.custom-agents.spec.ts',
                    'libs/code-review/infrastructure/agents/providers/custom-agent.provider.spec.ts',
                    'libs/code-review/infrastructure/agents/prompts/prompt-builder.custom-agent.spec.ts',
                    'libs/code-review/infrastructure/agents/core/convention-check.spec.ts',
                    'libs/code-review/pipeline/stages/agent-review.stage.custom-agents.spec.ts',
                    'libs/code-review/pipeline/stages/fetch-changed-files.stage.spec.ts',
                    'libs/ee/codeBase/__tests__/directory-custom-agents-cascade.spec.ts',
                ],
            },
            { kind: 'contract', name: "A scripted model's review of each case: what the review hands every agent (scope, ignored files, disabled agents)", wiring: ['custom-agents'] },
        ],
        eval: {
            path: 'evals/custom-agents',
            metric: "of the agents' property checks right",
            sets: {
                controlled: 'small invented pull requests, each reviewed by a team with one custom agent: a violation of its instructions to flag, a defect outside them and a file outside its globs to leave alone, an ignored file its glob names, and compliant controls',
                full: null,
            },
            nightly: 'shared',
            caveat: 'Severity floor, comment limit and the quote gate are held by the unit specs, not this eval: the cases set no floor or limit and link no guide.',
        },
    },
    {
        id: 'anchoring',
        name: 'Anchoring',
        short: 'Places each finding on its diff lines',
        group: 'After the agents',
        does: 'Places each finding on the file and lines of the diff: drops one whose file is not in the PR, and moves its lines onto the changed lines it is about.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The path check and the line snap',
                specs: [
                    'libs/code-review/pipeline/stages/agent-review.stage.file-anchor.spec.ts',
                    'libs/code-review/pipeline/stages/agent-review.stage.diff-boundary.spec.ts',
                    'test/unit/shared/utils/resolve-added-line-anchor.spec.ts',
                ],
            },
            { kind: 'contract', name: 'Keeps a finding on a changed line and drops one outside the diff', wiring: ['funnel-anchoring'] },
        ],
        eval: null,
        note: "Tests only for now: no model decides here. Run on a production review's findings by hand: node evals/funnel/anchoring/run.js.",
    },
    {
        id: 'review-rounds',
        name: 'Later rounds',
        short: 'Posts nothing twice on a later push',
        group: 'After the agents',
        does: 'On a new push to a PR Kody already reviewed, decides what to post again: no repost of a comment the PR already has or the developer declined, and no new problem or revision lost.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The repeat check and the decision history',
                specs: [
                    'libs/code-review/infrastructure/agents/engine/repeat-check.spec.ts',
                    'libs/code-review/pipeline/stages/agent-review.stage.repeat-check.spec.ts',
                    'libs/code-review/infrastructure/adapters/services/pr-decision-store.service.spec.ts',
                    'libs/code-review/pipeline/stages/load-external-context.stage.previous-decisions.spec.ts',
                ],
            },
            { kind: 'contract', name: 'Two rounds of a PR, and a Kody Rule lifecycle, run end to end', wiring: ['review-rounds', 'review-lifecycle'] },
        ],
        eval: {
            path: 'evals/review-rounds',
            metric: 'of claims handled right',
            sets: {
                controlled: 'later rounds of a PR (targets.json sets.nightly): reposts that must stay off it, new problems and revisions that must post',
                full: null,
            },
            nightly: 'shared',
            caveat: 'The full set, the lifecycle chains and other judges run by hand.',
        },
    },
    {
        id: 'dedup',
        name: 'Dedup',
        short: 'Merges findings about the same bug',
        group: 'After the agents',
        does: 'Merges findings that describe the same problem into one comment, so the developer does not read the same bug twice, without merging two different bugs.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The dedup contract and its merge guard',
                specs: ['libs/code-review/pipeline/stages/agent-review.stage.dedup-contract.spec.ts', 'libs/code-review/infrastructure/agents/engine/dedup-prompt.spec.ts'],
            },
            { kind: 'contract', name: 'Merges two findings of one bug and keeps two different bugs', wiring: ['funnel-dedup'] },
        ],
        eval: {
            path: 'evals/funnel/dedup',
            metric: 'of known bugs reaching dedup kept, and of its control checks right',
            sets: FUNNEL_SETS,
            nightly: 'shared',
            caveat: 'Counts the known bugs a wrong merge loses, and one duplicate it must merge. Duplicates still posted do not count yet: the dataset has no labels for them.',
        },
    },
    {
        id: 'severity',
        name: 'Severity',
        short: 'Rates each finding, drops the minor ones',
        group: 'After the agents',
        does: "Gives each finding a severity (critical, high, medium or low); the team's minimum (medium by default) then drops what falls below it. A real bug rated too low is dropped here without anyone seeing it.",
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The classifier and the threshold',
                specs: ['libs/code-review/infrastructure/agents/engine/classify-severity.spec.ts', 'libs/code-review/infrastructure/agents/engine/survives-severity-filter.spec.ts'],
            },
            { kind: 'contract', name: 'Keeps a crash and drops a naming nit at the default threshold', wiring: ['funnel-severity'] },
            { kind: 'contract', name: "Rates a PR's suggestions in one call and maps each level back", wiring: ['severity-levels'] },
        ],
        eval: {
            path: 'evals/funnel/severity',
            metric: 'of known bugs reaching severity kept above the threshold, and of its control checks right',
            sets: FUNNEL_SETS,
            nightly: 'shared',
        },
    },
    {
        id: 'enrichment',
        name: 'Enrichment',
        short: 'Titles each finding and writes its fix',
        group: 'After the agents',
        does: 'Completes each finding the review keeps: the cited code and its language from the file at the PR head, then one model call for a title that names the problem and, when a fix fits exactly the cited lines, the code that replaces them. A finding with no fix that fits ships with no code.',
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'What the call gets and what the finding keeps',
                specs: [
                    'libs/code-review/infrastructure/agents/engine/enrich-suggestions.spec.ts',
                    'libs/code-review/infrastructure/agents/engine/enrich-deterministic.spec.ts',
                    'libs/code-review/pipeline/stages/agent-review.stage.post-finder.spec.ts',
                ],
            },
            { kind: 'contract', name: 'Enriches each finding in one call and keeps it when the call fails', wiring: ['suggestion-enrichment'] },
        ],
        eval: {
            path: 'evals/suggestion-enrichment',
            metric: 'of fixable findings, a fix the judge passes; of the others, no code; of all, a title that names the problem in 80 characters',
            sets: { controlled: 'the 150 confirmed findings of the enrichment dataset, each with its file at the PR head', full: null },
            nightly: 'shared',
            caveat: 'Graded by Opus 5.5 against Astra references: a floor holds only under that judge.',
        },
    },
    {
        id: 'format',
        name: 'Formatting',
        short: 'Writes the comment the developer reads',
        group: 'After the agents',
        does: "Rewrites each finding into the comment the developer reads: plain prose in the team's language and length, with its code names kept and no WHAT/WHY/HOW labels.",
        pipeline: ['AgentReviewStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The formatter and what it is given',
                specs: ['libs/code-review/infrastructure/agents/engine/format-and-shape-suggestions.spec.ts', 'libs/code-review/pipeline/stages/agent-review.stage.formatter-input.spec.ts'],
            },
            { kind: 'contract', name: 'Every case formats through the local fallback when the model answers nothing usable', wiring: ['format'] },
        ],
        eval: {
            path: 'evals/format',
            metric: 'of findings formatted right',
            sets: { controlled: 'batches of findings: each of 31 real reviews under four team languages and a writing guideline', full: null },
            nightly: 'shared',
            caveat: 'Checks the text a reviewer sees, not whether the claim stayed the same.',
        },
    },
    {
        id: 'pr-comments',
        name: 'PR-level comments',
        short: 'Posts the findings with no diff line',
        group: 'On the PR',
        does: 'Posts the findings that have no line in the diff as one comment on the PR.',
        pipeline: ['CreatePrLevelCommentsStage'],
        tests: [{ kind: 'unit', name: 'The stage', specs: ['libs/code-review/pipeline/stages/create-pr-level-comments.stage.spec.ts'] }],
        eval: null,
    },
    {
        id: 'posting',
        name: 'Posting',
        short: 'Validates and posts each comment',
        group: 'On the PR',
        does: 'Checks each comment is valid for the code host, then posts it on its file and line.',
        pipeline: ['ValidateSuggestionsStage', 'CreateFileCommentsStage'],
        tests: [
            {
                kind: 'unit',
                name: 'Validation and posting',
                specs: [
                    'libs/code-review/pipeline/stages/validate-suggestions.stage.spec.ts',
                    'test/unit/code-review/pipeline/stages/validate-suggestions.stage.spec.ts',
                    'test/unit/code-review/pipeline/stages/validate-suggestions-chunking.spec.ts',
                    'libs/code-review/pipeline/stages/create-file-comments.stage.spec.ts',
                    'test/unit/code-review/pipeline/stages/create-file-comments.stage.spec.ts',
                ],
            },
        ],
        eval: null,
    },
    {
        id: 'pr-summary',
        name: 'PR summary',
        short: 'Writes the PR description',
        group: 'On the PR',
        does: "Writes the PR description Kody posts when a PR opens or gets a new commit, the way the team configured it: replacing the author's, added to it, or complementing it.",
        pipeline: ['UpdateCommentsAndGenerateSummaryStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The summary and its findings',
                specs: ['test/unit/code-review/services/commentManager-summary-findings.spec.ts', 'test/unit/code-review/services/commentManager-summary-chunking.spec.ts'],
            },
            { kind: 'contract', name: "Generated, posted, sent to the org's model and composed as configured, with a scripted model", wiring: ['pr-summary'] },
            { kind: 'contract', name: "Generated, posted, sent to the org's model and composed as configured, on every tier-0 model", weekly: ['evals/pr-summary/run.js', '--gate'] },
        ],
        eval: null,
        note: 'Tests only for now: summaries once died for every client because the step went to a model nobody configured, and these catch that. Whether a summary is a good one is not measured yet.',
    },
    {
        id: 'approval',
        name: 'Approval',
        short: 'Approves or requests changes',
        group: 'On the PR',
        does: 'Approves the PR or requests changes, when the team turned it on.',
        pipeline: ['RequestChangesOrApproveStage'],
        tests: [
            {
                kind: 'unit',
                name: 'The approval flow and its cron',
                specs: ['libs/code-review/pipeline/stages/summary-failure-to-approve.flow.spec.ts', 'apps/api/src/cron/CheckIfPRCanBeApproved.cron.spec.ts', 'apps/api/src/cron/__tests__/CheckIfPRCanBeApproved.cron.spec.ts'],
            },
        ],
        eval: null,
    },
    {
        id: 'rules-learned',
        name: 'Learned from reviews',
        short: 'Writes rules from past reviews',
        group: 'Where rules and memories come from',
        does: "Writes Kody Rules from what the team's reviewers said on past PRs.",
        pipeline: null,
        tests: [
            {
                kind: 'unit',
                name: 'Which comments it reads, and its cron',
                specs: ['libs/kodyRules/application/use-cases/generate-kody-rules.use-case.spec.ts', 'test/unit/kodyRules/use-cases/generate-kody-rules.sampling.spec.ts', 'apps/api/src/cron/kodyLearning.cron.spec.ts'],
            },
        ],
        eval: null,
        note: 'Nothing checks the rules it writes.',
    },
    {
        id: 'rules-from-files',
        name: 'From repo files',
        short: 'Imports rules from repository files',
        group: 'Where rules and memories come from',
        does: 'Imports rules from files in the repository (.kody/rules, AGENTS.md, IDE rule files) and keeps them in sync.',
        pipeline: null,
        tests: [
            {
                kind: 'unit',
                name: 'The sync, the rule-file parser and the file patterns',
                specs: [
                    'libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service.spec.ts',
                    'libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.context-reference-pointer.spec.ts',
                    'test/unit/common/kody-rule-file-parser.spec.ts',
                    'test/unit/common/kody-rules-file-patterns.spec.ts',
                    'libs/common/utils/kody-rules/file-patterns.spec.ts',
                    'test/unit/kodyRules/use-cases/resync-rules-from-ide.use-case.spec.ts',
                ],
            },
            { kind: 'e2e', name: 'File sync, lifecycle and rule-file detection on a real stack', scenario: 'tests/e2e/scenarios/kody-rules-file-sync.ts', signal: 'e2e.selfhosted.matrix' },
        ],
        eval: null,
    },
    {
        id: 'thread-rule',
        name: 'Rule from a thread',
        short: 'Creates or narrows a rule from a thread',
        group: 'Where rules and memories come from',
        does: 'In a PR thread, offers to create a Kody Rule, or to narrow one the thread shows is too broad, and does it when the developer asks.',
        pipeline: null,
        tests: [
            {
                kind: 'unit',
                name: 'What the agent may write, and when',
                specs: ['libs/agents/infrastructure/services/agents/conversation/write-gate.policy.spec.ts', 'libs/agents/infrastructure/services/agents/conversation/write-truth.policy.spec.ts'],
            },
            { kind: 'contract', name: "Each thread runs end to end through production's MCP server", wiring: ['thread-rule'] },
        ],
        eval: {
            path: 'evals/thread-actions',
            catalog: 'evals/thread-actions/catalog.js#rule',
            metric: 'of write checks right',
            sets: { controlled: 'invented PR threads that do or do not call for a Kody Rule, in English and Portuguese', full: null },
            nightly: 'shared',
            caveat: "Counts the writes: the rule lands when the developer asks and nothing is written unasked. Whether the reply offers it is reported beside the number, not gated: production's MCP client drops the tools' proactiveHint (libs/mcp-server/mcp-adapter/client.ts listTools).",
        },
    },
    {
        id: 'thread-memory',
        name: 'Memory from a thread',
        short: 'Saves a memory from a thread',
        group: 'Where rules and memories come from',
        does: 'In a PR thread that shows a team convention, offers to save it as a memory, and saves it when the developer asks.',
        pipeline: null,
        tests: [
            {
                kind: 'unit',
                name: 'What the agent may write, and when',
                specs: ['libs/agents/infrastructure/services/agents/conversation/write-gate.policy.spec.ts', 'libs/agents/infrastructure/services/agents/conversation/write-truth.policy.spec.ts'],
            },
            { kind: 'contract', name: "Each thread runs end to end through production's MCP server", wiring: ['thread-memory'] },
        ],
        eval: {
            path: 'evals/thread-actions',
            catalog: 'evals/thread-actions/catalog.js#memory',
            metric: 'of write checks right',
            sets: { controlled: 'invented PR threads that do or do not call for a memory, in English and Portuguese', full: null },
            nightly: 'shared',
            caveat: "Counts the writes: the memory lands when the developer asks and nothing is written unasked. Whether the reply offers it is reported beside the number, not gated: production's MCP client drops the tools' proactiveHint (libs/mcp-server/mcp-adapter/client.ts listTools).",
        },
    },
    {
        id: 'reply-addressing',
        name: 'Thread replies',
        short: 'Decides if a reply is meant for Kody',
        group: 'Conversation with Kody',
        does: 'When someone replies in a thread Kody started without writing @kody, decides whether the reply is meant for Kody (and answers it) or for another person (and stays out).',
        pipeline: null,
        tests: [
            {
                kind: 'unit',
                name: 'The thread, the free gate and the classifier call',
                specs: [
                    'libs/platform/application/use-cases/codeManagement/reply-thread.spec.ts',
                    'libs/platform/application/use-cases/codeManagement/implicit-reply.spec.ts',
                    'libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.implicit-reply.spec.ts',
                ],
            },
            { kind: 'contract', name: 'Two replies go through the gate and the classifier with a scripted model', wiring: ['reply-addressing'] },
        ],
        eval: {
            path: 'evals/reply-addressing',
            metric: 'of replies handled right',
            sets: {
                controlled: 'conversations where someone replies in a Kody thread without @kody',
                full: 'the same conversations and 373 real replies from kodus-ai threads, labelled by hand',
            },
            nightly: 'shared',
        },
    },
    {
        id: 'conversation',
        name: 'Conversation replies',
        short: 'Answers a developer from the code',
        group: 'Conversation with Kody',
        does: "Answers a developer who replies to a Kody comment, from the code: whether a claimed fix landed, whether a decline holds, or the answer to a question, in the team's language.",
        pipeline: null,
        tests: [
            {
                kind: 'unit',
                name: 'The agent, its prompt and its decision',
                specs: [
                    'libs/agents/infrastructure/services/agents/conversation/conversationAgent.spec.ts',
                    'libs/agents/infrastructure/services/agents/conversation/conversation-decision.spec.ts',
                    'libs/agents/infrastructure/services/agents/conversation/conversation-prompt.spec.ts',
                    'libs/agents/infrastructure/services/agents/conversation/conversation-response.util.spec.ts',
                    'libs/agents/infrastructure/services/agents/conversation/conversation-tool-audit.spec.ts',
                    'libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.spec.ts',
                ],
            },
            { kind: 'contract', name: "Each thread runs end to end through production's sandbox and MCP server", wiring: ['conversation'] },
        ],
        eval: {
            path: 'evals/conversation',
            metric: 'of reply checks right',
            sets: { controlled: 'invented threads where the developer is right or wrong about the code, in English and Portuguese', full: null },
            nightly: 'shared',
            caveat: 'A judge reads whether the reply asserts what the code shows; offering or taking actions is evals/thread-actions.',
        },
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

// Every unit spec a stage names, once: what evals/stage-tests.js runs.
const unitSpecs = (stages = STAGES) => [...new Set(stages.flatMap((s) => s.tests.filter((t) => t.kind === 'unit').flatMap((t) => t.specs)))];

// The wiring smoke steps a stage's contract tests name.
const wiringSteps = (stage) => stage.tests.filter((t) => t.kind === 'contract' && t.wiring).flatMap((t) => t.wiring);

module.exports = { STAGES, GROUPS, PLUMBING, FUNNEL_SETS, unitSpecs, wiringSteps };
