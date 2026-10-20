#!/usr/bin/env node
// Approval decision stage on supplied PR snapshots. Controlled cases prove
// wiring; full cases require adjudicated historical snapshots.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { registerTs, countTokens, tokensUsed } = require('../shared/eval-kit');
const { orgRouteOrExit } = require('../shared/model-route');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
        return match ? [match[1], match[2] ?? true] : [arg, true];
    }),
);
const model = args.model || 'deepseek-v4-flash@fireworks';
const set = args.set || 'controlled';
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
registerTs();
const route = orgRouteOrExit(model);
const {
    routeCodeReviewModel,
} = require('../../libs/code-review/pipeline/stages/route-code-review-model.ts');
const {
    DecidePrApprovalStage,
} = require('../../libs/code-review/pipeline/stages/decide-pr-approval.stage.ts');
const {
    evaluateApproval,
} = require('../../libs/code-review/domain/approval/approval-decision.ts');
const targets = require('./targets.json');

function loadCases() {
    if (set === 'controlled') return require('./controlled.json');
    if (set !== 'full') throw new Error(`Unknown set: ${set}`);
    const adjudications = require('./adjudications.json').cases;
    const scored = adjudications.filter((row) =>
        ['hold', 'eligible'].includes(row.decision),
    );
    if (scored.length < 200)
        throw new Error(
            'Full set needs at least 200 adjudicated PRs',
        );
    const snapshots = path.join(__dirname, 'snapshots.json.gz');
    if (!fs.existsSync(snapshots))
        throw new Error('Full set snapshots have not been materialized');
    const byId = new Map(
        JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshots))).cases.map((row) => [
            row.id,
            row,
        ]),
    );
    return scored.map((row) => {
        const snapshot = byId.get(row.id);
        if (!snapshot || snapshot.headSha !== row.snapshotSha)
            throw new Error(`Missing or stale snapshot ${row.id}`);
        if (
            snapshot.areaMap &&
            Date.parse(snapshot.areaMap.windowEnd) > Date.parse(row.snapshotAt)
        ) {
            throw new Error(`Area map leaks future history for ${row.id}`);
        }
        return {
            ...snapshot,
            expect: row.decision === 'eligible' ? 'approve' : 'hold',
            snapshotAt: row.snapshotAt,
        };
    });
}

async function runCase(item, slot, withMap = true) {
    const headSha = item.headSha || `eval-${item.id}`;
    const pr = {
        number: item.prNumber || 1,
        title: item.title,
        body: item.body || '',
        head: { sha: headSha },
        user: { login: item.author || 'eval-author' },
    };
    const host = {
        getPullRequest: async () => ({ ...pr, labels: item.labels || [] }),
    };
    const maps = { read: async () => (withMap ? item.areaMap || null : null) };
    const stage = new DecidePrApprovalStage(host, maps);
    const context = {
        organizationAndTeamData: {
            organizationId: '00000000-0000-4000-8000-00000000e7a1',
            teamId: 'eval-team',
        },
        repository: {
            id: item.repositoryId || 'eval-repo',
            name: item.repository || 'eval-repo',
        },
        pullRequest: pr,
        codeReviewConfig: {
            pullRequestApprovalActive: true,
            approvalRiskActive: true,
            ...item.policy,
            resolvedModelSlot: slot,
        },
        origin: 'github',
        lineComments: [],
        prLevelCommentResults: [],
        preliminaryFiles: item.files,
        changedFiles: item.files,
        ignoredFileChanges: [],
    };
    const result = await stage.execute(context);
    return { decision: result.approvalDecision, risk: result.approvalRisk };
}

function summaryMetrics(rows) {
    const scored = rows.filter((row) => row.total);
    const groups = {
        hold: scored.filter((row) => row.metadata.expect === 'hold'),
        eligible: scored.filter((row) => row.metadata.expect === 'approve'),
        sparseHold: scored.filter(
            (row) => row.metadata.sparseHistory && row.metadata.expect === 'hold',
        ),
        sparseEligible: scored.filter(
            (row) => row.metadata.sparseHistory && row.metadata.expect === 'approve',
        ),
        linkedBugHold: scored.filter(
            (row) => row.metadata.linkedBugHistory && row.metadata.expect === 'hold',
        ),
        linkedBugEligible: scored.filter(
            (row) => row.metadata.linkedBugHistory && row.metadata.expect === 'approve',
        ),
    };
    const arms = ['baseline', 'modelOnly', 'modelAndMap'];
    return Object.fromEntries(
        arms.map((arm) => {
            const hold = groups.hold.filter(
                (row) => row.metadata.arms[arm] === 'approve',
            ).length;
            const coverage = groups.eligible.filter(
                (row) => row.metadata.arms[arm] === 'approve',
            ).length;
            const approvals = (group) =>
                group.filter((row) => row.metadata.arms[arm] === 'approve')
                    .length;
            return [
                arm,
                {
                    wrongApprovals: { count: hold, of: groups.hold.length },
                    eligibleCoverage: {
                        count: coverage,
                        of: groups.eligible.length,
                    },
                    sparseWrongApprovals: {
                        count: approvals(groups.sparseHold),
                        of: groups.sparseHold.length,
                    },
                    sparseEligibleCoverage: {
                        count: approvals(groups.sparseEligible),
                        of: groups.sparseEligible.length,
                    },
                    linkedBugWrongApprovals: {
                        count: approvals(groups.linkedBugHold),
                        of: groups.linkedBugHold.length,
                    },
                    linkedBugEligibleCoverage: {
                        count: approvals(groups.linkedBugEligible),
                        of: groups.linkedBugEligible.length,
                    },
                },
            ];
        }),
    );
}

function touchesLinkedBugHistory(item) {
    const directPaths = new Set(
        item.files.map((file) => {
            const slash = file.filename.lastIndexOf('/');
            return slash < 0 ? '.' : file.filename.slice(0, slash);
        }),
    );
    return Boolean(
        item.areaMap?.directDirectories?.some(
            (area) =>
                directPaths.has(area.path) && area.linkedBugFixPrs > 0,
        ),
    );
}

async function main() {
    let cases;
    try {
        cases = loadCases();
    } catch (error) {
        console.error(`not measured: ${error.message}`);
        return 2;
    }
    const slot = routeCodeReviewModel(route.storedConfig, {}).resolvedModelSlot;
    if (!slot) {
        console.error('not measured: no production model slot');
        return 2;
    }
    countTokens();
    const rows = [];
    let errored = 0;
    for (const item of cases) {
        try {
            if (set === 'full') {
                const baseline = evaluateApproval({
                    approvalActive: true,
                    reviewClean: true,
                });
                const modelOnly = await runCase(item, slot, false);
                const modelAndMap = await runCase(item, slot, true);
                if (
                    modelOnly.risk?.level === 'unknown' ||
                    modelAndMap.risk?.level === 'unknown'
                ) {
                    throw new Error('Model risk judgment was unavailable');
                }
                const arms = {
                    baseline: baseline.kind,
                    modelOnly: modelOnly.decision?.kind,
                    modelAndMap: modelAndMap.decision?.kind,
                };
                const ok = arms.modelAndMap === item.expect;
                rows.push({
                    id: item.id,
                    checks: `At the pre-review snapshot, an adjudicator judged this PR ${item.expect === 'approve' ? 'eligible' : 'in need of human approval'}.`,
                    hits: Number(ok),
                    total: 1,
                    detail: [
                        {
                            what: `${arms.modelAndMap} expected ${item.expect}`,
                            ok,
                        },
                    ],
                    metadata: {
                        expect: item.expect,
                        arms,
                        sparseHistory:
                            !item.areaMap ||
                            item.areaMap.coverage?.scannedPrs < 10,
                        linkedBugHistory: touchesLinkedBugHistory(item),
                    },
                });
            } else {
                const { decision, risk } = await runCase(item, slot);
                if (risk?.level === 'unknown')
                    throw new Error('Model risk judgment was unavailable');
                const ok = decision?.kind === item.expect;
                rows.push({
                    id: item.id,
                    checks: item.checks,
                    hits: Number(ok),
                    total: 1,
                    detail: [
                        {
                            what: `${decision?.kind} expected ${item.expect}`,
                            ok,
                        },
                    ],
                });
            }
        } catch (error) {
            errored++;
            rows.push({
                id: item.id,
                checks: item.checks,
                hits: 0,
                total: 0,
                unmeasured: true,
            });
            console.error(`${item.id}: ${error.message}`);
        }
    }
    const hits = rows.reduce((sum, row) => sum + row.hits, 0);
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const target = targets.models[model] || {};
    const result = {
        eval: 'approval-risk',
        question: evalQuestion('evals/approval-risk'),
        model,
        runs: 1,
        metric: {
            name: 'approval decisions matching adjudication',
            value: total ? hits / total : null,
            floor: target.floor ?? null,
            baseline: target.observed ?? null,
        },
        cases: rows,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
        ...(set === 'full' ? { comparisons: summaryMetrics(rows) } : {}),
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), {
            recursive: true,
        });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(
        `approval-risk: ${hits}/${total} decisions match · ${errored} unmeasured`,
    );
    if (errored / cases.length > 0.05 || resultProblems(result).length)
        return 2;
    if (args.gate && target.floor != null && result.metric.value < target.floor)
        return 1;
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
