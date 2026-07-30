import { PlatformType } from '@libs/core/domain/enums';

import { CloneParamsResolverService } from './clone-params-resolver.service';

/**
 * Regression coverage for issue #1541.
 *
 * A CLI review against a repository on a self-managed git host (GitLab
 * self-managed, Bitbucket Server, Gitea/Forgejo, GHES) used to clone from
 * github.com: the CLI can only infer a platform from well-known SaaS
 * hostnames, so `inferredPlatform` arrives undefined, the resolver defaulted
 * to GITHUB, and the GitHub clone params then overwrote the real remote with
 * `https://github.com/<fullName>`.
 */

const SELF_MANAGED_HOST = 'git.acme.com';
const GITLAB_TOKEN = 'glpat-self-managed';
const GITHUB_TOKEN = 'ghs-github-token';

const cliContext = (remote: string, inferredPlatform?: PlatformType) =>
    ({
        gitContext: { remote, branch: 'feature/x', inferredPlatform },
    }) as any;

const pipelineContext = () =>
    ({
        origin: 'cli',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    }) as any;

/** Clone params shaped like the ones each real adapter returns. */
const paramsFor = (platform: PlatformType, fullName: string) => {
    switch (platform) {
        case PlatformType.GITHUB:
            return {
                url: `https://github.com/${fullName}`,
                provider: PlatformType.GITHUB,
                auth: { type: 'oauth', token: GITHUB_TOKEN },
            };
        case PlatformType.GITLAB:
            return {
                url: `https://${SELF_MANAGED_HOST}/${fullName}`,
                provider: PlatformType.GITLAB,
                auth: { type: 'token', token: GITLAB_TOKEN },
            };
        default:
            return null;
    }
};

describe('CloneParamsResolverService (CLI mode, self-managed host)', () => {
    const REMOTE = `https://${SELF_MANAGED_HOST}/group/repo.git`;

    let service: CloneParamsResolverService;
    let codeManagementService: { getCloneParams: jest.Mock };

    beforeEach(() => {
        codeManagementService = {
            // Stands in for CodeManagementService: an undefined platform makes
            // it resolve the team's connected integration — a self-managed
            // GitLab here.
            getCloneParams: jest.fn(async (params: any, type?: PlatformType) =>
                paramsFor(type ?? PlatformType.GITLAB, params.repository.fullName),
            ),
        };

        service = new CloneParamsResolverService(codeManagementService as any);
    });

    it('does not clone from github.com when the platform cannot be inferred', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE),
        );

        expect(result?.url).not.toContain('github.com');
        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
    });

    it('does not assume GitHub when asking for clone params', async () => {
        await service.resolve(pipelineContext(), cliContext(REMOTE));

        const platformsAskedFor =
            codeManagementService.getCloneParams.mock.calls.map(([, type]) => type);

        // Undefined, not GITHUB: the service resolves the connected
        // integration itself. Naming GitHub here was the bug.
        expect(platformsAskedFor).toEqual([undefined]);
    });

    it('resolves the credentials of the connected integration', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE),
        );

        expect(result?.authToken).toBe(GITLAB_TOKEN);
        expect(result?.platform).toBe(PlatformType.GITLAB);
    });

    it('still honors an explicitly inferred platform', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE, PlatformType.GITLAB),
        );

        expect(codeManagementService.getCloneParams).toHaveBeenCalledWith(
            expect.anything(),
            PlatformType.GITLAB,
        );
        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
    });

    it('resolves an scp-like SSH remote against the same host', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(`git@${SELF_MANAGED_HOST}:group/repo.git`),
        );

        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
        expect(result?.authToken).toBe(GITLAB_TOKEN);
    });

    it('trusts the integration when its host differs from the remote', async () => {
        // Internal DNS alias / mirror / vanity hostname: the remote and the
        // configured integration name the same server differently. Rejecting
        // that would regress a setup that works today.
        const result = await service.resolve(
            pipelineContext(),
            cliContext('https://git-mirror.acme.com/group/repo.git'),
        );

        expect(result?.authToken).toBe(GITLAB_TOKEN);
        expect(result?.platform).toBe(PlatformType.GITLAB);
    });

    it('skips the sandbox when the organization has no integration at all', async () => {
        // getCloneParams resolves no platform and returns null.
        codeManagementService.getCloneParams.mockResolvedValue(null);

        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE),
        );

        expect(result).toBeNull();
    });
});

/**
 * KNOWN LIMITATION, deliberately not handled here.
 *
 * A team can hold more than one active code-management integration: nothing
 * deactivates the previous one on connect, and there is no unique constraint
 * on (organization, team, category). getTypeIntegration then resolves it with
 * a findOne carrying no ORDER BY, so the answer is arbitrary — and for a
 * remote whose host belongs to the *other* integration, the CLI sandbox
 * reproduces #1541 for that team.
 *
 * The resolver could disambiguate by matching the remote's host against each
 * integration, but that treats the symptom: the real defect is that the state
 * is reachable at all. The invariant belongs in the integration layer (a
 * partial unique index on status = true, or deactivating the previous one on
 * connect), so this spec pins the current behavior rather than papering over
 * it. See the follow-up issue.
 */
describe('CloneParamsResolverService (team with several integrations)', () => {
    it('follows whichever integration the service resolves, right or wrong', async () => {
        const codeManagementService = {
            // The unordered findOne landed on GitHub, though the remote is a
            // self-managed GitLab.
            getCloneParams: jest.fn(async (params: any) =>
                paramsFor(PlatformType.GITHUB, params.repository.fullName),
            ),
        };
        const service = new CloneParamsResolverService(
            codeManagementService as any,
        );

        const result = await service.resolve(
            pipelineContext(),
            cliContext(`https://${SELF_MANAGED_HOST}/group/repo.git`),
        );

        // Documented, not endorsed: the clone targets the wrong host and the
        // sandbox will fail to acquire. Fixing this means enforcing one
        // code-management integration per team.
        expect(new URL(result!.url).hostname).toBe('github.com');
    });
});

describe('CloneParamsResolverService (platform coverage)', () => {
    const cases = [
        {
            name: 'GitLab self-managed',
            host: 'gitlab.acme.com',
            provider: PlatformType.GITLAB,
        },
        {
            name: 'GitHub Enterprise Server',
            host: 'github.acme.com',
            provider: PlatformType.GITHUB,
        },
        {
            name: 'Bitbucket Server',
            host: 'bitbucket.acme.com',
            provider: PlatformType.BITBUCKET,
        },
        {
            name: 'Forgejo self-hosted',
            host: 'forgejo.acme.com',
            provider: PlatformType.FORGEJO,
        },
        {
            name: 'Azure DevOps',
            host: 'dev.azure.com',
            provider: PlatformType.AZURE_REPOS,
        },
        {
            name: 'GitHub SaaS',
            host: 'github.com',
            provider: PlatformType.GITHUB,
        },
    ];

    it.each(cases)(
        'clones $name from its own host with its own credentials',
        async ({ host, provider }) => {
            const codeManagementService = {
                getCloneParams: jest.fn().mockResolvedValue({
                    url: `https://${host}/group/repo`,
                    provider,
                    auth: { type: 'token', token: `token-for-${provider}` },
                }),
            };

            const service = new CloneParamsResolverService(
                codeManagementService as any,
            );

            const result = await service.resolve(
                pipelineContext(),
                cliContext(`https://${host}/group/repo.git`),
            );

            expect(new URL(result!.url).hostname).toBe(host);
            expect(result?.platform).toBe(provider);
            expect(result?.authToken).toBe(`token-for-${provider}`);
        },
    );
});
