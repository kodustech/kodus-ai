import type { RunContext, Scenario } from '../lib/types.js';
import { http } from '../lib/http.js';

/**
 * Cross-repo context (#1576) — config contract e2e.
 *
 * Validates the settings surface (API + formatted parameter) for
 * `linkedRepositories` without requiring a multi-repo agent review fixture:
 *  1. Save linkedRepositories on a selected repository via create-or-update.
 *  2. Read back via GET code-review-parameter (formatted config).
 *  3. Assert value + content match.
 *  4. Clear the field so the tenant is left clean.
 *
 * A full agentic multi-repo review e2e (boundary mismatch fixture pair) is
 * tracked as a follow-up once two linked fixture repos are provisioned.
 */
export const crossRepoConfig: Scenario = {
    id: 'cross-repo-config',
    title: 'Linked repositories config saves and returns via code-review parameter API',
    priority: 'P1',
    appliesTo: {
        target: ['cloud', 'self-hosted'],
        provider: [
            'github',
            'github-app',
            'gitlab',
            'bitbucket',
            'azure-devops',
        ],
        license: ['paid', 'license-paid'],
    },
    timeoutSec: 180,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            'scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)',
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const baseUrl = ctx.target.apiBaseUrl;
        const teamId = session.teamId;
        const auth = {
            Authorization: `Bearer ${session.accessToken}`,
        };

        // Resolve a real repository id from the code-review parameter shell
        // (same list the settings UI uses for the picker).
        const getParam = await http(
            `${baseUrl}/parameters/code-review-parameter?teamId=${encodeURIComponent(teamId)}`,
            {
                method: 'GET',
                headers: auth,
                timeoutMs: 30_000,
            },
        );
        ctx.assert(
            getParam.status >= 200 && getParam.status < 300,
            `GET code-review-parameter failed: HTTP ${getParam.status} ${getParam.raw.slice(0, 200)}`,
        );

        const shell = unwrap(getParam.body);
        const repositories: Array<{ id: string; name: string }> =
            shell?.repositories ?? shell?.configValue?.repositories ?? [];

        ctx.assert(
            repositories.length >= 1,
            'Tenant has no selected repositories — cannot set linkedRepositories',
        );

        // Prefer a second repo as the link target so the declaring repo
        // isn't linking to itself. Fall back to the first if only one.
        const declaring = repositories[0]!;
        const target =
            repositories.find((r) => r.id !== declaring.id) ?? declaring;
        const targetFullName = target.name;
        const e2eMarker = `e2e cross-repo link ${ctx.runId.slice(0, 8)}`;

        const setConfig = await http(
            `${baseUrl}/parameters/create-or-update-code-review`,
            {
                method: 'POST',
                headers: auth,
                body: {
                    organizationAndTeamData: { teamId },
                    repositoryId: declaring.id,
                    configValue: {
                        linkedRepositories: [
                            {
                                repository: targetFullName,
                                instructions: e2eMarker,
                                ref: 'main',
                            },
                        ],
                    },
                },
                timeoutMs: 30_000,
            },
        );
        ctx.assert(
            setConfig.status >= 200 && setConfig.status < 300,
            `Could not save linkedRepositories: HTTP ${setConfig.status} ${setConfig.raw.slice(0, 300)}`,
        );

        // Re-read formatted config and assert the link landed.
        const getAfter = await http(
            `${baseUrl}/parameters/code-review-parameter?teamId=${encodeURIComponent(teamId)}`,
            {
                method: 'GET',
                headers: auth,
                timeoutMs: 30_000,
            },
        );
        ctx.assert(
            getAfter.status >= 200 && getAfter.status < 300,
            `GET after save failed: HTTP ${getAfter.status}`,
        );

        const afterShell = unwrap(getAfter.body);
        const afterRepos: any[] =
            afterShell?.repositories ??
            afterShell?.configValue?.repositories ??
            [];
        const afterRepo = afterRepos.find(
            (r) => String(r.id) === String(declaring.id),
        );
        ctx.assert(
            afterRepo,
            `Repository ${declaring.id} missing after save`,
        );

        // Formatted shape: linkedRepositories.value is the array, with level.
        const linkedNode =
            afterRepo.configs?.linkedRepositories ??
            afterRepo.configs?.linked_repositories;
        ctx.assert(
            linkedNode,
            `linkedRepositories missing from formatted repo config. keys=${Object.keys(afterRepo.configs ?? {}).join(',')}`,
        );

        const linkedValue: any[] = Array.isArray(linkedNode)
            ? linkedNode
            : (linkedNode?.value ?? []);
        ctx.assert(
            Array.isArray(linkedValue) && linkedValue.length >= 1,
            `Expected at least one linked repository, got ${JSON.stringify(linkedNode).slice(0, 300)}`,
        );

        const first = linkedValue[0];
        const repoName =
            typeof first === 'string' ? first : first?.repository;
        const expectedTail = targetFullName
            .toLowerCase()
            .split('/')
            .pop()!;
        ctx.assert(
            typeof repoName === 'string' &&
                repoName.toLowerCase().includes(expectedTail),
            `Expected linked repo to match ${targetFullName}, got ${JSON.stringify(first)}`,
        );

        if (typeof first === 'object' && first) {
            ctx.assert(
                String(first.instructions || '').includes(e2eMarker),
                `Expected instructions to carry the e2e marker, got ${first.instructions}`,
            );
            ctx.assert(
                first.ref === 'main',
                `Expected ref pin 'main', got ${first.ref}`,
            );
        }

        // Cleanup: clear linkedRepositories so the tenant is left clean.
        const clearConfig = await http(
            `${baseUrl}/parameters/create-or-update-code-review`,
            {
                method: 'POST',
                headers: auth,
                body: {
                    organizationAndTeamData: { teamId },
                    repositoryId: declaring.id,
                    configValue: { linkedRepositories: [] },
                },
                timeoutMs: 30_000,
            },
        );
        ctx.assert(
            clearConfig.status >= 200 && clearConfig.status < 300,
            `Could not clear linkedRepositories: HTTP ${clearConfig.status}`,
        );

        // Evidence object — the Scenario contract requires run() to return
        // a record the matrix report can attach.
        return {
            declaringRepo: declaring.name,
            linkedRepository: targetFullName,
            savedAndReadBack: true,
            clearedAfterTest: true,
        };
    },
};

function unwrap(body: unknown): any {
    if (!body || typeof body !== 'object') return body;
    const b = body as any;
    // Common Nest response envelopes: { data: ... } or the raw parameter.
    return b.data ?? b;
}

export default crossRepoConfig;
