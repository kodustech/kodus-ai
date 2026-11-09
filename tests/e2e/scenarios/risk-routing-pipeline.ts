import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { chromium, expect } from 'playwright/test';
import { http } from '../lib/http.js';
import { settle } from '../providers/base.js';
import type {
    KodusSession,
    OpenedPR,
    ProviderRepoRef,
    RunContext,
    Scenario,
} from '../lib/types.js';

const execute = promisify(execFile);
const FILE = 'src/qa-risk-routing/status.ts';
const AGENT = 'qa-risk-watch';
const safe = 'export const serviceStatus = "ready" as const;\n';
const risky = `/** Reads private tenant documents. Callers rely on this authorization check. */
export function canReadTenantDocuments(requesterTenantId: string, documentTenantId: string): boolean {
    return true;
}
`;
type Evidence = {
    execution: {
        uuid: string;
        status: string;
        heavy?: boolean;
        risk?: { status: string; riskIdentified?: boolean; reason?: string };
        decision?: { kind: string; reason?: string; reviewedHeadSha?: string };
        eligibility?: Record<string, { key: string; status: string }>;
        agentSkips?: Array<{ id: string; reason: string }>;
    } | null;
    stages: Array<{ name: string; status: string }>;
    agents: Array<{ agentId: string; status: string; reason?: string }>;
    models: Array<{
        task: string;
        model: string;
        runName: string;
        calls: number;
        tokens: number;
    }>;
};

async function inspect(
    ctx: RunContext,
    session: KodusSession,
    repo: ProviderRepoRef,
    pr: OpenedPR,
    since: string,
    approvalOnly = false,
): Promise<Evidence> {
    const [bin, entry] = (process.env.RUNO ?? '').split(' ');
    ctx.assert(
        bin === 'bun' && entry && process.env.HEAD_REF,
        'Run through the Runo preview workflow',
    );
    ctx.assert(
        /^[a-f0-9-]{36}$/i.test(session.organizationId) &&
            /^[a-z0-9_-]+$/i.test(String(repo.id)),
        'Invalid evidence identity',
    );
    const command = `docker exec -e PREVIEW_RISK_ROUTING_QA=true kodus_api node scripts/preview/inspect-risk-routing-e2e.cjs ${session.organizationId} ${repo.id} ${pr.number} ${since}${approvalOnly ? ' --approval-only' : ''}`;
    const { stdout } = await execute(
        bin,
        [
            entry,
            'exec',
            '--branch',
            process.env.HEAD_REF!,
            '--profile',
            'cloud',
            '--',
            command,
        ],
        { timeout: 45_000, maxBuffer: 1_000_000 },
    );
    const line = stdout
        .split('\n')
        .find((item) => item.startsWith('RISK_E2E_JSON='));
    ctx.assert(line, 'Runo returned no scoped execution evidence');
    return JSON.parse(line.slice('RISK_E2E_JSON='.length));
}

async function waitForRun(
    ctx: RunContext,
    session: KodusSession,
    repo: ProviderRepoRef,
    pr: OpenedPR,
    since: string,
): Promise<Evidence> {
    const deadline = Date.now() + 12 * 60_000;
    let last: Evidence | undefined;
    while (Date.now() < deadline) {
        last = await inspect(ctx, session, repo, pr, since);
        const status = last.execution?.status;
        if (status && !['pending', 'in_progress', 'queued'].includes(status)) {
            writeFileSync(
                join(
                    ctx.artifactDir,
                    `execution-${pr.number}-${last.execution!.uuid}.json`,
                ),
                JSON.stringify(last, null, 2),
            );
            ctx.assert(
                status === 'success',
                `PR #${pr.number} ended ${status}; stages=${JSON.stringify(last.stages)}`,
            );
            await settle(3_000);
            const settled = await inspect(ctx, session, repo, pr, since);
            ctx.assert(
                settled.execution?.uuid === last.execution!.uuid &&
                    settled.execution.status === 'success',
                'Settled evidence changed execution or lost its successful status',
            );
            writeFileSync(
                join(
                    ctx.artifactDir,
                    `execution-${pr.number}-${settled.execution.uuid}.json`,
                ),
                JSON.stringify(settled, null, 2),
            );
            return settled;
        }
        await settle(8_000);
    }
    throw new Error(
        `PR #${pr.number} did not finish; last status=${last?.execution?.status ?? 'no webhook execution'}`,
    );
}

async function request(
    ctx: RunContext,
    session: KodusSession,
    path: string,
    body?: unknown,
): Promise<any> {
    const result = await http<any>(`${ctx.target.apiBaseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body,
        timeoutMs: 60_000,
    });
    ctx.assert(
        result.status >= 200 && result.status < 300,
        `${path} returned HTTP ${result.status}`,
    );
    return result.body?.data ?? result.body;
}

async function providerState(
    ctx: RunContext,
    repo: ProviderRepoRef,
    pr: OpenedPR,
) {
    // A durable integration identity distinct from the PR author is required:
    // GitHub forbids authors from approving their own PRs.
    const headers = {
        'Authorization': `Bearer ${ctx.provider.authToken()}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const root = `https://api.github.com/repos/${repo.full_name}`;
    const live = await http<{ head: { sha: string } }>(
        `${root}/pulls/${pr.number}`,
        { headers },
    );
    const reviews = await http<
        Array<{
            id: number;
            state: string;
            commit_id: string;
            user: { login: string };
        }>
    >(`${root}/pulls/${pr.number}/reviews`, { headers });
    const comments = await http<Array<{ body: string }>>(
        `${root}/issues/${pr.number}/comments?per_page=100`,
        { headers },
    );
    ctx.assert(
        live.status === 200 &&
            reviews.status === 200 &&
            comments.status === 200,
        'Could not read actual provider approval/comments',
    );
    return {
        headSha: live.body.head.sha,
        approvals: reviews.body.filter(
            (review) =>
                review.state === 'APPROVED' &&
                review.commit_id === live.body.head.sha,
        ),
        decisions: comments.body.filter((comment) =>
            comment.body.includes('<!-- kodus-conditional-approval -->'),
        ),
    };
}

async function waitForApproval(
    ctx: RunContext,
    session: KodusSession,
    repo: ProviderRepoRef,
    pr: OpenedPR,
    since: string,
    initial: Evidence,
    policyName: string,
) {
    // Metadata may change after the policy decision (including generated PR
    // descriptions). Preserve the snapshot veto and let the real cron recheck.
    const deadline = Date.now() + 6 * 60_000;
    let data = initial;
    while (true) {
        const state = await providerState(ctx, repo, pr);
        if (
            data.execution?.decision?.reviewedHeadSha === state.headSha &&
            state.approvals.length > 0 &&
            state.decisions.some(
                (comment) =>
                    comment.body.includes('**Automatic approval completed**') &&
                    comment.body.includes(policyName),
            )
        ) {
            const full = await inspect(ctx, session, repo, pr, since);
            const verified = {
                ...full,
                providerApproval: {
                    headSha: state.headSha,
                    policyName,
                    reviews: state.approvals.map((review) => ({
                        id: review.id,
                        state: review.state,
                        headSha: review.commit_id,
                        reviewer: review.user.login,
                    })),
                },
            };
            writeFileSync(
                join(
                    ctx.artifactDir,
                    `execution-${pr.number}-${data.execution.uuid}-approved.json`,
                ),
                JSON.stringify(verified, null, 2),
            );
            return { data: verified, state };
        }
        ctx.assert(
            Date.now() < deadline,
            `PR #${pr.number} approval was not confirmed: ${data.execution?.decision?.reason ?? 'no decision'}`,
        );
        await settle(8_000);
        data = await inspect(ctx, session, repo, pr, since, true);
        ctx.assert(
            data.execution?.uuid === initial.execution?.uuid &&
                data.execution?.status === 'success',
            'Approval evidence changed execution or lost its successful status',
        );
    }
}

async function realPreview(
    ctx: RunContext,
    repo: ProviderRepoRef,
    pr: OpenedPR,
) {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const csrf = await context.request.get(
            `${ctx.target.webBaseUrl}/api/auth/csrf`,
        );
        const { csrfToken } = await csrf.json();
        await context.request.post(
            `${ctx.target.webBaseUrl}/api/auth/callback/credentials`,
            {
                form: {
                    csrfToken,
                    email: ctx.tenant!.email,
                    password: ctx.tenant!.password,
                    json: 'true',
                    redirect: 'false',
                },
                maxRedirects: 0,
            },
        );
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        await page.goto(
            `${ctx.target.webBaseUrl}/settings/code-review/${repo.id}/risk`,
            { waitUntil: 'domcontentloaded' },
        );
        const preview = page.getByRole('button', {
            name: 'Preview on a PR',
            exact: true,
        });
        await expect(preview).toBeEnabled({ timeout: 60_000 });
        await page.waitForFunction(
            "[...document.querySelectorAll('button')].some(node => node.textContent?.includes('Preview on a PR') && Object.keys(node).some(key => key.startsWith('__reactProps$')))",
        );
        await preview.click();
        const sheet = page.getByRole('dialog');
        await sheet
            .getByLabel('PR number', { exact: true })
            .fill(String(pr.number));
        const [response] = await Promise.all([
            page.waitForResponse(
                (res) =>
                    res.url().includes('/code-review/risk/preview') &&
                    res.request().method() === 'POST',
                { timeout: 120_000 },
            ),
            sheet
                .getByRole('button', { name: 'Preview risk', exact: true })
                .click(),
        ]);
        ctx.assert(
            response.ok(),
            `Real risk preview returned HTTP ${response.status()}`,
        );
        await expect(
            sheet.getByRole('heading', { name: 'No risk found', exact: true }),
        ).toBeVisible({ timeout: 120_000 });
        await expect(
            sheet.getByText('PR files · 1', { exact: true }),
        ).toBeVisible();
        await page.screenshot({
            path: join(ctx.artifactDir, 'real-pr-risk-preview.png'),
            fullPage: true,
        });
    } finally {
        await browser.close();
    }
}

export const riskRoutingPipeline: Scenario = {
    id: 'risk-routing-pipeline',
    title: 'Real webhook, risk, review mode/model, conditional agents, preview and provider approval',
    priority: 'P0',
    appliesTo: { target: ['cloud'], provider: ['github'], license: ['paid'] },
    timeoutSec: 4500,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, 'An isolated Runo QA tenant is required');
        ctx.assert(
            process.env.CLOUD_RISK_POLICY_TENANT_EMAIL?.startsWith(
                'preview-risk-policies-',
            ),
            'A separate isolated policy tenant is required to respect trial review limits',
        );
        const prepareTenant = async (
            session: KodusSession,
            fullOnboarding = true,
        ) => {
            await ctx.kodus.registerIntegration(session);
            const repo = await ctx.kodus.registerRepo(session);
            if (fullOnboarding) {
                await ctx.kodus.finishOnboarding(session, repo);
            } else {
                // The policy phase needs its own normal trial allowance, not
                // another repository-wide Kody Rules import/backfill.
                const platform = await request(
                    ctx,
                    session,
                    `/parameters/find-by-key?key=platform_configs&teamId=${encodeURIComponent(session.teamId)}`,
                );
                await request(ctx, session, '/parameters/create-or-update', {
                    key: 'platform_configs',
                    organizationAndTeamData: { teamId: session.teamId },
                    configValue: {
                        ...platform.configValue,
                        finishOnboard: true,
                    },
                });
                const trial = await http(
                    `${ctx.target.webBaseUrl}/api/proxy/billing/trial`,
                    {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        body: {
                            organizationId: session.organizationId,
                            teamId: session.teamId,
                            byok: false,
                        },
                    },
                );
                ctx.assert(
                    (trial.status >= 200 && trial.status < 300) ||
                        trial.status === 409,
                    'Could not provision the policy QA tenant’s normal trial.',
                );
                await settle(10_000);
            }
            const seat = await http<any>(
                `${ctx.target.webBaseUrl}/api/proxy/billing/assign-license`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    body: {
                        organizationId: session.organizationId,
                        teamId: session.teamId,
                        users: [
                            {
                                gitId: await ctx.provider.currentUserId(),
                                gitTool: ctx.provider.licenseGitTool(),
                                licenseStatus: 'active',
                            },
                        ],
                        userName: 'Risk routing QA',
                    },
                },
            );
            ctx.assert(
                seat.status >= 200 &&
                    seat.status < 300 &&
                    !seat.body?.failed?.length &&
                    !seat.body?.error?.length,
                'QA author seat was not assigned',
            );
            return repo;
        };
        let session = await ctx.kodus.login(ctx.tenant!);
        const repo = await prepareTenant(session);
        const disconnect = async (owner: KodusSession) => {
            const result = await http(
                `${ctx.target.apiBaseUrl}/code-management/delete-integration?teamId=${encodeURIComponent(owner.teamId)}`,
                {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${owner.accessToken}` },
                },
            );
            ctx.assert(
                result.status >= 200 && result.status < 300,
                'Could not disconnect the isolated QA tenant.',
            );
        };
        const results: Array<Record<string, unknown>> = [];
        const record = (name: string, pr: OpenedPR, data: Evidence) => {
            results.push({ name, pr: pr.url, ...data });
            writeFileSync(
                join(ctx.artifactDir, 'risk-routing-progress.json'),
                JSON.stringify(results, null, 2),
            );
            console.log(`PASS risk-routing ${name}: ${pr.url}`);
        };
        const agent = (enabled = true) => ({
            id: AGENT,
            name: 'QA Risk Watch',
            enabled,
            runWhen: 'risk-found',
            instructions:
                'Inspect authorization changes in the supplied files. Report an authorization bypass only when the changed code allows reading another tenant’s private data. If no concrete issue exists, return no findings.',
            scope: { include: ['src/qa-risk-routing/**'] },
            tools: {},
            presentation: {
                tag: { color: '#C9BBF2' },
                format: 'single-comment',
                suggestedFix: 'never',
            },
        });
        const disarmed = {
            pullRequestApprovalActive: false,
            automatedReviewActive: false,
            riskAssessmentActive: false,
            customAgents: [],
        };
        const configure = async (changes: Record<string, unknown> = {}) => {
            await request(
                ctx,
                session,
                '/parameters/create-or-update-code-review',
                {
                    organizationAndTeamData: { teamId: session.teamId },
                    configValue: {
                        automatedReviewActive: true,
                        baseBranches: ['main'],
                        ignorePaths: ['qa-risk-large/**'],
                        riskAssessmentActive: true,
                        riskCriteria: [],
                        reviewMode: 'balanced',
                        riskReviewRouting: {
                            noRisk: 'balanced',
                            riskFound: 'heavy',
                        },
                        pullRequestApprovalActive: true,
                        approvalPolicies: [
                            {
                                id: 'qa-clean',
                                name: 'QA clean PRs',
                                enabled: true,
                            },
                        ],
                        customAgents: [agent()],
                        ...changes,
                    },
                },
            );
        };
        const open = async (
            name: string,
            files: Record<string, string> = { [FILE]: safe },
        ) => {
            const since = new Date().toISOString();
            const pr = await ctx.provider.openPR({
                branch: `e2e/risk-${randomUUID().slice(0, 8)}`,
                baseBranch: 'main',
                title: `[e2e] ${name}`,
                body: 'Isolated risk-routing QA fixture. No customer code or data.',
                fixtureFiles: files,
            });
            return { pr, since };
        };
        const check = (
            data: Evidence,
            risk: string,
            heavy: boolean,
            agentRan: boolean,
        ) => {
            ctx.assert(
                data.execution?.risk?.status === risk,
                `Expected risk ${risk}, got ${JSON.stringify(data.execution?.risk)}`,
            );
            ctx.assert(
                data.execution.heavy === heavy,
                `Expected ${heavy ? 'Heavy' : 'Balanced'}, got ${data.execution.heavy}`,
            );
            ctx.assert(
                data.agents.some(
                    (run) => run.agentId === AGENT && run.status === 'ran',
                ) === agentRan,
                `Conditional agent expected ran=${agentRan}; actual=${JSON.stringify(data.agents)}`,
            );
            if (!agentRan)
                ctx.assert(
                    data.execution.agentSkips?.some(
                        (skip) => skip.id === AGENT,
                    ),
                    'No recorded reason for skipping the conditional agent',
                );
        };
        let active: OpenedPR | undefined;
        const label = `qa-risk-${ctx.runId.slice(-6)}`;
        let createdLabel = false;
        try {
            await configure({ pullRequestApprovalActive: false });
            let opened = await open(
                'Risk independently assesses a clean PR while approval is off',
            );
            active = opened.pr;
            let data = await waitForRun(
                ctx,
                session,
                repo,
                active,
                opened.since,
            );
            check(data, 'assessed', false, false);
            ctx.assert(
                data.execution!.risk!.riskIdentified === false,
                'Benign constant unexpectedly has confirmed risk',
            );
            ctx.assert(
                (await providerState(ctx, repo, active)).approvals.length === 0,
                'Approval master off still approved',
            );
            record('risk-on-approval-off', active, data);
            await ctx.provider.closePR(active);
            active = undefined;

            await configure();
            opened = await open(
                'Clean no-risk PR matches the named approval policy',
            );
            active = opened.pr;
            data = await waitForRun(ctx, session, repo, active, opened.since);
            check(data, 'assessed', false, false);
            const confirmed = await waitForApproval(
                ctx,
                session,
                repo,
                active,
                opened.since,
                data,
                'QA clean PRs',
            );
            data = confirmed.data;
            let state = confirmed.state;
            ctx.assert(
                state.approvals.length > 0,
                'Clean matching policy did not produce an actual provider approval',
            );
            ctx.assert(
                state.decisions.some((comment) =>
                    comment.body.includes('QA clean PRs'),
                ),
                'Decision comment omits the matched policy',
            );
            const reviewTask = data.models.find(
                (model) => model.task === 'codeReview',
            );
            ctx.assert(
                reviewTask?.model &&
                    data.models.some(
                        (model) => model.runName === 'pr-risk-assessment',
                    ),
                'Actual risk/review model usage is missing',
            );
            const commentsBefore = state.decisions.length;
            await realPreview(ctx, repo, active);
            ctx.assert(
                (await providerState(ctx, repo, active)).decisions.length ===
                    commentsBefore,
                'Preview posted a provider decision comment',
            );
            record('no-risk-balanced-approved-and-real-preview', active, data);
            await ctx.provider.closePR(active);
            active = undefined;

            await configure({
                riskCriteria: [
                    {
                        id: 'qa-auth',
                        name: 'Tenant authorization',
                        enabled: true,
                        instructions:
                            'Returning true for every requester permits access across tenants. Treat authorization bypasses as a risk; equivalent refactors do not create one.',
                        includedFiles: ['src/qa-risk-routing/**'],
                    },
                ],
            });
            opened = await open(
                'Authorization bypass must route to Heavy and run the conditional agent',
                { [FILE]: risky },
            );
            active = opened.pr;
            const riskData = await waitForRun(
                ctx,
                session,
                repo,
                active,
                opened.since,
            );
            check(riskData, 'assessed', true, true);
            ctx.assert(
                riskData.execution!.risk!.riskIdentified === true,
                'Authorization bypass risk was missed',
            );
            ctx.assert(
                riskData.execution!.decision?.kind === 'hold',
                'Confirmed risk did not block approval',
            );
            ctx.assert(
                (await providerState(ctx, repo, active)).approvals.length === 0,
                'Risky PR was approved in the provider',
            );
            record('risk-found-heavy-agent-ran-blocked', active, riskData);
            await settle(3_000);
            const commandSince = new Date().toISOString();
            await ctx.provider.postComment(
                active.number,
                '@kody review --balanced',
            );
            const balancedData = await waitForRun(
                ctx,
                session,
                repo,
                active,
                commandSince,
            );
            check(balancedData, 'assessed', false, true);
            ctx.assert(
                balancedData.execution!.risk!.riskIdentified === true &&
                    (await providerState(ctx, repo, active)).approvals
                        .length === 0,
                'Explicit Balanced lost the risk veto',
            );
            record(
                'explicit-balanced-preserves-risk-veto',
                active,
                balancedData,
            );
            await ctx.provider.closePR(active);
            active = undefined;

            await configure({
                riskAssessmentActive: false,
                reviewMode: 'heavy',
            });
            opened = await open(
                'Risk off uses fixed Heavy without running the conditional agent',
            );
            active = opened.pr;
            data = await waitForRun(ctx, session, repo, active, opened.since);
            check(data, 'disabled', true, false);
            ctx.assert(
                !data.models.some(
                    (model) => model.runName === 'pr-risk-assessment',
                ),
                'Disabled risk still spent a model call',
            );
            data = (
                await waitForApproval(
                    ctx,
                    session,
                    repo,
                    active,
                    opened.since,
                    data,
                    'QA clean PRs',
                )
            ).data;
            ctx.assert(
                (await providerState(ctx, repo, active)).approvals.length > 0,
                'Risk off prevented a clean matching policy from approving',
            );
            record('risk-off-fixed-heavy', active, data);
            await ctx.provider.closePR(active);
            active = undefined;

            await configure();
            opened = await open(
                'An omitted large patch stays unknown even when its file is excluded from review',
                {
                    [FILE]: safe,
                    'qa-risk-large/notes.txt': Array.from(
                        { length: 2500 },
                        (_, i) =>
                            `QA evidence line ${i}: static fixture with no executable behavior.\n`,
                    ).join(''),
                },
            );
            active = opened.pr;
            const unknownData = await waitForRun(
                ctx,
                session,
                repo,
                active,
                opened.since,
            );
            check(unknownData, 'unavailable', false, false);
            ctx.assert(
                !unknownData.models.some(
                    (model) => model.runName === 'pr-risk-assessment',
                ),
                'An incomplete diff still spent a risk model call',
            );
            ctx.assert(
                unknownData.execution!.decision?.kind === 'hold' &&
                    (await providerState(ctx, repo, active)).approvals
                        .length === 0,
                'Unavailable risk did not block actual approval',
            );
            record(
                'unknown-default-balanced-agent-skipped-blocked',
                active,
                unknownData,
            );
            await ctx.provider.closePR(active);
            active = undefined;

            // The core group consumes the normal six managed trial reviews.
            // Continue with a separately seeded QA tenant, preserving the gate.
            await configure(disarmed);
            // getContext resolves by repository: remove our old ownership
            // before registering the policy tenant against that repository.
            await disconnect(session);
            session = await ctx.kodus.login({
                email: process.env.CLOUD_RISK_POLICY_TENANT_EMAIL!,
                password: ctx.tenant!.password,
            });
            const policyRepo = await prepareTenant(session, false);
            ctx.assert(
                policyRepo.id === repo.id,
                'Policy tenant selected a different QA repository',
            );

            const integrationHeaders = {
                Authorization: `Bearer ${ctx.provider.authToken()}`,
            };
            const author = await http<{ login: string }>(
                'https://api.github.com/user',
                {
                    headers: {
                        Authorization: `Bearer ${process.env.GH_TEST_TOKEN}`,
                    },
                },
            );
            ctx.assert(
                author.status === 200 && author.body.login,
                'Could not resolve the QA PR author',
            );
            const githubRoot = `https://api.github.com/repos/${repo.full_name}`;
            const newLabel = await http(`${githubRoot}/labels`, {
                method: 'POST',
                headers: integrationHeaders,
                body: {
                    name: label,
                    color: 'C9BBF2',
                    description: 'Temporary risk-routing E2E condition',
                },
            });
            ctx.assert(
                newLabel.status === 201,
                'Could not create the isolated QA label',
            );
            createdLabel = true;
            await configure({
                approvalPolicies: [
                    {
                        id: 'qa-other-author',
                        name: 'QA different author',
                        enabled: true,
                        authors: ['qa-not-the-pr-author'],
                        labels: [label],
                    },
                    {
                        id: 'qa-labeled',
                        name: 'QA labeled static changes',
                        enabled: true,
                        authors: [author.body.login],
                        labels: [label],
                        includedFiles: ['src/qa-risk-routing/**'],
                        excludedFiles: ['**/*.test.ts'],
                        maxChangedLines: 10,
                        instruction:
                            'Eligible only when the change exports a static serviceStatus string literal and introduces no executable logic.',
                    },
                ],
            });
            opened = await open(
                'Named policy waits for its label and then approves the same clean head',
            );
            active = opened.pr;
            const beforeLabel = await waitForRun(
                ctx,
                session,
                repo,
                active,
                opened.since,
            );
            check(beforeLabel, 'assessed', false, false);
            ctx.assert(
                beforeLabel.execution!.decision?.kind === 'out-of-scope' &&
                    (await providerState(ctx, repo, active)).approvals
                        .length === 0,
                'A PR without the required label was approved',
            );
            ctx.assert(
                Object.keys(beforeLabel.execution!.eligibility ?? {}).length ===
                    0 &&
                    !beforeLabel.models.some(
                        (model) =>
                            model.runName === 'approval-policy-eligibility',
                    ),
                'Eligibility instructions ran before fixed conditions matched',
            );
            record('label-missing-policy-holds', active, beforeLabel);
            const addLabel = await http(
                `${githubRoot}/issues/${active.number}/labels`,
                {
                    method: 'POST',
                    headers: integrationHeaders,
                    body: { labels: [label] },
                },
            );
            ctx.assert(
                addLabel.status === 200,
                'Could not add the required label',
            );
            const labelApproval = await waitForApproval(
                ctx,
                session,
                repo,
                active,
                opened.since,
                beforeLabel,
                'QA labeled static changes',
            );
            const labelState = labelApproval.state;
            ctx.assert(
                labelState.approvals.length > 0,
                'The approval cron did not approve after the required label was added',
            );
            ctx.assert(
                labelState.decisions.some((comment) =>
                    comment.body.includes('QA labeled static changes'),
                ),
                'The decision comment does not name the matched filtered policy',
            );
            ctx.assert(
                labelState.decisions.every(
                    (comment) => !comment.body.includes('Eligible only when'),
                ),
                'Private eligibility instructions leaked into a provider comment',
            );
            const afterLabel = labelApproval.data;
            const eligibility = Object.entries(
                afterLabel.execution!.eligibility ?? {},
            );
            ctx.assert(
                eligibility.length === 1 &&
                    eligibility.every(
                        ([key, result]) =>
                            Boolean(key) &&
                            result.key === key &&
                            result.status === 'eligible',
                    ) &&
                    afterLabel.models.some(
                        (model) =>
                            model.runName === 'approval-policy-eligibility',
                    ),
                'The actual eligibility judgment was not persisted',
            );
            record(
                'label-author-files-lines-instruction-cron-approved',
                active,
                afterLabel,
            );
            await ctx.provider.closePR(active);
            active = undefined;

            await configure({
                automatedReviewActive: false,
                riskAssessmentActive: false,
                customAgents: [agent(false)],
            });
            opened = await open(
                'Manual agent bypasses activation and risk without approving',
            );
            active = opened.pr;
            // Let the automatic skip settle before the explicit command takes the PR lock.
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                const pending = await inspect(
                    ctx,
                    session,
                    repo,
                    active,
                    opened.since,
                );
                if (pending.execution?.status === 'skipped') break;
                await settle(5_000);
            }
            await settle(3_000);
            const manualSince = new Date().toISOString();
            await ctx.provider.postComment(
                active.number,
                '@kody -v qa-risk-watch',
            );
            data = await waitForRun(ctx, session, repo, active, manualSince);
            ctx.assert(
                data.agents.some(
                    (run) => run.agentId === AGENT && run.status === 'ran',
                ),
                'Explicit disabled agent did not run without risk',
            );
            ctx.assert(
                (await providerState(ctx, repo, active)).approvals.length === 0,
                'Custom-agent-only command approved the PR',
            );
            record('manual-agent-bypasses-risk-never-approves', active, data);
            return { provider: ctx.provider.name, cases: results };
        } finally {
            if (active) await ctx.provider.closePR(active);
            await configure(disarmed);
            await disconnect(session);
            if (createdLabel)
                await http(
                    `https://api.github.com/repos/${repo.full_name}/labels/${encodeURIComponent(label)}`,
                    {
                        method: 'DELETE',
                        headers: {
                            Authorization: `Bearer ${ctx.provider.authToken()}`,
                        },
                    },
                );
        }
    },
};
export default riskRoutingPipeline;
