import { randomUUID } from 'node:crypto';
import { ensureOk, http } from '../lib/http.js';
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

async function ensureCloudAuthorSeat(ctx: RunContext, session: KodusSession) {
    if (ctx.target.target !== 'cloud' || ctx.provider.name !== 'gitlab') return;

    const gitId = await ctx.provider.currentUserId();
    const hasSeat = async () => {
        const seats = await http<{
            data?: Array<{ git_id: string; status?: string }>;
        }>(`${ctx.target.apiBaseUrl}/license/users`, {
            headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        ensureOk(seats, 'conditional-approval-provider:listSeats');
        return seats.body.data?.some(
            (user) =>
                user.git_id === gitId && user.status !== 'inactive',
        );
    };
    if (await hasSeat()) return;

    const response = await http<{
        error?: unknown[];
        failed?: unknown[];
    }>(`${ctx.target.webBaseUrl}/api/proxy/billing/assign-license`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: {
            organizationId: session.organizationId,
            teamId: session.teamId,
            users: [{
                gitId,
                gitTool: ctx.provider.licenseGitTool(),
                licenseStatus: 'active',
            }],
            userName: 'GitLab approval QA',
        },
    });
    ensureOk(response, 'conditional-approval-provider:assignAuthorSeat');
    ctx.assert(
        !(response.body.error?.length || response.body.failed?.length),
        'GitLab QA author has no review seat; billing refused to assign one',
    );
    ctx.assert(
        await hasSeat(),
        'Billing accepted the GitLab QA seat but the review license list did not update',
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
        await resetCodeReviewConfig(ctx.target, session);
        await ensureCloudAuthorSeat(ctx, session);
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
            await waitForApprovalReason(ctx, repo, sensitivePr, 'held', SENSITIVE_FILE);

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
            await waitForApprovalReason(ctx, repo, safePr, 'completed');
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
    repo: ProviderRepoRef,
    pr: OpenedPR,
    kind: 'held' | 'completed',
    detail?: string,
): Promise<void> {
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
        const comments = await approvalComments(ctx, repo, pr);
        if (comments.some((comment) =>
            comment.includes(REASON_MARKER) &&
            comment.includes(`Automatic approval ${kind}`) &&
            (!detail || comment.includes(detail)),
        )) return;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error(`No automatic approval ${kind} reason appeared on ${pr.url} within 12 minutes`);
}

export default conditionalApprovalProvider;
