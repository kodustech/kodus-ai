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

const cliContext = (remote: string, inferredPlatform?: PlatformType) =>
    ({
        gitContext: { remote, branch: 'feature/x', inferredPlatform },
    }) as any;

const pipelineContext = () =>
    ({
        origin: 'cli',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    }) as any;

// The undefined-platform path (resolve the connected integration, never
// assume GitHub) is covered against the real adapters in
// clone-params-resolver.contract.spec.ts.
describe('CloneParamsResolverService (CLI mode, self-managed host)', () => {
    const REMOTE = `https://${SELF_MANAGED_HOST}/group/repo.git`;

    let service: CloneParamsResolverService;
    let codeManagementService: { getCloneParams: jest.Mock };

    beforeEach(() => {
        codeManagementService = {
            // Stands in for CodeManagementService resolving the team's
            // connected self-managed GitLab.
            getCloneParams: jest.fn(async (params: any) => ({
                url: `https://${SELF_MANAGED_HOST}/${params.repository.fullName}`,
                provider: PlatformType.GITLAB,
                auth: { type: 'token', token: GITLAB_TOKEN },
            })),
        };

        service = new CloneParamsResolverService(codeManagementService as any);
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
});

/**
 * Regression coverage for the trial-mode "invalid input syntax for type
 * uuid" prod incident (2026-09-14). Trial/anonymous CLI reviews
 * (public-pr-review.use-case.ts) run with the placeholder
 * `organizationAndTeamData: {organizationId: 'trial', teamId: 'trial'}` —
 * there is no real integration row behind it. Without this fix, a trial
 * review with no PAT still called `getCloneParams` with that placeholder,
 * which Postgres rejected outright on the UUID-typed organization_id column.
 */
describe('CloneParamsResolverService (trial mode, no PAT)', () => {
    const REMOTE = 'https://github.com/octocat/hello-world.git';

    const trialPipelineContext = () =>
        ({
            origin: 'cli',
            organizationAndTeamData: { organizationId: 'trial', teamId: 'trial' },
        }) as any;

    const trialCliContext = (over: Record<string, unknown> = {}) =>
        ({
            isTrialMode: true,
            gitContext: {
                remote: REMOTE,
                branch: 'main',
                inferredPlatform: PlatformType.GITHUB,
            },
            ...over,
        }) as any;

    it('never calls getCloneParams with the trial placeholder org', async () => {
        const getCloneParams = jest.fn();
        const service = new CloneParamsResolverService({
            getCloneParams,
        } as any);

        await service.resolve(trialPipelineContext(), trialCliContext());

        expect(getCloneParams).not.toHaveBeenCalled();
    });

    it('clones anonymously (no token) using the inferred platform', async () => {
        const getCloneParams = jest.fn();
        const service = new CloneParamsResolverService({
            getCloneParams,
        } as any);

        const result = await service.resolve(
            trialPipelineContext(),
            trialCliContext(),
        );

        expect(result?.authToken).toBe('');
        expect(result?.platform).toBe(PlatformType.GITHUB);
        expect(result?.url).toBe(REMOTE);
    });

    it('still uses the PAT path when the trial user supplies one, without calling getCloneParams either', async () => {
        const getCloneParams = jest.fn();
        const service = new CloneParamsResolverService({
            getCloneParams,
        } as any);

        const result = await service.resolve(
            trialPipelineContext(),
            trialCliContext({
                gitContext: {
                    remote: REMOTE,
                    branch: 'main',
                    inferredPlatform: PlatformType.GITHUB,
                    githubPat: 'ghp-user-supplied',
                },
            }),
        );

        expect(getCloneParams).not.toHaveBeenCalled();
        expect(result?.authToken).toBe('ghp-user-supplied');
    });

    // Regression (caught in review, PR #1954): a self-managed host (GitLab
    // CE/EE, GHES, Gitea) the CLI could not infer a platform for must skip
    // the sandbox via the existing `!platform` guard, not get force-assumed
    // as GitHub — that would attempt an anonymous GitHub-shaped clone and
    // fetch the wrong repository entirely (#1541, "Do NOT guess GitHub").
    it('skips the sandbox (does not force GitHub) for a self-managed host trial-mode could not infer', async () => {
        const getCloneParams = jest.fn();
        const service = new CloneParamsResolverService({
            getCloneParams,
        } as any);

        const result = await service.resolve(
            trialPipelineContext(),
            trialCliContext({
                gitContext: {
                    remote: 'https://git.acme-corp.internal/group/repo.git',
                    branch: 'main',
                    inferredPlatform: undefined,
                },
            }),
        );

        expect(getCloneParams).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });
});
