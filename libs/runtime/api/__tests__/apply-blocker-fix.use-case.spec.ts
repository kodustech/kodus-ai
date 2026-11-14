import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { ApplyBlockerFixUseCase } from '../application/use-cases/apply-blocker-fix.use-case';
import { blockerGroups } from '../application/use-cases/environments.use-cases';

const ORG = 'org-1';
const RECIPE = 'version: 1\nservices:\n  compose:\n    public: web # ready check\n  expose:\n    - { service: web, port: 3000, kind: http }\n';
const user = { uuid: 'user-1', organization: { uuid: ORG } };
const product = {
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'acme/shop',
};

const setupRecord = (over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: ORG,
    repositoryId: 'repo-1',
    key: 'k',
    state: 'blocked',
    steps: [],
    blockers: [
        {
            kind: 'toolchain',
            signature: 'compose_up',
            message: 'compose up: exit 1',
            at: '2026-11-03T12:00:00.000Z',
        },
    ],
    failureBundle: {
        services: [
            {
                name: 'api',
                state: 'exited',
                logTail: ['Error: Missing required environment variable: STRIPE_SECRET_KEY'],
            },
        ],
        ports: [],
        disk: [],
        deniedEgress: [],
        redactions: 0,
        truncated: false,
        collectedAt: '2026-11-03T12:00:00.000Z',
    },
    recipe: {
        path: '.kodus/workspace.yaml',
        sha: 'abc',
        state: 'found',
        content: RECIPE,
    },
    requestedAt: '2026-11-03T12:00:00.000Z',
    updatedAt: '2026-11-03T12:00:00.000Z',
    ...over,
});

function make(rec = setupRecord(), opts: { recipeOnBranch?: string | null; deny?: boolean } = {}) {
    const git = {
        getDefaultBranchHead: jest.fn().mockResolvedValue({
            status: 'ok',
            branch: 'main',
            sha: 'f00dbabe1234',
        }),
        readFileAtCommit: jest.fn().mockResolvedValue(opts.recipeOnBranch === undefined ? RECIPE : opts.recipeOnBranch),
        openPullRequestWithFiles: jest.fn().mockResolvedValue({
            number: 41,
            url: 'https://github.com/acme/shop/pull/41',
        }),
    };
    const setups = { request: jest.fn().mockResolvedValue(product) };
    const approveEgress = { execute: jest.fn().mockResolvedValue({}) };
    const authorization = {
        ensure: jest.fn(async () => {
            if (opts.deny) throw new ForbiddenException();
        }),
    };
    const environment = {
        load: jest.fn(async (_u: unknown, id: string) => {
            if (id !== 'env-1') throw new NotFoundException('Environment not found');
            return {
                env: {
                    environmentId: 'env-1',
                    organizationId: ORG,
                    repositoryId: 'repo-1',
                },
                runs: [],
            };
        }),
        setup: jest.fn().mockResolvedValue(rec),
    };
    const useCase = new ApplyBlockerFixUseCase(
        environment as any,
        { get: jest.fn().mockResolvedValue(product) },
        authorization as any,
        setups as any,
        approveEgress as any,
        git as any,
    );
    return { useCase, git, setups, approveEgress, authorization };
}

describe('ApplyBlockerFixUseCase', () => {
    it('opens a recipe PR with the one-field change, read from the default branch, and says so', async () => {
        const t = make();
        const out = await t.useCase.execute({
            user,
            environmentId: 'env-1',
            signature: 'missing_env:STRIPE_SECRET_KEY',
            fixId: 'set_env:STRIPE_SECRET_KEY',
        });
        expect(out).toEqual({
            action: 'set_env',
            pullRequest: {
                number: 41,
                url: 'https://github.com/acme/shop/pull/41',
            },
        });
        expect(t.git.readFileAtCommit).toHaveBeenCalledWith(
            expect.objectContaining({
                path: '.kodus/workspace.yaml',
                sha: 'f00dbabe1234',
            }),
        );
        const pr = t.git.openPullRequestWithFiles.mock.calls[0][0];
        expect(pr).toMatchObject({
            baseBranch: 'main',
            branch: 'kody-runtime/fix-set-env-stripe-secret-key-f00dbab',
            repositoryName: 'acme/shop',
            teamId: 'team-1',
        });
        expect(pr.files).toEqual([
            {
                path: '.kodus/workspace.yaml',
                content: expect.stringContaining('    public: web # ready check\n    env:\n      STRIPE_SECRET_KEY: "kodus-test-value"\n'),
            },
        ]);
        expect(pr.body).toContain('+      STRIPE_SECRET_KEY: "kodus-test-value"');
        expect(t.authorization.ensure).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', repoIds: ['repo-1'] }));
    });

    it('refuses when the recipe on the default branch already has the change or is gone', async () => {
        const already = RECIPE.replace(
            '    public: web # ready check\n',
            '    public: web # ready check\n    env:\n      STRIPE_SECRET_KEY: "kodus-test-value"\n',
        );
        await expect(
            make(undefined, { recipeOnBranch: already }).useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'missing_env:STRIPE_SECRET_KEY',
                fixId: 'set_env:STRIPE_SECRET_KEY',
            }),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
            make(undefined, { recipeOnBranch: null }).useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'missing_env:STRIPE_SECRET_KEY',
                fixId: 'set_env:STRIPE_SECRET_KEY',
            }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 503 with a plain message when the Git platform fails (bad credentials, outage)', async () => {
        const t = make();
        t.git.getDefaultBranchHead.mockRejectedValue(new Error('Bad credentials - https://docs.github.com/rest'));
        const err = await t.useCase
            .execute({
                user,
                environmentId: 'env-1',
                signature: 'missing_env:STRIPE_SECRET_KEY',
                fixId: 'set_env:STRIPE_SECRET_KEY',
            })
            .catch((e) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect(err.message).toContain('Check the Git integration');
        expect(err.message).not.toContain('Bad credentials');
    });

    it('approves a denied host and sets up again in one click', async () => {
        const rec = setupRecord();
        rec.failureBundle!.deniedEgress = [
            {
                host: 'api.segment.io',
                port: 443,
                at: '2026-11-03T12:00:00.000Z',
            },
        ];
        const t = make(rec);
        const out = await t.useCase.execute({
            user,
            environmentId: 'env-1',
            signature: 'external_service:egress:api.segment.io',
            fixId: 'approve_host:api.segment.io',
        });
        expect(out).toEqual({
            action: 'approve_host',
            host: 'api.segment.io',
            setupRequested: true,
        });
        expect(t.approveEgress.execute).toHaveBeenCalledWith({
            user,
            environmentId: 'env-1',
            host: 'api.segment.io',
        });
        expect(t.setups.request).toHaveBeenCalledWith(product, user);
    });

    it('retries the setup for a failure on the Kodus side', async () => {
        const t = make(
            setupRecord({
                blockers: [
                    {
                        kind: 'platform',
                        signature: 'repo_fetch',
                        message: 'download: 502',
                        at: '2026-11-03T12:00:00.000Z',
                    },
                ],
                failureBundle: undefined,
            }),
        );
        await expect(
            t.useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'repo_fetch',
                fixId: 'retry_setup',
            }),
        ).resolves.toEqual({ action: 'retry_setup', setupRequested: true });
    });

    it('applies only what the catalog offers for that blocker now', async () => {
        const t = make();
        await expect(
            t.useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'missing_env:STRIPE_SECRET_KEY',
                fixId: 'approve_host:evil.test',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            t.useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'missing_env:OTHER',
                fixId: 'set_env:OTHER',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            t.useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'missing_env:STRIPE_SECRET_KEY',
                fixId: 'use_mock:STRIPE_SECRET_KEY',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(t.git.openPullRequestWithFiles).not.toHaveBeenCalled();
        expect(t.setups.request).not.toHaveBeenCalled();
    });

    it('needs Update on the environment, and another environment is 404', async () => {
        await expect(
            make(undefined, { deny: true }).useCase.execute({
                user,
                environmentId: 'env-1',
                signature: 'repo_fetch',
                fixId: 'retry_setup',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            make().useCase.execute({
                user,
                environmentId: 'env-9',
                signature: 'repo_fetch',
                fixId: 'retry_setup',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('blockerGroups', () => {
    it("shows a recipe fix as a diff, and as plain guidance when there's no recipe to change", () => {
        const [withRecipe] = blockerGroups(setupRecord(), []);
        expect(withRecipe.fixes[0]).toMatchObject({
            who: 'dev',
            recipeDiff: expect.stringContaining('+    env:'),
        });
        expect(withRecipe.fixes[0]).not.toHaveProperty('recipeChange');
        const [noRecipe] = blockerGroups(
            setupRecord({
                recipe: {
                    path: '.kodus/workspace.yaml',
                    sha: 'abc',
                    state: 'absent',
                },
            }),
            [],
        );
        expect(noRecipe.fixes[0].recipeDiff).toBeUndefined();
        expect(noRecipe.fixes[0].detail).toContain('not offered as a PR');
        // A recipe Kodus inferred is not on the default branch yet: the one-field PR waits for the recipe PR.
        const [inferred] = blockerGroups(setupRecord({ recipe: { path: '.kodus/workspace.yaml', sha: 'abc', state: 'found', content: RECIPE, origin: 'inferred' } }), []);
        expect(inferred.fixes[0].recipeDiff).toBeUndefined();
        // Nor is one Kody wrote.
        const [authored] = blockerGroups(setupRecord({ recipe: { path: '.kodus/workspace.yaml', sha: 'abc', state: 'found', content: RECIPE, origin: 'authored' } }), []);
        expect(authored.fixes[0].recipeDiff).toBeUndefined();
    });
});
