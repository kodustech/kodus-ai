#!/usr/bin/env node
// Contract for the shared pre-review assessment. Scripted vendor, production services.
const fs = require('node:fs');
const path = require('node:path');
const { registerTs, countTokens, tokensUsed } = require('../shared/eval-kit');
const { orgRouteOrExit, EVAL_ORG } = require('../shared/model-route');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
        return match ? [match[1], match[2] ?? true] : [arg, true];
    }),
);
const model = args.model || 'eval-fake';
if (model !== 'eval-fake') {
    console.error(
        'not measured: this contract uses scripted vendor responses; risk quality needs an adjudicated corpus',
    );
    process.exit(2);
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
process.env.API_CLOUD_MODE = 'true';
registerTs();
const { stageFor } = require('./runtime');
const {
    resolveRiskReviewMode,
} = require('../../libs/code-review/domain/review-mode.ts');
const {
    selectCustomAgents,
} = require('../../libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope.ts');
const {
    riskApprovalVeto,
} = require('../../libs/code-review/domain/risk/risk-assessment.ts');

async function runCase(item, storedConfig) {
    const { pr, stage, approvalStage } = stageFor(item, storedConfig);
    const before = tokensUsed().calls;
    const result = await stage.execute({
        organizationAndTeamData: EVAL_ORG,
        repository: { id: 'eval-repo', name: 'eval-repo' },
        pullRequest: pr,
        origin: 'github',
        codeReviewConfig: {
            riskAssessmentActive: item.active,
            pullRequestApprovalActive: false,
        },
    });
    const risk = result.riskAssessment;
    const approvalInput = {
        ...result,
        lineComments: [],
        prLevelCommentResults: [],
        codeReviewConfig: {
            ...result.codeReviewConfig,
            pullRequestApprovalActive: true,
            approvalPolicies: item.policies ?? [
                { id: 'all', name: 'All clean PRs', enabled: true },
            ],
        },
    };
    const decision = await approvalStage.execute(approvalInput);
    const calls = tokensUsed().calls - before;
    const beforeReplay = tokensUsed().calls;
    const replay = await approvalStage.execute({
        ...approvalInput,
        lastExecution: {
            approvalPolicyEligibility: decision.approvalPolicyEligibility,
        },
    });
    return {
        status: risk.status,
        ...(risk.status === 'assessed'
            ? { riskIdentified: risk.riskIdentified }
            : {}),
        mode: resolveRiskReviewMode({
            risk,
            currentHeadSha: 'head',
            heavyAllowed: true,
        }),
        agentRuns:
            selectCustomAgents(
                [
                    {
                        id: 'agent',
                        name: 'Risk check',
                        enabled: true,
                        runWhen: 'risk-found',
                    },
                ],
                undefined,
                risk,
            ).length > 0,
        approvalVeto: Boolean(riskApprovalVeto(item.active, risk, 'head')),
        policyDecision: decision.approvalDecision.kind,
        replayDecisionMatches:
            decision.approvalDecision.kind === replay.approvalDecision.kind,
        replayCalls: tokensUsed().calls - beforeReplay,
        calls,
    };
}

async function main() {
    const route = orgRouteOrExit(model);
    countTokens();
    const cases = require('./cases.json');
    const results = [];
    let errored = 0;
    for (const item of cases) {
        try {
            const output = await runCase(item, route.storedConfig);
            const expected = {
                calls: Number(item.active),
                replayCalls: 0,
                replayDecisionMatches: true,
                ...item.expected,
            };
            const detail = Object.entries(expected).map(([key, value]) => ({
                what: key,
                ok: output[key] === value,
                actual: output[key],
                expected: value,
            }));
            results.push({
                id: item.id,
                checks: item.checks,
                hits: detail.filter((row) => row.ok).length,
                total: detail.length,
                detail,
                metadata: { output },
            });
        } catch (error) {
            errored++;
            results.push({
                id: item.id,
                checks: item.checks,
                hits: 0,
                total: 0,
                unmeasured: true,
            });
            console.error(`${item.id}: ${error.message}`);
        }
    }
    const hits = results.reduce((sum, row) => sum + row.hits, 0);
    const total = results.reduce((sum, row) => sum + row.total, 0);
    const result = {
        eval: 'pr-risk',
        question: evalQuestion('evals/pr-risk'),
        model,
        runs: 1,
        metric: {
            name: 'contract assertions',
            value: total ? hits / total : 0,
            floor: null,
            baseline: null,
        },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), {
            recursive: true,
        });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(
        `pr-risk: ${hits}/${total}, ${result.tokens.calls} model calls; scripted contract, not risk quality`,
    );
    if (errored || resultProblems(result).length) return 2;
    return args.gate && hits !== total ? 1 : 0;
}
main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
