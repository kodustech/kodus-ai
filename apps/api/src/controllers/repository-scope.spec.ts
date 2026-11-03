import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { ForbiddenException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';

import { FindByOrganizationIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-by-organization-id.use-case';

import { KodyRulesController } from './kodyRules.controller';
import { ParametersController } from './parameters.controller';
import { PullRequestController } from './pullRequest.controller';

/**
 * Repository scope — a member can be limited to some repositories of the
 * organization. These endpoints took a repository from the request and acted
 * on it after checking only the type-level permission, so a repo-scoped
 * member reached repositories outside their scope.
 *
 * The fake AuthorizationService mirrors the real one for a member scoped to
 * `my-repo`: `ensure` refuses any other repository, and refuses a call with
 * no repository (an org-wide action needs org-wide permission).
 */
const ALLOWED = 'my-repo';
const OTHER = 'other-repo';

const user = {
    uuid: 'u1',
    email: 'member@example.com',
    status: 'active',
    organization: { uuid: 'org-1' },
};

const makeAuthorization = () => ({
    ensure: jest.fn(async ({ repoIds }: { repoIds?: string[] }) => {
        if (!repoIds || repoIds.some((id) => id !== ALLOWED)) {
            throw new ForbiddenException('outside repository scope');
        }
    }),
    getRepositoryScope: jest.fn().mockResolvedValue([ALLOWED]),
});

const make = <T extends object>(
    Controller: { prototype: T },
    fields: Record<string, any>,
) => {
    const controller: any = Object.create(Controller.prototype);
    Object.assign(controller, {
        request: { user },
        authorizationService: makeAuthorization(),
        ...fields,
    });
    return controller;
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('repository scope — pull requests', () => {
    it('POST /pull-requests/backfill only backfills repositories in the scope', async () => {
        const execute = jest.fn().mockResolvedValue(undefined);
        const controller = make(PullRequestController, {
            backfillHistoricalPRsUseCase: { execute },
            codeManagementService: {
                getRepositories: jest.fn().mockResolvedValue([
                    { id: ALLOWED, name: 'a', selected: true },
                    { id: OTHER, name: 'b', selected: true },
                ]),
            },
        });

        await controller.backfillHistoricalPRs({ teamId: 'team-1' });
        await flush();

        const repositories = execute.mock.calls.flatMap(
            ([args]) => args.repositories,
        );
        expect(repositories.map((r) => r.id)).not.toContain(OTHER);
    });
});

describe('repository scope — kody rules', () => {
    it('GET /kody-rules/check-sync-status refuses a repository outside the scope', async () => {
        const execute = jest.fn();
        const controller = make(KodyRulesController, {
            checkSyncStatusUseCase: { execute },
            cacheService: {
                getFromCache: jest.fn().mockResolvedValue({ cached: true }),
                addToCache: jest.fn(),
            },
        });

        await expect(
            controller.checkSyncStatus('team-1', OTHER),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(execute).not.toHaveBeenCalled();
    });

    it('POST /kody-rules/generate-kody-rules refuses a repository outside the scope', async () => {
        const execute = jest.fn();
        const controller = make(KodyRulesController, {
            generateKodyRulesUseCase: { execute },
        });

        await expect(
            controller.generateKodyRules({
                teamId: 'team-1',
                repositoriesIds: [OTHER],
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(execute).not.toHaveBeenCalled();
    });

    it('GET /kody-rules/imported/count refuses a repository outside the scope', async () => {
        const count = jest.fn();
        const controller = make(KodyRulesController, {
            manageImportedKodyRulesUseCase: { count },
        });

        await expect(
            controller.countImportedRules(OTHER, 'team-1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(count).not.toHaveBeenCalled();
    });

    it('POST /kody-rules/imported/manage refuses a repository outside the scope', async () => {
        const execute = jest.fn();
        const controller = make(KodyRulesController, {
            manageImportedKodyRulesUseCase: { execute },
        });

        await expect(
            controller.manageImportedRules({
                repositoryId: OTHER,
                action: 'pause',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(execute).not.toHaveBeenCalled();
    });

    it('GET /kody-rules/find-by-organization-id hides rules of repositories outside the scope', async () => {
        const rule = (repositoryId: string) => ({
            uuid: `rule-${repositoryId}`,
            repositoryId,
            status: 'active',
        });
        const useCase = new FindByOrganizationIdKodyRulesUseCase(
            { user } as any,
            {
                findByOrganizationId: jest.fn().mockResolvedValue({
                    organizationId: 'org-1',
                    rules: [rule(ALLOWED), rule(OTHER), rule('global')],
                }),
            } as any,
            { findById: jest.fn().mockResolvedValue(null) } as any,
            makeAuthorization() as any,
        );

        const result = await useCase.execute();

        expect(result.rules.map((r) => r.repositoryId).sort()).toEqual(
            [ALLOWED, 'global'].sort(),
        );
    });
});

/**
 * Endpoints whose repository is mandatory check it in their
 * `@CheckPolicies(checkRepoPermissions(...))`, evaluated here against the
 * ability of a member scoped to `my-repo`.
 */
describe('repository scope — route policies', () => {
    const ability = (() => {
        const { can, build } = new AbilityBuilder<AppAbility>(
            createMongoAbility,
        );
        for (const [action, resource] of [
            [Action.Read, ResourceType.PullRequests],
            [Action.Create, ResourceType.KodyRules],
            [Action.Read, ResourceType.CodeReviewSettings],
        ] as const) {
            can(action, resource, {
                organizationId: 'org-1',
                repoId: { $in: [ALLOWED] },
            } as any);
        }
        return build();
    })();

    const policyUser = {
        organization: { uuid: 'org-1' },
        status: STATUS.ACTIVE,
    };

    it.each([
        [
            'GET /pull-requests/files',
            PullRequestController,
            'getPullRequestFiles',
            (repositoryId: string) => ({ query: { repositoryId } }),
        ],
        [
            'POST /kody-rules/sync-ide-rules',
            KodyRulesController,
            'syncIdeRules',
            (repositoryId: string) => ({ body: { repositoryId } }),
        ],
        [
            'POST /kody-rules/fast-sync-ide-rules',
            KodyRulesController,
            'fastSyncIdeRules',
            (repositoryId: string) => ({ body: { repositoryId } }),
        ],
        [
            'POST /kody-rules/resync-ide-rules',
            KodyRulesController,
            'resyncIdeRules',
            (repositoryId: string) => ({ body: { repositoryId } }),
        ],
        [
            'POST /parameters/preview-pr-summary',
            ParametersController,
            'previewPrSummary',
            (repositoryId: string) => ({
                body: { repository: { id: repositoryId } },
            }),
        ],
    ] as const)(
        '%s only allows a repository in the scope',
        (_route, Controller, handler, requestFor) => {
            const policies = Reflect.getMetadata(
                'check_policy',
                (Controller.prototype as any)[handler],
            ) as Array<(ability: AppAbility, request: any) => boolean>;
            const allows = (repositoryId: string) =>
                policies.every((policy) =>
                    policy(ability, {
                        user: policyUser,
                        ...requestFor(repositoryId),
                    }),
                );

            expect(allows(ALLOWED)).toBe(true);
            expect(allows(OTHER)).toBe(false);
        },
    );
});

describe('repository scope — CLI suggestions with a user JWT', () => {
    it('refuses a pull request of a repository outside the scope', async () => {
        const execute = jest.fn();
        const controller = make(PullRequestController, {
            jwtService: {
                verify: () => ({
                    email: user.email,
                    role: 'contributor',
                    status: 'active',
                    organizationId: 'org-1',
                }),
            },
            jwtConfig: { secret: 's' },
            authService: {
                validateUser: jest.fn().mockResolvedValue({
                    ...user,
                    role: 'contributor',
                    status: 'active',
                }),
            },
            pullRequestsService: {
                findOne: jest.fn().mockResolvedValue({
                    toObject: () => ({
                        number: 1,
                        repository: { id: OTHER, fullName: 'acme/other' },
                    }),
                }),
            },
            getPullRequestSuggestionsUseCase: { execute },
        });

        await expect(
            controller.getSuggestionsByPullRequest(
                undefined,
                OTHER,
                '1',
                'json',
                undefined,
                undefined,
                undefined,
                'Bearer header.payload.sig',
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(execute).not.toHaveBeenCalled();
    });
});
