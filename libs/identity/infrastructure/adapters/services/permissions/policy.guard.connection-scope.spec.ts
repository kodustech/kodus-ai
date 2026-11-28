import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';

import {
    AppliesConnectionScope,
    CheckPolicies,
    PolicyGuard,
} from './policy.guard';
import {
    checkAnyPermission,
    checkPermissions,
    checkRepoPermissions,
} from './policy.handlers';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const user = {
    uuid: 'u-1',
    role: 'contributor',
    status: 'active',
    organization: { uuid: 'org-1' },
};

const guardFor = (
    handler: (...args: unknown[]) => unknown,
    restricted: boolean,
) => {
    const abilityFactory = {
        createForUser: jest.fn(async () => ({ can: () => true })),
        isConnectionRestricted: jest.fn(async () => restricted),
    };
    const guard = new PolicyGuard(
        new Reflector(),
        abilityFactory as any,
        {} as any,
    );
    const context = {
        getHandler: () => handler,
        getClass: () => class Controller {},
        switchToHttp: () => ({
            getRequest: () => ({
                user,
                params: {},
                query: { repositoryId: 'repo-1' },
                body: {},
            }),
        }),
    };
    return { guard, context: context as any, abilityFactory };
};

const route = (...decorators: MethodDecorator[]) => {
    class Controller {
        handler() {
            return undefined;
        }
    }
    const descriptor = Object.getOwnPropertyDescriptor(
        Controller.prototype,
        'handler',
    )!;
    for (const decorator of decorators) {
        decorator(Controller.prototype, 'handler', descriptor);
    }
    return Controller.prototype.handler;
};

const readPullRequests = CheckPolicies(
    checkPermissions({
        action: Action.Read,
        resource: ResourceType.PullRequests,
    }),
);

describe('PolicyGuard — reads of connection-scoped data', () => {
    it('refuses an organization-wide read to a member granted only some Git connections', async () => {
        const { guard, context } = guardFor(route(readPullRequests), true);

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('lets the read through for a member granted every connection', async () => {
        const { guard, context } = guardFor(route(readPullRequests), false);

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('lets the read through when the handler narrows it to the granted connections itself', async () => {
        const { guard, context } = guardFor(
            route(readPullRequests, AppliesConnectionScope()),
            true,
        );

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('leaves repository-checked reads, writes and other resources to the policies', async () => {
        for (const policy of [
            checkRepoPermissions({
                action: Action.Read,
                resource: ResourceType.PullRequests,
                repo: { key: { query: 'repositoryId' } },
            }),
            checkPermissions({
                action: Action.Update,
                resource: ResourceType.CodeReviewSettings,
            }),
            checkPermissions({
                action: Action.Read,
                resource: ResourceType.UserSettings,
            }),
        ]) {
            const { guard, context, abilityFactory } = guardFor(
                route(CheckPolicies(policy)),
                true,
            );
            await expect(guard.canActivate(context)).resolves.toBe(true);
            expect(
                abilityFactory.isConnectionRestricted,
            ).not.toHaveBeenCalled();
        }
    });

    it('holds a choice that includes any connection-scoped read to the same rule, unless the handler narrows it', async () => {
        const mixed = CheckPolicies(
            checkAnyPermission([
                { action: Action.Read, resource: ResourceType.PullRequests },
                { action: Action.Read, resource: ResourceType.UserSettings },
            ]),
        );

        const unmarked = guardFor(route(mixed), true);
        await expect(
            unmarked.guard.canActivate(unmarked.context),
        ).rejects.toBeInstanceOf(ForbiddenException);

        const marked = guardFor(route(AppliesConnectionScope(), mixed), true);
        await expect(marked.guard.canActivate(marked.context)).resolves.toBe(
            true,
        );
    });

    it('treats a choice between connection-scoped reads as one', async () => {
        const { guard, context } = guardFor(
            route(
                CheckPolicies(
                    checkAnyPermission([
                        {
                            action: Action.Read,
                            resource: ResourceType.PullRequests,
                        },
                        {
                            action: Action.Read,
                            resource: ResourceType.KodyRules,
                        },
                    ]),
                ),
            ),
            true,
        );

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });
});
