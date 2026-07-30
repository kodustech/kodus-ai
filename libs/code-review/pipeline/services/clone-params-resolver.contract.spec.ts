import { ConfigService } from '@nestjs/config';

import {
    IntegrationCategory,
    PlatformType,
} from '@libs/core/domain/enums';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';
import { PlatformIntegrationFactory } from '@libs/platform/infrastructure/adapters/services/platformIntegration.factory';

import { CloneParamsResolverService } from './clone-params-resolver.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Contract-level coverage for issue #1541.
 *
 * The sibling unit spec mocks CodeManagementService, which only proves the
 * resolver behaves given clone params of a shape *we assumed*. This one wires
 * the REAL adapters (GithubService, GitlabService) behind the REAL
 * CodeManagementService and fakes only the integration lookup — so the clone
 * URL, the provider and the token are the ones production actually builds.
 * If an adapter's contract drifts, this fails; the mocked spec would not.
 */
describe('CloneParamsResolver × real platform adapters (self-managed host)', () => {
    const SELF_MANAGED_HOST = 'gitlab.acme.com';
    const GITLAB_TOKEN = 'glpat-self-managed';

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const cliContext = (remote: string) =>
        ({ gitContext: { remote, branch: 'feature/x' } }) as any;

    const pipelineContext = () =>
        ({ origin: 'cli', organizationAndTeamData }) as any;

    /**
     * Builds the real object graph. `integrations` drives what the
     * organization has connected; `authDetails` what each adapter reads back.
     */
    const buildResolver = (connected?: PlatformType) => {
        const integrationService = {
            // getTypeIntegration reads the team's connected integration here.
            findOne: jest.fn(async (filter: any) =>
                filter?.integrationCategory ===
                    IntegrationCategory.CODE_MANAGEMENT && connected
                    ? { platform: connected }
                    : null,
            ),
            getPlatformAuthDetails: jest.fn(async (_org, platform) => {
                if (platform === PlatformType.GITLAB) {
                    // OAUTH: the adapter returns accessToken as-is. (TOKEN mode
                    // would run it through decrypt(), which needs a real
                    // ciphertext — out of scope for this contract.)
                    return {
                        accessToken: GITLAB_TOKEN,
                        authMode: AuthMode.OAUTH,
                        host: `https://${SELF_MANAGED_HOST}`,
                    };
                }
                // No GitHub integration for this organization.
                return undefined;
            }),
        };

        const gitlabService = new GitlabService(
            integrationService as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
            {} as any,
        );

        const githubService = new GithubService(
            integrationService as any,
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
        );

        const factory = new PlatformIntegrationFactory();
        factory.registerCodeManagementService(
            PlatformType.GITLAB,
            gitlabService as any,
        );
        factory.registerCodeManagementService(
            PlatformType.GITHUB,
            githubService as any,
        );

        const codeManagementService = new CodeManagementService(
            integrationService as any,
            factory,
        );

        return {
            resolver: new CloneParamsResolverService(codeManagementService),
            codeManagementService,
            integrationService,
        };
    };

    it('clones a self-managed GitLab remote from its own host, with its own token', async () => {
        const { resolver } = buildResolver(PlatformType.GITLAB);

        const result = await resolver.resolve(
            pipelineContext(),
            cliContext(`https://${SELF_MANAGED_HOST}/group/repo.git`),
        );

        // The exact failure from the issue: this used to be
        // https://github.com/group/repo with an empty token.
        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
        expect(result!.url).not.toContain('github.com');
        expect(result!.authToken).toBe(GITLAB_TOKEN);
        expect(result!.platform).toBe(PlatformType.GITLAB);
    });

    it('does not reach the GitHub adapter for a GitLab-only organization', async () => {
        const { resolver, integrationService } = buildResolver(
            PlatformType.GITLAB,
        );

        await resolver.resolve(
            pipelineContext(),
            cliContext(`https://${SELF_MANAGED_HOST}/group/repo.git`),
        );

        const platformsAskedFor =
            integrationService.getPlatformAuthDetails.mock.calls.map(
                ([, platform]) => platform,
            );

        expect(platformsAskedFor).not.toContain(PlatformType.GITHUB);
    });

    it('skips the sandbox when the organization connected nothing', async () => {
        const { resolver } = buildResolver(undefined);

        const result = await resolver.resolve(
            pipelineContext(),
            cliContext(`https://${SELF_MANAGED_HOST}/group/repo.git`),
        );

        expect(result).toBeNull();
    });
});

/**
 * getCloneParams resolves the platform itself when the caller does not name
 * one — the same fallback the list-returning methods in CodeManagementService
 * use. Those all guard the null that getTypeIntegration returns for an
 * organization with no integration; getCloneParams did not, and handed the
 * null straight to the factory.
 */
describe('CodeManagementService.getCloneParams (platform not supplied)', () => {
    const repository = {
        id: 'repo-1',
        defaultBranch: 'main',
        fullName: 'group/repo',
        name: 'repo',
    };
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildService = (connected?: PlatformType) => {
        const integrationService = {
            findOne: jest
                .fn()
                .mockResolvedValue(
                    connected ? { platform: connected } : null,
                ),
            getPlatformAuthDetails: jest.fn().mockResolvedValue({
                accessToken: 'oauth-token',
                authMode: AuthMode.OAUTH,
                host: 'https://gitlab.acme.com',
            }),
        };

        const factory = new PlatformIntegrationFactory();
        factory.registerCodeManagementService(
            PlatformType.GITLAB,
            new GitlabService(
                integrationService as any,
                {} as any,
                {} as any,
                { get: jest.fn() } as unknown as ConfigService,
                {} as any,
            ) as any,
        );

        return new CodeManagementService(integrationService as any, factory);
    };

    it('resolves the connected platform when none is passed', async () => {
        const service = buildService(PlatformType.GITLAB);

        const cloneParams = await service.getCloneParams({
            repository,
            organizationAndTeamData,
        });

        expect(cloneParams?.url).toBe('https://gitlab.acme.com/group/repo');
        expect(cloneParams?.provider).toBe(PlatformType.GITLAB);
    });

    it('returns null instead of throwing when nothing is connected', async () => {
        const service = buildService(undefined);

        // Previously: getTypeIntegration → null → factory throws
        // "Repository service for type 'null' not found."
        await expect(
            service.getCloneParams({ repository, organizationAndTeamData }),
        ).resolves.toBeNull();
    });
});
