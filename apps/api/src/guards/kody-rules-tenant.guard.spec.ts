import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';

import { Action } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { KodyRulesTenantGuard } from './kody-rules-tenant.guard';

/**
 * The guard owns the repository check of the Kody Rules routes that take one
 * `repositoryId` (check-sync-status, imported/count, sync, fast-sync and
 * resync of IDE rules): their handlers do not check it again.
 */
describe('KodyRulesTenantGuard', () => {
    const ALLOWED = 'my-repo';
    const user = { uuid: 'u1', organization: { uuid: 'org-1' } };

    const setup = () => {
        const ensure = jest.fn(
            async ({ repoIds }: { repoIds: string[]; action?: Action }) => {
                if (repoIds.some((id) => id !== ALLOWED)) {
                    throw new ForbiddenException('outside repository scope');
                }
            },
        );
        const guard = new KodyRulesTenantGuard(
            {
                findOneOrganizationIdByTeamId: jest.fn(
                    async (teamId: string) =>
                        teamId === 'team-1' ? 'org-1' : 'org-2',
                ),
            } as any,
            { ensure } as any,
        );
        const run = (request: Record<string, unknown>) =>
            guard.canActivate({
                switchToHttp: () => ({
                    getRequest: () => ({ user, ...request }),
                }),
            } as any);
        return { run, ensure };
    };

    it('reads a repository in the scope (GET → Read)', async () => {
        const { run, ensure } = setup();

        await expect(
            run({
                method: 'GET',
                query: { teamId: 'team-1', repositoryId: ALLOWED },
            }),
        ).resolves.toBe(true);
        expect(ensure.mock.calls[0][0].action).toBe(Action.Read);
    });

    it('refuses a repository outside the scope on read and on write', async () => {
        const { run, ensure } = setup();

        await expect(
            run({
                method: 'GET',
                query: { teamId: 'team-1', repositoryId: 'other-repo' },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            run({
                method: 'POST',
                body: { teamId: 'team-1', repositoryId: 'other-repo' },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(ensure.mock.calls[1][0].action).toBe(Action.Create);
    });

    it('hides a team of another organization as not found', async () => {
        const { run, ensure } = setup();

        await expect(
            run({ method: 'GET', query: { teamId: 'team-of-org-2' } }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(run({ method: 'GET', query: {} })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(ensure).not.toHaveBeenCalled();
    });

    // GET bodies are parsed too: a value in the body must not hide the one
    // in the query that the handler reads.
    it('checks the query repository even when the body names another', async () => {
        const { run } = setup();

        for (const bodyRepo of [ALLOWED, '']) {
            await expect(
                run({
                    method: 'GET',
                    body: { repositoryId: bodyRepo },
                    query: { teamId: 'team-1', repositoryId: 'other-repo' },
                }),
            ).rejects.toBeInstanceOf(ForbiddenException);
        }
    });

    it('refuses a request without an authenticated organization', async () => {
        const { ensure } = setup();
        const guard = new KodyRulesTenantGuard(
            {
                findOneOrganizationIdByTeamId: jest.fn(async () => 'org-1'),
            } as any,
            { ensure } as any,
        );
        for (const requestUser of [undefined, {}, { organization: {} }]) {
            await expect(
                guard.canActivate({
                    switchToHttp: () => ({
                        getRequest: () => ({
                            user: requestUser,
                            method: 'GET',
                            query: { teamId: 'team-1' },
                        }),
                    }),
                } as any),
            ).rejects.toThrow(new NotFoundException('Team not found'));
        }
    });

    // The sync routes match a numeric id against the repository's id: a
    // number names a repository just as its string does.
    it('checks a repository named by a number', async () => {
        const { run, ensure } = setup();

        await expect(
            run({
                method: 'POST',
                body: { teamId: 'team-1', repositoryId: 12345 },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(ensure.mock.calls[0][0].repoIds).toEqual(['12345']);
    });

    // A JSON body can carry anything: a value that is not an id is refused,
    // never dropped from the check while the handler still receives it.
    it('refuses a team or repository that is neither a string nor a number', async () => {
        const { run, ensure } = setup();

        for (const repositoryId of [{ $ne: null }, true, [{ x: 1 }]]) {
            await expect(
                run({
                    method: 'POST',
                    body: { teamId: 'team-1', repositoryId },
                }),
            ).rejects.toThrow(
                new BadRequestException('repositoryId must be a string'),
            );
        }
        await expect(
            run({ method: 'POST', body: { teamId: { $ne: null } } }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(ensure).not.toHaveBeenCalled();
    });

    it('does not check the repository scope of a request that names no repository', async () => {
        const { run, ensure } = setup();

        await expect(
            run({ method: 'GET', query: { teamId: 'team-1' } }),
        ).resolves.toBe(true);
        // A form sends an unset field as null or ''.
        for (const repositoryId of [null, '', undefined]) {
            await expect(
                run({
                    method: 'POST',
                    body: { teamId: 'team-1', repositoryId },
                }),
            ).resolves.toBe(true);
        }
        expect(ensure).not.toHaveBeenCalled();
    });

    it('checks every team the request names', async () => {
        const { run } = setup();

        await expect(
            run({
                method: 'GET',
                body: { teamId: 'team-1' },
                query: { teamId: 'team-of-org-2' },
            }),
        ).rejects.toThrow(new NotFoundException('Team not found'));
    });
});
