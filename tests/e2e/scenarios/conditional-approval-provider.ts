import { randomUUID } from 'node:crypto';
import { ensureOk, http } from '../lib/http.js';
import { findExecutionStatus } from '../lib/execution-health.js';
import { resetCodeReviewConfig } from '../lib/onboarding.js';
import type {
    KodusSession,
    OpenedPR,
    ProviderRepoRef,
    RunContext,
    Scenario,
} from '../lib/types.js';

const SENSITIVE_FILE = 'src/qa-approval/smoke.ts';
const SAFE_FILE = 'src/qa-approval-clean/smoke.ts';
const REASON_MARKER = '<!-- kodus-conditional-approval -->';

async function assignCloudAuthorSeat(ctx: RunContext, session: KodusSession) {
    if (ctx.target.target !== 'cloud') return;

    const gitId = await ctx.provider.currentUserId();
    const response = await http<{
        error?: unknown[];
        failed?: unknown[];
        successful?: Array<{ git_id?: string }>;
    }>(`${ctx.target.webBaseUrl}/api/proxy/billing/assign-license`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: {
            organizationId: session.organizationId,
            teamId: session.teamId,
            users: [
                {
                    gitId,
                    gitTool: ctx.provider.licenseGitTool(),
                    licenseStatus: 'active',
                },
            ],
            userName: `${ctx.provider.name} approval QA`,
        },
    });
    ensureOk(response, 'conditional-approval-provider:assignAuthorSeat');
    ctx.assert(
        !(response.body.error?.length || response.body.failed?.length),
        `${ctx.provider.name} QA author has no review seat; billing refused to assign one`,
    );
    ctx.assert(
        response.body.successful?.some(
            (user) => String(user.git_id) === String(gitId),
        ),
        `Billing did not confirm the ${ctx.provider.name} QA author seat`,
    );
}

function providerHeaders(name: string): Record<string, string> {
    if (name === 'gitlab')
        return { 'PRIVATE-TOKEN': process.env.GL_TEST_TOKEN! };
    if (name === 'bitbucket') {
        const credentials = `${process.env.BB_TEST_USER}:${process.env.BB_TEST_APP_PASSWORD}`;
        return {
            Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
        };
    }
    return {
        Authorization: `Basic ${Buffer.from(`:${process.env.AZ_TEST_TOKEN}`).toString('base64')}`,
    };
}

async function approvalComments(
    ctx: RunContext,
    repo: ProviderRepoRef,
    pr: OpenedPR,
): Promise<string[]> {
    const name = ctx.provider.name;
    let url: string;
    if (name === 'gitlab') {
        const host = process.env.GL_HOST ?? 'https://gitlab.com';
        url = `${host}/api/v4/projects/${encodeURIComponent(repo.full_name)}/merge_requests/${pr.number}/notes?per_page=100`;
    } else if (name === 'bitbucket') {
        url = `https://api.bitbucket.org/2.0/repositories/${repo.full_name}/pullrequests/${pr.number}/comments?pagelen=100`;
    } else {
        const org = process.env.AZ_TEST_ORG!;
        const project = process.env.AZ_TEST_PROJECT!;
        url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/pullRequests/${pr.number}/threads?api-version=7.1`;
    }
    const response = await http<unknown>(url, {
        headers: providerHeaders(name),
    });
    ensureOk(response, `${name}:approvalComments`);
    const body = response.body as
        | Array<{ body?: string }>
        | { values?: Array<{ content?: { raw?: string } }> }
        | { value?: Array<{ comments?: Array<{ content?: string }> }> };
    if (name === 'gitlab')
        return (body as Array<{ body?: string }>).map(
            (note) => note.body ?? '',
        );
    if (name === 'bitbucket')
        return (
            (body as { values?: Array<{ content?: { raw?: string } }> })
                .values ?? []
        ).map((comment) => comment.content?.raw ?? '');
    return (
        (body as { value?: Array<{ comments?: Array<{ content?: string }> }> })
            .value ?? []
    ).flatMap((thread) =>
        (thread.comments ?? []).map((comment) => comment.content ?? ''),
    );
}

async function setApprovalPolicy(
    ctx: RunContext,
    accessToken: string,
    teamId: string,
    enabled: boolean,
) {
    const response = await http(
        `${ctx.target.apiBaseUrl}/parameters/create-or-update-code-review`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            body: {
                organizationAndTeamData: { teamId },
                configValue: {
                    automatedReviewActive: true,
                    baseBranches: ['main'],
                    pullRequestApprovalActive: enabled,
                    approvalRiskActive: false,
                    approvalSensitivePaths: enabled
                        ? ['src/qa-approval/**']
                        : [],
                },
            },
        },
    );
    ensureOk(response, 'conditional-approval-provider:setPolicy');
}

export const conditionalApprovalProvider: Scenario = {
    id: 'conditional-approval-provider',
    title: 'Conditional approval holds sensitive changes and approves safe changes on a real provider',
    priority: 'P0',
    appliesTo: {
        target: ['cloud'],
        provider: ['gitlab', 'bitbucket', 'azure-devops'],
        license: ['paid'],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, 'preview paid tenant is required');
        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        if (ctx.provider.name === 'gitlab') {
            const hooks = await ctx.provider.listWebhooks();
            ctx.assert(
                hooks.some(
                    (hook) =>
                        hook.url.includes(ctx.provider.webhookPath) &&
                        hook.active &&
                        hook.events.includes('merge_request'),
                ),
                'GitLab merge request webhook is missing or inactive after onboarding',
            );
        }
        await resetCodeReviewConfig(ctx.target, session);
        await assignCloudAuthorSeat(ctx, session);
        await setApprovalPolicy(ctx, session.accessToken, session.teamId, true);

        const branch = `e2e/approval-${randomUUID().slice(0, 8)}`;
        const opened: OpenedPR[] = [];
        try {
            const sensitivePr = await ctx.provider.openPR({
                branch,
                baseBranch: 'main',
                title: `[e2e] Conditional approval sensitive path ${branch}`,
                body: 'Checks that a clean review still requires human approval for a team-marked path.',
                fixtureFiles: {
                    [SENSITIVE_FILE]: `// Conditional approval QA ${branch}\nexport const qaApprovalSmoke = true;\n`,
                },
            });
            opened.push(sensitivePr);
            await waitForApprovalReason(
                ctx,
                session,
                repo,
                sensitivePr,
                'held',
                SENSITIVE_FILE,
            );

            const safeBranch = `e2e/approval-safe-${randomUUID().slice(0, 8)}`;
            const safePr = await ctx.provider.openPR({
                branch: safeBranch,
                baseBranch: 'main',
                title: `[e2e] Conditional approval safe path ${safeBranch}`,
                body: 'Checks that a clean review outside team-marked paths is approved.',
                fixtureFiles: {
                    [SAFE_FILE]: `// Conditional approval QA ${safeBranch}\nexport const qaApprovalSmoke = true;\n`,
                },
            });
            opened.push(safePr);
            await waitForApprovalReason(
                ctx,
                session,
                repo,
                safePr,
                'completed',
            );
            return {
                provider: ctx.provider.name,
                sensitivePr: sensitivePr.url,
                safePr: safePr.url,
                sensitivePathHeld: true,
                safePathApproved: true,
            };
        } finally {
            try {
                await setApprovalPolicy(
                    ctx,
                    session.accessToken,
                    session.teamId,
                    false,
                );
            } finally {
                for (const pr of opened) await ctx.provider.closePR(pr);
            }
        }
    },
};

async function waitForApprovalReason(
    ctx: RunContext,
    session: KodusSession,
    repo: ProviderRepoRef,
    pr: OpenedPR,
    kind: 'held' | 'completed',
    detail?: string,
): Promise<void> {
    const deadline = Date.now() + 12 * 60_000;
    let terminalFailureSince = 0;
    let lastReviewStatus: string | null = null;
    let lastStatusCheck = 0;
    while (Date.now() < deadline) {
        const comments = await approvalComments(ctx, repo, pr);
        if (
            comments.some(
                (comment) =>
                    comment.includes(REASON_MARKER) &&
                    comment.includes(`Automatic approval ${kind}`) &&
                    (!detail || comment.includes(detail)),
            )
        )
            return;
        if (Date.now() - lastStatusCheck >= 30_000) {
            lastStatusCheck = Date.now();
            const executions = await http<unknown>(
                `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${pr.number}&teamId=${encodeURIComponent(session.teamId)}&limit=10`,
                { headers: { Authorization: `Bearer ${session.accessToken}` } },
            );
            if (executions.status >= 200 && executions.status < 300) {
                lastReviewStatus = findExecutionStatus(
                    executions.body,
                    pr.number,
                );
                if (
                    lastReviewStatus === 'skipped' ||
                    lastReviewStatus === 'error' ||
                    lastReviewStatus === 'partial_error'
                ) {
                    terminalFailureSince ||= Date.now();
                    if (Date.now() - terminalFailureSince >= 90_000) {
                        throw new Error(
                            `${pr.url} review ended ${lastReviewStatus}; an approval decision requires a successful review`,
                        );
                    }
                } else {
                    terminalFailureSince = 0;
                }
            }
        }
        await new Promise((resolve) =>
            setTimeout(
                resolve,
                ctx.provider.name === 'gitlab' ? 60_000 : 10_000,
            ),
        );
    }
    throw new Error(
        `No automatic approval ${kind} reason appeared on ${pr.url} within 12 minutes (review=${lastReviewStatus ?? 'unknown'})`,
    );
}

export default conditionalApprovalProvider;
