import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';

import { FindByOrganizationIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-by-organization-id.use-case';

import { KodyRulesTenantGuard } from '../guards/kody-rules-tenant.guard';
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

    it('POST /kody-rules/generate-kody-rules without a list narrows a scoped member to their repositories', async () => {
        const execute = jest.fn();
        const controller = make(KodyRulesController, {
            generateKodyRulesUseCase: { execute },
        });

        await controller.generateKodyRules({ teamId: 'team-1' });

        expect(execute.mock.calls[0][0].repositoriesIds).toEqual([ALLOWED]);
        expect(
            controller.authorizationService.getRepositoryScope,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.Create,
                resource: ResourceType.KodyRules,
                user: expect.objectContaining({ uuid: expect.anything() }),
            }),
        );
    });

    // No scope (null) is a member who reaches every repository: the use case
    // gets the request as sent and generates for all of them.
    it('POST /kody-rules/generate-kody-rules without a list keeps every repository for an unscoped member', async () => {
        const execute = jest.fn();
        const controller = make(KodyRulesController, {
            generateKodyRulesUseCase: { execute },
        });
        controller.authorizationService.getRepositoryScope.mockResolvedValue(
            null,
        );

        await controller.generateKodyRules({ teamId: 'team-1' });

        expect(execute.mock.calls[0][0]).toEqual({ teamId: 'team-1' });
    });

    // An empty list means "every repository" to the use case, so a member
    // scoped to no repository must not reach it.
    it('POST /kody-rules/generate-kody-rules refuses a member scoped to no repository', async () => {
        const execute = jest.fn();
        const controller = make(KodyRulesController, {
            generateKodyRulesUseCase: { execute },
        });
        controller.authorizationService.getRepositoryScope.mockResolvedValue(
            [],
        );

        for (const body of [
            { teamId: 'team-1' },
            { teamId: 'team-1', repositoriesIds: [] },
        ]) {
            await expect(controller.generateKodyRules(body)).rejects.toThrow(
                new ForbiddenException(
                    'No repository in your scope to generate rules for',
                ),
            );
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it('GET /kody-rules/past-reviewers takes no `global` as a scoped repository, and passes the granted connections', async () => {
        const execute = jest.fn().mockResolvedValue([]);
        const controller = make(KodyRulesController, {
            listPastReviewersUseCase: { execute },
            connectionAccess: {
                restrictionFor: jest
                    .fn()
                    .mockResolvedValue({ connectionIds: new Set(['gh-a']) }),
            },
        });
        controller.authorizationService.getRepositoryScope.mockResolvedValue([
            ALLOWED,
            'global',
        ]);

        await expect(
            controller.listPastReviewers('team-2', 'global'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await controller.listPastReviewers('team-2', ALLOWED);

        expect(execute.mock.calls).toEqual([
            [
                {
                    teamId: 'team-2',
                    repositoryId: ALLOWED,
                    months: undefined,
                    readableConnectionIds: new Set(['gh-a']),
                },
            ],
        ]);
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
/**
 * These routes take one `repositoryId` and leave its check to
 * KodyRulesTenantGuard (its own spec covers the check); here, that the
 * guard stays on them.
 */
describe('repository scope — Kody Rules routes guarded by KodyRulesTenantGuard', () => {
    it.each([
        'checkSyncStatus',
        'countImportedRules',
        'syncIdeRules',
        'fastSyncIdeRules',
        'resyncIdeRules',
    ])('%s runs KodyRulesTenantGuard', (handler) => {
        const guards = Reflect.getMetadata(
            GUARDS_METADATA,
            (KodyRulesController.prototype as any)[handler],
        ) as unknown[];

        expect(guards).toContain(KodyRulesTenantGuard);
    });
});

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

describe('workspace scope — suggestions with a team CLI key', () => {
    const storedPr = {
        toObject: () => ({
            number: 1,
            repository: { id: OTHER, fullName: 'acme/other' },
        }),
    };
    const teamKeyController = (teamRepositoryIds: string[]) => {
        const execute = jest.fn().mockResolvedValue({
            response: {},
            suggestionsCount: 0,
        });
        const controller = make(PullRequestController, {
            teamCliKeyService: {
                validateKey: jest.fn().mockResolvedValue({
                    organization: { uuid: 'org-1' },
                    team: { uuid: 'team-1' },
                }),
            },
            integrationConfigService: {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue(
                        teamRepositoryIds.map((id) => ({ id, name: id })),
                    ),
            },
            pullRequestsService: {
                findOne: jest.fn().mockResolvedValue(storedPr),
                find: jest.fn().mockResolvedValue([storedPr]),
            },
            getPullRequestSuggestionsUseCase: { execute },
            eventEmitter: { emit: jest.fn() },
        });
        return { controller, execute };
    };

    it("serves the key's own repository when another server has one with the same id", async () => {
        const execute = jest.fn().mockResolvedValue({
            response: {},
            suggestionsCount: 0,
        });
        const pr = (fullName: string) => ({
            toObject: () => ({
                number: 12,
                repository: { id: '3', fullName },
            }),
        });
        const controller = make(PullRequestController, {
            teamCliKeyService: {
                validateKey: jest.fn().mockResolvedValue({
                    organization: { uuid: 'org-1' },
                    team: { uuid: 'team-1' },
                }),
            },
            integrationConfigService: {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue([
                        { id: 3, name: 'api', organizationName: 'acme' },
                    ]),
            },
            pullRequestsService: {
                findOne: jest.fn().mockResolvedValue(pr('other/tool')),
                find: jest
                    .fn()
                    .mockResolvedValue([pr('other/tool'), pr('acme/api')]),
            },
            getPullRequestSuggestionsUseCase: { execute },
            eventEmitter: { emit: jest.fn() },
            automationExecutionService: {
                create: jest.fn().mockResolvedValue(undefined),
            },
        });

        await controller.getSuggestionsByPullRequest(
            undefined,
            '3',
            '12',
            'json',
            undefined,
            undefined,
            'kodus_key',
        );

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                pr: expect.objectContaining({
                    repository: { id: '3', fullName: 'acme/api' },
                }),
            }),
        );
    });

    it("refuses a pull request of a repository outside the key's workspace", async () => {
        const { controller, execute } = teamKeyController([ALLOWED]);

        await expect(
            controller.getSuggestionsByPullRequest(
                undefined,
                OTHER,
                '1',
                'json',
                undefined,
                undefined,
                'kodus_key',
            ),
        ).rejects.toThrow('Pull request not found');
        expect(execute).not.toHaveBeenCalled();
    });

    it("serves a pull request of a repository of the key's workspace", async () => {
        const { controller, execute } = teamKeyController([OTHER]);

        await controller
            .getSuggestionsByPullRequest(
                undefined,
                OTHER,
                '1',
                'json',
                undefined,
                undefined,
                'kodus_key',
            )
            .catch(() => undefined);

        expect(execute).toHaveBeenCalled();
    });
});

describe('repository scope — execution events stream', () => {
    it('streams only the executions of repositories in the scope', async () => {
        const { EventEmitter2 } = await import('@nestjs/event-emitter');
        const { Subject, firstValueFrom, filter, take, toArray } =
            await import('rxjs');
        const eventEmitter = new EventEmitter2();
        const controller = make(PullRequestController, {
            eventEmitter,
            shutdown$: new Subject<void>(),
        });

        const received = firstValueFrom(
            controller.executionEvents().pipe(
                filter((event: any) => event.data.type === 'execution_updated'),
                take(2),
                toArray(),
            ),
        );
        await flush();
        for (const [executionUuid, repositoryId] of [
            ['e-other', OTHER],
            ['e-mine', ALLOWED],
            ['e-signal', undefined],
        ]) {
            eventEmitter.emit('pr-execution.updated', {
                organizationId: 'org-1',
                executionUuid,
                repositoryId,
                status: 'success',
            });
        }

        expect(
            (await received).map((event: any) => event.data.executionUuid),
        ).toEqual(['e-mine', 'e-signal']);
    });

    it('stops streaming a repository soon after the grant to it is revoked', async () => {
        const { EventEmitter2 } = await import('@nestjs/event-emitter');
        const { Subject } = await import('rxjs');
        const eventEmitter = new EventEmitter2();
        const authorizationService = makeAuthorization();
        const controller = make(PullRequestController, {
            eventEmitter,
            authorizationService,
            shutdown$: new Subject<void>(),
        });
        let now = 1_000_000;
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        const received: string[] = [];
        const subscription = controller
            .executionEvents()
            .subscribe((event: any) => {
                if (event.data.type === 'execution_updated') {
                    received.push(event.data.executionUuid);
                }
            });
        const emit = (executionUuid: string) =>
            eventEmitter.emit('pr-execution.updated', {
                organizationId: 'org-1',
                executionUuid,
                repositoryId: ALLOWED,
                status: 'success',
            });

        emit('before');
        await flush();
        authorizationService.getRepositoryScope.mockResolvedValue([]);
        now += 16_000;
        emit('after');
        await flush();

        subscription.unsubscribe();
        clock.mockRestore();
        expect(received).toEqual(['before']);
    });
});
